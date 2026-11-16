/**
 * Versionen sichtbar (COPI-84) mit echten Sitzungen je Rolle gegen die echte Datenbank: die Cockpit-Version in Sidebar
 * und auf „Mehr" (alle Rollen), der Hinweis „Update verfügbar" (nur Betreuer, nur bei gelbem Befund der Versions-Wache)
 * und die Modul-Version auf `/module` und im Kopf der Modulseite.
 *
 * Läuft nur mit `TEST_DATABASE_URL`, legt eine eigene Test-Tabelle und -View an (Präfix `v_modul_test_…`), räumt
 * `cockpit.modul`, `cockpit.befund` und `cockpit.wache` und entfernt sie am Ende. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle } from '../src/auth/berechtigung.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { instanzMelden } from '../src/status/instanz-speicher.js';
import { updateHinweisLesen, updateInstallierbarLesen } from '../src/status/update-hinweis.js';
import { kontenLoeschen, kontoEinrichten, betreuerDarf } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const PASSWORT = 'ein-ausreichend-langes-passwort';
const BASIS_URL = 'http://localhost:3000';
const JETZT = new Date('2026-09-29T12:00:00.000Z');
const WACHEN_TEXT = 'verfügbar: 0.7.0 <b>neu</b>';

const BLOCK = [
  'kennung: version-anzeige',
  'menuename: "Versions-Modul"',
  'ansicht: liste-detail',
  'view: v_modul_test_version',
  'spalten:',
  '  - { name: titel, label: "Titel" }',
  '  - { name: status, label: "Status" }',
  '  - { name: aktualisiert_am, label: "Zuletzt", format: zeitpunkt }',
  'rollen: [betreuer, betriebs_admin, betrieb_mitarbeiter]',
  'eingriffe: []',
  '',
].join('\n');

type Name = 'mitarbeiter' | 'admin' | 'betreuer';

describe.skipIf(!datenbankUrl)('Versionen sichtbar (echte Datenbank, echte Sitzungen)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let ohneVersion: FastifyInstance;
  let einrichtung: FastifyInstance;
  const cookies: Record<Name, string> = { mitarbeiter: '', admin: '', betreuer: '' };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query(`
      CREATE TABLE cockpit.modul_version_test_quelle (id text PRIMARY KEY, titel text NOT NULL, status text NOT NULL, aktualisiert_am timestamptz NOT NULL DEFAULT now());
      CREATE VIEW cockpit.v_modul_test_version AS SELECT id, titel, status, aktualisiert_am FROM cockpit.modul_version_test_quelle;
    `);
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test', imageVersion: '0.6.0+0620cc9' }, { auth, pool, basisUrl: BASIS_URL, jetzt: () => JETZT });
    ohneVersion = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, jetzt: () => JETZT });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();
    await ohneVersion.ready();

    const rollen: Record<Name, Rolle> = { mitarbeiter: 'betrieb_mitarbeiter', admin: 'betriebs_admin', betreuer: 'betreuer' };
    for (const name of Object.keys(cookies) as Name[]) {
      const konto = await kontoEinrichten(einrichtung, auth, { email: `${name}-version@example.org`, passwort: PASSWORT, name, mitZweitemFaktor: true });
      cookies[name] = konto.cookie;
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rollen[name]]);
    }
    // Zweimal: Version 2 ist die aktive.
    for (const rohtext of [BLOCK, `${BLOCK}# zweite Fassung\n`]) {
      const ergebnis = await modulEinspielen(pool, { rohtext, akteur: 'konsole' });
      expect(ergebnis.ok).toBe(true);
    }
    await betreuerDarf(pool, 'version-anzeige');
  }, 90_000);

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
  });

  afterAll(async () => {
    await app.close();
    await ohneVersion.close();
    await einrichtung.close();
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.instanz');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_test_version; DROP TABLE IF EXISTS cockpit.modul_version_test_quelle;');
    await kontenLoeschen(pool);
    await pool.end();
  });

  const holen = (instanz: FastifyInstance, url: string, name: Name) => instanz.inject({ method: 'GET', url, headers: { cookie: cookies[name] } });

  async function wacheMelden(status: 'gruen' | 'gelb' | 'rot'): Promise<void> {
    await befundMelden(pool, {
      wache: 'version-cockpit',
      status,
      textIntern: WACHEN_TEXT,
      kundensichtbar: false,
      taktSekunden: 7 * 86_400,
      quelle: 'admin-agent',
      jetzt: JETZT,
    });
  }

  describe('Cockpit-Version', () => {
    it.each<Name>(['betreuer', 'admin', 'mitarbeiter'])('steht für %s in der Sidebar und auf „Mehr", ohne den Commit', async (name) => {
      for (const url of ['/', '/mehr']) {
        const { body } = await holen(app, url, name);
        expect(body, `${name} ${url}`).toContain('Cockpit v0.6.0');
        expect(body, `${name} ${url}`).not.toContain('0620cc9');
      }
    });

    it('steht auf „Mehr" in einer Zeile, die am Desktop ausgeblendet ist', async () => {
      const { body } = await holen(app, '/mehr', 'admin');
      expect(body).toContain('versionszeile versionszeile-mobil');
    });

    it('entfällt ohne gesetzte Version', async () => {
      for (const url of ['/', '/mehr']) {
        const { body } = await holen(ohneVersion, url, 'betreuer');
        expect(body, url).not.toContain('versionszeile');
      }
    });
  });

  describe('Hinweis „Update verfügbar"', () => {
    it('erscheint für den Betreuer bei gelbem Befund, als Link zu den Einstellungen mit Text und Tooltip (escaped)', async () => {
      await wacheMelden('gelb');

      for (const url of ['/', '/mehr']) {
        const { body } = await holen(app, url, 'betreuer');
        expect(body, url).toContain('<a href="/einstellungen" class="update-hinweis"');
        expect(body, url).toContain('<span class="sr-only">Update verfügbar</span>');
        expect(body, url).toContain('Update verfügbar: verfügbar: 0.7.0 &lt;b&gt;neu&lt;/b&gt;');
        expect(body, url).not.toContain('<b>neu</b>');
      }
    });

    it.each<'gruen' | 'rot'>(['gruen', 'rot'])('erscheint für den Betreuer nicht bei %s', async (status) => {
      await wacheMelden(status);
      const { body } = await holen(app, '/mehr', 'betreuer');
      expect(body).not.toContain('update-hinweis');
    });

    it('erscheint für den Betreuer nicht ohne Befund', async () => {
      const { body } = await holen(app, '/mehr', 'betreuer');
      expect(body).not.toContain('update-hinweis');
    });

    it.each<Name>(['admin', 'mitarbeiter'])('erscheint für %s auch bei gelbem Befund nicht, die Version aber schon', async (name) => {
      await wacheMelden('gelb');
      for (const url of ['/', '/mehr']) {
        const { body } = await holen(app, url, name);
        expect(body, url).not.toContain('update-hinweis');
        expect(body, url).not.toContain('0.7.0');
        expect(body, url).toContain('Cockpit v0.6.0');
      }
    });

    it('liefert bei einer gescheiterten Abfrage keinen Hinweis, nur eine Warnung im Log', async () => {
      const zugang = { angemeldet: true, rolle: 'betreuer', zweiterFaktorAktiv: true, benutzerId: 'x' } as const;
      const warnungen: string[] = [];
      const kaputt = { query: () => Promise.reject(new Error('Verbindung weg')) } as unknown as pg.Pool;

      const ergebnis = await updateHinweisLesen(kaputt, zugang, { warn: (_objekt, nachricht) => void warnungen.push(nachricht) });

      expect(ergebnis).toBeUndefined();
      expect(warnungen).toHaveLength(1);
      expect(warnungen[0]).not.toContain('Verbindung weg');
    });
  });

  describe('Hinweispunkt an „Einstellungen" (COPI-140)', () => {
    const LAUFEND = `sha256:${'9f'.repeat(32)}`;
    const ZIEL = { art: 'cockpit', ziel: `sha256:${'ab'.repeat(32)}`, version: '0.7.0', seit: '2026-09-28T10:00:00+02:00' };

    async function zielMelden(ziel: Readonly<Record<string, string>>): Promise<void> {
      await instanzMelden(pool, { version: '0.6.0', digest: LAUFEND }, JETZT);
      await befundMelden(pool, {
        wache: 'version-cockpit',
        status: 'gelb',
        textIntern: WACHEN_TEXT,
        kundensichtbar: false,
        taktSekunden: 7 * 86_400,
        updateZiel: ziel,
        quelle: 'admin-agent',
        jetzt: JETZT,
      });
    }

    it('steht für den Betreuer, solange eine Karte „Update installieren" anbietet', async () => {
      await zielMelden(ZIEL);

      for (const url of ['/', '/mehr', '/einstellungen']) {
        const { body } = await holen(app, url, 'betreuer');
        expect(body, url).toContain('class="nav-punkt"');
      }
    });

    it('fehlt, wenn das gemeldete Ziel schon läuft', async () => {
      await zielMelden({ ...ZIEL, ziel: LAUFEND });

      const { body } = await holen(app, '/mehr', 'betreuer');
      expect(body).not.toContain('nav-punkt');
    });

    it.each<Name>(['admin', 'mitarbeiter'])('fehlt für %s', async (name) => {
      await zielMelden(ZIEL);

      for (const url of ['/', '/mehr']) {
        const { body } = await holen(app, url, name);
        expect(body, url).not.toContain('nav-punkt');
      }
    });

    it('liefert bei einer gescheiterten Abfrage keinen Punkt, nur eine Warnung im Log', async () => {
      const zugang = { angemeldet: true, rolle: 'betreuer', zweiterFaktorAktiv: true, benutzerId: 'x' } as const;
      const warnungen: string[] = [];
      const kaputt = { query: () => Promise.reject(new Error('Verbindung weg')) } as unknown as pg.Pool;

      expect(await updateInstallierbarLesen(kaputt, zugang, JETZT, { warn: (_objekt, nachricht) => void warnungen.push(nachricht) })).toBe(false);
      expect(warnungen).toEqual(['Update-Hinweis: Versionen konnten nicht gelesen werden']);
    });
  });

  describe('Modul-Version', () => {
    it('steht auf /module je Modul', async () => {
      const { body } = await holen(app, '/module', 'admin');
      expect(body).toContain('Versions-Modul');
      expect(body).toContain('Version 2');
    });

    it('steht im Kopf der Modulseite mit Datum, als sichtbarer Text', async () => {
      const { body } = await holen(app, '/module/version-anzeige', 'admin');
      expect(body).toMatch(/<p class="seiten-unterzeile">Version 2 · eingespielt am \d{2}\.\d{2}\.\d{4}<\/p>/);
    });

    it('steht auch im Kopf der Detailseite einer Zeile', async () => {
      await pool.query(`INSERT INTO cockpit.modul_version_test_quelle (id, titel, status) VALUES ('z1', 'Eintrag', 'gruen')`);
      const { body, statusCode } = await holen(app, '/module/version-anzeige/z1', 'betreuer');
      expect(statusCode).toBe(200);
      expect(body).toContain('class="seiten-unterzeile">Version 2 · eingespielt am');
      await pool.query('DELETE FROM cockpit.modul_version_test_quelle');
    });
  });
});
