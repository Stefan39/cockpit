/**
 * Das Inventar der Agenten in der Datenbank (COPI-38): `PUT /intern/agenten` ersetzt es als Ganzes.
 *
 * Was hier gilt: die Liste ist der neue Stand — Angelegtes und Geändertes kommt hinein, Fehlendes fällt
 * heraus, und das alles in **einer** Transaktion. Scheitert irgendetwas, bleibt der alte Stand ganz stehen;
 * zwei gleichzeitige Meldungen ergeben nie eine Mischung aus beiden.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.agent` ab. Niemals gegen eine Kundendatenbank
 * laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentenLesen, inventarErsetzen, type AgentInventar } from '../src/status/agenten-speicher.js';
import { testDatenbankUrl } from './testdatenbank.js';

const JETZT = new Date('2026-09-21T12:00:00.000Z');

function agent(kennung: string, teil: Partial<AgentInventar> = {}): AgentInventar {
  return {
    kennung,
    rolle: `Rolle von ${kennung}`,
    version: '1.0.0',
    grenzen: {},
    zeitplan: [],
    ...teil,
  };
}

describe.skipIf(!testDatenbankUrl)('Inventar der Agenten (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDatenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.agent');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.agent');
    await pool.end();
  });

  const kennungen = async (): Promise<string[]> => (await agentenLesen(pool)).map((zeile) => zeile.kennung).sort();

  describe('ersetzen', () => {
    it('legt neue Agenten an und meldet, wie viele es sind', async () => {
      const ergebnis = await inventarErsetzen(pool, [agent('rechnung'), agent('buchung')], JETZT);

      expect(ergebnis).toEqual({ agenten: 2, entfernt: 0 });
      expect(await kennungen()).toEqual(['buchung', 'rechnung']);
    });

    it('speichert Rolle, Version, Grenzen und Zeitplan unverändert, samt der Typen der Werte', async () => {
      await inventarErsetzen(
        pool,
        [
          agent('rechnung', {
            rolle: 'Rechnungs-Agent',
            version: '2.3.1',
            grenzen: { 'Betrag je Rechnung': 5000, 'darf löschen': false, Währung: 'EUR' },
            zeitplan: [
              { name: 'Rechnungslauf', wann: 'täglich 07:00' },
              { name: 'Mahnungen', wann: 'montags 09:00' },
            ],
          }),
        ],
        JETZT,
      );

      const [zeile] = await agentenLesen(pool);

      expect(zeile).toEqual({
        kennung: 'rechnung',
        rolle: 'Rechnungs-Agent',
        version: '2.3.1',
        grenzen: { 'Betrag je Rechnung': 5000, 'darf löschen': false, Währung: 'EUR' },
        // Die Reihenfolge des Zeitplans bleibt, wie der Agent sie meldet.
        zeitplan: [
          { name: 'Rechnungslauf', wann: 'täglich 07:00' },
          { name: 'Mahnungen', wann: 'montags 09:00' },
        ],
        aktualisiertAm: JETZT,
      });
    });

    it('überschreibt einen vorhandenen Agenten mit dem neuen Stand, auch wenn Grenzen und Zeitplan schrumpfen', async () => {
      await inventarErsetzen(
        pool,
        [agent('rechnung', { version: '1.0.0', grenzen: { a: 1, b: 2 }, zeitplan: [{ name: 'x', wann: 'y' }] })],
        JETZT,
      );
      const spaeter = new Date(JETZT.getTime() + 3600_000);

      await inventarErsetzen(pool, [agent('rechnung', { rolle: 'Neu', version: '1.1.0', grenzen: { a: 9 }, zeitplan: [] })], spaeter);

      expect(await agentenLesen(pool)).toEqual([
        { kennung: 'rechnung', rolle: 'Neu', version: '1.1.0', grenzen: { a: 9 }, zeitplan: [], aktualisiertAm: spaeter },
      ]);
    });

    it('entfernt Agenten, die im neuen Inventar fehlen, und zählt sie', async () => {
      await inventarErsetzen(pool, [agent('a'), agent('b'), agent('c')], JETZT);

      const ergebnis = await inventarErsetzen(pool, [agent('b')], JETZT);

      expect(ergebnis).toEqual({ agenten: 1, entfernt: 2 });
      expect(await kennungen()).toEqual(['b']);
    });

    it('leert das Inventar mit einer leeren Liste: eine Instanz ohne Agenten ist ein gültiger Stand', async () => {
      await inventarErsetzen(pool, [agent('a'), agent('b')], JETZT);

      const ergebnis = await inventarErsetzen(pool, [], JETZT);

      expect(ergebnis).toEqual({ agenten: 0, entfernt: 2 });
      expect(await agentenLesen(pool)).toEqual([]);
    });

    it('ist wiederholbar: dieselbe Liste noch einmal ändert nichts außer dem Zeitpunkt der Meldung', async () => {
      const liste = [agent('a', { grenzen: { x: 1 } }), agent('b', { zeitplan: [{ name: 'n', wann: 'w' }] })];
      await inventarErsetzen(pool, liste, JETZT);
      const spaeter = new Date(JETZT.getTime() + 60_000);

      const ergebnis = await inventarErsetzen(pool, liste, spaeter);

      expect(ergebnis).toEqual({ agenten: 2, entfernt: 0 });
      const zeilen = await agentenLesen(pool);
      expect(zeilen.map(({ aktualisiertAm: _, ...rest }) => rest)).toEqual(liste);
      expect(zeilen.every((zeile) => zeile.aktualisiertAm.getTime() === spaeter.getTime())).toBe(true);
    });

    it('speichert Text verbatim: Fremdtext wird nicht verändert (Maskieren ist Sache der Ausgabe)', async () => {
      const fremd = '<img src=x onerror=alert(1)> https://boese.example';
      await inventarErsetzen(pool, [agent('a', { rolle: fremd, grenzen: { [fremd]: fremd }, zeitplan: [{ name: fremd, wann: fremd }] })], JETZT);

      const [zeile] = await agentenLesen(pool);

      expect(zeile?.rolle).toBe(fremd);
      expect(zeile?.grenzen).toEqual({ [fremd]: fremd });
      expect(zeile?.zeitplan).toEqual([{ name: fremd, wann: fremd }]);
    });
  });

  describe('eine Transaktion', () => {
    it('lässt den alten Stand ganz stehen, wenn ein Eintrag scheitert — auch das Entfernen gilt dann nicht', async () => {
      await inventarErsetzen(pool, [agent('alt-1'), agent('alt-2')], JETZT);

      // Die Rolle nur aus Leerzeichen verletzt die Regel der Datenbank (`agent_rolle_nicht_leer`).
      await expect(
        inventarErsetzen(pool, [agent('alt-1', { rolle: 'geändert' }), agent('neu', { rolle: '   ' })], JETZT),
      ).rejects.toThrow(/agent_rolle_nicht_leer/);

      const zeilen = await agentenLesen(pool);
      expect(zeilen.map((zeile) => zeile.kennung).sort()).toEqual(['alt-1', 'alt-2']);
      expect(zeilen.find((zeile) => zeile.kennung === 'alt-1')?.rolle).toBe('Rolle von alt-1');
    });

    it('ergibt bei zwei gleichzeitigen Meldungen genau eine der beiden Listen, nie eine Mischung', async () => {
      const liste1 = [agent('a1', { version: '1' }), agent('a2', { version: '1' }), agent('a3', { version: '1' })];
      const liste2 = [agent('b1', { version: '2' }), agent('a2', { version: '2' })];

      for (let lauf = 0; lauf < 8; lauf += 1) {
        await Promise.all([inventarErsetzen(pool, liste1, JETZT), inventarErsetzen(pool, liste2, JETZT)]);

        const zeilen = await agentenLesen(pool);
        const stand = zeilen.map((zeile) => `${zeile.kennung}:${zeile.version}`).sort();
        const erste = liste1.map((eintrag) => `${eintrag.kennung}:${eintrag.version}`).sort();
        const zweite = liste2.map((eintrag) => `${eintrag.kennung}:${eintrag.version}`).sort();
        expect([erste, zweite], `Lauf ${String(lauf)}: ${stand.join(', ')}`).toContainEqual(stand);
      }
    });
  });

  describe('lesen', () => {
    it('sortiert nach Rolle, dann nach Kennung: die Reihenfolge ist nie zufällig', async () => {
      await inventarErsetzen(
        pool,
        [agent('z', { rolle: 'Buchung' }), agent('b', { rolle: 'Rechnung' }), agent('a', { rolle: 'Rechnung' })],
        JETZT,
      );

      expect((await agentenLesen(pool)).map((zeile) => zeile.kennung)).toEqual(['z', 'a', 'b']);
    });

    it('liefert ohne Inventar eine leere Liste', async () => {
      expect(await agentenLesen(pool)).toEqual([]);
    });
  });
});
