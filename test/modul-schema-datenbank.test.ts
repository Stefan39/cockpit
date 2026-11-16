/**
 * Das Schema der Modul-Registry (COPI-77, Migration `0028_modul`): Tabelle `cockpit.modul`.
 *
 * Geprüft werden die Regeln der Datenbank selbst — Kennung, Version, Prüfsumme, Unveränderlichkeit,
 * höchstens eine aktive Version je Kennung, nie löschen —, nicht der Anwendungsweg über
 * `modulEinspielen` (der steht in `modul-speicher-datenbank.test.ts`).
 *
 * Läuft nur mit `TEST_DATABASE_URL` (echte PostgreSQL) und räumt dort `cockpit.modul` ab. Niemals gegen
 * eine Kundendatenbank laufen lassen. Die erwarteten Werte (Constraint-Namen) stehen als Literale: der
 * Test soll nicht mitrechnen, wenn die Migration sie ändert.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const PRUEFSUMME_A = 'a'.repeat(64);
const PRUEFSUMME_B = 'b'.repeat(64);

/** Die Meldung, mit der die Datenbank eine Anweisung ablehnt; scheitert der Test, wenn sie angenommen wird. */
async function abgelehnt(anweisung: Promise<unknown>): Promise<string> {
  try {
    await anweisung;
  } catch (fehler) {
    return fehler instanceof Error ? fehler.message : String(fehler);
  }
  throw new Error('Die Datenbank hat die Anweisung angenommen, obwohl sie abgelehnt werden musste.');
}

describe.skipIf(!datenbankUrl)('Schema der Modul-Registry (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.end();
  });

  async function zeileEinfuegen(werte: {
    readonly kennung?: string;
    readonly version?: number;
    readonly block?: unknown;
    readonly blockRoh?: string;
    readonly pruefsumme?: string;
    readonly herkunft?: string | null;
    readonly eingespieltVon?: string;
    readonly aktiv?: boolean;
    readonly aktivSeit?: string | null;
  }): Promise<number> {
    const ergebnis = await pool.query<{ id: number }>(
      `INSERT INTO cockpit.modul (kennung, version, block, block_roh, pruefsumme, herkunft, eingespielt_von, aktiv, aktiv_seit)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
       RETURNING id::int AS id`,
      [
        werte.kennung ?? 'server-zustand',
        werte.version ?? 1,
        JSON.stringify(werte.block ?? { kennung: 'server-zustand' }),
        werte.blockRoh ?? 'kennung: server-zustand',
        werte.pruefsumme ?? PRUEFSUMME_A,
        werte.herkunft ?? null,
        werte.eingespieltVon ?? 'konsole',
        werte.aktiv ?? false,
        werte.aktivSeit ?? null,
      ],
    );
    const id = ergebnis.rows[0]?.id;
    if (id === undefined) {
      throw new Error('Keine Zeile angelegt');
    }
    return id;
  }

  describe('Tabelle modul', () => {
    it('nimmt eine Zeile mit sinnvollen Werten an und setzt eingespielt_am', async () => {
      const id = await zeileEinfuegen({});

      const zeile = await pool.query<{ eingespielt_am: Date; aktiv: boolean; aktiv_seit: Date | null }>(
        'SELECT eingespielt_am, aktiv, aktiv_seit FROM cockpit.modul WHERE id = $1',
        [id],
      );
      expect(zeile.rows[0]?.eingespielt_am).toBeInstanceOf(Date);
      expect(zeile.rows[0]?.aktiv).toBe(false);
      expect(zeile.rows[0]?.aktiv_seit).toBeNull();
    });

    it.each(['', 'Server-Zustand', '-server', 'server_zustand', 'a'.repeat(64), 'umlaut-ä'])(
      'lehnt die Kennung „%s" ab',
      async (kennung) => {
        expect(await abgelehnt(zeileEinfuegen({ kennung }))).toContain('modul_kennung_form');
      },
    );

    it.each(['server-zustand', 'a', 'a1-b2', 'a'.repeat(63)])('nimmt die Kennung „%s" an', async (kennung) => {
      await zeileEinfuegen({ kennung });
    });

    it.each([0, -1, -5])('lehnt die Version %i ab: sie zählt ab 1', async (version) => {
      expect(await abgelehnt(zeileEinfuegen({ version }))).toContain('modul_version_positiv');
    });

    it('kennt Kennung und Version zusammen nur einmal', async () => {
      await zeileEinfuegen({ kennung: 'server-zustand', version: 1 });

      expect(await abgelehnt(zeileEinfuegen({ kennung: 'server-zustand', version: 1 }))).toContain(
        'modul_kennung_version_eindeutig',
      );
    });

    it('lässt dieselbe Version für unterschiedliche Kennungen zu', async () => {
      await zeileEinfuegen({ kennung: 'server-zustand', version: 1 });

      await zeileEinfuegen({ kennung: 'backup-lauf', version: 1 });
    });

    it('lehnt einen Block ab, der kein Objekt ist', async () => {
      expect(await abgelehnt(zeileEinfuegen({ block: ['nicht', 'ein', 'objekt'] }))).toContain('modul_block_objekt');
    });

    it.each(['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])(
      'lehnt die Prüfsumme „%s" ab: nur ein SHA-256 in Hex',
      async (pruefsumme) => {
        expect(await abgelehnt(zeileEinfuegen({ pruefsumme }))).toContain('modul_pruefsumme_form');
      },
    );

    it.each(['', '   '])('lehnt eingespielt_von %j ab: leer sagt nichts über den Akteur', async (eingespieltVon) => {
      expect(await abgelehnt(zeileEinfuegen({ eingespieltVon }))).toContain('modul_eingespielt_von_nicht_leer');
    });

    it('lehnt aktiv ohne aktiv_seit ab', async () => {
      expect(await abgelehnt(zeileEinfuegen({ aktiv: true, aktivSeit: null }))).toContain('modul_aktiv_seit_passt');
    });

    it('lehnt aktiv_seit ohne aktiv ab', async () => {
      expect(await abgelehnt(zeileEinfuegen({ aktiv: false, aktivSeit: '2025-01-01T00:00:00Z' }))).toContain(
        'modul_aktiv_seit_passt',
      );
    });

    it('lässt herkunft leer (NULL): frei, kein Zwang', async () => {
      const id = await zeileEinfuegen({ herkunft: null });

      const zeile = await pool.query<{ herkunft: string | null }>('SELECT herkunft FROM cockpit.modul WHERE id = $1', [id]);
      expect(zeile.rows[0]?.herkunft).toBeNull();
    });

    it('lässt höchstens eine aktive Version je Kennung zu', async () => {
      await zeileEinfuegen({ kennung: 'server-zustand', version: 1, aktiv: true, aktivSeit: '2025-01-01T00:00:00Z' });

      const meldung = await abgelehnt(
        zeileEinfuegen({ kennung: 'server-zustand', version: 2, aktiv: true, aktivSeit: '2025-01-02T00:00:00Z' }),
      );

      expect(meldung).toContain('modul_eine_aktive_je_kennung');
    });

    it('lässt zwei Kennungen gleichzeitig aktiv', async () => {
      await zeileEinfuegen({ kennung: 'server-zustand', aktiv: true, aktivSeit: '2025-01-01T00:00:00Z' });

      await zeileEinfuegen({ kennung: 'backup-lauf', aktiv: true, aktivSeit: '2025-01-01T00:00:00Z' });
    });

    describe('was nach dem Einspielen feststeht', () => {
      it.each([
        ['die Kennung', `SET kennung = 'anderes-modul'`],
        ['die Version', 'SET version = 99'],
        ['der Block', `SET block = '{"anders": true}'::jsonb`],
        ['der rohe Block', `SET block_roh = 'anders'`],
        ['die Prüfsumme', `SET pruefsumme = '${PRUEFSUMME_B}'`],
        ['die Herkunft', `SET herkunft = 'woanders her'`],
        ['der Zeitpunkt des Einspielens', `SET eingespielt_am = '2001-01-01T00:00:00Z'`],
        ['wer eingespielt hat', `SET eingespielt_von = 'jemand-anders'`],
      ])('lässt sich %s nicht mehr ändern: eine neue Version kommt als neue Zeile', async (_name, aenderung) => {
        const id = await zeileEinfuegen({});

        const meldung = await abgelehnt(pool.query(`UPDATE cockpit.modul ${aenderung} WHERE id = $1`, [id]));

        expect(meldung).toContain('modul_unveraenderlich');
      });

      it('lässt aktiv und aktiv_seit ändern: das ist der Wechsel der aktiven Version', async () => {
        const id = await zeileEinfuegen({});

        await pool.query(`UPDATE cockpit.modul SET aktiv = true, aktiv_seit = now() WHERE id = $1`, [id]);

        const zeile = await pool.query<{ aktiv: boolean }>('SELECT aktiv FROM cockpit.modul WHERE id = $1', [id]);
        expect(zeile.rows[0]?.aktiv).toBe(true);
      });
    });

    it('weist DELETE ab: die Registry ist eine Nachweistabelle wie jede andere (0025)', async () => {
      await zeileEinfuegen({});

      const meldung = await abgelehnt(wieImBetrieb(pool, 'DELETE FROM cockpit.modul'));

      expect(meldung).toContain('nie_loeschen');
    });
  });
});
