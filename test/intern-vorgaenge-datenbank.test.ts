/**
 * `GET /intern/vorgaenge/sperre` (COPI-85) gegen eine echte PostgreSQL: die Abfrage der Übernahme-Sperre für die
 * Fachagenten — Recht `vorgang_lesen`, gesperrt/frei, keine E-Mail-Adresse, unbekanntes Modul, ungültige Eingabe.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import type { ApiScope } from '../src/intern/token.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { uebernehmen, zurueckgeben } from '../src/module/vorgang-sperre.js';
import { buildApp } from '../src/server/app.js';
import { kontenLoeschen, sperrenLeeren } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const ANNA = { id: 'konto-anna', rolle: 'betrieb_mitarbeiter' as const };

const BLOCK = [
  'kennung: anfragen',
  'menuename: "Anfragen"',
  'ansicht: liste-detail',
  'view: v_modul_test_vorgaenge',
  'spalten:',
  '  - { name: titel, label: "Titel" }',
  'rollen: [betreuer, betriebs_admin, betrieb_mitarbeiter]',
  'eingriffe: [uebernehmen]',
  '',
].join('\n');

describe.skipIf(!datenbankUrl)('GET /intern/vorgaenge/sperre (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let fachagent: string;

  async function token(name: string, scopes: ApiScope[]): Promise<string> {
    return (await apiTokenAnlegen(pool, { name, scopes })).token;
  }

  async function fragen(query: string, mit: string = fachagent) {
    const antwort = await app.inject({ method: 'GET', url: `/intern/vorgaenge/sperre${query}`, headers: { authorization: `Bearer ${mit}` } });
    return { status: antwort.statusCode, json: antwort.json() as Record<string, unknown>, body: antwort.body, kopf: antwort.headers };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE cockpit.vorgaenge_test_quelle (id text PRIMARY KEY, titel text NOT NULL, status text NOT NULL, aktualisiert_am timestamptz NOT NULL DEFAULT now());
      CREATE VIEW cockpit.v_modul_test_vorgaenge AS SELECT id, titel, status, aktualisiert_am FROM cockpit.vorgaenge_test_quelle;
    `);
    app = buildApp({ nodeEnv: 'test' }, { pool });
    await app.ready();
  });

  beforeEach(async () => {
    await sperrenLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query(`INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, 'Anna Albers', 'anna@example.org', true, $2)`, [
      ANNA.id,
      ANNA.rolle,
    ]);
    const eingespielt = await modulEinspielen(pool, { rohtext: BLOCK, akteur: 'konsole' });
    if (!eingespielt.ok) {
      throw new Error(eingespielt.grund);
    }
    fachagent = await token('buchungs-agent', ['vorgang_lesen']);
  });

  afterAll(async () => {
    await app.close();
    await sperrenLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_test_vorgaenge; DROP TABLE IF EXISTS cockpit.vorgaenge_test_quelle;');
    await pool.end();
  });

  it('meldet einen freien Vorgang als frei — auch einen, den die View (noch) nicht kennt', async () => {
    const antwort = await fragen('?modul=anfragen&id=brandt');

    expect(antwort.status).toBe(200);
    expect(antwort.json).toEqual({ gesperrt: false });
    expect(antwort.kopf['cache-control']).toBe('no-store');
  });

  it('meldet einen übernommenen Vorgang mit Anzeigename und Zeitpunkt, ohne E-Mail-Adresse und ohne Konto-ID', async () => {
    const { sperre } = await uebernehmen(pool, { modul: 'anfragen', vorgangId: 'brandt' }, ANNA);

    const antwort = await fragen('?modul=anfragen&id=brandt');

    expect(antwort.status).toBe(200);
    expect(antwort.json).toEqual({ gesperrt: true, von: 'Anna Albers', seit: sperre.uebernommenAm.toISOString() });
    expect(antwort.body).not.toContain('@');
    expect(antwort.body).not.toContain(ANNA.id);
  });

  it('meldet den Vorgang nach der Rückgabe wieder als frei; ein anderer Vorgang bleibt unberührt', async () => {
    await uebernehmen(pool, { modul: 'anfragen', vorgangId: 'brandt' }, ANNA);
    expect((await fragen('?modul=anfragen&id=vogt')).json).toEqual({ gesperrt: false });

    await zurueckgeben(pool, { modul: 'anfragen', vorgangId: 'brandt' }, ANNA);

    expect((await fragen('?modul=anfragen&id=brandt')).json).toEqual({ gesperrt: false });
  });

  it('meldet eine Sperre auch, wenn das Modul den Eingriff inzwischen nicht mehr anbietet (im Zweifel gesperrt)', async () => {
    await uebernehmen(pool, { modul: 'anfragen', vorgangId: 'brandt' }, ANNA);
    await modulEinspielen(pool, { rohtext: BLOCK.replace('eingriffe: [uebernehmen]', 'eingriffe: []'), akteur: 'konsole' });

    expect((await fragen('?modul=anfragen&id=brandt')).json).toMatchObject({ gesperrt: true });
  });

  it('antwortet für ein unbekanntes Modul mit 404 statt „frei" — ein Agent mit falscher Kennung sendet dann nicht', async () => {
    const antwort = await fragen('?modul=anfrage&id=brandt');

    expect(antwort.status).toBe(404);
    expect(antwort.json).toEqual({ fehler: 'nicht_gefunden' });
  });

  it.each([
    ['ohne Modul', '?id=brandt', ['modul']],
    ['ohne id', '?modul=anfragen', ['id']],
    ['mit leerer id', '?modul=anfragen&id=', ['id']],
    ['mit zu langer id', `?modul=anfragen&id=${'x'.repeat(201)}`, ['id']],
    ['mit ungültiger Modul-Kennung', '?modul=Anfragen_1&id=brandt', ['modul']],
    ['mit unbekanntem Feld', '?modul=anfragen&id=brandt&mehr=1', ['mehr']],
  ])('antwortet %s mit 400 und nennt nur Feldnamen', async (_fall, query, felder) => {
    const antwort = await fragen(query);

    expect(antwort.status).toBe(400);
    expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder });
  });

  it('verlangt das Recht vorgang_lesen: ohne es 403, ohne Token 401', async () => {
    const admin = await token('admin-agent', ['befund_schreiben', 'zustand_lesen']);

    expect((await fragen('?modul=anfragen&id=brandt', admin)).status).toBe(403);
    const ohne = await app.inject({ method: 'GET', url: '/intern/vorgaenge/sperre?modul=anfragen&id=brandt' });
    expect(ohne.statusCode).toBe(401);
  });
});
