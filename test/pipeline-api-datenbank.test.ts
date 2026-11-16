/**
 * Die Pipeline-API (COPI-145, JAC-757) über HTTP gegen eine echte PostgreSQL:
 *
 *   * `/pipeline/*` für den Runner — HMAC über den rohen Rumpf mit Zeitstempel: falsche Signatur, alter oder künftiger
 *     Zeitstempel, fehlende Kopfzeilen, fehlender Rumpf und ein nicht eingerichtetes Geheimnis ergeben 401; danach
 *     `claim`, `heartbeat`, `event` (idempotent über `event_id`) und `complete` samt ihren Fehlerantworten.
 *   * `/intern/pipeline/*` für Koordinator — Bearer-Token mit Recht `pipeline_verwalten`: Jobs anlegen, lesen, aufräumen.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { LEASE_MS } from '../src/pipeline/queue.js';
import { repoConfigPruefen, repoConfigSpeichern } from '../src/pipeline/repo-config.js';
import { SIGNATUR_KOPF, signaturKopfzeilen, ZEITPUNKT_KOPF } from '../src/pipeline/signatur.js';
import { buildApp } from '../src/server/app.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const GEHEIMNIS = 'ein-gemeinsames-geheimnis-mit-mindestens-32-zeichen';
const REPO = 'Stefan39/cockpit';
const EVENT_ID = '0b7a3c52-9d1e-4f7a-8c2b-5e6d7f8a9b0c';

describe.skipIf(!datenbankUrl)('Pipeline-API (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let ohneGeheimnis: FastifyInstance;
  let uhr: Date;
  let koordinator: string;

  async function leeren(): Promise<void> {
    await pool.query(
      'TRUNCATE cockpit.pipeline_usage, cockpit.pipeline_job_event, cockpit.pipeline_job, cockpit.pipeline_provider_state, cockpit.pipeline_repo_config',
    );
    await pool.query('DELETE FROM cockpit.api_token');
  }

  /** Eine signierte Anfrage an `/pipeline/<pfad>`; `kopf` überschreibt die Kopfzeilen. */
  async function runner(pfad: string, rumpf: unknown, optionen: { kopf?: Record<string, string>; an?: FastifyInstance; signiertAm?: Date } = {}) {
    const text = JSON.stringify(rumpf);
    const antwort = await (optionen.an ?? app).inject({
      method: 'POST',
      url: `/pipeline/${pfad}`,
      headers: { 'content-type': 'application/json', ...signaturKopfzeilen(GEHEIMNIS, text, optionen.signiertAm ?? uhr), ...optionen.kopf },
      payload: text,
    });
    return { status: antwort.statusCode, json: antwort.json() as Record<string, unknown>, headers: antwort.headers };
  }

  async function intern(methode: 'GET' | 'POST', pfad: string, rumpf?: unknown, token = koordinator) {
    const antwort = await app.inject({
      method: methode,
      url: `/intern/pipeline/${pfad}`,
      headers: { authorization: `Bearer ${token}` },
      ...(rumpf === undefined ? {} : { payload: rumpf as object }),
    });
    return { status: antwort.statusCode, json: antwort.json() as Record<string, unknown> };
  }

  async function jobAnlegen(ticketKey = 'COPI-145', kind = 'implement'): Promise<string> {
    const antwort = await intern('POST', 'jobs', { ticket_key: ticketKey, repo: REPO, kind, due_date: '2026-10-16', payload: { titel: 'Pipeline-Queue' } });
    expect(antwort.status).toBe(201);
    return String((antwort.json.job as { id: string }).id);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => uhr, pipeline: { geheimnis: GEHEIMNIS } });
    ohneGeheimnis = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => uhr });
    await Promise.all([app.ready(), ohneGeheimnis.ready()]);
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
    await Promise.all([app.close(), ohneGeheimnis.close()]);
    await leeren();
    await pool.end();
  });

  describe('Anmeldung des Runners', () => {
    function erwarteNichtAngemeldet(antwort: { status: number; json: Record<string, unknown>; headers: Record<string, unknown> }): void {
      expect(antwort.status).toBe(401);
      expect(antwort.json).toEqual({ fehler: 'nicht_angemeldet' });
      expect(antwort.headers['www-authenticate']).toBe('HMAC-SHA256');
      expect(antwort.headers['cache-control']).toBe('no-store');
    }

    it('lässt eine richtig signierte Anfrage durch', async () => {
      const antwort = await runner('claim', { runner: 'mini-pc' });
      expect(antwort).toMatchObject({ status: 200, json: { job: null } });
      expect(antwort.headers['cache-control']).toBe('no-store');
    });

    it('weist eine falsche Signatur ab', async () => {
      const falsch = signaturKopfzeilen('ein-anderes-geheimnis-mit-mindestens-32-zeichen', JSON.stringify({ runner: 'mini-pc' }), uhr);
      erwarteNichtAngemeldet(await runner('claim', { runner: 'mini-pc' }, { kopf: falsch }));
    });

    it('weist einen veränderten Rumpf ab: die Signatur gilt für genau die gesendeten Zeichen', async () => {
      const kopf = signaturKopfzeilen(GEHEIMNIS, JSON.stringify({ runner: 'mini-pc' }), uhr);
      erwarteNichtAngemeldet(await runner('claim', { runner: 'mini-pd' }, { kopf }));
    });

    it('weist einen Zeitstempel außerhalb von fünf Minuten ab, in beide Richtungen', async () => {
      erwarteNichtAngemeldet(await runner('claim', { runner: 'mini-pc' }, { signiertAm: new Date(uhr.getTime() - 301_000) }));
      erwarteNichtAngemeldet(await runner('claim', { runner: 'mini-pc' }, { signiertAm: new Date(uhr.getTime() + 301_000) }));
      expect((await runner('claim', { runner: 'mini-pc' }, { signiertAm: new Date(uhr.getTime() - 299_000) })).status).toBe(200);
    });

    it('weist fehlende oder kaputte Kopfzeilen ab', async () => {
      erwarteNichtAngemeldet(await runner('claim', { runner: 'mini-pc' }, { kopf: { [SIGNATUR_KOPF]: 'sha256=xyz' } }));
      erwarteNichtAngemeldet(await runner('claim', { runner: 'mini-pc' }, { kopf: { [ZEITPUNKT_KOPF]: 'gestern' } }));
      const ohne = await app.inject({ method: 'POST', url: '/pipeline/claim', headers: { 'content-type': 'application/json' }, payload: '{"runner":"mini-pc"}' });
      expect(ohne.statusCode).toBe(401);
    });

    it('weist eine Anfrage ohne Rumpf ab, auch mit gültigen Kopfzeilen', async () => {
      const antwort = await app.inject({ method: 'POST', url: '/pipeline/claim', headers: signaturKopfzeilen(GEHEIMNIS, '', uhr) });
      expect(antwort.statusCode).toBe(401);
    });

    it('nimmt ohne eingerichtetes Geheimnis nichts an', async () => {
      erwarteNichtAngemeldet(await runner('claim', { runner: 'mini-pc' }, { an: ohneGeheimnis }));
    });

    it('verlangt die Signatur auch für einen Pfad, den es nicht gibt', async () => {
      erwarteNichtAngemeldet(await runner('gibt-es-nicht', {}, { kopf: { [SIGNATUR_KOPF]: `sha256=${'0'.repeat(64)}` } }));
      expect((await runner('gibt-es-nicht', {})).status).toBe(404);
    });

    it('nimmt nur JSON an', async () => {
      const text = 'runner=mini-pc';
      const antwort = await app.inject({
        method: 'POST',
        url: '/pipeline/claim',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...signaturKopfzeilen(GEHEIMNIS, text, uhr) },
        payload: text,
      });
      expect(antwort.statusCode).toBe(415);
    });
  });

  describe('Ablauf eines Jobs', () => {
    it('führt einen Job von claim über heartbeat und event bis complete', async () => {
      const id = await jobAnlegen();

      const claim = await runner('claim', { runner: 'mini-pc', arten: ['implement', 'rework'] });
      expect(claim.status).toBe(200);
      expect(claim.json).toMatchObject({
        job: { id, ticket_key: 'COPI-145', repo: REPO, kind: 'implement', status: 'leased', due_date: '2026-10-16', payload: { titel: 'Pipeline-Queue' } },
        repo_config: { quelle: 'jira', jira_project: 'COPI', base_branch: 'main', auto_merge: false, phase: 0, reviewers: ['codex'], protected_paths: ['.github/**'] },
      });

      uhr = new Date(uhr.getTime() + 60_000);
      const heartbeat = await runner('heartbeat', { runner: 'mini-pc', job_id: id });
      expect(heartbeat).toMatchObject({ status: 200, json: { lease_until: new Date(uhr.getTime() + LEASE_MS).toISOString() } });

      const ereignis = { runner: 'mini-pc', job_id: id, event_id: EVENT_ID, type: 'job.pr_opened', data: { pr: 170 } };
      expect(await runner('event', ereignis)).toMatchObject({ status: 201, json: { gespeichert: true } });
      expect(await runner('event', ereignis)).toMatchObject({ status: 200, json: { gespeichert: false } });

      const abschluss = {
        runner: 'mini-pc',
        job_id: id,
        ergebnis: 'done',
        result: { pr: 170 },
        usage: [{ tool: 'claude-code', model: 'claude-opus-5-5', billing: 'abo', input_tokens: 100, output_tokens: 20, cost_eur_notional: 0.5 }],
      };
      expect(await runner('complete', abschluss)).toMatchObject({ status: 200, json: { status: 'done', attempt: 0, wiederholt: false } });
      expect(await runner('complete', abschluss)).toMatchObject({ status: 200, json: { status: 'done', wiederholt: true } });

      const gelesen = await intern('GET', `jobs/${id}`);
      expect(gelesen.status).toBe(200);
      expect(gelesen.json.job).toMatchObject({ status: 'done', result: { pr: 170 }, lease_until: null });
      expect((gelesen.json.ereignisse as { type: string }[]).map((e) => e.type)).toEqual(['status', 'status', 'job.pr_opened', 'status']);
      const verbrauch = await pool.query('SELECT count(*)::int AS anzahl FROM cockpit.pipeline_usage');
      expect(verbrauch.rows[0]).toEqual({ anzahl: 1 });
    });

    it('antwortet 409, wenn die Lease nicht (mehr) dem Runner gehört', async () => {
      const id = await jobAnlegen();
      await runner('claim', { runner: 'mini-pc' });

      expect(await runner('heartbeat', { runner: 'anderer', job_id: id })).toMatchObject({ status: 409, json: { fehler: 'lease_verloren' } });
      expect(await runner('complete', { runner: 'anderer', job_id: id, ergebnis: 'done' })).toMatchObject({ status: 409, json: { fehler: 'lease_verloren' } });
    });

    it('antwortet 404 für einen unbekannten Job', async () => {
      const unbekannt = '00000000-0000-4000-8000-000000000000';
      expect(await runner('event', { runner: 'mini-pc', job_id: unbekannt, event_id: EVENT_ID, type: 'x' })).toMatchObject({ status: 404, json: { fehler: 'job_unbekannt' } });
      expect(await runner('complete', { runner: 'mini-pc', job_id: unbekannt, ergebnis: 'done' })).toMatchObject({ status: 404 });
    });

    it('vergibt eine abgelaufene Lease neu und nimmt ein Abo-Limit ohne Versuch an', async () => {
      const id = await jobAnlegen();
      await runner('claim', { runner: 'runner-a' });

      uhr = new Date(uhr.getTime() + LEASE_MS + 1000);
      const neu = await runner('claim', { runner: 'runner-b' });
      expect(neu.json.job).toMatchObject({ id, lease_owner: 'runner-b', attempt: 1 });

      const bis = new Date(uhr.getTime() + 3_600_000).toISOString();
      expect(await runner('complete', { runner: 'runner-b', job_id: id, ergebnis: 'quota', provider_bis: bis })).toMatchObject({
        status: 200,
        json: { status: 'queued', attempt: 1 },
      });
      expect((await runner('claim', { runner: 'runner-b' })).json).toEqual({ job: null });
    });

    it('prüft die Eingaben streng und nennt nur Feldnamen', async () => {
      expect(await runner('claim', { runner: 'Mini PC' })).toMatchObject({ status: 400, json: { fehler: 'ungueltige_anfrage', felder: ['runner'] } });
      expect(await runner('claim', { runner: 'mini-pc', arten: ['deploy'] })).toMatchObject({ status: 400, json: { felder: ['arten.0'] } });
      expect(await runner('heartbeat', { runner: 'mini-pc', job_id: 'kein-uuid', extra: 1 })).toMatchObject({ status: 400, json: { felder: ['extra', 'job_id'] } });
      expect(await runner('complete', { runner: 'mini-pc', job_id: EVENT_ID, ergebnis: 'done', provider_bis: '2026-10-16T09:00:00Z' })).toMatchObject({
        status: 400,
        json: { felder: ['provider_bis'] },
      });
      expect(await runner('complete', { runner: 'mini-pc', job_id: EVENT_ID, ergebnis: 'done', usage: [{ tool: 'x', billing: 'gratis' }] })).toMatchObject({
        status: 400,
        json: { felder: ['usage.0.billing'] },
      });
    });
  });

  describe('Tims Seite unter /intern/pipeline', () => {
    it('legt einen Job an und legt denselben offenen Job nicht doppelt an', async () => {
      const id = await jobAnlegen();
      const doppelt = await intern('POST', 'jobs', { ticket_key: 'COPI-145', repo: REPO, kind: 'implement' });
      expect(doppelt).toMatchObject({ status: 200, json: { angelegt: false, job: { id } } });
    });

    it('nimmt GitHub-Issues als Ticket-Schlüssel an', async () => {
      const antwort = await intern('POST', 'jobs', { ticket_key: 'Stefan39/cockpit#12', repo: REPO, kind: 'review:codex', priority: 1 });
      expect(antwort).toMatchObject({ status: 201, json: { angelegt: true, job: { ticket_key: 'Stefan39/cockpit#12', provider: 'codex', priority: 1 } } });
    });

    it('verlangt ein eingerichtetes Repo und gültige Eingaben', async () => {
      expect(await intern('POST', 'jobs', { ticket_key: 'X-1', repo: 'Stefan39/unbekannt', kind: 'implement' })).toMatchObject({ status: 409, json: { fehler: 'repo_unbekannt' } });
      expect(await intern('POST', 'jobs', { ticket_key: '', repo: 'kein repo', kind: 'deploy', due_date: '16.10.2026' })).toMatchObject({
        status: 400,
        json: { felder: ['due_date', 'kind', 'repo', 'ticket_key'] },
      });
    });

    it('räumt abgelaufene Leases auf und nennt die geparkten Jobs', async () => {
      const antwort = await intern('POST', 'jobs', { ticket_key: 'COPI-1', repo: REPO, kind: 'implement', max_attempts: 0 });
      const id = String((antwort.json.job as { id: string }).id);
      await runner('claim', { runner: 'mini-pc' });

      expect(await intern('POST', 'aufraeumen', {})).toMatchObject({ status: 200, json: { aufgeraeumt: [] } });
      uhr = new Date(uhr.getTime() + LEASE_MS + 1000);
      expect(await intern('POST', 'aufraeumen', {})).toMatchObject({
        status: 200,
        json: { aufgeraeumt: [{ id, ticket_key: 'COPI-1', status: 'parked', attempt: 1 }] },
      });
    });

    it('liest offene Freigaben und markiert sie als erledigt', async () => {
      const id = await jobAnlegen();
      expect(await intern('GET', 'freigaben')).toMatchObject({ status: 200, json: { freigaben: [] } });

      await pool.query(
        `INSERT INTO cockpit.pipeline_job_event (job_id, runner, ts, type, data) VALUES
           ($1, 'mini-pc', $2, 'review.clean', '{"round":2}'),
           ($1, 'mini-pc', $2, 'merge.approval_requested', '{"pr":7,"pr_url":"https://example.invalid/pr/7","head_sha":"abc123"}')`,
        [id, uhr],
      );
      const ohneTitel = String(((await intern('POST', 'jobs', { ticket_key: 'COPI-146', repo: REPO, kind: 'implement' })).json.job as { id: string }).id);
      const spaeter = new Date(uhr.getTime() + 60_000);
      await pool.query(
        `INSERT INTO cockpit.pipeline_job_event (job_id, runner, ts, type, data)
         VALUES ($1, 'mini-pc', $2, 'merge.approval_requested', '{"pr":8,"pr_url":"https://example.invalid/pr/8","head_sha":"def456"}')`,
        [ohneTitel, spaeter],
      );
      expect(await intern('GET', 'freigaben')).toEqual({
        status: 200,
        json: {
          freigaben: [
            {
              job_id: id,
              ticket_key: 'COPI-145',
              titel: 'Pipeline-Queue',
              repo: REPO,
              pr: 7,
              pr_url: 'https://example.invalid/pr/7',
              head_sha: 'abc123',
              runden: 2,
              angefragt_am: uhr.toISOString(),
            },
            {
              job_id: ohneTitel,
              ticket_key: 'COPI-146',
              titel: null,
              repo: REPO,
              pr: 8,
              pr_url: 'https://example.invalid/pr/8',
              head_sha: 'def456',
              runden: null,
              angefragt_am: spaeter.toISOString(),
            },
          ],
        },
      });

      expect(await intern('POST', `jobs/${ohneTitel}/freigabe-erledigt`, { grund: 'geschlossen' })).toEqual({ status: 200, json: { erledigt: true } });
      expect(await intern('POST', `jobs/${id}/freigabe-erledigt`, { grund: 'gemergt' })).toEqual({ status: 200, json: { erledigt: true } });
      expect(await intern('GET', 'freigaben')).toMatchObject({ json: { freigaben: [] } });
      expect(await intern('POST', `jobs/${id}/freigabe-erledigt`, { grund: 'gemergt' })).toEqual({ status: 200, json: { erledigt: false } });
    });

    it('antwortet bei freigabe-erledigt 404 für einen unbekannten Job und 400 für einen ungültigen Rumpf', async () => {
      const id = await jobAnlegen();
      expect((await intern('POST', `jobs/${EVENT_ID}/freigabe-erledigt`, { grund: 'geschlossen' })).status).toBe(404);
      expect((await intern('POST', `jobs/${id}/freigabe-erledigt`, { grund: 'vergessen' })).status).toBe(400);
      expect((await intern('POST', `jobs/${id}/freigabe-erledigt`, { grund: 'gemergt', extra: 1 })).status).toBe(400);
      expect((await intern('POST', 'jobs/kein-uuid/freigabe-erledigt', { grund: 'gemergt' })).status).toBe(400);
    });

    it('verlangt das Recht pipeline_verwalten', async () => {
      const fremd = (await apiTokenAnlegen(pool, { name: 'koordinator', scopes: ['zustand_lesen'] })).token;
      expect((await intern('POST', 'jobs', { ticket_key: 'COPI-1', repo: REPO, kind: 'implement' }, fremd)).status).toBe(403);
      expect((await intern('POST', 'aufraeumen', {}, fremd)).status).toBe(403);
      expect((await intern('GET', `jobs/${EVENT_ID}`, undefined, fremd)).status).toBe(403);
      expect((await intern('GET', 'freigaben', undefined, fremd)).status).toBe(403);
      expect((await intern('POST', `jobs/${EVENT_ID}/freigabe-erledigt`, { grund: 'gemergt' }, fremd)).status).toBe(403);
    });

    it('antwortet 404 für einen unbekannten Job und 400 für eine kaputte ID', async () => {
      expect((await intern('GET', `jobs/${EVENT_ID}`)).status).toBe(404);
      expect((await intern('GET', 'jobs/kein-uuid')).status).toBe(400);
    });
  });
});
