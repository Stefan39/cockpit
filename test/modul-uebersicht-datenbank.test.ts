/**
 * Das Dashboard der Übersicht (COPI-81) gegen eine echte PostgreSQL: die Katalogprüfung der Verlaufs-View und die
 * Route `GET /` mit Modulen, die `uebersicht:` anmelden.
 *
 * Kernzusagen: Der Betriebs-Admin sieht die Karten, aber nirgends einen `text_intern`; ein Mitarbeiter ohne Rolle
 * im Modul sieht den Abschnitt nicht (und damit die bisherige Übersicht); nur der Betreuer sieht zusätzlich
 * „Alle Wachen · nur Betreuer"; Titel und Kurztext werden escaped; eine kaputte Verlaufs-View lässt die Karten
 * stehen, nur die Bänder bleiben neutral.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Legt eigene Test-Tabellen und -Views an (`uebersicht_test_…`,
 * `v_modul_test_ueb…`) und entfernt sie am Ende; räumt `cockpit.modul`, `cockpit.befund` und `cockpit.wache`.
 * Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { modulBlockAusText } from '../src/module/block.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { betreuerDarf } from './hilfen.js';
import { katalogPruefen, verlaufViewPruefen } from '../src/module/registry.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-28T08:02:00.000Z');
const STUNDE = 3_600_000;
const GEHEIM = 'GEHEIM-INTERN-0815';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function zugangMit(rolle: Rolle | undefined): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
}

/** Ein Block gegen die Test-View, mit `uebersicht:` und variabler Verlaufs-View und Rollen. */
function block(kennung: string, verlauf: string | undefined, rollen: readonly string[] = ['betreuer', 'betriebs_admin']): string {
  return [
    `kennung: ${kennung}`,
    `menuename: "Dienste ${kennung}"`,
    'ansicht: liste-detail',
    'view: v_modul_test_ueb',
    'spalten:',
    '  - { name: titel, label: "Titel" }',
    '  - { name: text, label: "Text" }',
    `rollen: [${rollen.join(', ')}]`,
    'eingriffe: []',
    'uebersicht:',
    `  titel: "Kacheln ${kennung}"`,
    '  kurztext: text',
    ...(verlauf === undefined ? [] : [`  verlauf: ${verlauf}`]),
    '',
  ].join('\n');
}

describe.skipIf(!datenbankUrl)('Dashboard der Übersicht (echte Datenbank)', () => {
  let pool: pg.Pool;

  const VERLAUF_OK = `
    CREATE OR REPLACE VIEW cockpit.v_modul_test_ueb_verlauf AS
      SELECT id, zeitpunkt, status FROM cockpit.uebersicht_test_verlauf`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE cockpit.uebersicht_test_quelle (
        id              text        PRIMARY KEY,
        titel           text        NOT NULL,
        status          text        NOT NULL,
        text_kunde      text        NOT NULL,
        text_intern     text        NOT NULL,
        aktualisiert_am timestamptz NOT NULL
      );
      CREATE TABLE cockpit.uebersicht_test_verlauf (
        id          text        NOT NULL,
        zeitpunkt   timestamptz NOT NULL,
        status      text        NOT NULL,
        text_intern text        NOT NULL DEFAULT '${GEHEIM}'
      );
      CREATE VIEW cockpit.v_modul_test_ueb AS
        SELECT id, titel, status, aktualisiert_am, text_kunde AS text FROM cockpit.uebersicht_test_quelle;
      CREATE VIEW cockpit.v_modul_test_ueb_verlauf AS
        SELECT id, zeitpunkt, status FROM cockpit.uebersicht_test_verlauf;
      CREATE VIEW cockpit.v_modul_test_ueb_ohne_status AS
        SELECT id, zeitpunkt FROM cockpit.uebersicht_test_verlauf;
      CREATE VIEW cockpit.v_modul_test_ueb_falscher_typ AS
        SELECT id, zeitpunkt::timestamp AS zeitpunkt, status FROM cockpit.uebersicht_test_verlauf;
      CREATE VIEW cockpit.v_modul_test_ueb_intern AS
        SELECT id, zeitpunkt, status, text_intern AS hinweis FROM cockpit.uebersicht_test_verlauf;
      CREATE VIEW cockpit.v_modul_test_ueb_zwischen AS
        SELECT id, zeitpunkt, status FROM cockpit.v_modul_test_ueb_verlauf;
    `);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DELETE FROM cockpit.uebersicht_test_quelle');
    await pool.query('DELETE FROM cockpit.uebersicht_test_verlauf');
    await pool.query(VERLAUF_OK);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query(`
      DROP VIEW IF EXISTS cockpit.v_modul_test_ueb_zwischen;
      DROP VIEW IF EXISTS cockpit.v_modul_test_ueb_intern;
      DROP VIEW IF EXISTS cockpit.v_modul_test_ueb_falscher_typ;
      DROP VIEW IF EXISTS cockpit.v_modul_test_ueb_ohne_status;
      DROP VIEW IF EXISTS cockpit.v_modul_test_ueb_verlauf;
      DROP VIEW IF EXISTS cockpit.v_modul_test_ueb;
      DROP TABLE IF EXISTS cockpit.uebersicht_test_verlauf;
      DROP TABLE IF EXISTS cockpit.uebersicht_test_quelle;
    `);
    await pool.end();
  });

  async function einspielen(kennung: string, verlauf: string | undefined = 'v_modul_test_ueb_verlauf', rollen?: readonly string[]): Promise<void> {
    const ergebnis = await modulEinspielen(pool, { rohtext: block(kennung, verlauf, rollen), akteur: 'konsole' });
    if (!ergebnis.ok) {
      throw new Error(ergebnis.grund);
    }
    await betreuerDarf(pool, kennung);
  }

  async function zeile(id: string, titel: string, status: string, text = `${titel}: Klartext`): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit.uebersicht_test_quelle (id, titel, status, text_kunde, text_intern, aktualisiert_am) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, titel, status, text, GEHEIM, new Date(JETZT.getTime() - 12 * 60_000)],
    );
  }

  async function verlauf(id: string, stundenVor: number, status: string): Promise<void> {
    await pool.query(`INSERT INTO cockpit.uebersicht_test_verlauf (id, zeitpunkt, status) VALUES ($1, $2, $3)`, [
      id,
      new Date(JETZT.getTime() - stundenVor * STUNDE),
      status,
    ]);
  }

  async function seite(rolle: Rolle | undefined): Promise<{ html: string; status: number }> {
    const app: FastifyInstance = buildApp(
      { nodeEnv: 'test' },
      { pool, jetzt: () => JETZT, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugangMit(rolle)) },
    );
    try {
      const antwort = await app.inject({ method: 'GET', url: '/' });
      return { html: antwort.body, status: antwort.statusCode };
    } finally {
      await app.close();
    }
  }

  describe('Katalogprüfung der Verlaufs-View', () => {
    async function geprueft(view: string, rollen: readonly string[] = ['betreuer', 'betriebs_admin']) {
      const geparst = modulBlockAusText(block('probe', view, rollen));
      if (!geparst.ok) {
        throw new Error(geparst.grund);
      }
      return { verlauf: await verlaufViewPruefen(pool, geparst.block), gesamt: await katalogPruefen(pool, geparst.block) };
    }

    it('nimmt eine passende Verlaufs-View an', async () => {
      expect(await geprueft('v_modul_test_ueb_verlauf')).toEqual({ verlauf: { ok: true }, gesamt: { ok: true } });
    });

    it('lehnt eine fehlende Verlaufs-View ab — auch beim Einspielen', async () => {
      const { gesamt } = await geprueft('v_modul_test_ueb_gibt_es_nicht');
      expect(gesamt.ok).toBe(false);
      expect(!gesamt.ok && gesamt.grund).toContain('v_modul_test_ueb_gibt_es_nicht');

      const ergebnis = await modulEinspielen(pool, { rohtext: block('ohne-verlauf', 'v_modul_test_ueb_gibt_es_nicht'), akteur: 'konsole' });
      expect(ergebnis.ok).toBe(false);
      const aktiv = await pool.query(`SELECT 1 FROM cockpit.modul WHERE kennung = 'ohne-verlauf'`);
      expect(aktiv.rowCount).toBe(0);
    });

    it('lehnt eine Verlaufs-View ohne Pflichtspalte status ab', async () => {
      const { verlauf: ergebnis } = await geprueft('v_modul_test_ueb_ohne_status');
      expect(!ergebnis.ok && ergebnis.grund).toContain('status');
    });

    it('lehnt zeitpunkt ohne Zeitzone ab (Typ genau)', async () => {
      const { verlauf: ergebnis } = await geprueft('v_modul_test_ueb_falscher_typ');
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('zeitpunkt');
      expect(!ergebnis.ok && ergebnis.grund).toContain('timestamp with time zone');
    });

    it('lehnt text_intern ab, sobald eine Kundenrolle das Modul sieht — für den Betreuer allein ist es erlaubt', async () => {
      const kunde = await geprueft('v_modul_test_ueb_intern');
      expect(!kunde.verlauf.ok && kunde.verlauf.grund).toContain('text_intern');

      const betreuer = await geprueft('v_modul_test_ueb_intern', ['betreuer']);
      expect(betreuer.verlauf).toEqual({ ok: true });
    });

    it('lehnt für Kundenrollen eine Zwischen-View ab (text_intern ließe sich sonst tarnen)', async () => {
      const { verlauf: ergebnis } = await geprueft('v_modul_test_ueb_zwischen');
      expect(!ergebnis.ok && ergebnis.grund).toContain('baut auf der View');
    });
  });

  describe('GET / mit Modul-Karten', () => {
    it('zeigt dem Betriebs-Admin Zustandsband, Kennzahlen, Karten und Bänder — ohne jeden text_intern', async () => {
      await einspielen('dienste');
      await zeile('web', 'Webserver', 'rot', 'Antwortet nicht.');
      await zeile('mail', 'Mail', 'gruen');
      await verlauf('web', 30, 'gruen');
      await verlauf('web', 2.5, 'rot');
      await verlauf('mail', 30, 'gruen');
      await befundMelden(pool, { wache: 'wache-x', status: 'rot', textIntern: GEHEIM, kundensichtbar: false, taktSekunden: 300, quelle: 'test', jetzt: JETZT });

      const { html, status } = await seite('betriebs_admin');

      expect(status).toBe(200);
      expect(html).toContain('Stand: heute, 10:02');
      // Den Stand trägt nur der Seitenkopf (COPI-109): je eine Zeile für mobil und Desktop, keine zweite im Dashboard.
      expect(html.match(/Stand: heute, 10:02/g)).toHaveLength(2);
      expect(html).toContain('seiten-stand-zeile-mobil">Stand: heute, 10:02');
      expect(html).toContain('seiten-stand-zeile-desktop">Stand: heute, 10:02');
      expect(html).toContain('class="statuszeile statuszeile-rot"');
      expect(html).toContain('1 Störung');
      expect(html).toContain('Webserver: Antwortet nicht.');
      expect(html).toContain('href="/module/dienste/web?von=uebersicht"');
      expect(html).toContain('Dienste in Ordnung');
      expect(html).toContain('1 von 2');
      expect(html).toContain('Kacheln dienste');
      expect(html).toContain('href="/module/dienste?von=uebersicht"');
      expect(html).toContain('class="band-rot"');
      expect(html).toContain('class="band-gruen"');
      expect(html).toContain('Zustand der letzten 7 Tage');
      expect(html).not.toContain(GEHEIM);
      expect(html).not.toContain('Alle Wachen · nur Betreuer');
      expect(html).not.toContain('wache-x');
    });

    it('zeigt einem Mitarbeiter ohne Rolle im Modul den Abschnitt nicht — die Übersicht bleibt wie bisher', async () => {
      await einspielen('dienste');
      await zeile('web', 'Webserver', 'rot');

      const { html } = await seite('betrieb_mitarbeiter');

      expect(html).not.toContain('Webserver');
      expect(html).not.toContain('Dienste in Ordnung');
      expect(html).not.toContain('class="statuszeile');
      expect(html).toContain('class="status status-leer"');
    });

    it('zeigt dem Betreuer zusätzlich „Alle Wachen · nur Betreuer" mit den Rohbefunden', async () => {
      await einspielen('dienste');
      await zeile('web', 'Webserver', 'gruen');
      await befundMelden(pool, { wache: 'wache-x', status: 'rot', textIntern: GEHEIM, kundensichtbar: false, taktSekunden: 300, quelle: 'test', jetzt: JETZT });

      const { html } = await seite('betreuer');

      expect(html).toContain('Webserver');
      expect(html).toContain('Alle Wachen · nur Betreuer');
      expect(html).toContain(GEHEIM);
    });

    it('escaped Titel und Kurztext aus der Fach-View und verlinkt nichts daraus', async () => {
      await einspielen('dienste');
      await zeile('boese', '<script>alert(1)</script>', 'rot', '<a href="https://boese.example">Link</a>');

      const { html } = await seite('betriebs_admin');

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<a href="https://boese.example">');
      expect(html).toContain('&lt;a href=');
    });

    it('bleibt ohne Modul mit uebersicht: genau wie bisher', async () => {
      const { html } = await seite('betriebs_admin');

      expect(html).not.toContain('class="statuszeile');
      expect(html).not.toContain('Dienste in Ordnung');
      expect(html).toContain('Noch keine Meldungen');
    });

    it('zeigt bei einer kaputten Verlaufs-View die Karten trotzdem, nur die Bänder bleiben neutral', async () => {
      await einspielen('dienste');
      await zeile('web', 'Webserver', 'rot');
      await verlauf('web', 2, 'rot');
      // Nachträglich gegen den Vertrag verändert: text_intern in einer Kundensicht.
      await pool.query(`
        CREATE OR REPLACE VIEW cockpit.v_modul_test_ueb_verlauf AS
          SELECT id, zeitpunkt, status FROM cockpit.uebersicht_test_verlauf WHERE text_intern IS NOT NULL`);

      const { html, status } = await seite('betriebs_admin');

      expect(status).toBe(200);
      expect(html).toContain('Webserver');
      expect(html).toContain('pille pille-rot');
      expect(html).toContain('class="band-leer"');
      expect(html).not.toContain('class="band-rot"');
      expect(html).toContain('keine Daten');
      expect(html).not.toContain(GEHEIM);
    });

    it('zeigt ein Modul mit nicht lesbarer Modul-View als „nicht verfügbar", ohne die Seite scheitern zu lassen', async () => {
      await einspielen('dienste');
      await pool.query(`ALTER VIEW cockpit.v_modul_test_ueb RENAME TO v_modul_test_ueb_weg`);
      try {
        const { html, status } = await seite('betriebs_admin');
        expect(status).toBe(200);
        expect(html).toContain('Dieses Modul ist gerade nicht verfügbar.');
      } finally {
        await pool.query(`ALTER VIEW cockpit.v_modul_test_ueb_weg RENAME TO v_modul_test_ueb`);
      }
    });
  });
});
