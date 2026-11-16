/**
 * Offene Freigabe-Anfragen der Pipeline (COPI-180) gegen eine echte PostgreSQL: eine offene Anfrage, eine erledigte,
 * eine erneute Anfrage nach einer Nacharbeit (die jüngste zählt), `runden` aus `review.clean`, die Idempotenz von
 * `freigabeErledigen` und der unbekannte Job. Das Erledigen hängt nur ein Ereignis an.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freigabeErledigen, offeneFreigaben } from '../src/pipeline/freigaben.js';
import { jobAnlegen, jobLesen } from '../src/pipeline/queue.js';
import { repoConfigPruefen, repoConfigSpeichern } from '../src/pipeline/repo-config.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-10-16T08:00:00Z');
const REPO = 'Stefan39/cockpit';
const UNBEKANNT = '0b7a3c52-9d1e-4f7a-8c2b-5e6d7f8a9b0c';

function spaeter(minuten: number): Date {
  return new Date(JETZT.getTime() + minuten * 60_000);
}

describe.skipIf(!datenbankUrl)('Pipeline-Freigaben (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function anlegen(ticketKey: string): Promise<string> {
    const antwort = await jobAnlegen(pool, { ticketKey, repo: REPO, kind: 'implement' }, JETZT);
    if (antwort.art !== 'angelegt') {
      throw new Error(`nicht angelegt: ${antwort.art}`);
    }
    return antwort.job.id;
  }

  async function ereignis(jobId: string, type: string, data: Record<string, unknown>, ts: Date): Promise<void> {
    await pool.query("INSERT INTO cockpit.pipeline_job_event (job_id, runner, ts, type, data) VALUES ($1, 'mini-pc', $2, $3, $4)", [jobId, ts, type, data]);
  }

  async function anfragen(jobId: string, pr: number, ts: Date, headSha = `sha${pr}`): Promise<void> {
    await ereignis(jobId, 'merge.approval_requested', { pr, pr_url: `https://example.invalid/pr/${pr}`, head_sha: headSha }, ts);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE cockpit.pipeline_usage, cockpit.pipeline_job_event, cockpit.pipeline_job, cockpit.pipeline_provider_state, cockpit.pipeline_repo_config');
    const config = repoConfigPruefen(`repo: ${REPO}\nquelle: github\n`);
    if (!config.ok) {
      throw new Error(config.grund);
    }
    await repoConfigSpeichern(pool, config.wert, JETZT);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('liefert ohne Anfrage nichts', async () => {
    await anlegen('COPI-1');
    expect(await offeneFreigaben(pool)).toEqual([]);
  });

  it('liefert eine offene Anfrage mit den Daten des Ereignisses', async () => {
    const id = await anlegen('COPI-1');
    await anfragen(id, 7, spaeter(5), 'abc123');
    expect(await offeneFreigaben(pool)).toEqual([
      { jobId: id, ticketKey: 'COPI-1', repo: REPO, titel: null, pr: 7, prUrl: 'https://example.invalid/pr/7', headSha: 'abc123', runden: null, angefragtAm: spaeter(5) },
    ]);
  });

  it('nimmt den Titel aus dem Payload; leer oder fehlend ergibt null', async () => {
    const mit = await jobAnlegen(pool, { ticketKey: 'COPI-1', repo: REPO, kind: 'implement', payload: { titel: 'Ein <Titel>' } }, JETZT);
    const leer = await jobAnlegen(pool, { ticketKey: 'COPI-2', repo: REPO, kind: 'implement', payload: { titel: '' } }, JETZT);
    const ohne = await anlegen('COPI-3');
    for (const [antwort, nr] of [[mit, 1], [leer, 2]] as const) {
      if (antwort.art !== 'angelegt') {
        throw new Error('nicht angelegt');
      }
      await anfragen(antwort.job.id, nr, spaeter(nr));
    }
    await anfragen(ohne, 3, spaeter(3));
    expect((await offeneFreigaben(pool)).map((f) => f.titel)).toEqual(['Ein <Titel>', null, null]);
  });

  it('nennt die höchste Runde aus review.clean', async () => {
    const id = await anlegen('COPI-1');
    await ereignis(id, 'review.round_done', { round: 3 }, spaeter(1));
    await ereignis(id, 'review.clean', { round: 1 }, spaeter(2));
    await ereignis(id, 'review.clean', { round: 3 }, spaeter(3));
    await ereignis(id, 'review.clean', { round: 2 }, spaeter(4));
    await anfragen(id, 7, spaeter(5));
    expect((await offeneFreigaben(pool)).map((f) => f.runden)).toEqual([3]);
  });

  it('lässt eine erledigte Anfrage weg', async () => {
    const id = await anlegen('COPI-1');
    await anfragen(id, 7, spaeter(1));
    expect(await freigabeErledigen(pool, { jobId: id, grund: 'gemergt', jetzt: spaeter(2) })).toBe('erledigt');
    expect(await offeneFreigaben(pool)).toEqual([]);
  });

  it('zählt nach einer Nacharbeit die jüngste Anfrage', async () => {
    const id = await anlegen('COPI-1');
    await anfragen(id, 7, spaeter(1), 'alt');
    expect(await freigabeErledigen(pool, { jobId: id, grund: 'geschlossen', jetzt: spaeter(2) })).toBe('erledigt');
    await anfragen(id, 8, spaeter(3), 'neu');
    expect(await offeneFreigaben(pool)).toMatchObject([{ jobId: id, pr: 8, headSha: 'neu', angefragtAm: spaeter(3) }]);

    // Auch zwei Anfragen ohne Erledigung ergeben nur die jüngste.
    await anfragen(id, 9, spaeter(4), 'neuer');
    expect(await offeneFreigaben(pool)).toMatchObject([{ pr: 9, headSha: 'neuer' }]);
  });

  it('sortiert die älteste Anfrage zuerst', async () => {
    const a = await anlegen('COPI-1');
    const b = await anlegen('COPI-2');
    await anfragen(b, 2, spaeter(1));
    await anfragen(a, 1, spaeter(2));
    expect((await offeneFreigaben(pool)).map((f) => f.ticketKey)).toEqual(['COPI-2', 'COPI-1']);
  });

  it('schreibt beim Erledigen genau ein Ereignis und ist idempotent', async () => {
    const id = await anlegen('COPI-1');
    await anfragen(id, 7, spaeter(1));
    expect(await freigabeErledigen(pool, { jobId: id, grund: 'gemergt', jetzt: spaeter(2) })).toBe('erledigt');
    expect(await freigabeErledigen(pool, { jobId: id, grund: 'geschlossen', jetzt: spaeter(3) })).toBe('nicht_offen');

    const erledigt = (await jobLesen(pool, id))?.ereignisse.filter((e) => e.type === 'merge.erledigt');
    expect(erledigt).toEqual([{ eventId: null, runner: null, ts: spaeter(2), type: 'merge.erledigt', data: { grund: 'gemergt' } }]);
  });

  it('serialisiert parallele Aufrufe: genau ein neues Ereignis', async () => {
    const id = await anlegen('COPI-1');
    await anfragen(id, 7, spaeter(1));
    const antworten = await Promise.all(
      Array.from({ length: 8 }, () => freigabeErledigen(pool, { jobId: id, grund: 'gemergt', jetzt: spaeter(2) })),
    );
    expect(antworten.filter((a) => a === 'erledigt')).toHaveLength(1);
    expect(antworten.filter((a) => a === 'nicht_offen')).toHaveLength(7);
    expect((await jobLesen(pool, id))?.ereignisse.filter((e) => e.type === 'merge.erledigt')).toHaveLength(1);
  });

  it('meldet nicht_offen ohne Anfrage und schreibt nichts', async () => {
    const id = await anlegen('COPI-1');
    expect(await freigabeErledigen(pool, { jobId: id, grund: 'gemergt', jetzt: spaeter(1) })).toBe('nicht_offen');
    expect((await jobLesen(pool, id))?.ereignisse.some((e) => e.type === 'merge.erledigt')).toBe(false);
  });

  it('meldet einen unbekannten Job', async () => {
    expect(await freigabeErledigen(pool, { jobId: UNBEKANNT, grund: 'gemergt', jetzt: JETZT })).toBe('job_unbekannt');
  });
});
