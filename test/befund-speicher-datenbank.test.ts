/**
 * Befund und Herzschlag in der Datenbank (COPI-36): `befundMelden` schreibt den Befund und setzt den
 * Herzschlag der Wache in **einer Transaktion**.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.befund` und `cockpit.wache` ab. Niemals
 * gegen eine Kundendatenbank laufen lassen. Die erwarteten Werte stehen als Literale.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { befundMelden, type BefundMeldung } from '../src/status/befund-speicher.js';
import { einfuegenScheitern } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const T0 = new Date('2026-09-21T12:00:00.000Z');
const STUNDE = 60 * 60 * 1000;

function meldung(teil: Partial<BefundMeldung> = {}): BefundMeldung {
  return {
    wache: 'container',
    status: 'gruen',
    textIntern: 'alle Container laufen',
    kundensichtbar: false,
    taktSekunden: 300,
    quelle: 'admin-agent',
    jetzt: T0,
    ...teil,
  };
}

describe.skipIf(!datenbankUrl)('befundMelden (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function wache(kennung = 'container') {
    const zeile = await pool.query<{ takt_sekunden: number; letzter_lauf: Date | null }>(
      'SELECT takt_sekunden, letzter_lauf FROM cockpit.wache WHERE kennung = $1',
      [kennung],
    );
    return zeile.rows[0];
  }

  async function anzahl(tabelle: 'befund' | 'wache'): Promise<number> {
    const zeile = await pool.query<{ anzahl: number }>(`SELECT count(*)::int AS anzahl FROM cockpit.${tabelle}`);
    return zeile.rows[0]?.anzahl ?? -1;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.end();
  });

  describe('eine unbekannte Wache', () => {
    it('wird mit ihrem gemeldeten Takt angelegt, und ihr letzter Lauf ist der Zeitpunkt des Befunds', async () => {
      const ergebnis = await befundMelden(pool, meldung({ taktSekunden: 900 }));

      expect(ergebnis.ok).toBe(true);
      expect(await wache()).toEqual({ takt_sekunden: 900, letzter_lauf: T0 });
    });

    it('bekommt einen Befund mit allen Angaben, dem Zeitpunkt der Meldung und der Quelle aus dem Zugang', async () => {
      const ergebnis = await befundMelden(
        pool,
        meldung({ status: 'rot', textIntern: 'postgres beendet (Exit 137)', textKunde: 'Die Buchungen sind gerade nicht erreichbar.', kundensichtbar: true }),
      );

      expect(ergebnis).toMatchObject({ ok: true, gemeldetAm: T0 });
      const zeile = await pool.query('SELECT wache, status, text_intern, text_kunde, kundensichtbar, quelle, gemeldet_am FROM cockpit.befund');
      expect(zeile.rows).toEqual([
        {
          wache: 'container',
          status: 'rot',
          text_intern: 'postgres beendet (Exit 137)',
          text_kunde: 'Die Buchungen sind gerade nicht erreichbar.',
          kundensichtbar: true,
          quelle: 'admin-agent',
          gemeldet_am: T0,
        },
      ]);
    });

    it('wird ohne Takt nicht angelegt und schreibt nichts: ohne Takt ließe sich nie sagen, ob sie ausbleibt', async () => {
      const ergebnis = await befundMelden(pool, meldung({ taktSekunden: undefined }));

      expect(ergebnis).toEqual({ ok: false, grund: 'takt_fehlt' });
      expect(await anzahl('wache')).toBe(0);
      expect(await anzahl('befund')).toBe(0);
    });
  });

  describe('eine bekannte Wache', () => {
    beforeEach(async () => {
      await befundMelden(pool, meldung({ taktSekunden: 300 }));
    });

    it('setzt mit jedem Befund ihren letzten Lauf neu, ohne dass sie ihren Takt nochmal nennen muss', async () => {
      const spaeter = new Date(T0.getTime() + 5 * 60_000);

      const ergebnis = await befundMelden(pool, meldung({ taktSekunden: undefined, jetzt: spaeter }));

      expect(ergebnis.ok).toBe(true);
      expect(await wache()).toEqual({ takt_sekunden: 300, letzter_lauf: spaeter });
      expect(await anzahl('befund')).toBe(2);
    });

    it('übernimmt einen neuen Takt: ändert sich der Zeitplan der Wache, folgt das Cockpit', async () => {
      await befundMelden(pool, meldung({ taktSekunden: 600, jetzt: new Date(T0.getTime() + 1000) }));

      expect((await wache())?.takt_sekunden).toBe(600);
    });

    it('lässt den Takt unverändert, wenn der Befund keinen nennt', async () => {
      await befundMelden(pool, meldung({ taktSekunden: undefined, jetzt: new Date(T0.getTime() + 1000) }));

      expect((await wache())?.takt_sekunden).toBe(300);
    });

    it('lässt den letzten Lauf nie rückwärts laufen, auch wenn die Uhr zurückspringt', async () => {
      const frueher = new Date(T0.getTime() - STUNDE);

      await befundMelden(pool, meldung({ jetzt: frueher }));

      // Der Befund trägt den Zeitpunkt, an dem er ankam; der Herzschlag der Wache bleibt der jüngste.
      expect((await wache())?.letzter_lauf).toEqual(T0);
      const zeitpunkte = await pool.query<{ gemeldet_am: Date }>('SELECT gemeldet_am FROM cockpit.befund ORDER BY gemeldet_am');
      expect(zeitpunkte.rows.map((zeile) => zeile.gemeldet_am)).toEqual([frueher, T0]);
    });

    it('hält die Wachen auseinander: der Herzschlag einer anderen bleibt unberührt', async () => {
      await befundMelden(pool, meldung({ wache: 'backup', taktSekunden: 86_400, jetzt: new Date(T0.getTime() - 2 * STUNDE) }));

      await befundMelden(pool, meldung({ wache: 'container', jetzt: new Date(T0.getTime() + 60_000) }));

      expect((await wache('backup'))?.letzter_lauf).toEqual(new Date(T0.getTime() - 2 * STUNDE));
    });
  });

  describe('der Anzeigename der Wache (COPI-37)', () => {
    async function anzeigename(): Promise<string | null | undefined> {
      const zeile = await pool.query<{ anzeigename: string | null }>(`SELECT anzeigename FROM cockpit.wache WHERE kennung = 'container'`);
      return zeile.rows[0]?.anzeigename;
    }

    it('wird mit einer neuen Wache angelegt', async () => {
      await befundMelden(pool, meldung({ anzeigename: 'Buchungs-Agent' }));

      expect(await anzeigename()).toBe('Buchungs-Agent');
    });

    it('bleibt ohne Angabe leer: NULL, nicht die Kennung', async () => {
      await befundMelden(pool, meldung());

      expect(await anzeigename()).toBeNull();
    });

    it('bleibt bei einem späteren Befund ohne Namen erhalten', async () => {
      await befundMelden(pool, meldung({ anzeigename: 'Buchungs-Agent' }));

      await befundMelden(pool, meldung({ taktSekunden: undefined, jetzt: new Date(T0.getTime() + 60_000) }));

      expect(await anzeigename()).toBe('Buchungs-Agent');
    });

    it('wird durch einen neuen Namen ersetzt, auch bei einer bekannten Wache', async () => {
      await befundMelden(pool, meldung({ anzeigename: 'Alter Name' }));

      await befundMelden(pool, meldung({ anzeigename: 'Neuer Name', taktSekunden: undefined, jetzt: new Date(T0.getTime() + 60_000) }));

      expect(await anzeigename()).toBe('Neuer Name');
    });

    it('wird bei einer unbekannten Wache ohne Takt nicht geschrieben: es entsteht nichts', async () => {
      const ergebnis = await befundMelden(pool, meldung({ anzeigename: 'Buchungs-Agent', taktSekunden: undefined }));

      expect(ergebnis).toEqual({ ok: false, grund: 'takt_fehlt' });
      expect(await anzahl('wache')).toBe(0);
    });
  });

  describe('Ein Befund ohne Klartext', () => {
    it('bleibt ohne Angabe unsichtbar: kundensichtbar ist nur mit ausdrücklichem true wahr', async () => {
      await befundMelden(pool, meldung({ textKunde: 'Klartext liegt vor, ist aber nicht freigegeben.' }));

      const zeile = await pool.query<{ kundensichtbar: boolean; text_kunde: string }>('SELECT kundensichtbar, text_kunde FROM cockpit.befund');
      expect(zeile.rows[0]).toEqual({ kundensichtbar: false, text_kunde: 'Klartext liegt vor, ist aber nicht freigegeben.' });
    });

    it('lässt sich nicht kundensichtbar melden: die Datenbank hält an der Regel fest, und die Wache entsteht dabei nicht', async () => {
      await expect(befundMelden(pool, meldung({ kundensichtbar: true }))).rejects.toThrow(/befund_kundentext_noetig/);

      expect(await anzahl('wache')).toBe(0);
      expect(await anzahl('befund')).toBe(0);
    });
  });

  describe('Transaktion', () => {
    it('legt die Wache nicht an, wenn der Befund scheitert: beides gilt oder nichts', async () => {
      const entfernen = await einfuegenScheitern(pool, 'befund', 'test_befund_scheitert: geheim');
      try {
        await expect(befundMelden(pool, meldung())).rejects.toThrow();
      } finally {
        await entfernen();
      }

      expect(await anzahl('wache')).toBe(0);
      expect(await anzahl('befund')).toBe(0);
    });

    it('setzt den Herzschlag einer bekannten Wache nicht, wenn der Befund scheitert: ein verlorener Befund ist kein „gerade geprüft"', async () => {
      await befundMelden(pool, meldung({ taktSekunden: 300 }));
      const entfernen = await einfuegenScheitern(pool, 'befund', 'test_befund_scheitert: geheim');
      try {
        await expect(befundMelden(pool, meldung({ jetzt: new Date(T0.getTime() + STUNDE), taktSekunden: 900 }))).rejects.toThrow();
      } finally {
        await entfernen();
      }

      expect(await wache()).toEqual({ takt_sekunden: 300, letzter_lauf: T0 });
      expect(await anzahl('befund')).toBe(1);
    });
  });

  describe('Gleichzeitig', () => {
    it('legt eine Wache auch dann genau einmal an, wenn viele Befunde zugleich für sie eintreffen', async () => {
      const ergebnisse = await Promise.all(
        Array.from({ length: 20 }, (_, i) => befundMelden(pool, meldung({ textIntern: `Befund ${String(i)}` }))),
      );

      expect(ergebnisse.every((ergebnis) => ergebnis.ok)).toBe(true);
      expect(await anzahl('wache')).toBe(1);
      expect(await anzahl('befund')).toBe(20);
      const ids = ergebnisse.flatMap((ergebnis) => (ergebnis.ok ? [ergebnis.id] : []));
      expect(new Set(ids).size).toBe(20);
    });

    it('lässt keinen der gleichzeitigen Befunde an einer fehlenden Wache scheitern', async () => {
      // Die Hälfte kennt den Takt, die andere nicht: wer die Wache anlegt, entscheidet die Reihenfolge.
      // Ohne Takt muss ein Befund entweder eine schon angelegte Wache finden oder sauber `takt_fehlt` melden.
      const ergebnisse = await Promise.all(
        Array.from({ length: 20 }, (_, i) => befundMelden(pool, meldung({ taktSekunden: i % 2 === 0 ? 300 : undefined }))),
      );

      for (const ergebnis of ergebnisse) {
        expect(ergebnis.ok || ergebnis.grund === 'takt_fehlt').toBe(true);
      }
      expect(await anzahl('wache')).toBe(1);
      expect(await anzahl('befund')).toBe(ergebnisse.filter((ergebnis) => ergebnis.ok).length);
    });
  });
});
