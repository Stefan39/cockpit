/**
 * „PR-Freigaben" unter „Zu tun" auf der Übersicht (COPI-183) gegen eine echte PostgreSQL: Der Betreuer sieht die Spalte
 * mit Link zum PR; Betriebs-Admin und Mitarbeiter sehen sie nicht und die Seite verrät weder Repo noch PR-Nummer. Nach
 * `merge.erledigt` ist der Eintrag weg, ohne offene Freigabe gibt es keine Spalte, ein Titel mit HTML wird maskiert.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { freigabeErledigen } from '../src/pipeline/freigaben.js';
import { jobAnlegen } from '../src/pipeline/queue.js';
import { repoConfigPruefen, repoConfigSpeichern } from '../src/pipeline/repo-config.js';
import { zugangLesenMitPosteingang } from '../src/posteingang/lesen.js';
import { buildApp } from '../src/server/app.js';
import { kontenLoeschen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const JETZT = new Date('2026-10-18T12:00:00.000Z');
const REPO = 'Stefan39/cockpit';
const KONTO = 'konto-pipeline-freigaben';
const PR_LINK = `https://github.com/${REPO}/pull/4711`;

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

describe.skipIf(!testDatenbankUrl)('Übersicht: PR-Freigaben (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function freigabeAnfragen(ticketKey: string, titel: string | undefined, pr: number): Promise<string> {
    const antwort = await jobAnlegen(pool, { ticketKey, repo: REPO, kind: 'implement', ...(titel === undefined ? {} : { payload: { titel } }) }, JETZT);
    if (antwort.art !== 'angelegt') {
      throw new Error(`nicht angelegt: ${antwort.art}`);
    }
    const data = { pr, pr_url: 'https://evil.invalid/fremd', head_sha: 'abc' };
    await pool.query("INSERT INTO cockpit.pipeline_job_event (job_id, runner, ts, type, data) VALUES ($1, 'mini-pc', $2, 'merge.approval_requested', $3)", [antwort.job.id, new Date(JETZT.getTime() - 3_600_000), data]);
    return antwort.job.id;
  }

  async function seite(rolle: Rolle): Promise<string> {
    const basis = (): Promise<Zugang> => Promise.resolve({ angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: KONTO });
    const jetzt = (): Date => JETZT;
    const app: FastifyInstance = buildApp({ nodeEnv: 'test' }, { pool, jetzt, sitzungLesen: MIT_FAKTOR, zugangLesen: zugangLesenMitPosteingang(basis, pool, jetzt) });
    try {
      const antwort = await app.inject({ method: 'GET', url: '/' });
      expect(antwort.statusCode).toBe(200);
      return antwort.body;
    } finally {
      await app.close();
    }
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDatenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE cockpit.pipeline_usage, cockpit.pipeline_job_event, cockpit.pipeline_job, cockpit.pipeline_provider_state, cockpit.pipeline_repo_config');
    const config = repoConfigPruefen(`repo: ${REPO}\nquelle: github\n`);
    if (!config.ok) {
      throw new Error(config.grund);
    }
    await repoConfigSpeichern(pool, config.wert, JETZT);
    await kontenLoeschen(pool);
    await pool.query(`INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, 'Stefan', $2, true, 'betreuer')`, [KONTO, `${KONTO}@example.org`]);
  });

  afterAll(async () => {
    await pool.query('TRUNCATE cockpit.pipeline_usage, cockpit.pipeline_job_event, cockpit.pipeline_job, cockpit.pipeline_provider_state, cockpit.pipeline_repo_config');
    await kontenLoeschen(pool);
    await pool.end();
  });

  it('zeigt dem Betreuer die Spalte mit Link zum PR', async () => {
    await freigabeAnfragen('COPI-183', 'Offene Freigaben anzeigen', 4711);
    const html = await seite('betreuer');
    expect(html).toContain('PR-Freigaben');
    expect(html).toContain(`href="${PR_LINK}"`);
    expect(html).toContain('COPI-183 · Offene Freigaben anzeigen');
    expect(html).toContain('PR #4711');
    expect(html).not.toContain('evil.invalid');
  });

  it.each<Rolle>(['betriebs_admin', 'betrieb_mitarbeiter'])('zeigt %s die Spalte nicht und verrät weder Repo noch PR-Nummer', async (rolle) => {
    await freigabeAnfragen('COPI-183', 'Offene Freigaben anzeigen', 4711);
    const html = await seite(rolle);
    for (const verboten of ['PR-Freigaben', REPO, '4711', 'COPI-183']) {
      expect(html, `Die Seite enthält „${verboten}"`).not.toContain(verboten);
    }
  });

  it('lässt den Eintrag nach merge.erledigt weg', async () => {
    const id = await freigabeAnfragen('COPI-183', undefined, 4711);
    expect(await seite('betreuer')).toContain('PR-Freigaben');
    expect(await freigabeErledigen(pool, { jobId: id, grund: 'gemergt', jetzt: JETZT })).toBe('erledigt');
    const html = await seite('betreuer');
    expect(html).not.toContain('PR-Freigaben');
    expect(html).not.toContain(PR_LINK);
  });

  it('zeigt ohne offene Freigabe keine Spalte', async () => {
    expect(await seite('betreuer')).not.toContain('PR-Freigaben');
  });

  it('maskiert HTML im Titel', async () => {
    await freigabeAnfragen('COPI-183', '<script>alert(1)</script>', 4711);
    const html = await seite('betreuer');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });
});
