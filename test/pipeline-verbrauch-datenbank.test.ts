/**
 * Der KI-Verbrauch je Ticket (COPI-182, JAC-768) gegen eine echte PostgreSQL: `ticketVerbrauch` summiert über alle
 * Jobs eines Tickets, `GET /intern/pipeline/verbrauch` gibt das an Koordinator.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { jobAnlegen } from '../src/pipeline/queue.js';
import { repoConfigPruefen, repoConfigSpeichern } from '../src/pipeline/repo-config.js';
import { ticketVerbrauch } from '../src/pipeline/verbrauch.js';
import { buildApp } from '../src/server/app.js';
import { testDatenbankUrl } from './testdatenbank.js';

const REPO = 'Stefan39/cockpit';
const JETZT = new Date('2026-10-17T08:00:00Z');

interface Lauf {
  tool: string;
  model?: string | null;
  input?: number;
  output?: number;
  cache?: number;
  notional?: number | null;
  real?: number | null;
  dauer?: number | null;
}

describe.skipIf(!testDatenbankUrl)('Pipeline-Verbrauch je Ticket (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let koordinator: string;

  async function leeren(): Promise<void> {
    await pool.query(
      'TRUNCATE cockpit.pipeline_usage, cockpit.pipeline_job_event, cockpit.pipeline_job, cockpit.pipeline_provider_state, cockpit.pipeline_repo_config',
    );
    await pool.query('DELETE FROM cockpit.api_token');
  }

  async function job(ticketKey: string, kind: 'implement' | 'rework' | 'review:codex', laeufe: readonly Lauf[]): Promise<void> {
    const angelegt = await jobAnlegen(pool, { ticketKey, repo: REPO, kind }, JETZT);
    if (angelegt.art === 'repo_unbekannt') {
      throw new Error('Repo fehlt');
    }
    for (const l of laeufe) {
      await pool.query(
        `INSERT INTO cockpit.pipeline_usage
           (job_id, ticket_key, tool, model, billing, input_tokens, output_tokens, cache_tokens, cost_eur_notional, cost_eur_real, duration_s)
         VALUES ($1, $2, $3, $4, 'abo', $5, $6, $7, $8, $9, $10)`,
        [angelegt.job.id, ticketKey, l.tool, l.model ?? null, l.input ?? 0, l.output ?? 0, l.cache ?? 0, l.notional ?? null, l.real ?? null, l.dauer ?? null],
      );
    }
  }

  async function lesen(abfrage: string, token = koordinator) {
    const antwort = await app.inject({ method: 'GET', url: `/intern/pipeline/verbrauch${abfrage}`, headers: { authorization: `Bearer ${token}` } });
    return { status: antwort.statusCode, json: antwort.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testDatenbankUrl });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT });
    await app.ready();
  });

  beforeEach(async () => {
    await leeren();
    const config = repoConfigPruefen(`repo: ${REPO}\nquelle: jira\njira_project: COPI\nprotected_paths: [".github/**"]\n`);
    if (!config.ok) {
      throw new Error(config.grund);
    }
    await repoConfigSpeichern(pool, config.wert, JETZT);
    koordinator = (await apiTokenAnlegen(pool, { name: 'koordinator-pipeline', scopes: ['pipeline_verwalten'] })).token;
    await job('COPI-1', 'implement', [
      { tool: 'claude-code', input: 1000, output: 200, cache: 50, notional: 1.5, dauer: 600 },
      { tool: 'claude-code', input: 500, output: 100, cache: 10, notional: 0.25, real: 0.1, dauer: 300 },
    ]);
    await job('COPI-1', 'rework', [{ tool: 'claude-code', input: 100, output: 20, cache: 5, dauer: 60 }]);
    await job('COPI-1', 'review:codex', [{ tool: 'codex', model: 'gpt-x', input: 700, output: 80, notional: 0.5 }]);
    await job('COPI-2', 'implement', [{ tool: 'claude-code', input: 9, output: 9, cache: 9, notional: 9 }]);
  });

  afterAll(async () => {
    await app.close();
    await leeren();
    await pool.end();
  });

  it('summiert alle Jobs eines Tickets je Werkzeug und gesamt', async () => {
    const verbrauch = await ticketVerbrauch(pool, 'COPI-1');
    expect(verbrauch.jobs).toBe(3);
    expect(verbrauch.gesamt).toEqual({
      laeufe: 4,
      inputTokens: 2300,
      outputTokens: 400,
      cacheTokens: 65,
      costEurNotional: 2.25,
      costEurReal: 0.1,
      durationS: 960,
    });
    expect(verbrauch.jeWerkzeug).toEqual([
      { tool: 'claude-code', model: null, laeufe: 3, inputTokens: 1600, outputTokens: 320, cacheTokens: 65, costEurNotional: 1.75, costEurReal: 0.1, durationS: 960 },
      { tool: 'codex', model: 'gpt-x', laeufe: 1, inputTokens: 700, outputTokens: 80, cacheTokens: 0, costEurNotional: 0.5, costEurReal: null, durationS: null },
    ]);
  });

  it('lässt Kosten null, wenn keine Zeile einen Wert hat', async () => {
    await job('COPI-3', 'implement', [{ tool: 'claude-code', input: 5 }]);
    const verbrauch = await ticketVerbrauch(pool, 'COPI-3');
    expect(verbrauch.gesamt).toMatchObject({ laeufe: 1, inputTokens: 5, costEurNotional: null, costEurReal: null, durationS: null });
    expect(verbrauch.jeWerkzeug).toHaveLength(1);
  });

  it('meldet ein Ticket ohne Zeilen als leer, nicht als Fehler', async () => {
    expect(await ticketVerbrauch(pool, 'COPI-99')).toEqual({
      ticketKey: 'COPI-99',
      jobs: 0,
      gesamt: { laeufe: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, costEurNotional: 0, costEurReal: 0, durationS: 0 },
      jeWerkzeug: [],
    });
  });

  describe('GET /intern/pipeline/verbrauch', () => {
    it('liefert die Summen in der Form der Agenten-API', async () => {
      const antwort = await lesen('?ticket=COPI-1');
      expect(antwort.status).toBe(200);
      expect(antwort.json).toMatchObject({
        ticket_key: 'COPI-1',
        jobs: 3,
        gesamt: { laeufe: 4, input_tokens: 2300, output_tokens: 400, cache_tokens: 65, cost_eur_notional: 2.25, cost_eur_real: 0.1, duration_s: 960 },
      });
      expect(antwort.json.je_werkzeug).toEqual([
        { tool: 'claude-code', model: null, laeufe: 3, input_tokens: 1600, output_tokens: 320, cache_tokens: 65, cost_eur_notional: 1.75, cost_eur_real: 0.1, duration_s: 960 },
        { tool: 'codex', model: 'gpt-x', laeufe: 1, input_tokens: 700, output_tokens: 80, cache_tokens: 0, cost_eur_notional: 0.5, cost_eur_real: null, duration_s: null },
      ]);
    });

    it('antwortet 200 mit leerer Liste für ein Ticket ohne Verbrauch', async () => {
      expect(await lesen('?ticket=COPI-99')).toMatchObject({ status: 200, json: { ticket_key: 'COPI-99', jobs: 0, gesamt: { laeufe: 0, cost_eur_notional: 0, cost_eur_real: 0, duration_s: 0 }, je_werkzeug: [] } });
    });

    it('verlangt ein gültiges ticket', async () => {
      expect(await lesen('')).toMatchObject({ status: 400, json: { felder: ['ticket'] } });
      expect((await lesen('?ticket=')).status).toBe(400);
      expect((await lesen(`?ticket=${'x'.repeat(201)}`)).status).toBe(400);
    });

    it('verlangt das Recht pipeline_verwalten', async () => {
      const fremd = (await apiTokenAnlegen(pool, { name: 'koordinator', scopes: ['zustand_lesen'] })).token;
      expect((await lesen('?ticket=COPI-1', fremd)).status).toBe(403);
    });
  });
});
