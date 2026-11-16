/**
 * Die Abfragen der Übersicht (COPI-37) gegen eine echte PostgreSQL: was die Kundensicht und was die
 * Betreuersicht aus der Datenbank bekommen.
 *
 * Die Trennung liegt schon **in der Abfrage**: die Kundensicht liest gar keinen Rohbefund in den
 * Speicher, und eine Wache ohne kundensichtbaren Befund liefert sie nicht einmal zurück. Dass die
 * Vorlage einen Rohbefund nicht zeigt, wäre sonst die einzige Sicherung.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.befund` und `cockpit.wache` ab.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { befundMelden, type BefundMeldung } from '../src/status/befund-speicher.js';
import { betreuerWachenLesen, kundenWachenLesen } from '../src/status/uebersicht-speicher.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const T0 = new Date('2026-09-21T12:00:00.000Z');
const nach = (minuten: number): Date => new Date(T0.getTime() + minuten * 60_000);
const GEHEIM = 'GEHEIM-INTERN-4711';

function meldung(teil: Partial<BefundMeldung> = {}): BefundMeldung {
  return {
    wache: 'buchung',
    status: 'gruen',
    textIntern: 'intern',
    kundensichtbar: false,
    taktSekunden: 300,
    quelle: 'admin-agent',
    jetzt: T0,
    ...teil,
  };
}

describe.skipIf(!datenbankUrl)('Abfragen der Übersicht (echte Datenbank)', () => {
  let pool: pg.Pool;

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

  describe('kundenWachenLesen', () => {
    it('liefert nichts, solange es keine Wache gibt', async () => {
      expect(await kundenWachenLesen(pool)).toEqual([]);
    });

    it('liefert eine Wache mit ihrem kundensichtbaren Befund, ihrem Anzeigenamen und ihrem Takt', async () => {
      await befundMelden(
        pool,
        meldung({ status: 'rot', textKunde: 'Die Buchungen sind nicht erreichbar.', kundensichtbar: true, anzeigename: 'Buchungs-Agent', taktSekunden: 600 }),
      );

      expect(await kundenWachenLesen(pool)).toEqual([
        {
          kennung: 'buchung',
          anzeigename: 'Buchungs-Agent',
          taktSekunden: 600,
          sichtbar: { status: 'rot', textKunde: 'Die Buchungen sind nicht erreichbar.', gemeldetAm: T0 },
        },
      ]);
    });

    it('liefert eine Wache ohne kundensichtbaren Befund gar nicht: der Kunde erfährt nicht einmal, dass es sie gibt', async () => {
      await befundMelden(pool, meldung({ wache: 'interne-wache', status: 'rot', textIntern: GEHEIM }));

      expect(await kundenWachenLesen(pool)).toEqual([]);
    });

    it('nimmt den jüngsten kundensichtbaren Befund, auch wenn danach ein interner eintraf', async () => {
      await befundMelden(pool, meldung({ status: 'gruen', textKunde: 'Alles läuft.', kundensichtbar: true, jetzt: T0 }));
      await befundMelden(pool, meldung({ status: 'rot', textIntern: GEHEIM, kundensichtbar: false, jetzt: nach(5) }));

      const zeilen = await kundenWachenLesen(pool);

      expect(zeilen).toHaveLength(1);
      expect(zeilen[0]?.sichtbar).toEqual({ status: 'gruen', textKunde: 'Alles läuft.', gemeldetAm: T0 });
    });

    it('nimmt von mehreren sichtbaren Befunden den zuletzt eingetroffenen', async () => {
      await befundMelden(pool, meldung({ status: 'rot', textKunde: 'Störung.', kundensichtbar: true, jetzt: T0 }));
      await befundMelden(pool, meldung({ status: 'gruen', textKunde: 'Behoben.', kundensichtbar: true, jetzt: nach(10) }));

      expect((await kundenWachenLesen(pool))[0]?.sichtbar).toMatchObject({ status: 'gruen', textKunde: 'Behoben.' });
    });

    it('liest keinen Rohbefund und keine Kennung der Herkunft in den Speicher: nichts davon steht im Ergebnis', async () => {
      await befundMelden(pool, meldung({ textIntern: GEHEIM, textKunde: 'Alles läuft.', kundensichtbar: true, quelle: 'geheime-quelle' }));
      await befundMelden(pool, meldung({ status: 'rot', textIntern: `${GEHEIM}-zwei`, jetzt: nach(1) }));

      const zeilen = await kundenWachenLesen(pool);

      const text = JSON.stringify(zeilen);
      expect(text).not.toContain('GEHEIM');
      expect(text).not.toContain('geheime-quelle');
      expect(text).not.toContain('intern');
      expect(Object.keys(zeilen[0] ?? {}).sort()).toEqual(['anzeigename', 'kennung', 'sichtbar', 'taktSekunden']);
      expect(Object.keys(zeilen[0]?.sichtbar ?? {}).sort()).toEqual(['gemeldetAm', 'messwert', 'status', 'textKunde']);
    });

    it('trennt die Wachen: jede bekommt ihren eigenen sichtbaren Befund', async () => {
      await befundMelden(pool, meldung({ wache: 'a', textKunde: 'Text A', kundensichtbar: true }));
      await befundMelden(pool, meldung({ wache: 'b', status: 'gelb', textKunde: 'Text B', kundensichtbar: true }));

      const zeilen = await kundenWachenLesen(pool);

      expect(zeilen.map((zeile) => [zeile.kennung, zeile.sichtbar.textKunde]).sort()).toEqual([
        ['a', 'Text A'],
        ['b', 'Text B'],
      ]);
    });

    it('hat ohne Anzeigenamen keinen: das Feld ist undefined, nicht die Kennung', async () => {
      await befundMelden(pool, meldung({ textKunde: 'Alles läuft.', kundensichtbar: true }));

      expect((await kundenWachenLesen(pool))[0]?.anzeigename).toBeUndefined();
    });
  });

  describe('betreuerWachenLesen', () => {
    it('liefert jede Wache mit dem letzten Befund gleich welcher Sichtbarkeit', async () => {
      await befundMelden(pool, meldung({ status: 'gruen', textIntern: 'alt', textKunde: 'Alles läuft.', kundensichtbar: true, jetzt: T0 }));
      await befundMelden(pool, meldung({ status: 'rot', textIntern: GEHEIM, jetzt: nach(5) }));
      await befundMelden(pool, meldung({ wache: 'nur-intern', status: 'gelb', textIntern: 'interner Hinweis' }));

      const zeilen = await betreuerWachenLesen(pool);

      expect(zeilen).toHaveLength(2);
      const buchung = zeilen.find((zeile) => zeile.kennung === 'buchung');
      expect(buchung).toMatchObject({
        taktSekunden: 300,
        letzterLauf: nach(5),
        letzter: { status: 'rot', textIntern: GEHEIM, kundensichtbar: false, gemeldetAm: nach(5) },
      });
      expect(zeilen.find((zeile) => zeile.kennung === 'nur-intern')?.letzter).toMatchObject({ status: 'gelb', kundensichtbar: false });
    });

    it('liefert den Klartext des letzten Befunds mit, auch wenn er nicht freigegeben ist', async () => {
      await befundMelden(pool, meldung({ textIntern: 'roh', textKunde: 'Noch nicht freigegeben.', kundensichtbar: false }));

      expect((await betreuerWachenLesen(pool))[0]?.letzter).toMatchObject({ textKunde: 'Noch nicht freigegeben.', kundensichtbar: false });
    });

    it('liefert eine Wache ohne Befund mit undefined statt eines erfundenen Standes', async () => {
      await pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ('ohne-befund', 300)`);

      expect(await betreuerWachenLesen(pool)).toEqual([
        { kennung: 'ohne-befund', anzeigename: undefined, taktSekunden: 300, letzterLauf: undefined, letzter: undefined },
      ]);
    });

    it('nimmt bei mehreren Befunden den zuletzt eingetroffenen, nicht den mit dem spätesten Zeitpunkt', async () => {
      await befundMelden(pool, meldung({ status: 'gruen', textIntern: 'zuerst eingetroffen', jetzt: nach(30) }));
      // Die Uhr springt zurück: dieser Befund trägt einen früheren Zeitpunkt, ist aber der jüngste.
      await befundMelden(pool, meldung({ status: 'rot', textIntern: 'zuletzt eingetroffen', jetzt: T0 }));

      expect((await betreuerWachenLesen(pool))[0]?.letzter?.textIntern).toBe('zuletzt eingetroffen');
    });
  });
});
