/**
 * Die Abfragen der Meldungen (COPI-43), gegen die echte Datenbank.
 *
 * Eine Meldung ist ein **Wechsel**: ein Befund, dessen Status oder Text sich gegenüber dem vorigen derselben Wache
 * geändert hat — eine Wache, die alle fünf Minuten „Alles läuft." meldet, ergibt eine Meldung, nicht hundert.
 *
 * Getrennt je Sicht, wie die Übersicht (COPI-37): die Kundenabfrage liest nur kundensichtbare Befunde, ihren
 * Klartext und den Anzeigenamen — keinen Rohbefund, keine Kennung. Auch der Wechsel wird dort nur unter den
 * sichtbaren Befunden bestimmt: ein interner Befund dazwischen ändert die Kundenliste nicht.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.befund` und `cockpit.wache` ab.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { befundMelden, type BefundMeldung } from '../src/status/befund-speicher.js';
import { betreuerMeldungenLesen, kundenMeldungenLesen } from '../src/status/meldungen-speicher.js';
import { testDatenbankUrl } from './testdatenbank.js';

const T0 = new Date('2026-09-21T12:00:00.000Z');
const GEHEIM = 'GEHEIM-INTERN-4711';
let minute = 0;

/** Ein Befund, jeder eine Minute nach dem vorigen. */
function meldung(teil: Partial<BefundMeldung> = {}): BefundMeldung {
  minute += 1;
  return {
    wache: 'buchung',
    status: 'gruen',
    textIntern: 'roh: alles läuft',
    textKunde: 'Alles läuft.',
    kundensichtbar: true,
    anzeigename: 'Buchungs-Agent',
    taktSekunden: 300,
    quelle: 'admin-agent',
    jetzt: new Date(T0.getTime() + minute * 60_000),
    ...teil,
  };
}

const ALLE = { art: undefined, suche: undefined, anzahl: 50 } as const;

describe.skipIf(!testDatenbankUrl)('Meldungen lesen (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDatenbankUrl });
  });

  beforeEach(async () => {
    minute = 0;
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.end();
  });

  async function melden(...teile: Partial<BefundMeldung>[]): Promise<void> {
    for (const teil of teile) {
      await befundMelden(pool, meldung(teil));
    }
  }

  describe('ein Wechsel ist eine Meldung', () => {
    it('fasst gleiche Befunde hintereinander zu einer Meldung zusammen: die erste zählt', async () => {
      await melden({}, {}, {}, {});

      const zeilen = await kundenMeldungenLesen(pool, ALLE);

      expect(zeilen).toHaveLength(1);
      expect(zeilen[0]?.gemeldetAm).toEqual(new Date(T0.getTime() + 60_000));
    });

    it('macht aus jedem Wechsel des Status oder des Textes eine Meldung, neueste zuerst', async () => {
      await melden(
        {},
        {},
        { status: 'gelb', textKunde: 'Zustellung fehlgeschlagen.' },
        { status: 'gelb', textKunde: 'Zustellung fehlgeschlagen.' },
        { status: 'gelb', textKunde: 'Zustellung erneut fehlgeschlagen.' },
        {},
      );

      const zeilen = await kundenMeldungenLesen(pool, ALLE);

      expect(zeilen.map((zeile) => `${zeile.status}: ${zeile.text}`)).toEqual([
        'gruen: Alles läuft.',
        'gelb: Zustellung erneut fehlgeschlagen.',
        'gelb: Zustellung fehlgeschlagen.',
        'gruen: Alles läuft.',
      ]);
    });

    it('bestimmt den Wechsel je Wache: zwei Wachen mit demselben Text sind zwei Meldungen', async () => {
      await melden({ wache: 'buchung' }, { wache: 'reinigung', anzeigename: 'Reinigungs-Agent' }, { wache: 'buchung' });

      expect(await kundenMeldungenLesen(pool, ALLE)).toHaveLength(2);
    });
  });

  describe('Kundensicht', () => {
    it('liest nur kundensichtbare Befunde, mit Klartext und Anzeigenamen', async () => {
      await melden({ status: 'rot', textIntern: GEHEIM, textKunde: undefined, kundensichtbar: false, wache: 'container', anzeigename: undefined }, {});

      const zeilen = await kundenMeldungenLesen(pool, ALLE);

      expect(zeilen).toEqual([{ status: 'gruen', text: 'Alles läuft.', gemeldetAm: expect.any(Date) as Date, name: 'Buchungs-Agent', intern: false }]);
      expect(JSON.stringify(zeilen)).not.toContain(GEHEIM);
    });

    it('lässt einen internen Befund dazwischen die Kundenliste nicht verändern', async () => {
      await melden({}, { status: 'rot', textIntern: GEHEIM, textKunde: undefined, kundensichtbar: false }, {});

      const zeilen = await kundenMeldungenLesen(pool, ALLE);

      expect(zeilen).toHaveLength(1);
      expect(JSON.stringify(zeilen)).not.toContain(GEHEIM);
    });

    it('nennt eine Wache ohne Anzeigenamen nicht beim Namen: keine Kennung in der Kundensicht', async () => {
      await melden({ wache: 'geheime-kennung', anzeigename: undefined });

      const [zeile] = await kundenMeldungenLesen(pool, ALLE);

      expect(zeile?.name).toBeUndefined();
      expect(JSON.stringify(zeile)).not.toContain('geheime-kennung');
    });
  });

  describe('Betreuersicht', () => {
    it('liest alle Befunde mit Rohbefund, nennt die Wache beim Anzeigenamen oder ihrer Kennung und markiert interne', async () => {
      await melden({ wache: 'container', status: 'rot', textIntern: GEHEIM, textKunde: undefined, kundensichtbar: false, anzeigename: undefined }, {});

      expect(await betreuerMeldungenLesen(pool, ALLE)).toEqual([
        { status: 'gruen', text: 'roh: alles läuft', gemeldetAm: expect.any(Date) as Date, name: 'Buchungs-Agent', intern: false },
        { status: 'rot', text: GEHEIM, gemeldetAm: expect.any(Date) as Date, name: 'container', intern: true },
      ]);
    });

    it('fasst auch dort gleiche Rohbefunde hintereinander zusammen', async () => {
      await melden({}, {}, {});

      expect(await betreuerMeldungenLesen(pool, ALLE)).toHaveLength(1);
    });
  });

  describe('Filter und Suche', () => {
    beforeEach(async () => {
      await melden(
        { status: 'gruen', textKunde: 'Reinigungsplan bestätigt.', wache: 'reinigung', anzeigename: 'Reinigungs-Agent' },
        { status: 'gelb', textKunde: 'Zustellung fehlgeschlagen.', wache: 'rechnung', anzeigename: 'Rechnungs-Agent' },
        { status: 'rot', textKunde: 'Zahlung konnte nicht abgebucht werden (100% Rabatt?)', wache: 'buchung', anzeigename: undefined },
      );
    });

    it.each([
      ['gelb', ['Zustellung fehlgeschlagen.']],
      ['rot', ['Zahlung konnte nicht abgebucht werden (100% Rabatt?)']],
      ['gruen', ['Reinigungsplan bestätigt.']],
    ] as const)('zeigt mit dem Filter %s nur diese', async (art, texte) => {
      expect((await kundenMeldungenLesen(pool, { ...ALLE, art })).map((zeile) => zeile.text)).toEqual(texte);
    });

    it('sucht im Text und im Namen, ohne Rücksicht auf Groß- und Kleinschreibung', async () => {
      expect((await kundenMeldungenLesen(pool, { ...ALLE, suche: 'zustellung' })).map((zeile) => zeile.text)).toEqual(['Zustellung fehlgeschlagen.']);
      expect((await kundenMeldungenLesen(pool, { ...ALLE, suche: 'reinigungs-agent' })).map((zeile) => zeile.text)).toEqual(['Reinigungsplan bestätigt.']);
    });

    it('nimmt Platzhalter in der Suche wörtlich: „%" findet nur ein Prozentzeichen', async () => {
      expect((await kundenMeldungenLesen(pool, { ...ALLE, suche: '100%' })).map((zeile) => zeile.text)).toEqual([
        'Zahlung konnte nicht abgebucht werden (100% Rabatt?)',
      ]);
      expect(await kundenMeldungenLesen(pool, { ...ALLE, suche: '%' })).toHaveLength(1);
      expect(await kundenMeldungenLesen(pool, { ...ALLE, suche: '_' })).toHaveLength(0);
    });

    it('findet in der Kundensicht nicht über die Kennung einer Wache', async () => {
      expect(await kundenMeldungenLesen(pool, { ...ALLE, suche: 'rechnung' })).toHaveLength(1);
      expect(await kundenMeldungenLesen(pool, { ...ALLE, suche: 'buchung' })).toHaveLength(0);
    });

    it('findet in der Betreuersicht auch über die Kennung', async () => {
      await melden({ wache: 'container', status: 'rot', textIntern: 'postgres beendet', textKunde: undefined, kundensichtbar: false, anzeigename: undefined });

      expect((await betreuerMeldungenLesen(pool, { ...ALLE, suche: 'contain' })).map((zeile) => zeile.text)).toEqual(['postgres beendet']);
    });

    it('liefert höchstens die gewünschte Zahl, die neuesten', async () => {
      expect((await kundenMeldungenLesen(pool, { ...ALLE, anzahl: 2 })).map((zeile) => zeile.status)).toEqual(['rot', 'gelb']);
    });
  });
});
