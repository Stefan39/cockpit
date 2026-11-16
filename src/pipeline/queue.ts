/**
 * Die Job-Queue der autonomen Entwicklungspipeline (COPI-145, JAC-757; Confluence TEAM 127172609, Abschnitt 3).
 *
 * Jira bzw. GitHub Issues sind die fachliche Wahrheit, diese Tabellen die operative: der Koordinator (n8n) legt Jobs an
 * (`jobAnlegen`), der Runner auf dem Mini-PC holt sie (`jobVergeben`), hält die Lease (`leaseVerlaengern`), meldet
 * (`ereignisMelden`) und schließt ab (`jobAbschliessen`).
 *
 *   * **Vergabe atomar.** Ein `claim` läuft in einer Transaktion, die zuerst eine Advisory-Sperre nimmt — gleichzeitige
 *     Vergaben reihen sich auf, denn „höchstens ein Umsetzungsjob je Repo" lässt sich mit Zeilensperren allein nicht
 *     sicherstellen (zwei Vergaben könnten zwei verschiedene Jobs desselben Repos wählen). Die Auswahl selbst sperrt
 *     ihre Zeile mit `FOR UPDATE SKIP LOCKED`, und ein eindeutiger Index (Migration 0051) hält die Regel je Repo auch
 *     gegen einen Fehler hier fest. Bei einigen Vergaben je Minute kostet das Aufreihen nichts.
 *   * **Reihenfolge:** Nacharbeit vor allem anderen (Angefangenes zuerst fertig), dann Fälligkeit (ohne Fälligkeit
 *     zuletzt), dann Priorität (1 dringend bis 5), dann Alter.
 *   * **Anbieter:** Ist einer erschöpft (`until` noch nicht vorbei, ohne `until` bis zum Zurücksetzen) oder abgeschaltet,
 *     gibt es keine Jobs dieses Anbieters — Reviews anderer Anbieter laufen weiter.
 *   * **Abgelaufene Leases** räumt jede Vergabe zuerst auf (und der Koordinator über `/intern/pipeline/aufraeumen`): Versuch + 1,
 *     zurück in die Queue, bei mehr als `max_attempts` Versuchen auf `parked`. So kommt ein Job auch ohne n8n zurück.
 *   * **Ein Abo-Limit ist kein Versuch** (`quota`): der Job geht ohne Zählung zurück, der Anbieter ist erschöpft.
 *
 * Jede Statusänderung steht als Ereignis in `pipeline_job_event` (ohne `event_id`); Meldungen des Runners tragen eine
 * `event_id`, und eine doppelt gesendete wird nur einmal gespeichert. Die Zeit kommt immer von außen (`jetzt`).
 */
import type pg from 'pg';
import { inTransaktion } from '../datenbank/transaktion.js';

export const JOB_ARTEN = ['implement', 'rework', 'review:codex', 'review:gemini', 'review:copilot'] as const;
export type JobArt = (typeof JOB_ARTEN)[number];

export const ANBIETER = ['claude', 'codex', 'gemini', 'copilot'] as const;
export type Anbieter = (typeof ANBIETER)[number];

export const JOB_STATUS = ['queued', 'leased', 'done', 'failed', 'parked'] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

/** Wie lange eine Lease gilt; ein Heartbeat verlängert sie um so viel ab jetzt. */
export const LEASE_MS = 15 * 60 * 1000;

/** Wie lange ein Anbieter ohne genannte Reset-Zeit als erschöpft gilt. */
export const ERSCHOEPFT_STANDARD_MS = 60 * 60 * 1000;

/** Die Sperre, an der sich gleichzeitige Vergaben aufreihen. */
const VERGABE_SPERRE = "hashtext('cockpit.pipeline_claim')";

export interface PipelineJob {
  readonly id: string;
  readonly ticketKey: string;
  readonly repo: string;
  readonly kind: JobArt;
  readonly provider: Anbieter;
  readonly status: JobStatus;
  readonly priority: number;
  /** `YYYY-MM-DD` oder `null`. */
  readonly dueDate: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string | null;
  readonly leaseUntil: Date | null;
  readonly payload: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface JobZeile {
  id: string;
  ticket_key: string;
  repo: string;
  kind: JobArt;
  provider: Anbieter;
  status: JobStatus;
  priority: number;
  due_date: string | null;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: Date | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const JOB_SPALTEN = `id, ticket_key, repo, kind, provider, status, priority, to_char(due_date, 'YYYY-MM-DD') AS due_date,
  attempt, max_attempts, lease_owner, lease_until, payload, result, created_at, updated_at`;

function jobAus(zeile: JobZeile): PipelineJob {
  return {
    id: zeile.id,
    ticketKey: zeile.ticket_key,
    repo: zeile.repo,
    kind: zeile.kind,
    provider: zeile.provider,
    status: zeile.status,
    priority: zeile.priority,
    dueDate: zeile.due_date,
    attempt: zeile.attempt,
    maxAttempts: zeile.max_attempts,
    leaseOwner: zeile.lease_owner,
    leaseUntil: zeile.lease_until,
    payload: zeile.payload,
    result: zeile.result,
    createdAt: zeile.created_at,
    updatedAt: zeile.updated_at,
  };
}

/** Ein Job, wie die APIs ihn ausgeben (Feldnamen wie im Konzept). */
export function jobAlsJson(job: PipelineJob): Record<string, unknown> {
  return {
    id: job.id,
    ticket_key: job.ticketKey,
    repo: job.repo,
    kind: job.kind,
    provider: job.provider,
    status: job.status,
    priority: job.priority,
    due_date: job.dueDate,
    attempt: job.attempt,
    max_attempts: job.maxAttempts,
    lease_owner: job.leaseOwner,
    lease_until: job.leaseUntil?.toISOString() ?? null,
    payload: job.payload,
    result: job.result,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
  };
}

/** Hält eine Statusänderung im Audit fest. */
async function statusNotieren(
  db: pg.ClientBase,
  jobId: string,
  daten: { readonly von: JobStatus; readonly nach: JobStatus; readonly grund: string; readonly runner?: string | null },
): Promise<void> {
  await db.query(`INSERT INTO cockpit.pipeline_job_event (job_id, runner, type, data) VALUES ($1, $2, 'status', $3)`, [
    jobId,
    daten.runner ?? null,
    { von: daten.von, nach: daten.nach, grund: daten.grund },
  ]);
}

export interface AufgeraeumterJob {
  readonly id: string;
  readonly ticketKey: string;
  readonly status: 'queued' | 'parked';
  readonly attempt: number;
}

/**
 * Gibt alle abgelaufenen Leases zurück in die Queue: Versuch + 1, bei mehr als `max_attempts` auf `parked`. Liefert die
 * betroffenen Jobs — der Koordinator meldet die geparkten an Stefan.
 */
export async function abgelaufeneAufraeumen(db: pg.ClientBase, jetzt: Date): Promise<AufgeraeumterJob[]> {
  const ergebnis = await db.query<{ id: string; ticket_key: string; status: 'queued' | 'parked'; attempt: number; owner: string }>(
    `WITH abgelaufen AS (
       SELECT id, lease_owner FROM cockpit.pipeline_job
        WHERE status = 'leased' AND lease_until < $1
        ORDER BY id
          FOR UPDATE
     )
     UPDATE cockpit.pipeline_job j
        SET attempt = j.attempt + 1,
            status = CASE WHEN j.attempt + 1 > j.max_attempts THEN 'parked' ELSE 'queued' END,
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = $1
       FROM abgelaufen a
      WHERE j.id = a.id
  RETURNING j.id, j.ticket_key, j.status, j.attempt, a.lease_owner AS owner`,
    [jetzt],
  );
  for (const zeile of ergebnis.rows) {
    await statusNotieren(db, zeile.id, { von: 'leased', nach: zeile.status, grund: 'lease_abgelaufen', runner: zeile.owner });
  }
  return ergebnis.rows.map((zeile) => ({ id: zeile.id, ticketKey: zeile.ticket_key, status: zeile.status, attempt: zeile.attempt }));
}

/** Räumt in einer eigenen Transaktion auf (für den Koordinator). */
export async function aufraeumen(pool: pg.Pool, jetzt: Date): Promise<AufgeraeumterJob[]> {
  return (await inTransaktion(pool, async (client) => abgelaufeneAufraeumen(client, jetzt))) ?? [];
}

export interface Vergabe {
  readonly runner: string;
  /** Nur Jobs dieser Arten — etwa nur Reviews für den Review-Slot. */
  readonly arten: readonly JobArt[];
  readonly jetzt: Date;
}

/** Vergibt den nächsten passenden Job mit einer Lease, oder `undefined`, wenn keiner wartet. */
export async function jobVergeben(pool: pg.Pool, vergabe: Vergabe): Promise<PipelineJob | undefined> {
  const { runner, arten, jetzt } = vergabe;
  return inTransaktion(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(${VERGABE_SPERRE})`);
    await abgelaufeneAufraeumen(client, jetzt);
    const kandidat = await client.query<{ id: string }>(
      `SELECT j.id
         FROM cockpit.pipeline_job j
        WHERE j.status = 'queued'
          AND j.kind = ANY ($1::text[])
          AND NOT EXISTS (
                SELECT 1 FROM cockpit.pipeline_provider_state p
                 WHERE p.provider = j.provider
                   AND (p.state = 'disabled' OR (p.state = 'exhausted' AND (p.until IS NULL OR p.until > $2))))
          AND (j.kind NOT IN ('implement', 'rework') OR NOT EXISTS (
                SELECT 1 FROM cockpit.pipeline_job a
                 WHERE a.repo = j.repo AND a.status = 'leased' AND a.kind IN ('implement', 'rework')))
        ORDER BY (j.kind = 'rework') DESC, j.due_date ASC NULLS LAST, j.priority ASC, j.created_at ASC, j.id ASC
        LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      [arten, jetzt],
    );
    const id = kandidat.rows[0]?.id;
    if (id === undefined) {
      // Kein Job ist kein Fehler; das Aufräumen oben soll trotzdem gelten.
      return null;
    }
    const vergeben = await client.query<JobZeile>(
      `UPDATE cockpit.pipeline_job
          SET status = 'leased', lease_owner = $2, lease_until = $3, updated_at = $4
        WHERE id = $1
    RETURNING ${JOB_SPALTEN}`,
      [id, runner, new Date(jetzt.getTime() + LEASE_MS), jetzt],
    );
    await statusNotieren(client, id, { von: 'queued', nach: 'leased', grund: 'claim', runner });
    const zeile = vergeben.rows[0];
    return zeile === undefined ? undefined : jobAus(zeile);
  }).then((job) => job ?? undefined);
}

/**
 * Verlängert die Lease um `LEASE_MS` ab jetzt — nur für den Runner, der sie hält, und nur, solange der Job noch
 * geleast ist. Ein knapp verspäteter Heartbeat rettet die Lease, solange niemand aufgeräumt hat; danach ist sie weg.
 */
export async function leaseVerlaengern(
  pool: pg.Pool,
  anfrage: { readonly runner: string; readonly jobId: string; readonly jetzt: Date },
): Promise<Date | undefined> {
  const ergebnis = await pool.query<{ lease_until: Date }>(
    `UPDATE cockpit.pipeline_job
        SET lease_until = $3, updated_at = $4
      WHERE id = $1 AND status = 'leased' AND lease_owner = $2
  RETURNING lease_until`,
    [anfrage.jobId, anfrage.runner, new Date(anfrage.jetzt.getTime() + LEASE_MS), anfrage.jetzt],
  );
  return ergebnis.rows[0]?.lease_until;
}

export interface Ereignis {
  readonly runner: string;
  readonly jobId: string;
  readonly eventId: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** Speichert eine Meldung des Runners — eine schon gespeicherte `event_id` nicht noch einmal. */
export async function ereignisMelden(pool: pg.Pool, ereignis: Ereignis): Promise<'gespeichert' | 'doppelt' | 'job_unbekannt'> {
  const ergebnis = await pool.query<{ gespeichert: boolean; job_da: boolean }>(
    `WITH neu AS (
       INSERT INTO cockpit.pipeline_job_event (job_id, event_id, runner, type, data)
       SELECT id, $2, $3, $4, $5 FROM cockpit.pipeline_job WHERE id = $1
       ON CONFLICT (event_id) DO NOTHING
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM neu) AS gespeichert,
            EXISTS (SELECT 1 FROM cockpit.pipeline_job WHERE id = $1) AS job_da`,
    [ereignis.jobId, ereignis.eventId, ereignis.runner, ereignis.type, ereignis.data],
  );
  const zeile = ergebnis.rows[0];
  if (zeile?.job_da !== true) {
    return 'job_unbekannt';
  }
  return zeile.gespeichert ? 'gespeichert' : 'doppelt';
}

export type Ergebnis = 'done' | 'failed' | 'abandoned' | 'released' | 'quota';

export interface Verbrauch {
  readonly tool: string;
  readonly model?: string | undefined;
  readonly billing: 'abo' | 'api';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly costEurNotional?: number | undefined;
  readonly costEurReal?: number | undefined;
  readonly durationS?: number | undefined;
}

export interface Abschluss {
  readonly runner: string;
  readonly jobId: string;
  readonly ergebnis: Ergebnis;
  readonly result?: Record<string, unknown> | undefined;
  readonly usage: readonly Verbrauch[];
  /** Nur bei `quota`: bis wann der Anbieter erschöpft ist, falls das CLI es nennt. */
  readonly providerBis?: Date | undefined;
  readonly jetzt: Date;
}

export type AbschlussAntwort =
  | { readonly art: 'abgeschlossen'; readonly job: PipelineJob }
  /** Derselbe Abschluss noch einmal (Wiederholung nach Netzfehler): nichts geändert. */
  | { readonly art: 'wiederholt'; readonly job: PipelineJob }
  | { readonly art: 'job_unbekannt' }
  /** Die Lease gehört nicht (mehr) diesem Runner. */
  | { readonly art: 'lease_verloren' };

const ENDSTATUS: Readonly<Partial<Record<Ergebnis, JobStatus>>> = { done: 'done', failed: 'failed' };

async function verbrauchSchreiben(db: pg.ClientBase, job: Pick<PipelineJob, 'id' | 'ticketKey'>, usage: readonly Verbrauch[]): Promise<void> {
  for (const lauf of usage) {
    await db.query(
      `INSERT INTO cockpit.pipeline_usage
         (job_id, ticket_key, tool, model, billing, input_tokens, output_tokens, cache_tokens, cost_eur_notional, cost_eur_real, duration_s)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        job.id,
        job.ticketKey,
        lauf.tool,
        lauf.model ?? null,
        lauf.billing,
        lauf.inputTokens,
        lauf.outputTokens,
        lauf.cacheTokens,
        lauf.costEurNotional ?? null,
        lauf.costEurReal ?? null,
        lauf.durationS ?? null,
      ],
    );
  }
}

/** Der neue Status und die Felder, die ein Abschluss setzt. */
function abschlussZiel(job: PipelineJob, ergebnis: Ergebnis): { status: JobStatus; attempt: number; owner: string | null } {
  const ende = ENDSTATUS[ergebnis];
  if (ende !== undefined) {
    // Der Runner bleibt eingetragen: an ihm erkennt eine Wiederholung, dass es derselbe Abschluss ist.
    return { status: ende, attempt: job.attempt, owner: job.leaseOwner };
  }
  if (ergebnis === 'quota' || ergebnis === 'released') {
    return { status: 'queued', attempt: job.attempt, owner: null };
  }
  const attempt = job.attempt + 1;
  return { status: attempt > job.maxAttempts ? 'parked' : 'queued', attempt, owner: null };
}

/**
 * Schließt einen Job ab: `done` und `failed` sind endgültig, `abandoned` gibt ihn als Versuch zurück (Absturz),
 * `released` ohne Zählung (geordneter Neustart des Runners, JAC-767), `quota` ohne Zählung und markiert den Anbieter
 * als erschöpft. Verbrauch wird in derselben Transaktion gespeichert.
 */
export async function jobAbschliessen(pool: pg.Pool, abschluss: Abschluss): Promise<AbschlussAntwort> {
  const { runner, jobId, ergebnis, jetzt } = abschluss;
  const antwort = await inTransaktion<AbschlussAntwort>(pool, async (client) => {
    const gelesen = await client.query<JobZeile>(`SELECT ${JOB_SPALTEN} FROM cockpit.pipeline_job WHERE id = $1 FOR UPDATE`, [jobId]);
    const zeile = gelesen.rows[0];
    if (zeile === undefined) {
      return { art: 'job_unbekannt' };
    }
    const job = jobAus(zeile);
    if (job.status !== 'leased' || job.leaseOwner !== runner) {
      const wiederholt = ENDSTATUS[ergebnis] === job.status && job.leaseOwner === runner;
      return wiederholt ? { art: 'wiederholt', job } : { art: 'lease_verloren' };
    }

    const ziel = abschlussZiel(job, ergebnis);
    const aktualisiert = await client.query<JobZeile>(
      `UPDATE cockpit.pipeline_job
          SET status = $2, attempt = $3, lease_owner = $4, lease_until = NULL, updated_at = $5,
              result = COALESCE($6, result)
        WHERE id = $1
    RETURNING ${JOB_SPALTEN}`,
      [jobId, ziel.status, ziel.attempt, ziel.owner, jetzt, abschluss.result ?? null],
    );
    await statusNotieren(client, jobId, { von: 'leased', nach: ziel.status, grund: ergebnis, runner });
    await verbrauchSchreiben(client, job, abschluss.usage);
    if (ergebnis === 'quota') {
      await client.query(
        `INSERT INTO cockpit.pipeline_provider_state (provider, state, until, updated_at)
         VALUES ($1, 'exhausted', $2, $3)
         ON CONFLICT (provider) DO UPDATE SET state = 'exhausted', until = EXCLUDED.until, updated_at = EXCLUDED.updated_at`,
        [job.provider, abschluss.providerBis ?? new Date(jetzt.getTime() + ERSCHOEPFT_STANDARD_MS), jetzt],
      );
    }
    const neu = aktualisiert.rows[0];
    return neu === undefined ? undefined : { art: 'abgeschlossen', job: jobAus(neu) };
  });
  // `undefined` hieße: die Zeile verschwand zwischen Lesen und Schreiben — sie wird nie gelöscht, also unmöglich.
  return antwort ?? { art: 'job_unbekannt' };
}

export interface NeuerJob {
  readonly ticketKey: string;
  readonly repo: string;
  readonly kind: JobArt;
  readonly priority?: number | undefined;
  readonly dueDate?: string | undefined;
  readonly maxAttempts?: number | undefined;
  readonly payload?: Record<string, unknown> | undefined;
}

export type AnlageAntwort =
  | { readonly art: 'angelegt'; readonly job: PipelineJob }
  /** Derselbe Job (Ticket und Art) wartet schon oder läuft: das Polling des Koordinators legt ihn nicht doppelt an. */
  | { readonly art: 'vorhanden'; readonly job: PipelineJob }
  | { readonly art: 'repo_unbekannt' };

/** Legt einen Job an (Koordinator, nach der Ready-Prüfung). */
export async function jobAnlegen(pool: pg.Pool, neu: NeuerJob, jetzt: Date): Promise<AnlageAntwort> {
  const antwort = await inTransaktion<AnlageAntwort>(pool, async (client) => {
    const repo = await client.query('SELECT 1 FROM cockpit.pipeline_repo_config WHERE repo = $1', [neu.repo]);
    if (repo.rowCount === 0) {
      return { art: 'repo_unbekannt' };
    }
    const angelegt = await client.query<JobZeile>(
      `INSERT INTO cockpit.pipeline_job (ticket_key, repo, kind, priority, due_date, max_attempts, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (ticket_key, kind) WHERE status IN ('queued', 'leased') DO NOTHING
       RETURNING ${JOB_SPALTEN}`,
      [neu.ticketKey, neu.repo, neu.kind, neu.priority ?? 3, neu.dueDate ?? null, neu.maxAttempts ?? 2, neu.payload ?? {}, jetzt],
    );
    const zeile = angelegt.rows[0];
    if (zeile !== undefined) {
      await client.query(`INSERT INTO cockpit.pipeline_job_event (job_id, type, data) VALUES ($1, 'status', $2)`, [
        zeile.id,
        { von: null, nach: 'queued', grund: 'angelegt' },
      ]);
      return { art: 'angelegt', job: jobAus(zeile) };
    }
    const offen = await client.query<JobZeile>(
      `SELECT ${JOB_SPALTEN} FROM cockpit.pipeline_job WHERE ticket_key = $1 AND kind = $2 AND status IN ('queued', 'leased')`,
      [neu.ticketKey, neu.kind],
    );
    const vorhanden = offen.rows[0];
    return vorhanden === undefined ? undefined : { art: 'vorhanden', job: jobAus(vorhanden) };
  });
  // Ohne Ergebnis: der offene Job wurde genau zwischen Einfügen und Lesen abgeschlossen. Dann einfach neu versuchen.
  return antwort ?? jobAnlegen(pool, neu, jetzt);
}

export interface JobEreignis {
  readonly eventId: string | null;
  readonly runner: string | null;
  readonly ts: Date;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** Ein Job mit seinem Verlauf (älteste Ereignisse zuerst), oder `undefined`. */
export async function jobLesen(pool: pg.Pool, id: string): Promise<{ job: PipelineJob; ereignisse: JobEreignis[] } | undefined> {
  const gelesen = await pool.query<JobZeile>(`SELECT ${JOB_SPALTEN} FROM cockpit.pipeline_job WHERE id = $1`, [id]);
  const zeile = gelesen.rows[0];
  if (zeile === undefined) {
    return undefined;
  }
  const ereignisse = await pool.query<{ event_id: string | null; runner: string | null; ts: Date; type: string; data: Record<string, unknown> }>(
    'SELECT event_id, runner, ts, type, data FROM cockpit.pipeline_job_event WHERE job_id = $1 ORDER BY id',
    [id],
  );
  return {
    job: jobAus(zeile),
    ereignisse: ereignisse.rows.map((e) => ({ eventId: e.event_id, runner: e.runner, ts: e.ts, type: e.type, data: e.data })),
  };
}

/** Jobs für die Liste, neueste zuerst; Filter sind optional, `limit` begrenzt die Anzahl, `offset` überspringt die ersten. Ohne Verlauf. */
export async function jobsLesen(pool: pg.Pool, filter: { status?: JobStatus | undefined; ticketKey?: string | undefined; limit: number; offset?: number | undefined }): Promise<PipelineJob[]> {
  const bedingungen: string[] = [];
  const werte: unknown[] = [];
  if (filter.status !== undefined) {
    werte.push(filter.status);
    bedingungen.push(`status = $${werte.length}`);
  }
  if (filter.ticketKey !== undefined) {
    werte.push(filter.ticketKey);
    bedingungen.push(`ticket_key = $${werte.length}`);
  }
  werte.push(filter.limit);
  werte.push(filter.offset ?? 0);
  const gelesen = await pool.query<JobZeile>(
    `SELECT ${JOB_SPALTEN} FROM cockpit.pipeline_job${bedingungen.length === 0 ? '' : ` WHERE ${bedingungen.join(' AND ')}`}
     ORDER BY created_at DESC, id DESC LIMIT $${werte.length - 1} OFFSET $${werte.length}`,
    werte,
  );
  return gelesen.rows.map(jobAus);
}
