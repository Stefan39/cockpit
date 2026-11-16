/**
 * `modulEinspielen`, `katalogPruefen` und `aktiveModule` gegen eine echte PostgreSQL (COPI-77).
 *
 * Der Katalog braucht eine echte View mit echten Spalten — das lässt sich nicht mit einer
 * Fake-Datenbank prüfen. Diese Datei legt dafür eine eigene Quelltabelle und mehrere Test-Views an
 * (Präfix `v_modul_test_`) und entfernt sie am Ende wieder; die Registry selbst (`cockpit.modul`) wird
 * vor jedem Test geleert.
 *
 * Läuft nur mit `TEST_DATABASE_URL` (echte PostgreSQL). Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modulBlockAusText } from '../src/module/block.js';
import { aktiveModule, modulEinspielen, pruefsummeBerechnen } from '../src/module/modul-speicher.js';
import { katalogPruefen } from '../src/module/registry.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

/** Ein gültiger Block gegen die (nicht leckende) Testview, mit variabler Kennung. */
function block(kennung: string, rollen: readonly string[] = ['betreuer', 'betriebs_admin']): string {
  return [
    `kennung: ${kennung}`,
    'menuename: "Test-Modul"',
    'ansicht: liste-detail',
    'view: v_modul_test_ok',
    'spalten:',
    '  - { name: titel, label: "Titel" }',
    '  - { name: status, label: "Status" }',
    '  - { name: text, label: "Text" }',
    '  - { name: aktualisiert_am, label: "Zuletzt", format: zeitpunkt }',
    `rollen: [${rollen.join(', ')}]`,
    'eingriffe: []',
    '',
  ].join('\n');
}

describe.skipIf(!datenbankUrl)('Modul-Speicher gegen die Katalogprüfung (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE cockpit.modul_test_quelle (
        id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        titel           text        NOT NULL,
        status          text        NOT NULL,
        text_intern     text        NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO cockpit.modul_test_quelle (titel, status, text_intern)
        VALUES ('Postgres', 'gruen', 'Rohbefund, nie für den Kunden');

      -- Verwendet text_intern nirgends: mit jeder Rolle erlaubt.
      CREATE VIEW cockpit.v_modul_test_ok AS
        SELECT id::text AS id, titel, status, aktualisiert_am, titel AS text
          FROM cockpit.modul_test_quelle;

      -- Zeigt text_intern unter einem anderen Namen: der Alias tarnt die Spalte nicht (view_column_usage).
      CREATE VIEW cockpit.v_modul_test_leck AS
        SELECT id::text AS id, titel, status, aktualisiert_am, text_intern AS text
          FROM cockpit.modul_test_quelle;

      -- Tarnt text_intern über eine Zwischen-View: view_column_usage sieht nur die direkte Abhängigkeit
      -- (harmlos in v_modul_test_zwischen), nicht die Herkunft aus text_intern (COPI-77, Review).
      CREATE VIEW cockpit.v_modul_test_zwischen AS
        SELECT id, titel, status, aktualisiert_am, text_intern AS harmlos
          FROM cockpit.modul_test_quelle;
      CREATE VIEW cockpit.v_modul_test_getarnt AS
        SELECT id::text AS id, titel, status, aktualisiert_am, harmlos AS text
          FROM cockpit.v_modul_test_zwischen;

      -- Ohne die Pflichtspalte status.
      CREATE VIEW cockpit.v_modul_test_ohne_status AS
        SELECT id::text AS id, titel, aktualisiert_am, titel AS text
          FROM cockpit.modul_test_quelle;

      -- id bleibt bigint statt text: falscher Typ einer Pflichtspalte.
      CREATE VIEW cockpit.v_modul_test_falscher_typ AS
        SELECT id, titel, status, aktualisiert_am, titel AS text
          FROM cockpit.modul_test_quelle;
    `);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query(`
      DROP VIEW IF EXISTS cockpit.v_modul_test_falscher_typ;
      DROP VIEW IF EXISTS cockpit.v_modul_test_ohne_status;
      DROP VIEW IF EXISTS cockpit.v_modul_test_leck;
      DROP VIEW IF EXISTS cockpit.v_modul_test_ok;
      DROP VIEW IF EXISTS cockpit.v_modul_test_getarnt;
      DROP VIEW IF EXISTS cockpit.v_modul_test_zwischen;
      DROP TABLE IF EXISTS cockpit.modul_test_quelle;
    `);
    await pool.end();
  });

  describe('katalogPruefen', () => {
    async function geprueft(view: string, rollen: readonly string[] = ['betreuer']) {
      const geparst = modulBlockAusText(block('probe', rollen).replace('v_modul_test_ok', view));
      if (!geparst.ok) {
        throw new Error(geparst.grund);
      }
      return katalogPruefen(pool, geparst.block);
    }

    it('nimmt eine passende View mit allen Pflichtspalten an', async () => {
      expect(await geprueft('v_modul_test_ok')).toEqual({ ok: true });
    });

    it('lehnt eine unbekannte View ab', async () => {
      const ergebnis = await geprueft('v_modul_test_unbekannt');
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('v_modul_test_unbekannt');
    });

    it('lehnt eine View ohne eine Pflichtspalte ab', async () => {
      const ergebnis = await geprueft('v_modul_test_ohne_status');
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('status');
    });

    it('lehnt eine View ab, deren Pflichtspalte den falschen Typ hat', async () => {
      const ergebnis = await geprueft('v_modul_test_falscher_typ');
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('id');
      expect(!ergebnis.ok && ergebnis.grund).toContain('Typ');
    });

    it('lehnt text_intern ab, sobald irgendeine Rolle außer betreuer freigegeben ist', async () => {
      const ergebnis = await geprueft('v_modul_test_leck', ['betreuer', 'betriebs_admin']);
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('text_intern');
    });

    it('lehnt für eine Kundenrolle eine View ab, die auf einer anderen View aufbaut (Tarnung von text_intern)', async () => {
      const ergebnis = await geprueft('v_modul_test_getarnt', ['betreuer', 'betriebs_admin']);
      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('v_modul_test_zwischen');
    });

    it('erlaubt eine View auf einer View, wenn ausschließlich betreuer freigegeben ist', async () => {
      expect(await geprueft('v_modul_test_getarnt', ['betreuer'])).toEqual({ ok: true });
    });

    it('erlaubt text_intern, wenn ausschließlich betreuer freigegeben ist', async () => {
      expect(await geprueft('v_modul_test_leck', ['betreuer'])).toEqual({ ok: true });
    });

    it('lehnt eine fehlende deklarierte Spalte ab, auch wenn alle Pflichtspalten da sind', async () => {
      const geparst = modulBlockAusText(
        block('probe').replace('name: text, label: "Text"', 'name: unbekannte_spalte, label: "Text"'),
      );
      if (!geparst.ok) throw new Error(geparst.grund);

      const ergebnis = await katalogPruefen(pool, geparst.block);

      expect(ergebnis.ok).toBe(false);
      expect(!ergebnis.ok && ergebnis.grund).toContain('unbekannte_spalte');
    });
  });

  describe('modulEinspielen', () => {
    it('legt die erste Version an und aktiviert sie sofort', async () => {
      const ergebnis = await modulEinspielen(pool, { rohtext: block('server-zustand'), akteur: 'konsole' });

      expect(ergebnis).toMatchObject({ ok: true, status: 'neu', kennung: 'server-zustand', version: 1 });
      const zeile = await pool.query<{ aktiv: boolean; aktiv_seit: Date | null; eingespielt_von: string }>(
        `SELECT aktiv, aktiv_seit, eingespielt_von FROM cockpit.modul WHERE kennung = 'server-zustand' AND version = 1`,
      );
      expect(zeile.rows[0]?.aktiv).toBe(true);
      expect(zeile.rows[0]?.aktiv_seit).toBeInstanceOf(Date);
      expect(zeile.rows[0]?.eingespielt_von).toBe('konsole');
    });

    it('speichert den geprüften Block als jsonb und den rohen Text unverändert', async () => {
      const rohtext = block('server-zustand');

      await modulEinspielen(pool, { rohtext, akteur: 'konsole' });

      const zeile = await pool.query<{ block: { kennung: string }; block_roh: string; pruefsumme: string }>(
        `SELECT block, block_roh, pruefsumme FROM cockpit.modul WHERE kennung = 'server-zustand'`,
      );
      expect(zeile.rows[0]?.block.kennung).toBe('server-zustand');
      expect(zeile.rows[0]?.block_roh).toBe(rohtext.trim());
      expect(zeile.rows[0]?.pruefsumme).toBe(pruefsummeBerechnen(rohtext.trim()));
    });

    it('speichert die Herkunft, wenn sie angegeben ist, sonst NULL', async () => {
      await modulEinspielen(pool, { rohtext: block('mit-herkunft'), akteur: 'konsole', herkunft: 'agent-blueprints@abc123' });
      await modulEinspielen(pool, { rohtext: block('ohne-herkunft'), akteur: 'konsole' });

      const zeilen = await pool.query<{ kennung: string; herkunft: string | null }>(
        `SELECT kennung, herkunft FROM cockpit.modul WHERE kennung IN ('mit-herkunft', 'ohne-herkunft')`,
      );
      const nachKennung = new Map(zeilen.rows.map((zeile) => [zeile.kennung, zeile.herkunft]));
      expect(nachKennung.get('mit-herkunft')).toBe('agent-blueprints@abc123');
      expect(nachKennung.get('ohne-herkunft')).toBeNull();
    });

    it('legt bei einem zweiten Einspielen Version 2 an und deaktiviert Version 1', async () => {
      await modulEinspielen(pool, { rohtext: block('server-zustand'), akteur: 'konsole' });

      const zweite = await modulEinspielen(pool, {
        rohtext: block('server-zustand').replace('Test-Modul', 'Test-Modul (neu)'),
        akteur: 'konsole',
      });

      expect(zweite).toMatchObject({ ok: true, status: 'neu', version: 2 });
      const zeilen = await pool.query<{ version: number; aktiv: boolean }>(
        `SELECT version::int AS version, aktiv FROM cockpit.modul WHERE kennung = 'server-zustand' ORDER BY version`,
      );
      expect(zeilen.rows).toEqual([
        { version: 1, aktiv: false },
        { version: 2, aktiv: true },
      ]);
    });

    it('meldet „unverändert" bei gleichem Block und legt keine neue Version an', async () => {
      const rohtext = block('server-zustand');
      const erste = await modulEinspielen(pool, { rohtext, akteur: 'konsole' });

      const zweite = await modulEinspielen(pool, { rohtext, akteur: 'konsole' });

      expect(zweite).toEqual({ ok: true, status: 'unveraendert', kennung: 'server-zustand', version: 1, pruefsumme: erste.ok ? erste.pruefsumme : '' });
      const anzahl = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM cockpit.modul WHERE kennung = 'server-zustand'`,
      );
      expect(anzahl.rows[0]?.n).toBe(1);
    });

    it('meldet „unverändert" auch bei nur anderer Umgebung des Textes (führende/nachfolgende Leerzeichen)', async () => {
      await modulEinspielen(pool, { rohtext: block('server-zustand'), akteur: 'konsole' });

      const zweite = await modulEinspielen(pool, { rohtext: `\n\n${block('server-zustand')}\n\n`, akteur: 'konsole' });

      expect(zweite).toMatchObject({ ok: true, status: 'unveraendert', version: 1 });
    });

    it('lehnt einen leeren Block ab, ohne die Datenbank zu ändern', async () => {
      const ergebnis = await modulEinspielen(pool, { rohtext: '   \n  ', akteur: 'konsole' });

      expect(ergebnis).toEqual({ ok: false, grund: 'Der Modul-Block ist leer.' });
    });

    it('lehnt ungültiges YAML ab, ohne die Datenbank zu ändern', async () => {
      const ergebnis = await modulEinspielen(pool, { rohtext: 'kennung: [unbalanciert', akteur: 'konsole' });

      expect(ergebnis.ok).toBe(false);
    });

    it('lehnt einen Block ab, dessen View es nicht gibt, und ändert nichts', async () => {
      const ergebnis = await modulEinspielen(pool, {
        rohtext: block('server-zustand').replace('v_modul_test_ok', 'v_modul_test_unbekannt'),
        akteur: 'konsole',
      });

      expect(ergebnis.ok).toBe(false);
      const anzahl = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM cockpit.modul`);
      expect(anzahl.rows[0]?.n).toBe(0);
    });

    it('lehnt einen Block ab, dessen View eine Pflichtspalte im falschen Typ hat, und ändert nichts', async () => {
      const ergebnis = await modulEinspielen(pool, {
        rohtext: block('server-zustand').replace('v_modul_test_ok', 'v_modul_test_falscher_typ'),
        akteur: 'konsole',
      });

      expect(ergebnis.ok).toBe(false);
      const anzahl = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM cockpit.modul`);
      expect(anzahl.rows[0]?.n).toBe(0);
    });

    it('lehnt text_intern für eine Kundenrolle ab, und die vorherige Version bleibt aktiv', async () => {
      // Betreuer allein geht nur für ein technisches Modul (COPI-134).
      const erste = await modulEinspielen(pool, { rohtext: `art: betrieb\n${block('server-zustand', ['betreuer'])}`, akteur: 'konsole' });
      expect(erste.ok).toBe(true);

      const zweite = await modulEinspielen(pool, {
        rohtext: block('server-zustand', ['betreuer', 'betriebs_admin']).replace('v_modul_test_ok', 'v_modul_test_leck'),
        akteur: 'konsole',
      });

      expect(zweite.ok).toBe(false);
      const aktive = await pool.query<{ version: number }>(
        `SELECT version::int AS version FROM cockpit.modul WHERE kennung = 'server-zustand' AND aktiv = true`,
      );
      expect(aktive.rows[0]?.version).toBe(1);
    });

    it('vergibt Versionsnummern unabhängig je Kennung', async () => {
      await modulEinspielen(pool, { rohtext: block('server-zustand'), akteur: 'konsole' });
      await modulEinspielen(pool, { rohtext: block('server-zustand').replace('Test-Modul', 'x'), akteur: 'konsole' });

      const dritte = await modulEinspielen(pool, { rohtext: block('backup-lauf'), akteur: 'konsole' });

      expect(dritte).toMatchObject({ ok: true, kennung: 'backup-lauf', version: 1 });
    });
  });

  describe('aktiveModule', () => {
    it('liefert nichts, solange kein Modul eingespielt ist', async () => {
      expect(await aktiveModule(pool)).toEqual([]);
    });

    it('liefert nur die aktive Version, mit geparstem Block, sortiert nach Kennung', async () => {
      await modulEinspielen(pool, { rohtext: block('server-zustand'), akteur: 'konsole' });
      await modulEinspielen(pool, { rohtext: block('backup-lauf'), akteur: 'konsole' });
      await modulEinspielen(pool, { rohtext: block('server-zustand').replace('Test-Modul', 'x'), akteur: 'konsole' });

      const module = await aktiveModule(pool);

      expect(module.map((modul) => [modul.kennung, modul.version])).toEqual([
        ['backup-lauf', 1],
        ['server-zustand', 2],
      ]);
      expect(module[1]?.block.menuename).toBe('x');
      expect(module[0]?.eingespieltAm).toBeInstanceOf(Date);
    });
  });
});
