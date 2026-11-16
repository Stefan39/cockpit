/**
 * Das Modul-Update als Antrag (COPI-106, ADR 13.1) mit echten Anfragen gegen die echte Datenbank.
 *
 * „Das Cockpit aktualisiert nichts. Es beantragt." — auch bei Modulen. Der Betreuer nennt in den Einstellungen einen
 * Commit in agent-blueprints; die Bestätigungsseite zeigt Herkunft und Ziel, erst ihr Formular schreibt die Zeile
 * `cockpit.eingriff` (`art: modul`). Freigegeben wird außerhalb, ausgeführt vom Admin-Agenten. Erledigt ist der Antrag
 * erst, wenn die Registry die Version aus dem Ziel-Commit aktiviert hat (Katalogprüfung bestanden) — das setzt das
 * Cockpit selbst, ein Agent kann es nicht. Höchstens ein offener Antrag je Modul.
 *
 * Läuft nur mit `TEST_DATABASE_URL`; legt eine eigene Quelle mit View an und räumt `cockpit.modul`,
 * `cockpit.eingriff`, `cockpit.instanz` und `cockpit.api_token` ab. Niemals gegen eine Kundendatenbank laufen lassen.
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
import { FORMULAR_KOPF, formular, protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const HOST = 'cockpit.example';
const EIGENE_HERKUNFT = { host: HOST, origin: `https://${HOST}` };
const VORHER_COMMIT = '3f2a9c1e0b7d44c2a9f1c0de5b6a7d8e9f0a1b2c';
const ZIEL_COMMIT = '8d41e07b2c9a4f10e5d6c7b8a9f0e1d2c3b4a5f6';
const HERKUNFT_VORHER = `agent-blueprints@${VORHER_COMMIT}:module/test-update.cockpit.yaml`;
const HERKUNFT_ZIEL = `agent-blueprints@${ZIEL_COMMIT}:module/test-update.cockpit.yaml`;

const KONTO: Readonly<Record<Rolle, string>> = {
  betreuer: 'konto-betreuer',
  betriebs_admin: 'konto-admin',
  betrieb_mitarbeiter: 'konto-mitarbeiter',
};

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

/** Ein gültiger Block gegen die Testview; `menuename` ändert die Prüfsumme. */
function block(kennung: string, menuename = 'Test-Update'): string {
  return [
    `kennung: ${kennung}`,
    `menuename: "${menuename}"`,
    'ansicht: liste-detail',
    'view: v_modul_update_test',
    'spalten:',
    '  - { name: titel, label: "Titel" }',
    'rollen: [betreuer]',
    // Ein technisches Modul (COPI-134): hier geht es um den Antrag, nicht um den Zugriff auf Fachdaten.
    'art: betrieb',
    'eingriffe: []',
    '',
  ].join('\n');
}

describe.skipIf(!datenbankUrl)('Modul-Update als Antrag (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let rolle: Rolle;
  let token: string;

  async function abraeumen(): Promise<void> {
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.instanz');
    await pool.query('DELETE FROM cockpit.api_token');
  }

  async function einspielen(kennung: string, herkunft: string | undefined, menuename?: string) {
    const ergebnis = await modulEinspielen(pool, { rohtext: block(kennung, menuename), akteur: 'test', ...(herkunft ? { herkunft } : {}) });
    expect(ergebnis.ok).toBe(true);
    return ergebnis;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cockpit.modul_update_quelle (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        titel text NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE VIEW cockpit.v_modul_update_test AS
        SELECT id::text AS id, titel, 'gruen'::text AS status, aktualisiert_am FROM cockpit.modul_update_quelle;
    `);
  });

  beforeEach(async () => {
    await abraeumen();
    await instanzMelden(pool, { version: '0.13.0+abc', digest: `sha256:${'9f'.repeat(32)}` }, new Date());
    await einspielen('test-update', HERKUNFT_VORHER);
    rolle = 'betreuer';
    token = (await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['eingriff_verwalten'] })).token;
    const zugang = (): Promise<Zugang> =>
      Promise.resolve({ angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: KONTO[rolle] });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => new Date(), sitzungLesen: MIT_FAKTOR, zugangLesen: zugang });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await abraeumen();
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_update_test; DROP TABLE IF EXISTS cockpit.modul_update_quelle;');
    await pool.end();
  });

  function senden(url: string, felder: Record<string, string>): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...EIGENE_HERKUNFT }, payload: formular(felder) });
  }

  function schalten(id: number, rumpf: unknown): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: `/intern/eingriffe/${String(id)}/status`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(rumpf),
    });
  }

  /** Schritt 1 und 2 wie ein Browser: Formular, dann die versteckten Felder der Bestätigungsseite. */
  async function beantragen(ziel: string, modul = 'test-update'): Promise<LightMyRequestResponse> {
    const seite = await senden('/einstellungen/modul-update', { modul, ziel });
    expect(seite.statusCode).toBe(200);
    const feld = (name: string): string => new RegExp(`name="${name}" value="([^"]*)"`).exec(seite.body)?.[1] ?? '';
    return senden('/einstellungen/modul-update/bestaetigen', { modul: feld('modul'), ziel: feld('ziel'), bis: feld('bis'), token: feld('token') });
  }

  async function antraege(): Promise<Record<string, unknown>[]> {
    const ergebnis = await pool.query<Record<string, unknown>>(
      `SELECT id::int AS id, art, status, modul_kennung, ziel_commit, herkunft_vorher, ziel_digest, digest_vorher, fehler_grund, beantragt_von
         FROM cockpit.eingriff ORDER BY id`,
    );
    return ergebnis.rows;
  }

  async function antragId(): Promise<number> {
    const [erster] = await antraege();
    return Number(erster?.id);
  }

  describe('beantragen in den Einstellungen', () => {
    it('zeigt erst die Bestätigung mit Herkunft und Ziel, legt dabei nichts an', async () => {
      const antwort = await senden('/einstellungen/modul-update', { modul: 'test-update', ziel: ' 8d41e07 ' });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.body).toContain('Modul · Test-Update');
      expect(antwort.body).toContain(HERKUNFT_VORHER);
      expect(antwort.body).toContain('name="ziel" value="8d41e07"');
      expect(await antraege()).toEqual([]);
    });

    it('stellt den Antrag erst mit der Bestätigung: eine Zeile, ein Protokolleintrag, Rückmeldung an der Karte', async () => {
      const marke = await protokollMarke(pool);

      const antwort = await beantragen('8d41e07');

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/einstellungen?antrag=gestellt&modul=test-update');
      expect(await antraege()).toEqual([
        expect.objectContaining({
          art: 'modul',
          status: 'beantragt',
          modul_kennung: 'test-update',
          ziel_commit: '8d41e07',
          herkunft_vorher: HERKUNFT_VORHER,
          ziel_digest: null,
          digest_vorher: null,
          beantragt_von: KONTO.betreuer,
        }),
      ]);
      expect((await protokollSeit(pool, marke)).map((eintrag) => eintrag.art)).toEqual(['update_beantragt']);

      const seite = await app.inject({ method: 'GET', url: '/einstellungen?antrag=gestellt&modul=test-update' });
      expect(seite.body).toContain('Antrag Nr.');
      expect(seite.body).toContain('Antrag zurückziehen');
    });

    it.each([
      ['einen Branch statt Commit', 'main'],
      ['Großbuchstaben', '8D41E07'],
      ['sechs Zeichen', '8d41e0'],
      ['41 Zeichen', 'a'.repeat(41)],
      ['die ganze Herkunft statt des Commits (COPI-115)', 'agent-blueprints@4044edd087412c3907612f5d12d8a59b8c548b1a:module/eingang.cockpit.yaml'],
    ])('weist %s ab und zeigt die Eingabe an der Karte des Moduls', async (_name, ziel) => {
      const antwort = await senden('/einstellungen/modul-update', { modul: 'test-update', ziel });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain('Bitte nur den Commit angeben, z. B. 8d41e07');
      expect(antwort.body).toContain(`id="ziel-test-update" name="ziel" required value="${ziel}"`);
      expect(await antraege()).toEqual([]);
    });

    it('weist den schon eingespielten Commit ab, auch gekürzt', async () => {
      const antwort = await senden('/einstellungen/modul-update', { modul: 'test-update', ziel: VORHER_COMMIT.slice(0, 7) });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain('Dieser Commit ist bereits eingespielt.');
    });

    it('nimmt kein Modul ohne Herkunft aus agent-blueprints und kein unbekanntes an', async () => {
      await einspielen('von-hand', 'scripts/irgendwo.ts');

      expect((await senden('/einstellungen/modul-update', { modul: 'von-hand', ziel: '8d41e07' })).statusCode).toBe(409);
      expect((await senden('/einstellungen/modul-update', { modul: 'gibt-es-nicht', ziel: '8d41e07' })).statusCode).toBe(400);
      expect((await senden('/einstellungen/modul-update', { modul: '../x', ziel: '8d41e07' })).statusCode).toBe(400);
      expect(await antraege()).toEqual([]);
    });

    it('erlaubt höchstens einen offenen Antrag je Modul, aber parallel für ein anderes', async () => {
      await einspielen('zweites', HERKUNFT_VORHER.replace('test-update', 'zweites'));
      expect((await beantragen('8d41e07')).statusCode).toBe(303);

      expect((await senden('/einstellungen/modul-update', { modul: 'test-update', ziel: 'c0ffee1' })).statusCode).toBe(409);
      expect((await beantragen('c0ffee1', 'zweites')).statusCode).toBe(303);
      expect((await antraege()).map((zeile) => zeile.modul_kennung)).toEqual(['test-update', 'zweites']);
    });

    it('verweigert anderen Rollen Formular und Bestätigung (403), es entsteht nichts', async () => {
      rolle = 'betriebs_admin';

      expect((await senden('/einstellungen/modul-update', { modul: 'test-update', ziel: '8d41e07' })).statusCode).toBe(403);
      expect((await senden('/einstellungen/modul-update/bestaetigen', { modul: 'test-update', ziel: '8d41e07', bis: '1', token: 'x' })).statusCode).toBe(
        403,
      );
      expect(await antraege()).toEqual([]);
    });

    it('verweigert eine gefälschte oder fremde Bestätigung — auch die eines Image-Antrags', async () => {
      const image = await senden('/einstellungen/update', { ziel: `sha256:${'e7'.repeat(32)}` });
      const feld = (name: string): string => new RegExp(`name="${name}" value="([^"]*)"`).exec(image.body)?.[1] ?? '';

      const antwort = await senden('/einstellungen/modul-update/bestaetigen', { modul: 'test-update', ziel: '8d41e07', bis: feld('bis'), token: feld('token') });

      expect(antwort.statusCode).toBe(403);
      expect(await antraege()).toEqual([]);
    });

    it('verweigert die Bestätigung, wenn sich die Herkunft des Moduls inzwischen geändert hat', async () => {
      const seite = await senden('/einstellungen/modul-update', { modul: 'test-update', ziel: '8d41e07' });
      const feld = (name: string): string => new RegExp(`name="${name}" value="([^"]*)"`).exec(seite.body)?.[1] ?? '';
      await einspielen('test-update', HERKUNFT_VORHER.replace(VORHER_COMMIT, 'abcdef1'));

      const antwort = await senden('/einstellungen/modul-update/bestaetigen', { modul: 'test-update', ziel: '8d41e07', bis: feld('bis'), token: feld('token') });

      expect(antwort.statusCode).toBe(403);
      expect(await antraege()).toEqual([]);
    });

    it('zieht einen wartenden Modul-Antrag zurück, Rückmeldung an seiner Karte', async () => {
      await beantragen('8d41e07');
      const id = await antragId();

      const antwort = await senden('/einstellungen/update/zurueckziehen', { id: String(id) });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/einstellungen?antrag=zurueckgezogen&modul=test-update');
      expect((await antraege())[0]).toMatchObject({ status: 'zurueckgezogen' });
    });

    it('zeigt Verfügbar aus der Versions-Wache des Moduls, unverändert', async () => {
      await befundMelden(pool, {
        wache: 'version-modul-test-update',
        status: 'gelb',
        textIntern: 'Commit 8d41e07 · <b>Block</b> geändert',
        kundensichtbar: false,
        taktSekunden: 3600,
        quelle: 'test',
        jetzt: new Date(),
      });

      const seite = await app.inject({ method: 'GET', url: '/einstellungen' });

      expect(seite.body).toContain('Update verfügbar');
      expect(seite.body).toContain('Commit 8d41e07 · &lt;b&gt;Block&lt;/b&gt; geändert');
    });
  });

  describe('Freigabe und Ausführung durch den Admin-Agenten', () => {
    it('gibt per Ziel-Commit frei — genau wie beantragt — und liefert die Felder des Moduls', async () => {
      await beantragen('8d41e07');
      const id = await antragId();

      expect((await schalten(id, { status: 'freigegeben', ziel_commit: '8d41e07b' })).statusCode).toBe(409);
      expect((await schalten(id, { status: 'freigegeben', ziel_digest: `sha256:${'e7'.repeat(32)}`, ziel_version: '1.0.0' })).statusCode).toBe(409);
      expect((await schalten(id, { status: 'freigegeben', ziel_commit: '8d41e07', ziel_version: '1.0.0' })).json()).toEqual({
        fehler: 'ungueltige_anfrage',
        felder: ['ziel_version'],
      });

      const antwort = await schalten(id, { status: 'freigegeben', ziel_commit: '8d41e07' });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.json().eingriff).toMatchObject({
        art: 'modul',
        status: 'freigegeben',
        modul: 'test-update',
        ziel_commit: '8d41e07',
        herkunft_vorher: HERKUNFT_VORHER,
        ziel_digest: null,
        ziel_version: null,
        grund: null,
      });
    });

    it('erledigt den Antrag, sobald die Registry die Version aus dem Ziel-Commit aktiviert (voller Hash zum Präfix)', async () => {
      await beantragen('8d41e07');
      const id = await antragId();
      await schalten(id, { status: 'freigegeben', ziel_commit: '8d41e07' });
      await schalten(id, { status: 'laeuft' });
      const marke = await protokollMarke(pool);

      // Gleicher Block, neuer Commit: eine neue Version, die Katalogprüfung läuft erneut.
      const ergebnis = await einspielen('test-update', HERKUNFT_ZIEL);

      expect(ergebnis).toMatchObject({ status: 'neu', version: 2, erledigt: id });
      expect((await antraege())[0]).toMatchObject({ status: 'erledigt' });
      expect((await protokollSeit(pool, marke)).map((eintrag) => [eintrag.art, eintrag.akteur])).toEqual([['update_erledigt', 'system']]);
    });

    it('erledigt nichts, wenn eine Version aus einem anderen Commit kommt', async () => {
      await beantragen('8d41e07');
      const id = await antragId();
      await schalten(id, { status: 'freigegeben', ziel_commit: '8d41e07' });
      await schalten(id, { status: 'laeuft' });

      const ergebnis = await einspielen('test-update', HERKUNFT_VORHER.replace(VORHER_COMMIT, 'abcdef1'));

      expect(ergebnis).toMatchObject({ status: 'neu', erledigt: undefined });
      expect((await antraege())[0]).toMatchObject({ status: 'laeuft' });
    });

    it('lässt niemanden ohne Beleg erledigt setzen — auch nicht direkt in der Datenbank', async () => {
      await beantragen('8d41e07');
      const id = await antragId();
      await schalten(id, { status: 'freigegeben', ziel_commit: '8d41e07' });
      await schalten(id, { status: 'laeuft' });

      await expect(pool.query(`UPDATE cockpit.eingriff SET status = 'erledigt' WHERE id = $1`, [id])).rejects.toThrow(/eingriff_ohne_beleg/);
      expect((await schalten(id, { status: 'erledigt' })).statusCode).toBe(400);
    });

    it('nimmt den Grund eines Fehlschlags an, zeigt ihn an der Karte und hält ihn danach fest', async () => {
      await beantragen('8d41e07');
      const id = await antragId();
      await schalten(id, { status: 'freigegeben', ziel_commit: '8d41e07' });
      await schalten(id, { status: 'laeuft' });

      const antwort = await schalten(id, { status: 'fehlgeschlagen', grund: '  Fachmigration 0005 fehlt  ' });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.json().eingriff).toMatchObject({ status: 'fehlgeschlagen', grund: 'Fachmigration 0005 fehlt' });
      await expect(pool.query(`UPDATE cockpit.eingriff SET fehler_grund = 'anders' WHERE id = $1`, [id])).rejects.toThrow(/eingriff_fehler_grund/);
      const seite = await app.inject({ method: 'GET', url: '/einstellungen' });
      expect(seite.body).toContain('Fachmigration 0005 fehlt');
      expect(seite.body).toContain('Update fehlgeschlagen');
      expect(seite.body).toContain('id="ziel-test-update"');
    });

    it('weist einen zu langen Grund ab', async () => {
      await beantragen('8d41e07');
      const id = await antragId();
      await schalten(id, { status: 'freigegeben', ziel_commit: '8d41e07' });
      await schalten(id, { status: 'laeuft' });

      expect((await schalten(id, { status: 'fehlgeschlagen', grund: 'x'.repeat(301) })).json()).toEqual({ fehler: 'ungueltige_anfrage', felder: ['grund'] });
    });

    it('der Rückweg: die Version aus dem Commit davor läuft nach dem Update wieder ein', async () => {
      await beantragen('8d41e07');
      const id = await antragId();
      await schalten(id, { status: 'freigegeben', ziel_commit: '8d41e07' });
      await schalten(id, { status: 'laeuft' });
      await einspielen('test-update', HERKUNFT_ZIEL, 'Test-Update neu');

      const zurueck = await einspielen('test-update', HERKUNFT_VORHER);

      expect(zurueck).toMatchObject({ status: 'neu', version: 3, erledigt: undefined });
      const aktiv = await pool.query<{ herkunft: string }>(`SELECT herkunft FROM cockpit.modul WHERE kennung = 'test-update' AND aktiv`);
      expect(aktiv.rows[0]?.herkunft).toBe(HERKUNFT_VORHER);
    });
  });

  describe('Regeln in der Datenbank (Migration 0040)', () => {
    it('hält Modul, Ziel-Commit und Herkunft nach dem Antrag fest', async () => {
      await beantragen('8d41e07');
      const id = await antragId();

      await expect(pool.query(`UPDATE cockpit.eingriff SET ziel_commit = 'c0ffee1' WHERE id = $1`, [id])).rejects.toThrow(/eingriff_unveraenderlich/);
      await expect(pool.query(`UPDATE cockpit.eingriff SET modul_kennung = 'anders' WHERE id = $1`, [id])).rejects.toThrow(/eingriff_unveraenderlich/);
    });

    it('trennt die Arten: kein Modul-Antrag mit Digest, kein Image-Antrag mit Commit', async () => {
      await expect(
        pool.query(
          `INSERT INTO cockpit.eingriff (art, modul_kennung, ziel_commit, herkunft_vorher, ziel_digest, beantragt_von)
           VALUES ('modul', 'x', 'c0ffee1', 'h', $1, 'k')`,
          [`sha256:${'e7'.repeat(32)}`],
        ),
      ).rejects.toThrow(/eingriff_art_passt/);
      await expect(
        pool.query(
          `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, ziel_commit, beantragt_von) VALUES ('cockpit-image', $1, $1, 'c0ffee1', 'k')`,
          [`sha256:${'e7'.repeat(32)}`],
        ),
      ).rejects.toThrow(/eingriff_art_passt/);
      await expect(
        pool.query(`INSERT INTO cockpit.eingriff (art, modul_kennung, ziel_commit, herkunft_vorher, beantragt_von) VALUES ('modul', 'x', 'main', 'h', 'k')`),
      ).rejects.toThrow(/eingriff_art_passt/);
    });
  });

  describe('Update installieren (COPI-140)', () => {
    const WACHE = 'version-modul-test-update';
    const NEUER_COMMIT = 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffe';

    beforeEach(async () => {
      await pool.query(`DELETE FROM cockpit.befund WHERE wache = $1`, [WACHE]);
      await pool.query(`DELETE FROM cockpit.wache WHERE kennung = $1`, [WACHE]);
    });

    /** Die Versions-Wache meldet ein Ziel, gelb; ohne Ziel meldet sie grün. */
    async function wacheMeldet(ziel: string | undefined): Promise<void> {
      const ergebnis = await befundMelden(pool, {
        wache: WACHE,
        status: ziel === undefined ? 'gruen' : 'gelb',
        textIntern: ziel === undefined ? 'aktuell' : `Commit ${ziel.slice(0, 7)}`,
        kundensichtbar: false,
        taktSekunden: 3600,
        ...(ziel === undefined ? {} : { updateZiel: { art: 'modul', ziel, hinweis: 'Block geändert', seit: '2026-10-12T04:25:00+02:00' } }),
        quelle: 'test',
        jetzt: new Date(),
      });
      expect(ergebnis.ok).toBe(true);
    }

    function feld(seite: LightMyRequestResponse, name: string): string {
      return new RegExp(`name="${name}" value="([^"]*)"`).exec(seite.body)?.[1] ?? '';
    }

    function bestaetigen(seite: LightMyRequestResponse): Promise<LightMyRequestResponse> {
      const felder = ['modul', 'ziel', 'quelle', 'bis', 'token'].map((name) => [name, feld(seite, name)]);
      return senden('/einstellungen/modul-update/bestaetigen', Object.fromEntries(felder));
    }

    it('zeigt das Ziel an der Karte und führt mit einem Klick zur Bestätigung, ohne Eingabe', async () => {
      await wacheMeldet(ZIEL_COMMIT);

      const karte = await app.inject({ method: 'GET', url: '/einstellungen' });
      expect(karte.body).toContain('Update verfügbar: 8d41e07 · Block geändert · seit 12.10.2026');
      expect(karte.body).toContain('Update installieren');

      const seite = await senden('/einstellungen/modul-update', { modul: 'test-update', quelle: 'wache' });
      expect(seite.statusCode).toBe(200);
      expect(feld(seite, 'ziel')).toBe(ZIEL_COMMIT);
      expect(feld(seite, 'quelle')).toBe('wache');
      expect(await antraege()).toEqual([]);

      expect((await bestaetigen(seite)).statusCode).toBe(303);
      expect(await antraege()).toEqual([expect.objectContaining({ status: 'beantragt', ziel_commit: ZIEL_COMMIT, herkunft_vorher: HERKUNFT_VORHER })]);
    });

    it('nimmt kein Ziel an, das das Formular mitschickt: es gilt das der Wache', async () => {
      await wacheMeldet(ZIEL_COMMIT);

      const seite = await senden('/einstellungen/modul-update', { modul: 'test-update', quelle: 'wache', ziel: NEUER_COMMIT });

      expect(feld(seite, 'ziel')).toBe(ZIEL_COMMIT);
    });

    it('stellt keinen Antrag, wenn die Wache kein Ziel meldet', async () => {
      await wacheMeldet(undefined);

      const antwort = await senden('/einstellungen/modul-update', { modul: 'test-update', quelle: 'wache' });

      expect(antwort.statusCode).toBe(409);
      expect(antwort.body).toContain('Die Versions-Wache meldet kein Update mehr.');
      expect(await antraege()).toEqual([]);
    });

    it('macht die Bestätigung ungültig, wenn die Wache inzwischen ein anderes Ziel meldet, und zeigt das neue', async () => {
      await wacheMeldet(ZIEL_COMMIT);
      const seite = await senden('/einstellungen/modul-update', { modul: 'test-update', quelle: 'wache' });
      await wacheMeldet(NEUER_COMMIT);

      const neu = await bestaetigen(seite);

      expect(neu.statusCode).toBe(409);
      expect(neu.body).toContain('Die Versions-Wache meldet inzwischen ein anderes Ziel.');
      expect(feld(neu, 'ziel')).toBe(NEUER_COMMIT);
      expect(await antraege()).toEqual([]);

      expect((await bestaetigen(neu)).statusCode).toBe(303);
      expect(await antraege()).toEqual([expect.objectContaining({ ziel_commit: NEUER_COMMIT })]);
    });

    it('stellt keinen Antrag, wenn die Wache zwischen Bestätigung und Absenden kein Ziel mehr meldet', async () => {
      await wacheMeldet(ZIEL_COMMIT);
      const seite = await senden('/einstellungen/modul-update', { modul: 'test-update', quelle: 'wache' });
      await wacheMeldet(undefined);

      const antwort = await bestaetigen(seite);

      expect(antwort.statusCode).toBe(409);
      expect(await antraege()).toEqual([]);
    });

    it('zeigt bei einem offenen Antrag dessen Stand statt eines zweiten Knopfs', async () => {
      await wacheMeldet(ZIEL_COMMIT);
      await bestaetigen(await senden('/einstellungen/modul-update', { modul: 'test-update', quelle: 'wache' }));

      const karte = await app.inject({ method: 'GET', url: '/einstellungen' });

      expect(karte.body).not.toContain('Update installieren');
      expect(karte.body).toContain('wartet auf die Freigabe');
    });

    it('nimmt bei einer Herkunft außerhalb von module/ keinen Antrag an und verweist auf die Server-Konsole', async () => {
      await einspielen('test-update', `agent-blueprints@${VORHER_COMMIT}:agents/agent-admin.yaml`, 'Test-Update alt');
      await wacheMeldet(ZIEL_COMMIT);

      const karte = await app.inject({ method: 'GET', url: '/einstellungen' });
      const knopf = await senden('/einstellungen/modul-update', { modul: 'test-update', quelle: 'wache' });
      const notweg = await senden('/einstellungen/modul-update', { modul: 'test-update', ziel: ZIEL_COMMIT });

      expect(karte.body).toContain('Herkunft nicht unter module/: Update nur per Server-Konsole');
      expect(karte.body).not.toContain('Update installieren');
      expect(knopf.statusCode).toBe(409);
      expect(notweg.statusCode).toBe(409);
      expect(notweg.body).toContain('ein Update geht nur per Server-Konsole');
      expect(await antraege()).toEqual([]);
    });

    it('zeigt Kundenrollen weder Ziel noch Knopf und weist den Klick ab', async () => {
      await wacheMeldet(ZIEL_COMMIT);
      rolle = 'betriebs_admin';

      const karte = await app.inject({ method: 'GET', url: '/einstellungen' });
      const klick = await senden('/einstellungen/modul-update', { modul: 'test-update', quelle: 'wache' });

      expect(karte.body).not.toContain('Update installieren');
      expect(karte.body).not.toContain('nav-punkt');
      expect(klick.statusCode).toBe(403);
      expect(await antraege()).toEqual([]);
    });
  });
});
