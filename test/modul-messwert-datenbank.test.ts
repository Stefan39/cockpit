/**
 * Messwerte im Modul-Vertrag (COPI-83) gegen eine echte PostgreSQL: die optionalen Spalten `wert`, `einheit`,
 * `wert_max`, `wert_warnung` der Modul-View und `wert` der Verlaufs-View — Katalogprüfung (Typ genau, Fehlen erlaubt)
 * und Darstellung auf Dashboard-Karte und Modul-Kachel (Wert, Balken, Kurve, Warnlinie nur mit `wert_warnung`,
 * Einheit maskiert, Karte ohne Wert unverändert).
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Legt eigene Test-Tabellen und -Views an (Präfix `modul_mw_test_…` bzw.
 * `v_modul_test_mw…`) und entfernt sie am Ende; räumt `cockpit.modul` vor jedem Test. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { modulBlockAusText } from '../src/module/block.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { betreuerDarf } from './hilfen.js';
import { modulViewPruefen, verlaufViewPruefen } from '../src/module/registry.js';
import { buildApp } from '../src/server/app.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-28T07:50:00.000Z');
const STUNDE = 3_600_000;

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function block(opts: { readonly kennung: string; readonly view: string; readonly verlauf?: string; readonly darstellung?: 'kacheln' }): string {
  return [
    `kennung: ${opts.kennung}`,
    `menuename: "Messwert ${opts.kennung}"`,
    'ansicht: liste-detail',
    `view: ${opts.view}`,
    ...(opts.darstellung === undefined ? [] : [`darstellung: ${opts.darstellung}`]),
    'spalten:',
    '  - { name: titel, label: "Titel" }',
    '  - { name: text, label: "Meldung" }',
    'rollen: [betreuer, betriebs_admin]',
    'eingriffe: []',
    'uebersicht:',
    '  kurztext: text',
    ...(opts.verlauf === undefined ? [] : [`  verlauf: ${opts.verlauf}`]),
    '',
  ].join('\n');
}

describe.skipIf(!datenbankUrl)('Messwerte im Modul-Vertrag (COPI-83, echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE cockpit.modul_mw_test_quelle (
        id              text        PRIMARY KEY,
        titel           text        NOT NULL,
        status          text        NOT NULL,
        text            text        NOT NULL DEFAULT 'Meldung',
        aktualisiert_am timestamptz NOT NULL,
        wert            numeric,
        einheit         text,
        wert_max        numeric,
        wert_warnung    numeric
      );
      CREATE TABLE cockpit.modul_mw_test_verlauf (
        id        text        NOT NULL,
        zeitpunkt timestamptz NOT NULL,
        status    text        NOT NULL,
        wert      numeric
      );
      CREATE VIEW cockpit.v_modul_test_mw AS
        SELECT id, titel, status, aktualisiert_am, text, wert, einheit, wert_max, wert_warnung FROM cockpit.modul_mw_test_quelle;
      CREATE VIEW cockpit.v_modul_test_mw_ohne_warnung AS
        SELECT id, titel, status, aktualisiert_am, text, wert, einheit, wert_max FROM cockpit.modul_mw_test_quelle;
      CREATE VIEW cockpit.v_modul_test_mw_ohne AS
        SELECT id, titel, status, aktualisiert_am, text FROM cockpit.modul_mw_test_quelle;
      CREATE VIEW cockpit.v_modul_test_mw_wert_text AS
        SELECT id, titel, status, aktualisiert_am, text, wert::text AS wert FROM cockpit.modul_mw_test_quelle;
      CREATE VIEW cockpit.v_modul_test_mw_einheit_zahl AS
        SELECT id, titel, status, aktualisiert_am, text, wert, wert AS einheit FROM cockpit.modul_mw_test_quelle;
      CREATE VIEW cockpit.v_modul_test_mw_verlauf AS
        SELECT id, zeitpunkt, status, wert FROM cockpit.modul_mw_test_verlauf;
      CREATE VIEW cockpit.v_modul_test_mw_verlauf_text AS
        SELECT id, zeitpunkt, status, wert::text AS wert FROM cockpit.modul_mw_test_verlauf;
    `);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.modul_mw_test_quelle');
    await pool.query('DELETE FROM cockpit.modul_mw_test_verlauf');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query(`
      DROP VIEW IF EXISTS cockpit.v_modul_test_mw, cockpit.v_modul_test_mw_ohne_warnung, cockpit.v_modul_test_mw_ohne,
        cockpit.v_modul_test_mw_wert_text, cockpit.v_modul_test_mw_einheit_zahl, cockpit.v_modul_test_mw_verlauf,
        cockpit.v_modul_test_mw_verlauf_text;
      DROP TABLE IF EXISTS cockpit.modul_mw_test_quelle, cockpit.modul_mw_test_verlauf;
    `);
    await pool.end();
  });

  function geparst(view: string, verlauf?: string) {
    const ergebnis = modulBlockAusText(block({ kennung: 'probe', view, ...(verlauf === undefined ? {} : { verlauf }) }));
    if (!ergebnis.ok) {
      throw new Error(ergebnis.grund);
    }
    return ergebnis.block;
  }

  describe('Katalogprüfung', () => {
    it('nimmt die Messwert-Spalten mit genau den richtigen Typen an und nennt sie', async () => {
      expect(await modulViewPruefen(pool, geparst('v_modul_test_mw'))).toEqual({
        ok: true,
        optionale: ['wert', 'einheit', 'wert_max', 'wert_warnung'],
      });
      expect(await verlaufViewPruefen(pool, geparst('v_modul_test_mw', 'v_modul_test_mw_verlauf'))).toEqual({ ok: true, optionale: ['wert'] });
    });

    it('nimmt eine View ohne Messwert-Spalten an wie bisher', async () => {
      expect(await modulViewPruefen(pool, geparst('v_modul_test_mw_ohne'))).toEqual({ ok: true });
    });

    it('lehnt wert text ab, mit Spalte und erwartetem Typ in der Meldung — auch beim Einspielen', async () => {
      const ergebnis = await modulViewPruefen(pool, geparst('v_modul_test_mw_wert_text'));
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toBe('Die Spalte wert in cockpit.v_modul_test_mw_wert_text hat den Typ text, erwartet numeric.');

      const eingespielt = await modulEinspielen(pool, { rohtext: block({ kennung: 'wert-text', view: 'v_modul_test_mw_wert_text' }), akteur: 'konsole' });
      expect(eingespielt.ok).toBe(false);
    });

    it('lehnt eine Einheit als Zahl und einen Verlaufswert als Text ab', async () => {
      const einheit = await modulViewPruefen(pool, geparst('v_modul_test_mw_einheit_zahl'));
      expect(!einheit.ok && einheit.grund).toContain('einheit');

      const verlauf = await verlaufViewPruefen(pool, geparst('v_modul_test_mw', 'v_modul_test_mw_verlauf_text'));
      expect(!verlauf.ok && verlauf.grund).toContain('erwartet numeric');
    });
  });

  describe('Darstellung', () => {
    async function einspielen(opts: Parameters<typeof block>[0]): Promise<void> {
      const ergebnis = await modulEinspielen(pool, { rohtext: block(opts), akteur: 'konsole' });
      if (!ergebnis.ok) {
        throw new Error(ergebnis.grund);
      }
      await betreuerDarf(pool, ergebnis.kennung);
    }

    async function zeile(werte: { id: string; titel: string; status: string; wert?: number; einheit?: string; max?: number; warnung?: number }) {
      await pool.query(
        `INSERT INTO cockpit.modul_mw_test_quelle (id, titel, status, aktualisiert_am, wert, einheit, wert_max, wert_warnung)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [werte.id, werte.titel, werte.status, JETZT, werte.wert ?? null, werte.einheit ?? null, werte.max ?? null, werte.warnung ?? null],
      );
    }

    async function verlauf(id: string, punkte: readonly (readonly [number, number | null])[]) {
      for (const [stundenVor, wert] of punkte) {
        await pool.query(`INSERT INTO cockpit.modul_mw_test_verlauf (id, zeitpunkt, status, wert) VALUES ($1, $2, 'gruen', $3)`, [
          id,
          new Date(JETZT.getTime() - stundenVor * STUNDE),
          wert,
        ]);
      }
    }

    async function seite(url: string, rolle: Rolle): Promise<string> {
      const zugang: Zugang = { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
      const app: FastifyInstance = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugang) });
      try {
        const antwort = await app.inject({ method: 'GET', url });
        expect(antwort.statusCode).toBe(200);
        return antwort.body;
      } finally {
        await app.close();
      }
    }

    it('zeigt auf der Dashboard-Karte Wert, Bezug, Balken und die 24-Std.-Kurve statt des Bands', async () => {
      await einspielen({ kennung: 'platte', view: 'v_modul_test_mw', verlauf: 'v_modul_test_mw_verlauf' });
      await zeile({ id: 'p', titel: 'Plattenplatz', status: 'gelb', wert: 86, einheit: '%', max: 100, warnung: 85 });
      await verlauf('p', [
        [30, 70],
        [20, 80],
        [10, null],
        [0, 86],
      ]);

      const html = await seite('/', 'betriebs_admin');

      expect(html).toMatch(/class="messwert-wert messwert-wert-gelb">86<\/span> <span class="messwert-einheit">%<\/span>/);
      expect(html).toContain('von 100 %');
      expect(html).toContain('width="86%"');
      expect(html).toContain('class="kurve kurve-gelb kurve-karte"');
      expect(html).toContain('aria-label="Plattenplatz, letzte 24 Stunden: 80 – 86 %, aktuell 86 %"');
      expect(html).toContain('<span>80 – 86 %</span>');
      expect(html).not.toContain('band-karte');
      // Die Warnlinie gehört zur Kachel, nicht zur kleinen Karte.
      expect(html).not.toContain('kurve-warnlinie');
    });

    it('lässt eine Karte ohne wert genau wie bisher: Band, keine Kurve, kein Balken', async () => {
      await einspielen({ kennung: 'ohne-wert', view: 'v_modul_test_mw', verlauf: 'v_modul_test_mw_verlauf' });
      await zeile({ id: 'd', titel: 'Datensicherung', status: 'gelb' });
      await verlauf('d', [[2, null]]);

      const html = await seite('/', 'betriebs_admin');

      expect(html).toContain('class="band band-karte"');
      expect(html).not.toContain('class="messwert');
      expect(html).not.toContain('class="kurve');
    });

    it('zeigt auf der Kachel den aktuellen Wert, die 7-Tage-Kurve mit min/max und die Warnlinie bei wert_warnung', async () => {
      await einspielen({ kennung: 'kachel-warn', view: 'v_modul_test_mw', verlauf: 'v_modul_test_mw_verlauf', darstellung: 'kacheln' });
      await zeile({ id: 'p', titel: 'Plattenplatz', status: 'gelb', wert: 86, einheit: '%', max: 100, warnung: 85 });
      await verlauf('p', [
        [150, 71],
        [0, 86],
      ]);

      const html = await seite('/module/kachel-warn', 'betriebs_admin');

      expect(html).toContain('class="messwert-kachel-wert messwert-wert-gelb">86</span>');
      expect(html).toContain('aktuell');
      expect(html).toContain('min. 71 % · max. 86 %');
      expect(html).toContain('class="kurve kurve-gelb kurve-kachel"');
      expect(html).toContain('class="kurve-warnlinie"');
      expect(html).toContain('class="kurve-tage"');
      expect(html).toContain('class="band band-kachel-schmal"');
    });

    it('zeichnet ohne wert_warnung keine Warnlinie', async () => {
      await einspielen({ kennung: 'kachel-ohne-warn', view: 'v_modul_test_mw_ohne_warnung', verlauf: 'v_modul_test_mw_verlauf', darstellung: 'kacheln' });
      await zeile({ id: 'p', titel: 'Plattenplatz', status: 'gruen', wert: 50, einheit: '%', max: 100, warnung: 85 });
      await verlauf('p', [
        [5, 40],
        [0, 50],
      ]);

      const html = await seite('/module/kachel-ohne-warn', 'betreuer');

      expect(html).toContain('class="kurve kurve-gruen kurve-kachel"');
      expect(html).not.toContain('kurve-warnlinie');
    });

    it('maskiert die Einheit überall, auch in der Textalternative', async () => {
      await einspielen({ kennung: 'fremd', view: 'v_modul_test_mw', verlauf: 'v_modul_test_mw_verlauf', darstellung: 'kacheln' });
      await zeile({ id: 'x', titel: 'Fremd', status: 'gelb', wert: 1, einheit: '<b>"x"</b>' });
      await verlauf('x', [
        [3, 1],
        [0, 1],
      ]);

      for (const url of ['/', '/module/fremd']) {
        const html = await seite(url, 'betreuer');
        expect(html).not.toContain('<b>"x"</b>');
        expect(html).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
      }
    });

    it('zeigt nach einer nachträglich falschen Messwert-Spalte keine Daten mehr (Prüfung vor jedem Lesen)', async () => {
      await pool.query(`CREATE VIEW cockpit.v_modul_test_mw_wechsel AS
        SELECT id, titel, status, aktualisiert_am, text, wert FROM cockpit.modul_mw_test_quelle`);
      try {
        await einspielen({ kennung: 'wechsel', view: 'v_modul_test_mw_wechsel' });
        await zeile({ id: 'p', titel: 'Plattenplatz', status: 'gelb', wert: 50 });
        expect(await seite('/', 'betreuer')).toContain('messwert-wert');

        await pool.query(`DROP VIEW cockpit.v_modul_test_mw_wechsel`);
        await pool.query(`CREATE VIEW cockpit.v_modul_test_mw_wechsel AS
          SELECT id, titel, status, aktualisiert_am, text, wert::text AS wert FROM cockpit.modul_mw_test_quelle`);

        const html = await seite('/', 'betreuer');
        expect(html).toContain('Dieses Modul ist gerade nicht verfügbar.');
        expect(html).not.toContain('messwert-wert');
      } finally {
        await pool.query('DELETE FROM cockpit.modul');
        await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_test_mw_wechsel');
      }
    });
  });
});
