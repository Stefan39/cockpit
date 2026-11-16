/**
 * Offene Freigabe-Anfragen der Entwicklungspipeline (COPI-180, Teil von COPI-172): Nach einem sauberen Review meldet
 * der Runner `merge.approval_requested` (`data` = `{pr, pr_url, head_sha}`). Der Koordinator-Agent fragt ab, welche PRs auf Stefans
 * Freigabe warten, und markiert eine Anfrage als erledigt (`merge.erledigt`), sobald der PR gemergt oder geschlossen ist.
 *
 * Die Tabelle `pipeline_job_event` wird nur angehängt: „erledigt" ist ein weiteres Ereignis, nie ein UPDATE.
 */
import type pg from 'pg';

export const FREIGABE_GRUENDE = ['gemergt', 'geschlossen'] as const;
export type FreigabeGrund = (typeof FREIGABE_GRUENDE)[number];

export interface OffeneFreigabe {
  readonly jobId: string;
  readonly ticketKey: string;
  readonly repo: string;
  /** `payload.titel` des Jobs (so legt ihn `POST /intern/pipeline/jobs` an); leer oder fehlend: `null`. */
  readonly titel: string | null;
  readonly pr: unknown;
  readonly prUrl: unknown;
  readonly headSha: unknown;
  /** Die höchste `data.round` aus `review.clean` dieses Jobs, sonst `null`. */
  readonly runden: number | null;
  readonly angefragtAm: Date;
}

interface FreigabeZeile {
  job_id: string;
  ticket_key: string;
  repo: string;
  titel: string | null;
  data: Record<string, unknown>;
  runden: number | null;
  ts: Date;
}

/** Je Job die jüngste Anfrage, nach der kein `merge.erledigt` desselben Jobs kommt; älteste Anfrage zuerst. */
export async function offeneFreigaben(pool: pg.Pool): Promise<OffeneFreigabe[]> {
  const ergebnis = await pool.query<FreigabeZeile>(
    `SELECT a.job_id, j.ticket_key, j.repo, nullif(j.payload->>'titel', '') AS titel, a.data, a.ts,
            (SELECT max((r.data->>'round')::int)
               FROM cockpit.pipeline_job_event r
              WHERE r.job_id = a.job_id AND r.type = 'review.clean' AND r.data->>'round' ~ '^[0-9]{1,9}$') AS runden
       FROM cockpit.pipeline_job_event a
       JOIN cockpit.pipeline_job j ON j.id = a.job_id
      WHERE a.type = 'merge.approval_requested'
        AND a.id = (SELECT max(m.id) FROM cockpit.pipeline_job_event m WHERE m.job_id = a.job_id AND m.type = 'merge.approval_requested')
        AND NOT EXISTS (SELECT 1 FROM cockpit.pipeline_job_event e WHERE e.job_id = a.job_id AND e.type = 'merge.erledigt' AND e.id > a.id)
      ORDER BY a.ts, a.id`,
  );
  return ergebnis.rows.map((z) => ({
    jobId: z.job_id,
    ticketKey: z.ticket_key,
    repo: z.repo,
    titel: z.titel,
    pr: z.data.pr ?? null,
    prUrl: z.data.pr_url ?? null,
    headSha: z.data.head_sha ?? null,
    runden: z.runden,
    angefragtAm: z.ts,
  }));
}

export interface FreigabeErledigen {
  readonly jobId: string;
  readonly grund: FreigabeGrund;
  readonly jetzt: Date;
}

/**
 * Markiert die offene Anfrage eines Jobs als erledigt. Ohne offene Anfrage wird nichts geschrieben.
 * Prüfung und Einfügen laufen in einer Transaktion unter einer Zeilensperre auf dem Job: Gleichzeitige Aufrufe für
 * denselben Job werden hintereinander ausgeführt, der zweite sieht das neue Ereignis und meldet `nicht_offen`.
 */
export async function freigabeErledigen(pool: pg.Pool, erledigen: FreigabeErledigen): Promise<'erledigt' | 'nicht_offen' | 'job_unbekannt'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = await client.query('SELECT 1 FROM cockpit.pipeline_job WHERE id = $1 FOR UPDATE', [erledigen.jobId]);
    if (job.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'job_unbekannt';
    }
    const neu = await client.query(
      `INSERT INTO cockpit.pipeline_job_event (job_id, runner, ts, type, data)
       SELECT a.job_id, NULL, $3, 'merge.erledigt', jsonb_build_object('grund', $2::text)
         FROM cockpit.pipeline_job_event a
        WHERE a.job_id = $1 AND a.type = 'merge.approval_requested'
          AND a.id = (SELECT max(m.id) FROM cockpit.pipeline_job_event m WHERE m.job_id = a.job_id AND m.type = 'merge.approval_requested')
          AND NOT EXISTS (SELECT 1 FROM cockpit.pipeline_job_event e WHERE e.job_id = a.job_id AND e.type = 'merge.erledigt' AND e.id > a.id)`,
      [erledigen.jobId, erledigen.grund, erledigen.jetzt],
    );
    await client.query('COMMIT');
    return neu.rowCount === 0 ? 'nicht_offen' : 'erledigt';
  } catch (fehler) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw fehler;
  } finally {
    client.release();
  }
}
