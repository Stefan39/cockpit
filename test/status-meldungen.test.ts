/**
 * Meldungen (COPI-43, Prototyp „Meldungen" und „Letzte Meldungen") — reine Funktionen, der Zeitpunkt ist ein
 * Parameter.
 *
 * Eine Meldung ist ein **Wechsel**: ein Befund, dessen Status oder Text sich gegenüber dem vorigen derselben Wache
 * geändert hat (die Abfrage wählt sie aus, `meldungen-speicher.ts`). Die Kundensicht kennt nur kundensichtbare
 * Befunde und nie die Kennung einer Wache; der Betreuer sieht alle, mit Rohbefund.
 */
import { describe, expect, it } from 'vitest';
import { filterAus, MELDUNGEN_SUCHE_HOECHSTENS, meldungenAnsicht, type MeldungZeile } from '../src/status/meldungen.js';

const JETZT = new Date('2026-09-21T12:00:00.000Z');
const vor = (sekunden: number): Date => new Date(JETZT.getTime() - sekunden * 1000);

function zeile(teil: Partial<MeldungZeile> = {}): MeldungZeile {
  return { status: 'gelb', text: 'Zustellung fehlgeschlagen.', gemeldetAm: vor(2 * 3600), name: 'Rechnungs-Agent', intern: false, ...teil };
}

describe('filterAus', () => {
  it.each([
    [{}, { art: undefined, suche: undefined, artWert: '' }],
    [{ art: 'warnung' }, { art: 'gelb', suche: undefined, artWert: 'warnung' }],
    [{ art: 'fehler' }, { art: 'rot', suche: undefined, artWert: 'fehler' }],
    [{ art: 'info' }, { art: 'gruen', suche: undefined, artWert: 'info' }],
    [{ art: 'lila' }, { art: undefined, suche: undefined, artWert: '' }],
    [{ art: ['fehler', 'info'] }, { art: undefined, suche: undefined, artWert: '' }],
    [{ q: '  Zustellung  ' }, { art: undefined, suche: 'Zustellung', artWert: '' }],
    [{ q: '   ' }, { art: undefined, suche: undefined, artWert: '' }],
  ])('liest %j als %j', (anfrage, erwartet) => {
    expect(filterAus(anfrage)).toEqual(erwartet);
  });

  it('kürzt eine zu lange Suche, statt an ihr zu scheitern', () => {
    expect(filterAus({ q: 'x'.repeat(500) }).suche).toHaveLength(MELDUNGEN_SUCHE_HOECHSTENS);
  });
});

describe('meldungenAnsicht', () => {
  it('schreibt jede Meldung wie der Prototyp: Titel, Farbe, „vor 2 Std. · Name"', () => {
    expect(meldungenAnsicht([zeile()], JETZT)).toEqual([
      { titel: 'Zustellung fehlgeschlagen.', farbe: 'gelb', zeit: 'vor 2 Std.', meta: 'vor 2 Std. · Rechnungs-Agent', intern: false },
    ]);
  });

  it('nennt eine Wache ohne Anzeigenamen „Bereich": nie die Kennung', () => {
    expect(meldungenAnsicht([zeile({ name: undefined })], JETZT)[0]?.meta).toBe('vor 2 Std. · Bereich');
  });

  it('kennzeichnet in der Betreuersicht, was der Kunde nicht sieht', () => {
    expect(meldungenAnsicht([zeile({ intern: true })], JETZT)[0]?.intern).toBe(true);
  });

  it('behält die Reihenfolge der Abfrage (neueste zuerst)', () => {
    const titel = meldungenAnsicht([zeile({ text: 'neu', gemeldetAm: vor(60) }), zeile({ text: 'alt', gemeldetAm: vor(7200) })], JETZT).map(
      (meldung) => meldung.titel,
    );

    expect(titel).toEqual(['neu', 'alt']);
  });

  it('sagt „gerade eben", wenn die Uhr zurückgesprungen ist', () => {
    expect(meldungenAnsicht([zeile({ gemeldetAm: new Date(JETZT.getTime() + 60_000) })], JETZT)[0]?.zeit).toBe('gerade eben');
  });
});
