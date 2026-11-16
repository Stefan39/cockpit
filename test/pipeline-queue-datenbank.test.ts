/**
 * Die Job-Queue der Entwicklungspipeline (COPI-145, JAC-757) gegen eine echte PostgreSQL: atomare Vergabe auch bei
 * gleichzeitigen `claim`s, Reihenfolge, ein Umsetzungsjob je Repo, erschöpfte Anbieter, abgelaufene Leases (zurück in
 * die Queue, nach `max_attempts` geparkt), Abschluss samt Wiederholung, Abo-Limit ohne Versuch, idempotente Ereignisse,
 * das unveränderliche Audit und die Sperrliste für Auto-Merge.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aufraeumen,
  ereignisMelden,
  JOB_ARTEN,
  jobAbschliessen,
  jobAnlegen,
  jobLesen,
  jobVergeben,
  LEASE_MS,
  leaseVerlaengern,
  type JobArt,
  type NeuerJob,
  type PipelineJob,
} from '../src/pipeline/queue.js';
import { repoConfigPruefen, repoConfigSpeichern, sperrlisteAusUmgebung } from '../src/pipeline/repo-config.js';
import { wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-10-16T08:00:00Z');
const REPO = 'Stefan39/cockpit';
const ANDERES_REPO = 'Stefan39/lexware-php-mcp';

function spaeter(ms: number): Date {
  return new Date(JETZT.getTime() + ms);
}

describe.skipIf(!datenbankUrl)('Pipeline-Queue (echte Datenbank)', () => {
  let pool: pg.Pool;
  /** Jeder neue Job ist eine Sekunde jünger als der vorige: das Alter entscheidet zuletzt. */
  let uhr = 0;

  async function leeren(): Promise<void> {
    await pool.query(
      'TRUNCATE cockpit.pipeline_usage, cockpit.pipeline_job_event, cockpit.pipeline_job, cockpit.pipeline_provider_state, cockpit.pipeline_repo_config',
    );
  }

  async function repoAnlegen(repo: string): Promise<void> {
    const config = repoConfigPruefen(`repo: ${repo}\nquelle: github\n`);
    if (!config.ok) {
      throw new Error(config.grund);
    }
    await repoConfigSpeichern(pool, config.wert, JETZT);
  }

  async function anlegen(ticketKey: string, kind: JobArt = 'implement', weiteres: Partial<NeuerJob> = {}): Promise<PipelineJob> {
    uhr += 1000;
    const antwort = await jobAnlegen(pool, { ticketKey, repo: REPO, kind, ...weiteres }, new Date(JETZT.getTime() - 3_600_000 + uhr));
    if (antwort.art !== 'angelegt') {
      throw new Error(`nicht angelegt: ${antwort.art}`);
    }
    return antwort.job;
  }

  async function vergeben(runner = 'mini-pc', jetzt = JETZT, arten: readonly JobArt[] = JOB_ARTEN): Promise<PipelineJob | undefined> {
    return jobVergeben(pool, { runner, arten, jetzt });
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl, max: 12 });
  });

  beforeEach(async () => {
    await leeren();
    uhr = 0;
    await repoAnlegen(REPO);
    await repoAnlegen(ANDERES_REPO);
  });

  afterAll(async () => {
    await leeren();
    await pool.end();
  });

  describe('Vergabe', () => {
    it('vergibt einen Job mit einer Lease von 15 Minuten und hält das im Verlauf fest', async () => {
      const job = await anlegen('COPI-1');
      const vergeben1 = await vergeben();

      expect(vergeben1).toMatchObject({ id: job.id, status: 'leased', leaseOwner: 'mini-pc', provider: 'claude' });
      expect(vergeben1?.leaseUntil?.toISOString()).toBe(spaeter(LEASE_MS).toISOString());
      expect(await vergeben()).toBeUndefined();

      const verlauf = await jobLesen(pool, job.id);
      expect(verlauf?.ereignisse.map((e) => e.data)).toEqual([
        { von: null, nach: 'queued', grund: 'angelegt' },
        { von: 'queued', nach: 'leased', grund: 'claim' },
      ]);
    });

    it('vergibt Nacharbeit vor allem anderen, dann nach Fälligkeit, Priorität und Alter', async () => {
      const ohneFaelligkeit = await anlegen('COPI-1', 'review:codex', { priority: 1 });
      const spaetFaellig = await anlegen('COPI-2', 'review:codex', { dueDate: '2026-10-20' });
      const frueherDringend = await anlegen('COPI-3', 'review:codex', { dueDate: '2026-10-16', priority: 1 });
      const frueher = await anlegen('COPI-4', 'review:codex', { dueDate: '2026-10-16', priority: 3 });
      const frueherJuenger = await anlegen('COPI-5', 'review:codex', { dueDate: '2026-10-16', priority: 3 });
      const nacharbeit = await anlegen('COPI-6', 'rework', { dueDate: '2026-12-31', priority: 5 });

      const reihenfolge: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const job = await vergeben();
        reihenfolge.push(job?.id ?? 'keiner');
      }
      expect(reihenfolge).toEqual([nacharbeit.id, frueherDringend.id, frueher.id, frueherJuenger.id, spaetFaellig.id, ohneFaelligkeit.id]);
    });

    it('vergibt nur die gewünschten Arten (etwa der Review-Slot)', async () => {
      await anlegen('COPI-1', 'implement');
      const review = await anlegen('COPI-1', 'review:gemini');

      expect((await vergeben('mini-pc', JETZT, ['review:codex', 'review:gemini', 'review:copilot']))?.id).toBe(review.id);
      expect(await vergeben('mini-pc', JETZT, ['review:codex'])).toBeUndefined();
    });

    it('gibt zwei gleichzeitigen claims nie denselben Job', async () => {
      for (let runde = 0; runde < 10; runde += 1) {
        await leeren();
        await repoAnlegen(REPO);
        const einziger = await anlegen(`COPI-${String(runde)}`, 'review:codex');

        const [a, b] = await Promise.all([vergeben('runner-a'), vergeben('runner-b')]);

        const erhalten = [a, b].filter((job) => job !== undefined);
        expect(erhalten).toHaveLength(1);
        expect(erhalten[0]?.id).toBe(einziger.id);
      }
    });

    it('verteilt viele gleichzeitige claims ohne Doppel und ohne Verlust', async () => {
      const jobs = [];
      for (let i = 0; i < 6; i += 1) {
        jobs.push(await anlegen(`COPI-${String(i)}`, 'review:codex'));
      }

      const ergebnisse = await Promise.all(Array.from({ length: 10 }, (_, i) => vergeben(`runner-${String(i)}`)));

      const ids = ergebnisse.flatMap((job) => (job === undefined ? [] : [job.id]));
      expect(ids).toHaveLength(6);
      expect(new Set(ids)).toEqual(new Set(jobs.map((job) => job.id)));
      const geleast = await pool.query<{ anzahl: string }>(`SELECT count(*) AS anzahl FROM cockpit.pipeline_job WHERE status = 'leased'`);
      expect(geleast.rows[0]?.anzahl).toBe('6');
    });

    it('vergibt höchstens einen Umsetzungsjob je Repo gleichzeitig — auch bei gleichzeitigen claims', async () => {
      await anlegen('COPI-1', 'implement');
      await anlegen('COPI-2', 'implement');
      await anlegen('COPI-3', 'rework');
      const review = await anlegen('COPI-4', 'review:codex');
      const fremd = await jobAnlegen(pool, { ticketKey: 'gh-12', repo: ANDERES_REPO, kind: 'implement' }, JETZT);

      const ergebnisse = await Promise.all([vergeben('a'), vergeben('b'), vergeben('c'), vergeben('d'), vergeben('e')]);

      const vergebeneArten = ergebnisse.flatMap((job) => (job === undefined ? [] : [`${job.repo} ${job.kind}`])).sort();
      expect(vergebeneArten).toEqual([`${REPO} review:codex`, `${REPO} rework`, `${ANDERES_REPO} implement`]);
      expect(ergebnisse.some((job) => job?.id === review.id)).toBe(true);
      expect(fremd.art).toBe('angelegt');
    });

    it('vergibt keine Jobs eines erschöpften oder abgeschalteten Anbieters, Reviews anderer Anbieter schon', async () => {
      await anlegen('COPI-1', 'implement');
      const review = await anlegen('COPI-2', 'review:codex');
      await pool.query(`INSERT INTO cockpit.pipeline_provider_state (provider, state, until) VALUES ('claude', 'exhausted', $1)`, [spaeter(10 * 60_000)]);

      expect((await vergeben())?.id).toBe(review.id);
      expect(await vergeben()).toBeUndefined();
      // Nach der Reset-Zeit gibt es wieder Umsetzungsjobs (die Lease des Reviews läuft noch).
      expect((await vergeben('mini-pc', spaeter(11 * 60_000)))?.kind).toBe('implement');

      await anlegen('COPI-3', 'review:gemini');
      await pool.query(`INSERT INTO cockpit.pipeline_provider_state (provider, state) VALUES ('gemini', 'disabled')`);
      expect(await vergeben('mini-pc', spaeter(11 * 60_000))).toBeUndefined();
    });
  });

  describe('Leases', () => {
    it('verlängert die Lease nur für den Runner, der sie hält', async () => {
      const job = await anlegen('COPI-1');
      await vergeben('mini-pc');

      const bis = await leaseVerlaengern(pool, { runner: 'mini-pc', jobId: job.id, jetzt: spaeter(10 * 60_000) });
      expect(bis?.toISOString()).toBe(spaeter(10 * 60_000 + LEASE_MS).toISOString());
      expect(await leaseVerlaengern(pool, { runner: 'fremder', jobId: job.id, jetzt: spaeter(10 * 60_000) })).toBeUndefined();
    });

    it('gibt eine abgelaufene Lease beim nächsten claim zurück in die Queue und vergibt sie neu', async () => {
      const job = await anlegen('COPI-1');
      await vergeben('runner-a');

      // Noch nicht abgelaufen: nichts zu holen.
      expect(await vergeben('runner-b', spaeter(LEASE_MS - 1000))).toBeUndefined();

      const neu = await vergeben('runner-b', spaeter(LEASE_MS + 1000));
      expect(neu).toMatchObject({ id: job.id, status: 'leased', leaseOwner: 'runner-b', attempt: 1 });
      // Der alte Runner hält sie nicht mehr.
      expect(await leaseVerlaengern(pool, { runner: 'runner-a', jobId: job.id, jetzt: spaeter(LEASE_MS + 2000) })).toBeUndefined();

      const verlauf = await jobLesen(pool, job.id);
      expect(verlauf?.ereignisse.map((e) => [e.runner, e.data.grund])).toEqual([
        [null, 'angelegt'],
        ['runner-a', 'claim'],
        ['runner-a', 'lease_abgelaufen'],
        ['runner-b', 'claim'],
      ]);
    });

    it('parkt einen Job nach mehr als max_attempts abgelaufenen Leases', async () => {
      const job = await anlegen('COPI-1', 'implement', { maxAttempts: 1 });
      await vergeben('a');
      await vergeben('a', spaeter(LEASE_MS + 1000));

      const aufgeraeumt = await aufraeumen(pool, spaeter(2 * LEASE_MS + 2000));

      expect(aufgeraeumt).toEqual([{ id: job.id, ticketKey: 'COPI-1', status: 'parked', attempt: 2 }]);
      expect((await jobLesen(pool, job.id))?.job).toMatchObject({ status: 'parked', leaseOwner: null, leaseUntil: null });
      expect(await vergeben('a', spaeter(3 * LEASE_MS))).toBeUndefined();
    });

    it('räumt nichts auf, solange keine Lease abgelaufen ist', async () => {
      await anlegen('COPI-1');
      await vergeben();
      expect(await aufraeumen(pool, spaeter(LEASE_MS))).toEqual([]);
    });
  });

  describe('Abschluss', () => {
    it('schließt einen Job ab, speichert Ergebnis und Verbrauch und nimmt eine Wiederholung ohne Änderung an', async () => {
      const job = await anlegen('COPI-1');
      await vergeben('mini-pc');
      const abschluss = {
        runner: 'mini-pc',
        jobId: job.id,
        ergebnis: 'done' as const,
        result: { pr: 'https://github.com/Stefan39/cockpit/pull/170' },
        usage: [{ tool: 'claude-code', model: 'claude-opus-5-5', billing: 'abo' as const, inputTokens: 1200, outputTokens: 300, cacheTokens: 5000, costEurNotional: 1.25, durationS: 900 }],
        jetzt: spaeter(20 * 60_000),
      };

      const erst = await jobAbschliessen(pool, abschluss);
      const nochmal = await jobAbschliessen(pool, abschluss);

      expect(erst).toMatchObject({ art: 'abgeschlossen', job: { status: 'done', result: abschluss.result } });
      expect(nochmal.art).toBe('wiederholt');
      const verbrauch = await pool.query('SELECT ticket_key, tool, billing, input_tokens, cost_eur_notional FROM cockpit.pipeline_usage');
      expect(verbrauch.rows).toEqual([{ ticket_key: 'COPI-1', tool: 'claude-code', billing: 'abo', input_tokens: '1200', cost_eur_notional: '1.250000' }]);
    });

    it('lehnt den Abschluss eines fremden, verlorenen oder unbekannten Jobs ab', async () => {
      const job = await anlegen('COPI-1');
      await vergeben('runner-a');
      const basis = { ergebnis: 'done' as const, usage: [], jetzt: JETZT };

      expect((await jobAbschliessen(pool, { ...basis, runner: 'runner-b', jobId: job.id })).art).toBe('lease_verloren');
      expect((await jobAbschliessen(pool, { ...basis, runner: 'runner-a', jobId: '00000000-0000-4000-8000-000000000000' })).art).toBe('job_unbekannt');

      await vergeben('runner-b', spaeter(LEASE_MS + 1000));
      expect((await jobAbschliessen(pool, { ...basis, runner: 'runner-a', jobId: job.id })).art).toBe('lease_verloren');
    });

    it('zählt ein Abo-Limit nicht als Versuch und markiert den Anbieter als erschöpft', async () => {
      const job = await anlegen('COPI-1', 'implement', { maxAttempts: 0 });
      const review = await anlegen('COPI-2', 'review:codex');
      await vergeben('mini-pc', JETZT, ['implement']);

      const antwort = await jobAbschliessen(pool, { runner: 'mini-pc', jobId: job.id, ergebnis: 'quota', usage: [], providerBis: spaeter(2 * 3_600_000), jetzt: JETZT });

      expect(antwort).toMatchObject({ art: 'abgeschlossen', job: { status: 'queued', attempt: 0, leaseOwner: null } });
      const anbieter = await pool.query<{ state: string; until: Date }>(`SELECT state, until FROM cockpit.pipeline_provider_state WHERE provider = 'claude'`);
      expect(anbieter.rows[0]).toEqual({ state: 'exhausted', until: spaeter(2 * 3_600_000) });
      expect((await vergeben())?.id).toBe(review.id);
      expect(await vergeben()).toBeUndefined();
      expect((await vergeben('mini-pc', spaeter(2 * 3_600_000 + 1000)))?.id).toBe(job.id);
    });

    it('nimmt ein Abo-Limit ohne Reset-Zeit für eine Stunde an', async () => {
      const job = await anlegen('COPI-1');
      await vergeben();
      await jobAbschliessen(pool, { runner: 'mini-pc', jobId: job.id, ergebnis: 'quota', usage: [], jetzt: JETZT });

      const anbieter = await pool.query<{ until: Date }>(`SELECT until FROM cockpit.pipeline_provider_state WHERE provider = 'claude'`);
      expect(anbieter.rows[0]?.until).toEqual(spaeter(3_600_000));
    });

    it('zählt einen aufgegebenen Job als Versuch und parkt ihn nach max_attempts', async () => {
      const job = await anlegen('COPI-1', 'implement', { maxAttempts: 1 });
      await vergeben();
      expect(await jobAbschliessen(pool, { runner: 'mini-pc', jobId: job.id, ergebnis: 'abandoned', usage: [], jetzt: JETZT })).toMatchObject({
        job: { status: 'queued', attempt: 1 },
      });
      await vergeben();
      expect(await jobAbschliessen(pool, { runner: 'mini-pc', jobId: job.id, ergebnis: 'abandoned', usage: [], jetzt: JETZT })).toMatchObject({
        job: { status: 'parked', attempt: 2 },
      });
    });

    it('gibt einen beim geordneten Neustart zurückgegebenen Job ohne Versuch zurück (JAC-767)', async () => {
      const job = await anlegen('COPI-1', 'implement', { maxAttempts: 1 });
      for (let runde = 0; runde < 3; runde++) {
        await vergeben();
        expect(await jobAbschliessen(pool, { runner: 'mini-pc', jobId: job.id, ergebnis: 'released', usage: [], jetzt: JETZT })).toMatchObject({
          art: 'abgeschlossen',
          job: { status: 'queued', attempt: 0, leaseOwner: null },
        });
      }
      const anbieter = await pool.query(`SELECT 1 FROM cockpit.pipeline_provider_state WHERE state = 'exhausted'`);
      expect(anbieter.rowCount).toBe(0);
    });

    it('gibt nach einem fertigen Umsetzungsjob das Repo für den nächsten frei', async () => {
      const erster = await anlegen('COPI-1');
      const zweiter = await anlegen('COPI-2');
      await vergeben();
      expect(await vergeben()).toBeUndefined();

      await jobAbschliessen(pool, { runner: 'mini-pc', jobId: erster.id, ergebnis: 'failed', usage: [], jetzt: JETZT });

      expect((await vergeben())?.id).toBe(zweiter.id);
    });
  });

  describe('Ereignisse', () => {
    it('speichert eine doppelt gesendete Meldung nur einmal', async () => {
      const job = await anlegen('COPI-1');
      const ereignis = { runner: 'mini-pc', jobId: job.id, eventId: '6f1c2a3e-1b2c-4d5e-8f90-123456789abc', type: 'pr_opened', data: { pr: 170 } };

      expect(await ereignisMelden(pool, ereignis)).toBe('gespeichert');
      expect(await ereignisMelden(pool, ereignis)).toBe('doppelt');
      expect(await ereignisMelden(pool, { ...ereignis, jobId: '00000000-0000-4000-8000-000000000000' })).toBe('job_unbekannt');

      const gespeichert = await pool.query(`SELECT runner, type, data FROM cockpit.pipeline_job_event WHERE event_id IS NOT NULL`);
      expect(gespeichert.rows).toEqual([{ runner: 'mini-pc', type: 'pr_opened', data: { pr: 170 } }]);
    });

    it('lässt das Audit und den Verbrauch nicht ändern und nichts löschen', async () => {
      const job = await anlegen('COPI-1');
      await vergeben();
      await jobAbschliessen(pool, { runner: 'mini-pc', jobId: job.id, ergebnis: 'done', usage: [{ tool: 'codex', billing: 'abo', inputTokens: 1, outputTokens: 1, cacheTokens: 0 }], jetzt: JETZT });

      await expect(wieImBetrieb(pool, `UPDATE cockpit.pipeline_job_event SET type = 'anders'`)).rejects.toThrow(/pipeline_unveraenderlich/);
      await expect(wieImBetrieb(pool, `UPDATE cockpit.pipeline_usage SET input_tokens = 0`)).rejects.toThrow(/pipeline_unveraenderlich/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.pipeline_job_event')).rejects.toThrow(/nie_loeschen/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.pipeline_job')).rejects.toThrow(/nie_loeschen/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.pipeline_repo_config')).rejects.toThrow(/nie_loeschen/);
    });
  });

  describe('Anlegen', () => {
    it('legt einen offenen Job nicht doppelt an, nach seinem Abschluss aber neu', async () => {
      const erster = await anlegen('COPI-1');
      const doppelt = await jobAnlegen(pool, { ticketKey: 'COPI-1', repo: REPO, kind: 'implement' }, JETZT);
      expect(doppelt).toMatchObject({ art: 'vorhanden', job: { id: erster.id } });

      await vergeben();
      await jobAbschliessen(pool, { runner: 'mini-pc', jobId: erster.id, ergebnis: 'done', usage: [], jetzt: JETZT });

      const neu = await jobAnlegen(pool, { ticketKey: 'COPI-1', repo: REPO, kind: 'implement' }, JETZT);
      expect(neu.art).toBe('angelegt');
    });

    it('verlangt ein eingerichtetes Repo', async () => {
      expect(await jobAnlegen(pool, { ticketKey: 'X-1', repo: 'Stefan39/unbekannt', kind: 'implement' }, JETZT)).toEqual({ art: 'repo_unbekannt' });
    });
  });

  describe('Sperrliste', () => {
    it('weist auto_merge für Repos der Sperrliste ab, für andere nicht', () => {
      const sperrliste = ['acme/web'];
      const gelesen = repoConfigPruefen('repo: Acme/Web\nquelle: jira\njira_project: WEB\nauto_merge: true\n', sperrliste);
      expect(gelesen).toEqual({ ok: false, grund: 'auto_merge: Dieses Repo steht auf der Sperrliste: auto_merge ist dort nie erlaubt.' });
      // Ohne Auto-Merge darf das Repo in die Pipeline (Phase 0: Stefan merged).
      expect(repoConfigPruefen('repo: Acme/Web\nquelle: jira\njira_project: WEB\n', sperrliste).ok).toBe(true);
      expect(repoConfigPruefen('repo: Acme/Api\nquelle: github\nauto_merge: true\n', sperrliste).ok).toBe(true);
    });

    it('liest die Sperrliste aus der Umgebung, kommagetrennt und klein geschrieben', () => {
      expect(sperrlisteAusUmgebung({})).toEqual([]);
      expect(sperrlisteAusUmgebung({ COCKPIT_AUTO_MERGE_SPERRLISTE: ' Acme/Web, ,acme/API ' })).toEqual(['acme/web', 'acme/api']);
    });

    it('hat in der Datenbank keine feste Sperrbedingung mehr', async () => {
      const bedingung = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_repo_sperrliste'`);
      expect(bedingung.rowCount).toBe(0);
    });

    it('verlangt bei Jira ein Projekt, bei GitHub nicht', () => {
      expect(repoConfigPruefen('repo: Stefan39/cockpit\nquelle: jira\n')).toEqual({ ok: false, grund: 'jira_project: Bei quelle: jira ist jira_project Pflicht.' });
      expect(repoConfigPruefen('repo: Stefan39/MiteBundle\nquelle: github\n').ok).toBe(true);
      expect(repoConfigPruefen('repo: kein-repo\nquelle: github\nunbekannt: 1\n')).toEqual({ ok: false, grund: 'repo: ungültig\n(Eingabe): ungültig' });
      expect(repoConfigPruefen(': : :')).toEqual({ ok: false, grund: 'Die Eingabe ist kein gültiges YAML.' });
    });
  });
});
