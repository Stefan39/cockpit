/**
 * `GET /intern/pipeline/jobs` (COPI-185) über HTTP gegen eine echte PostgreSQL: die Jobliste mit den Filtern
 * `status`, `ticket_key` und `limit`, ihre Sortierung, die Eingabeprüfung und das Recht `pipeline_verwalten`.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { repoConfigPruefen, repoConfigSpeichern } from '../src/pipeline/repo-config.js';
import { buildApp } from '../src/server/app.js';
import { testDatenbankUrl } from './testdatenbank.js';

const REPO = 'Stefan39/cockpit';

describe.skipIf(!testDatenbankUrl)('Pipeline: Jobliste (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let uhr: Date;
  let koordinator: string;

  async function leeren(): Promise<void> {
    await pool.query(
      'TRUNCATE cockpit.pipeline_usage, cockpit.pipeline_job_event, cockpit.pipeline_job, cockpit.pipeline_provider_state, cockpit.pipeline_repo_config',
    );
    await pool.query('DELETE FROM cockpit.api_token');
  }

  async function liste(abfrage = '', token = koordinator) {
    const antwort = await app.inject({
      method: 'GET',
      url: `/intern/pipeline/jobs${abfrage}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: antwort.statusCode, json: antwort.json() as { jobs?: { id: string; ticket_key: string; kind: string; status: string }[] } };
  }

  /** Legt einen Job an; jeder Aufruf liegt eine Minute nach dem vorigen. */
  async function jobAnlegen(ticketKey: string, kind = 'implement'): Promise<string> {
    uhr = new Date(uhr.getTime() + 60_000);
    const antwort = await app.inject({
      method: 'POST',
      url: '/intern/pipeline/jobs',
      headers: { authorization: `Bearer ${koordinator}` },
      payload: { ticket_key: ticketKey, repo: REPO, kind },
    });
    expect(antwort.statusCode).toBe(201);
    return String((antwort.json() as { job: { id: string } }).job.id);
  }

  async function status(id: string, neu: string): Promise<void> {
    await pool.query('UPDATE cockpit.pipeline_job SET status = $2 WHERE id = $1', [id, neu]);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testDatenbankUrl });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => uhr });
    await app.ready();
  });

  beforeEach(async () => {
    uhr = new Date('2026-10-16T08:00:00Z');
    await leeren();
    const config = repoConfigPruefen(`repo: ${REPO}\nquelle: jira\njira_project: COPI\nprotected_paths: [".github/**"]\n`);
    if (!config.ok) {
      throw new Error(config.grund);
    }
    await repoConfigSpeichern(pool, config.wert, uhr);
    koordinator = (await apiTokenAnlegen(pool, { name: 'koordinator-pipeline', scopes: ['pipeline_verwalten'] })).token;
  });

  afterAll(async () => {
    await app.close();
    await leeren();
    await pool.end();
  });

  it('liefert ohne Filter alle Jobs, neueste zuerst', async () => {
    const erster = await jobAnlegen('COPI-1');
    const zweiter = await jobAnlegen('COPI-2');
    const dritter = await jobAnlegen('COPI-3');
    const antwort = await liste();
    expect(antwort.status).toBe(200);
    expect(antwort.json.jobs?.map((j) => j.id)).toEqual([dritter, zweiter, erster]);
    expect(antwort.json.jobs?.[0]).toMatchObject({ ticket_key: 'COPI-3', kind: 'implement', status: 'queued' });
  });

  it('filtert nach status', async () => {
    const offen = await jobAnlegen('COPI-1');
    const geparkt = await jobAnlegen('COPI-2');
    await status(geparkt, 'parked');
    expect((await liste('?status=parked')).json.jobs?.map((j) => j.id)).toEqual([geparkt]);
    expect((await liste('?status=queued')).json.jobs?.map((j) => j.id)).toEqual([offen]);
  });

  it('filtert nach ticket_key', async () => {
    const a = await jobAnlegen('COPI-1');
    await jobAnlegen('COPI-2');
    const b = await jobAnlegen('COPI-1', 'review:codex');
    expect((await liste('?ticket_key=COPI-1')).json.jobs?.map((j) => j.id)).toEqual([b, a]);
  });

  it('kombiniert status und ticket_key', async () => {
    const a = await jobAnlegen('COPI-1');
    const b = await jobAnlegen('COPI-1', 'review:codex');
    const c = await jobAnlegen('COPI-2');
    await status(a, 'done');
    await status(c, 'done');
    expect((await liste('?status=done&ticket_key=COPI-1')).json.jobs?.map((j) => j.id)).toEqual([a]);
    expect((await liste('?status=queued&ticket_key=COPI-1')).json.jobs?.map((j) => j.id)).toEqual([b]);
  });

  it('begrenzt mit limit und nimmt sonst 50', async () => {
    for (let i = 1; i <= 51; i += 1) {
      await jobAnlegen(`COPI-${i}`);
    }
    expect((await liste()).json.jobs).toHaveLength(50);
    const zwei = await liste('?limit=2');
    expect(zwei.json.jobs?.map((j) => j.ticket_key)).toEqual(['COPI-51', 'COPI-50']);
    expect((await liste('?limit=200')).json.jobs).toHaveLength(51);
  });

  it('antwortet ohne Treffer mit einer leeren Liste', async () => {
    expect(await liste()).toEqual({ status: 200, json: { jobs: [] } });
    await jobAnlegen('COPI-1');
    expect(await liste('?ticket_key=COPI-9')).toEqual({ status: 200, json: { jobs: [] } });
  });

  it.each(['?status=erfunden', '?limit=0', '?limit=201', '?limit=abc', '?limit=1.5', '?ticket_key=', '?unbekannt=1'])(
    'weist %s mit 400 ab',
    async (abfrage) => {
      expect((await liste(abfrage)).status).toBe(400);
    },
  );

  it('verlangt das Recht pipeline_verwalten', async () => {
    const fremd = (await apiTokenAnlegen(pool, { name: 'koordinator', scopes: ['zustand_lesen'] })).token;
    expect((await liste('', fremd)).status).toBe(403);
  });
});
