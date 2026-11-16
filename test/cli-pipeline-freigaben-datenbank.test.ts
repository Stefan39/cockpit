/**
 * Server-Kommando `pipeline-freigaben` (COPI-184) gegen eine echte PostgreSQL: offene Freigaben als Tabelle,
 * älteste Anfrage zuerst, Runden aus `review.clean`, nach `merge.erledigt` wieder leer. Der Befehl schreibt nichts.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { befehlLesen, cliAusfuehren, EXIT_BEDIENUNG, EXIT_ERLEDIGT } from '../src/cli/befehle.js';
import { jobAnlegen } from '../src/pipeline/queue.js';
import { repoConfigPruefen, repoConfigSpeichern } from '../src/pipeline/repo-config.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const JETZT = new Date('2026-10-16T08:00:00Z');
const REPO = 'Stefan39/cockpit';

describe('Server-Kommando: pipeline-freigaben (Bedienung)', () => {
  it('erkennt den Befehl und lehnt eine Option ab', () => {
    expect(befehlLesen(['pipeline-freigaben'])).toEqual({ befehl: 'pipeline-freigaben' });
    expect(befehlLesen(['pipeline-freigaben', '--repo', 'x'])).toHaveProperty('fehler');
  });
});

describe.skipIf(!datenbankUrl)('Server-Kommando: pipeline-freigaben (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function laufen(argumente: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await cliAusfuehren(argumente, {
      pool,
      basisUrl: 'http://localhost:3000',
      ausgabe: (zeile) => stdout.push(zeile),
      fehlerausgabe: (zeile) => stderr.push(zeile),
      eingabeLesen: () => Promise.resolve(''),
      jetzt: () => JETZT,
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  async function job(ticketKey: string): Promise<string> {
    const antwort = await jobAnlegen(pool, { ticketKey, repo: REPO, kind: 'implement' }, JETZT);
    if (antwort.art !== 'angelegt') {
      throw new Error(`nicht angelegt: ${antwort.art}`);
    }
    return antwort.job.id;
  }

  async function ereignis(jobId: string, type: string, data: Record<string, unknown>, minuten: number): Promise<void> {
    const ts = new Date(JETZT.getTime() + minuten * 60_000);
    await pool.query("INSERT INTO cockpit.pipeline_job_event (job_id, runner, ts, type, data) VALUES ($1, 'mini-pc', $2, $3, $4)", [jobId, ts, type, data]);
  }

  const anfrage = (pr: number): Record<string, unknown> => ({ pr, pr_url: `https://example.invalid/pr/${String(pr)}`, head_sha: `sha${String(pr)}` });

  beforeAll(() => {
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

  it('meldet ohne offene Freigaben eine Zeile', async () => {
    expect(await laufen(['pipeline-freigaben'])).toEqual({ code: EXIT_ERLEDIGT, stdout: 'keine offenen Freigaben', stderr: '' });
  });

  it('zeigt eine Freigabe mit Runden und lässt sie nach merge.erledigt verschwinden', async () => {
    const id = await job('COPI-184');
    await ereignis(id, 'review.clean', { round: 2 }, 1);
    await ereignis(id, 'merge.approval_requested', anfrage(205), 2);

    const lauf = await laufen(['pipeline-freigaben']);
    expect(lauf.code).toBe(EXIT_ERLEDIGT);
    expect(lauf.stdout.split('\n')).toEqual([
      'Ticket   Repo             PR   Runden angefragt                Titel',
      'COPI-184 Stefan39/cockpit #205 2      2026-10-16T08:02:00.000Z –',
    ]);

    await ereignis(id, 'merge.erledigt', { grund: 'gemergt' }, 3);
    expect((await laufen(['pipeline-freigaben'])).stdout).toBe('keine offenen Freigaben');
  });

  it('zeigt – ohne review.clean und ohne gültige PR-Nummer', async () => {
    const id = await job('COPI-185');
    await ereignis(id, 'merge.approval_requested', { pr: 'x' }, 1);

    const zeilen = (await laufen(['pipeline-freigaben'])).stdout.split('\n');
    expect(zeilen[1]).toBe('COPI-185 Stefan39/cockpit –  –      2026-10-16T08:01:00.000Z –');
  });

  async function jobMitTitel(ticketKey: string, titel: string): Promise<void> {
    const antwort = await jobAnlegen(pool, { ticketKey, repo: REPO, kind: 'implement', payload: { titel } }, JETZT);
    if (antwort.art !== 'angelegt') {
      throw new Error(`nicht angelegt: ${antwort.art}`);
    }
    await ereignis(antwort.job.id, 'merge.approval_requested', anfrage(210), 1);
  }

  it('zeigt den Titel als letzte Spalte ohne Leerzeichen am Zeilenende', async () => {
    await jobMitTitel('COPI-186', 'Kurzer Titel');

    const zeilen = (await laufen(['pipeline-freigaben'])).stdout.split('\n');
    expect(zeilen[1]).toBe('COPI-186 Stefan39/cockpit #210 –      2026-10-16T08:01:00.000Z Kurzer Titel');
  });

  it('kürzt einen Titel über 60 Zeichen mit …', async () => {
    await jobMitTitel('COPI-186', 'x'.repeat(61));

    const zeilen = (await laufen(['pipeline-freigaben'])).stdout.split('\n');
    expect(zeilen[1]?.endsWith(` ${'x'.repeat(59)}…`)).toBe(true);
  });

  it('lässt einen Titel mit genau 60 Zeichen unverändert', async () => {
    await jobMitTitel('COPI-186', 'y'.repeat(60));

    const zeilen = (await laufen(['pipeline-freigaben'])).stdout.split('\n');
    expect(zeilen[1]?.endsWith(` ${'y'.repeat(60)}`)).toBe(true);
  });

  it('ersetzt Zeilenumbrüche und Tabulatoren im Titel durch ein Leerzeichen', async () => {
    await jobMitTitel('COPI-186', 'Erste\nzweite\tdritte');

    const zeilen = (await laufen(['pipeline-freigaben'])).stdout.split('\n');
    expect(zeilen).toHaveLength(2);
    expect(zeilen[1]?.endsWith(' Erste zweite dritte')).toBe(true);
  });

  it('listet die älteste Anfrage zuerst', async () => {
    const spaet = await job('COPI-190');
    const frueh = await job('COPI-191');
    await ereignis(spaet, 'merge.approval_requested', anfrage(300), 10);
    await ereignis(frueh, 'merge.approval_requested', anfrage(301), 5);

    const zeilen = (await laufen(['pipeline-freigaben'])).stdout.split('\n');
    expect(zeilen).toHaveLength(3);
    expect(zeilen[1]).toContain('COPI-191');
    expect(zeilen[2]).toContain('COPI-190');
  });

  it('lehnt eine Option ab', async () => {
    expect((await laufen(['pipeline-freigaben', '--repo', 'x'])).code).toBe(EXIT_BEDIENUNG);
  });
});
