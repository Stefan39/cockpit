/**
 * Der Freigabemodus für Updates (COPI-141) mit echten Anfragen gegen die echte Datenbank.
 *
 * Getrennt für Cockpit und Module: `rueckfrage` (Standard, Freigabe außerhalb des Cockpits) oder `direkt` (die Bestätigung
 * des Betreuers ist die Freigabe, der Antrag steht sofort auf `freigegeben`). Geprüft werden das Umschalten (nur der
 * Betreuer, mit Bestätigung auf „direkt", protokolliert), beide Modi je Art, der Notweg (immer Rückfrage), der Modus als
 * Snapshot am Antrag, die Bestätigung bei inzwischen geändertem Modus und der Rückzug nach direkter Freigabe.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort Anträge, Freigabemodus, Instanz, Module, Agenten-Zugänge, die
 * Versions-Wachen und das eigene Konto ab. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { instanzMelden } from '../src/status/instanz-speicher.js';
import { updatePlanerLaufen } from '../src/status/update-planer.js';
import { FORMULAR_KOPF, formular, protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const HOST = 'cockpit.example';
const EIGENE_HERKUNFT = { host: HOST, origin: `https://${HOST}` };
const KONTO = 'konto-freigabe-betreuer';
const LAUFEND = `sha256:${'9f'.repeat(32)}`;
const ZIEL = `sha256:${'e7'.repeat(32)}`;
const MODUL = 'test-freigabe';
const VORHER_COMMIT = '3f2a9c1e0b7d44c2a9f1c0de5b6a7d8e9f0a1b2c';
const ZIEL_COMMIT = '8d41e07b2c9a4f10e5d6c7b8a9f0e1d2c3b4a5f6';
const MODUL_WACHE = `version-modul-${MODUL}`;

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

const BLOCK = [
  `kennung: ${MODUL}`,
  'menuename: "Test-Freigabe"',
  'ansicht: liste-detail',
  'view: v_modul_freigabe_test',
  'spalten:',
  '  - { name: titel, label: "Titel" }',
  'rollen: [betreuer]',
  'art: betrieb',
  'eingriffe: []',
  '',
].join('\n');

interface AntragZeile {
  readonly id: number;
  readonly art: string;
  readonly status: string;
  readonly freigabe_modus: string;
  readonly ziel_version: string | null;
  readonly freigegeben: boolean;
}

describe.skipIf(!datenbankUrl)('Freigabemodus für Updates (COPI-141, echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let rolle: Rolle;
  let token: string;

  async function abraeumen(): Promise<void> {
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.update_freigabemodus');
    await pool.query('DELETE FROM cockpit.instanz');
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query('DELETE FROM cockpit.befund WHERE wache = ANY($1)', [['version-cockpit', MODUL_WACHE]]);
    await pool.query('DELETE FROM cockpit.wache WHERE kennung = ANY($1)', [['version-cockpit', MODUL_WACHE]]);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cockpit.freigabe_modus_quelle (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        titel text NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE VIEW cockpit.v_modul_freigabe_test AS
        SELECT id::text AS id, titel, 'gruen'::text AS status, aktualisiert_am FROM cockpit.freigabe_modus_quelle;
    `);
    await pool.query(
      `INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, 'Stefan Test', $2, true, 'betreuer')
       ON CONFLICT (id) DO NOTHING`,
      [KONTO, `${KONTO}@example.org`],
    );
  });

  beforeEach(async () => {
    await abraeumen();
    await instanzMelden(pool, { version: '1.4.0+0123456', digest: LAUFEND }, new Date());
    const modul = await modulEinspielen(pool, { rohtext: BLOCK, akteur: 'test', herkunft: `agent-blueprints@${VORHER_COMMIT}:module/${MODUL}.cockpit.yaml` });
    expect(modul.ok).toBe(true);
    token = (await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['eingriff_verwalten'] })).token;
    rolle = 'betreuer';
    const zugang = (): Promise<Zugang> =>
      Promise.resolve({ angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: rolle === 'betreuer' ? KONTO : 'konto-admin' });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => new Date(), sitzungLesen: MIT_FAKTOR, zugangLesen: zugang });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await abraeumen();
    await pool.query(`DELETE FROM cockpit."user" WHERE id = $1`, [KONTO]);
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_freigabe_test; DROP TABLE IF EXISTS cockpit.freigabe_modus_quelle;');
    await pool.end();
  });

  function senden(url: string, felder: Record<string, string>, kopf: Record<string, string> = EIGENE_HERKUNFT): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...kopf }, payload: formular(felder) });
  }

  function feld(seite: LightMyRequestResponse, name: string): string {
    return new RegExp(`name="${name}" value="([^"]*)"`).exec(seite.body)?.[1] ?? '';
  }

  /** Das Formular der Bestätigungsseite, wie ein Browser es abschickt. */
  function bestaetigen(seite: LightMyRequestResponse, url: string): Promise<LightMyRequestResponse> {
    const felder = ['modul', 'ziel', 'quelle', 'modus', 'bis', 'token'].map((name) => [name, feld(seite, name)]).filter(([, wert]) => wert !== '');
    return senden(url, Object.fromEntries(felder));
  }

  function umschalten(bereich: string, modus: string, bestaetigt = true): Promise<LightMyRequestResponse> {
    return senden('/einstellungen/freigabe', { bereich, modus, ...(bestaetigt ? { bestaetigt: 'ja' } : {}) });
  }

  function agent(id: number, rumpf: unknown): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: `/intern/eingriffe/${String(id)}/status`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(rumpf),
    });
  }

  async function wacheMeldet(art: 'cockpit' | 'modul'): Promise<void> {
    const ergebnis = await befundMelden(pool, {
      wache: art === 'cockpit' ? 'version-cockpit' : MODUL_WACHE,
      status: 'gelb',
      textIntern: 'neuer Stand',
      kundensichtbar: false,
      taktSekunden: 3600,
      updateZiel:
        art === 'cockpit'
          ? { art, ziel: ZIEL, version: '1.5.0', seit: '2026-10-12T04:25:00+02:00' }
          : { art, ziel: ZIEL_COMMIT, seit: '2026-10-12T04:25:00+02:00' },
      quelle: 'test',
      jetzt: new Date(),
    });
    expect(ergebnis.ok).toBe(true);
  }

  /** „Update installieren" beim Cockpit: der Klick, dann die Bestätigungsseite. */
  async function cockpitKlick(): Promise<LightMyRequestResponse> {
    await wacheMeldet('cockpit');
    const seite = await senden('/einstellungen/update', { quelle: 'wache' });
    expect(seite.statusCode).toBe(200);
    return seite;
  }

  async function modulKlick(): Promise<LightMyRequestResponse> {
    await wacheMeldet('modul');
    const seite = await senden('/einstellungen/modul-update', { modul: MODUL, quelle: 'wache' });
    expect(seite.statusCode).toBe(200);
    return seite;
  }

  async function antraege(): Promise<AntragZeile[]> {
    const ergebnis = await pool.query<AntragZeile>(
      `SELECT id::int AS id, art, status, freigabe_modus, ziel_version, freigegeben_am IS NOT NULL AS freigegeben FROM cockpit.eingriff ORDER BY id`,
    );
    return ergebnis.rows;
  }

  async function einstellungen(url = '/einstellungen'): Promise<string> {
    return (await app.inject({ method: 'GET', url })).body;
  }

  describe('umschalten', () => {
    it('zeigt beiden Bereichen die Rückfrage als Standard', async () => {
      const seite = await einstellungen();

      expect(seite).toContain('Freigabe von Updates');
      expect(seite).toContain('id="freigabe-cockpit"');
      expect(seite).toContain('id="freigabe-module"');
      expect(seite.match(/<option value="rueckfrage" selected>/g)).toHaveLength(2);
    });

    it('verlangt auf „direkt" erst eine Bestätigung, schaltet dann um und protokolliert alt → neu', async () => {
      const marke = await protokollMarke(pool);

      const frage = await umschalten('cockpit', 'direkt', false);
      expect(frage.statusCode).toBe(200);
      expect(frage.body).toContain('Direkt installieren einschalten');
      expect(feld(frage, 'bestaetigt')).toBe('ja');
      expect((await pool.query('SELECT 1 FROM cockpit.update_freigabemodus')).rowCount).toBe(0);

      const antwort = await umschalten('cockpit', 'direkt');
      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/einstellungen?freigabe=gesetzt#freigabe-titel');
      const zeilen = await pool.query('SELECT bereich, modus, gesetzt_von FROM cockpit.update_freigabemodus');
      expect(zeilen.rows).toEqual([{ bereich: 'cockpit', modus: 'direkt', gesetzt_von: KONTO }]);
      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege).toEqual([
        expect.objectContaining({ art: 'update_freigabemodus_geaendert', akteur: KONTO, einzelheiten: expect.objectContaining({ von: 'rueckfrage', an: 'direkt' }) }),
      ]);

      const seite = await einstellungen();
      expect(seite).toContain('Zuletzt geändert von Stefan Test');
      expect(seite.match(/<option value="direkt" selected>/g)).toHaveLength(1);
    });

    it('schreibt denselben Modus nicht noch einmal und schaltet ohne Bestätigung zurück auf die Rückfrage', async () => {
      await umschalten('module', 'direkt');

      expect((await umschalten('module', 'direkt', false)).headers.location).toBe('/einstellungen?freigabe=unveraendert#freigabe-titel');
      const zurueck = await umschalten('module', 'rueckfrage', false);

      expect(zurueck.headers.location).toBe('/einstellungen?freigabe=gesetzt#freigabe-titel');
      const zeilen = await pool.query('SELECT modus FROM cockpit.update_freigabemodus ORDER BY id');
      expect(zeilen.rows.map((zeile: { modus: string }) => zeile.modus)).toEqual(['direkt', 'rueckfrage']);
    });

    it('weist einen unbekannten Bereich oder Modus ab', async () => {
      expect((await umschalten('alles', 'direkt')).headers.location).toBe('/einstellungen?freigabe=abgewiesen#freigabe-titel');
      expect((await umschalten('cockpit', 'sofort')).headers.location).toBe('/einstellungen?freigabe=abgewiesen#freigabe-titel');
      expect((await pool.query('SELECT 1 FROM cockpit.update_freigabemodus')).rowCount).toBe(0);
    });

    it('lässt nur den Betreuer umschalten, und nur aus dem Cockpit', async () => {
      expect((await senden('/einstellungen/freigabe', { bereich: 'cockpit', modus: 'direkt', bestaetigt: 'ja' }, { host: HOST })).statusCode).toBe(403);
      rolle = 'betriebs_admin';
      expect((await umschalten('cockpit', 'direkt')).statusCode).toBe(404);
      expect(await einstellungen()).not.toContain('Freigabe von Updates');
      expect((await pool.query('SELECT 1 FROM cockpit.update_freigabemodus')).rowCount).toBe(0);
    });
  });

  describe('Antrag je Modus', () => {
    it('Cockpit mit Rückfrage: der Antrag wartet auf die Freigabe', async () => {
      const seite = await cockpitKlick();
      expect(seite.body).toContain('Antrag stellen');
      expect(feld(seite, 'modus')).toBe('rueckfrage');

      const antwort = await bestaetigen(seite, '/einstellungen/update/bestaetigen');

      expect(antwort.headers.location).toBe('/einstellungen?antrag=gestellt');
      expect(await antraege()).toEqual([expect.objectContaining({ art: 'cockpit-image', status: 'beantragt', freigabe_modus: 'rueckfrage', ziel_version: null })]);
    });

    it('Cockpit direkt: die Bestätigung ist die Freigabe, mit Ziel-Version und Protokoll „direkt"', async () => {
      await umschalten('cockpit', 'direkt');
      const seite = await cockpitKlick();
      expect(seite.body).toContain('Freigeben und installieren');
      expect(seite.body).toContain('Freigabe: direkt.');
      const marke = await protokollMarke(pool);

      const antwort = await bestaetigen(seite, '/einstellungen/update/bestaetigen');

      expect(antwort.headers.location).toBe('/einstellungen?antrag=freigegeben');
      const [antrag] = await antraege();
      expect(antrag).toEqual(expect.objectContaining({ status: 'freigegeben', freigabe_modus: 'direkt', ziel_version: '1.5.0' }));
      expect(await protokollSeit(pool, marke)).toEqual([
        expect.objectContaining({ art: 'update_beantragt', akteur: KONTO }),
        expect.objectContaining({ art: 'update_freigegeben', akteur: KONTO, einzelheiten: { eingriff_id: antrag?.id, weg: 'direkt' } }),
      ]);
      const intern = await app.inject({ method: 'GET', url: `/intern/eingriffe/${String(antrag?.id)}`, headers: { authorization: `Bearer ${token}` } });
      expect(intern.json()).toMatchObject({ eingriff: { status: 'freigegeben', freigabe_modus: 'direkt', ziel_version: '1.5.0' } });
      const karte = await einstellungen(antwort.headers.location);
      expect(karte).toContain('Update freigegeben. Der Admin-Agent spielt es ohne Rückfrage ein');
      expect(karte).toContain('ist direkt freigegeben');
      expect(karte).toContain('direkt im Cockpit');
    });

    it('Modul direkt, Cockpit mit Rückfrage: die Bereiche sind getrennt', async () => {
      await umschalten('module', 'direkt');

      const modul = await modulKlick();
      expect(modul.body).toContain('Freigeben und installieren');
      expect((await bestaetigen(modul, '/einstellungen/modul-update/bestaetigen')).headers.location).toBe(`/einstellungen?antrag=freigegeben&modul=${MODUL}`);
      const cockpit = await cockpitKlick();
      expect(cockpit.body).toContain('Antrag stellen');
      await bestaetigen(cockpit, '/einstellungen/update/bestaetigen');

      expect(await antraege()).toEqual([
        expect.objectContaining({ art: 'modul', status: 'freigegeben', freigabe_modus: 'direkt', ziel_version: null }),
        expect.objectContaining({ art: 'cockpit-image', status: 'beantragt', freigabe_modus: 'rueckfrage' }),
      ]);
    });

    it('Notweg: ein getipptes Ziel bleibt auch bei „direkt" bei der Rückfrage, mit Hinweis', async () => {
      await umschalten('cockpit', 'direkt');
      await umschalten('module', 'direkt');

      const cockpit = await senden('/einstellungen/update', { ziel: ZIEL });
      expect(cockpit.body).toContain('Ein von Hand gewählter Stand wird immer in Slack bestätigt');
      expect(cockpit.body).toContain('Antrag stellen');
      expect((await bestaetigen(cockpit, '/einstellungen/update/bestaetigen')).headers.location).toBe('/einstellungen?antrag=gestellt');
      const modul = await senden('/einstellungen/modul-update', { modul: MODUL, ziel: ZIEL_COMMIT.slice(0, 7) });
      expect(feld(modul, 'modus')).toBe('rueckfrage');
      await bestaetigen(modul, '/einstellungen/modul-update/bestaetigen');

      expect((await antraege()).map((antrag) => [antrag.status, antrag.freigabe_modus])).toEqual([
        ['beantragt', 'rueckfrage'],
        ['beantragt', 'rueckfrage'],
      ]);
    });

    it('stellt nichts, wenn inzwischen ein anderer Modus gilt, und zeigt den geltenden', async () => {
      const seite = await cockpitKlick();
      await umschalten('cockpit', 'direkt');

      const antwort = await bestaetigen(seite, '/einstellungen/update/bestaetigen');

      expect(antwort.statusCode).toBe(409);
      expect(antwort.body).toContain('Der Freigabemodus wurde inzwischen umgestellt.');
      expect(antwort.body).toContain('Freigeben und installieren');
      expect(await antraege()).toEqual([]);
    });
  });

  describe('Snapshot und Rückzug', () => {
    it('ein späterer Wechsel der Einstellung ändert keinen laufenden Antrag', async () => {
      await bestaetigen(await cockpitKlick(), '/einstellungen/update/bestaetigen');
      await umschalten('module', 'direkt');
      await bestaetigen(await modulKlick(), '/einstellungen/modul-update/bestaetigen');

      await umschalten('cockpit', 'direkt');
      await umschalten('module', 'rueckfrage');

      expect((await antraege()).map((antrag) => [antrag.art, antrag.status, antrag.freigabe_modus])).toEqual([
        ['cockpit-image', 'beantragt', 'rueckfrage'],
        ['modul', 'freigegeben', 'direkt'],
      ]);
    });

    it('zieht einen direkt freigegebenen Antrag zurück, solange der Agent ihn nicht gestartet hat', async () => {
      await umschalten('cockpit', 'direkt');
      await bestaetigen(await cockpitKlick(), '/einstellungen/update/bestaetigen');
      const [antrag] = await antraege();
      const id = String(antrag?.id);

      expect((await agent(Number(id), { status: 'freigegeben', ziel_digest: ZIEL, ziel_version: '1.5.0' })).statusCode).toBe(409);
      const antwort = await senden('/einstellungen/update/zurueckziehen', { id });

      expect(antwort.headers.location).toBe('/einstellungen?antrag=zurueckgezogen');
      expect(await antraege()).toEqual([expect.objectContaining({ status: 'zurueckgezogen', freigabe_modus: 'direkt', freigegeben: true })]);
    });

    it('zieht nichts mehr zurück, sobald der Agent gestartet hat', async () => {
      await umschalten('module', 'direkt');
      await bestaetigen(await modulKlick(), '/einstellungen/modul-update/bestaetigen');
      const [antrag] = await antraege();
      expect((await agent(antrag?.id ?? 0, { status: 'laeuft' })).statusCode).toBe(200);

      const antwort = await senden('/einstellungen/update/zurueckziehen', { id: String(antrag?.id) });

      expect(antwort.statusCode).toBe(409);
      expect(await antraege()).toEqual([expect.objectContaining({ status: 'laeuft' })]);
    });

    it('lässt einen mit Rückfrage freigegebenen Antrag nicht zurückziehen, auch nicht in der Datenbank', async () => {
      await bestaetigen(await cockpitKlick(), '/einstellungen/update/bestaetigen');
      const [antrag] = await antraege();
      expect((await agent(antrag?.id ?? 0, { status: 'freigegeben', ziel_digest: ZIEL, ziel_version: '1.5.0' })).statusCode).toBe(200);

      expect((await senden('/einstellungen/update/zurueckziehen', { id: String(antrag?.id) })).statusCode).toBe(409);
      await expect(pool.query(`UPDATE cockpit.eingriff SET status = 'zurueckgezogen' WHERE id = $1`, [antrag?.id])).rejects.toThrow(/eingriff_uebergang/);
    });
  });

  describe('Automatisch (COPI-142)', () => {
    it('verlangt auf „automatisch" erst eine Bestätigung, auch von „direkt" aus, und protokolliert alt → neu', async () => {
      await umschalten('module', 'direkt');
      const marke = await protokollMarke(pool);

      const frage = await umschalten('module', 'automatisch', false);
      expect(frage.statusCode).toBe(200);
      expect(frage.body).toContain('Automatisch installieren einschalten');
      expect(frage.body).toContain('Module werden jederzeit aktualisiert, je Modul höchstens einmal am Tag.');
      expect(feld(frage, 'modus')).toBe('automatisch');
      expect((await umschalten('cockpit', 'automatisch', false)).body).toContain('nur dienstags zwischen 7 und 9 Uhr');
      expect((await pool.query(`SELECT 1 FROM cockpit.update_freigabemodus WHERE modus = 'automatisch'`)).rowCount).toBe(0);

      expect((await umschalten('module', 'automatisch')).headers.location).toBe('/einstellungen?freigabe=gesetzt#freigabe-titel');
      expect(await protokollSeit(pool, marke)).toEqual([
        expect.objectContaining({ art: 'update_freigabemodus_geaendert', einzelheiten: expect.objectContaining({ von: 'direkt', an: 'automatisch' }) }),
      ]);
      expect((await einstellungen()).match(/<option value="automatisch" selected>/g)).toHaveLength(1);
    });

    it('zeigt beim Cockpit im Modus automatisch das geltende Wartungsfenster (COPI-235), bei Modulen keins', async () => {
      await umschalten('cockpit', 'automatisch');
      await umschalten('module', 'automatisch');
      expect(await einstellungen()).toContain('Wartungsfenster: Dienstag 07:00–09:00');

      const zugang = (): Promise<Zugang> => Promise.resolve({ angemeldet: true, rolle: 'betreuer', zweiterFaktorAktiv: true, benutzerId: KONTO });
      const jederzeit = buildApp({ nodeEnv: 'test', wartungsfenster: 'jederzeit' }, { pool, jetzt: () => new Date(), sitzungLesen: MIT_FAKTOR, zugangLesen: zugang });
      await jederzeit.ready();
      const seite = (await jederzeit.inject({ method: 'GET', url: '/einstellungen' })).body;
      await jederzeit.close();

      expect(seite.match(/Wartungsfenster: jederzeit/g)).toHaveLength(1);
      expect(seite).not.toContain('Dienstag 07:00–09:00');
    });

    it('ein Klick im Modus automatisch gibt direkt frei, wie im Modus direkt (kein automatischer Antrag)', async () => {
      await umschalten('module', 'automatisch');
      const seite = await modulKlick();
      expect(seite.body).toContain('Freigeben und installieren');
      expect(feld(seite, 'modus')).toBe('direkt');

      await bestaetigen(seite, '/einstellungen/modul-update/bestaetigen');

      const zeilen = await pool.query('SELECT status, freigabe_modus, automatisch FROM cockpit.eingriff');
      expect(zeilen.rows).toEqual([{ status: 'freigegeben', freigabe_modus: 'direkt', automatisch: false }]);
    });

    it('zeigt, was die Automatik tut: bereit, der automatische Antrag, nach einem Fehlschlag gesperrt', async () => {
      await umschalten('module', 'automatisch');
      await wacheMeldet('modul');
      expect(await einstellungen()).toContain('Wird automatisch installiert.');

      const [versuch] = await updatePlanerLaufen(pool, new Date());
      const id = versuch?.ergebnis.ok === true ? versuch.ergebnis.id : 0;
      expect(await einstellungen()).toContain('automatisch, ohne Klick');
      const intern = await app.inject({ method: 'GET', url: `/intern/eingriffe/${String(id)}`, headers: { authorization: `Bearer ${token}` } });
      expect(intern.json()).toMatchObject({ eingriff: { status: 'freigegeben', freigabe_modus: 'direkt', automatisch: true } });

      expect((await agent(id, { status: 'laeuft' })).statusCode).toBe(200);
      expect((await agent(id, { status: 'fehlgeschlagen', grund: 'Test' })).statusCode).toBe(200);
      const seite = await einstellungen();
      expect(seite).toContain('Automatik für dieses Ziel gesperrt');
      expect(seite).toContain('Update installieren');
    });
  });

  describe('Datenbank', () => {
    it('hält den Modus eines Antrags und jede gesetzte Zeile fest', async () => {
      await umschalten('cockpit', 'direkt');
      await bestaetigen(await cockpitKlick(), '/einstellungen/update/bestaetigen');
      const [antrag] = await antraege();

      await expect(pool.query(`UPDATE cockpit.eingriff SET freigabe_modus = 'rueckfrage' WHERE id = $1`, [antrag?.id])).rejects.toThrow(/eingriff_unveraenderlich/);
      await expect(pool.query(`UPDATE cockpit.update_freigabemodus SET modus = 'rueckfrage'`)).rejects.toThrow(/update_freigabemodus_bleibt/);
      await expect(pool.query(`INSERT INTO cockpit.update_freigabemodus (bereich, modus, gesetzt_von) VALUES ('cockpit', 'sofort', $1)`, [KONTO])).rejects.toThrow(
        /update_freigabemodus_modus/,
      );
    });
  });
});
