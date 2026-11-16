/**
 * Messwert, Balken und Kurve (COPI-83, `src/module/messwert-kurve.ts`) — reine Funktionen, ohne Datenbank: deutsche
 * Zahlen, Skalierung, Pfade mit Lücken, ein einzelner Punkt, lauter gleiche Werte, und die Ansicht für Karte und
 * Kachel (Bezug, Balken, Textalternative).
 */
import { describe, expect, it } from 'vitest';
import {
  KACHEL_KURVE,
  KARTE_KURVE,
  kurvenPfade,
  kurvenTage,
  messwertAnsicht,
  minMax,
  mitEinheit,
  skala,
  yAus,
  zahlAus,
  zahlText,
  zeilenMesswert,
  type MesswertEingabe,
} from '../src/module/messwert-kurve.js';
import type { VerlaufPunkt } from '../src/module/zeitraster.js';

const JETZT = new Date('2026-09-28T10:00:00.000Z');
const STUNDE = 3_600_000;
const MASSE = { breite: 100, hoehe: 50 };

describe('Zahlen und Einheiten', () => {
  it('schreibt Zahlen deutsch, höchstens zwei Nachkommastellen', () => {
    expect(zahlText(86)).toBe('86');
    expect(zahlText(0.5)).toBe('0,5');
    expect(zahlText(1234)).toBe('1.234');
    expect(zahlText(-3.14159)).toBe('-3,14');
    expect(zahlText(-1.5)).toBe('-1,5');
  });

  it('schreibt minus null und auf null gerundete Werte ohne Minuszeichen', () => {
    expect(zahlText(-0)).toBe('0');
    expect(zahlText(-0.001)).toBe('0');
    expect(mitEinheit(-0, '%')).toBe('0 %');
  });

  it('zeigt für nicht endliche Zahlen einen Gedankenstrich, bei Einheit ohne diese', () => {
    expect(zahlText(NaN)).toBe('–');
    expect(zahlText(Infinity)).toBe('–');
    expect(zahlText(-Infinity)).toBe('–');
    expect(mitEinheit(NaN, '%')).toBe('–');
    expect(mitEinheit(Infinity, 'von 5')).toBe('–');
  });

  it('setzt ein Leerzeichen vor die Einheit, ohne Einheit nur die Zahl', () => {
    expect(mitEinheit(86, '%')).toBe('86 %');
    expect(mitEinheit(5, 'von 5')).toBe('5 von 5');
    expect(mitEinheit(180, '')).toBe('180');
  });

  it('liest numeric aus pg (Text) und übergeht NULL und Unlesbares', () => {
    expect(zahlAus('86.50')).toBe(86.5);
    expect(zahlAus(3)).toBe(3);
    expect(zahlAus(null)).toBeUndefined();
    expect(zahlAus('')).toBeUndefined();
    expect(zahlAus('NaN')).toBeUndefined();
    expect(zahlAus('Infinity')).toBeUndefined();
  });
});

describe('minMax und skala', () => {
  it('liefert ohne Werte nichts', () => {
    expect(minMax([])).toBeUndefined();
    expect(skala([], { max: 100 })).toBeUndefined();
  });

  it('nimmt mit Obergrenze 0..max', () => {
    expect(skala([71, 86], { max: 100, warnung: 85 })).toEqual({ min: 0, max: 100 });
  });

  it('dehnt sich mit Obergrenze nach oben, wenn Werte darüber liegen, und nach unten bei negativen Werten', () => {
    expect(skala([-10, 120], { max: 100 })).toEqual({ min: -10, max: 120 });
  });

  it('nimmt ohne Obergrenze die Daten mit 10 % Luft, bei nicht-negativen Werten nie unter 0', () => {
    expect(skala([100, 200], {})).toEqual({ min: 90, max: 210 });
    expect(skala([1, 11], {})).toEqual({ min: 0, max: 12 });
    expect(skala([-20, -10], {})).toEqual({ min: -21, max: -9 });
  });

  it('holt die Warnschwelle in den Bereich', () => {
    const bereich = skala([170, 410], { warnung: 1000 });
    expect(bereich?.max).toBeGreaterThan(1000);
    expect(bereich?.min).toBeLessThan(170);
  });

  it('hat auch bei lauter gleichen Werten eine Spanne > 0', () => {
    const bereich = skala([5, 5, 5], {});
    expect(bereich).toEqual({ min: 4.5, max: 5.5 });
    const null0 = skala([0, 0], {});
    expect(null0 !== undefined && null0.max > null0.min).toBe(true);
  });
});

describe('kurvenPfade', () => {
  const fenster = { min: 0, max: 100 };
  const bereich = { min: 0, max: 10 };

  it('verbindet Punkte zu einer Linie und schließt die Fläche zum Boden', () => {
    const pfade = kurvenPfade(
      [
        { zeit: 0, wert: 0 },
        { zeit: 50, wert: 10 },
        { zeit: 100, wert: 5 },
      ],
      fenster,
      bereich,
      MASSE,
    );
    expect(pfade.linie).toBe('M0 47 L50 3 L100 25');
    expect(pfade.flaeche).toBe('M0 50 L0 47 L50 3 L100 25 L100 50 Z');
    expect(pfade.punkte).toBe('');
  });

  it('unterbricht die Linie an einem Punkt ohne Wert (zwei Stücke, zwei Flächen)', () => {
    const pfade = kurvenPfade(
      [
        { zeit: 0, wert: 1 },
        { zeit: 10, wert: 2 },
        { zeit: 20, wert: undefined },
        { zeit: 30, wert: 3 },
        { zeit: 40, wert: 4 },
      ],
      fenster,
      bereich,
      MASSE,
    );
    expect(pfade.linie.match(/M/g)).toHaveLength(2);
    expect(pfade.flaeche.match(/Z/g)).toHaveLength(2);
  });

  it('zeichnet einen einzelnen Punkt als Strich der Länge null (eigener Pfad), ohne Linie und Fläche', () => {
    const pfade = kurvenPfade([{ zeit: 50, wert: 5 }], fenster, bereich, MASSE);
    expect(pfade).toEqual({ linie: '', flaeche: '', punkte: 'M50 25 h0' });
  });

  it('zeichnet einen Wert allein nach einer Lücke als Punkt, den Rest als Linie', () => {
    const pfade = kurvenPfade(
      [
        { zeit: 0, wert: 0 },
        { zeit: 50, wert: 10 },
        { zeit: 60, wert: undefined },
        { zeit: 100, wert: 5 },
      ],
      fenster,
      bereich,
      MASSE,
    );
    expect(pfade).toEqual({ linie: 'M0 47 L50 3', flaeche: 'M0 50 L0 47 L50 3 L50 50 Z', punkte: 'M100 25 h0' });
  });

  it('sortiert nach Zeit und lässt Punkte außerhalb des Fensters weg', () => {
    const pfade = kurvenPfade(
      [
        { zeit: 80, wert: 10 },
        { zeit: -5, wert: 1 },
        { zeit: 20, wert: 0 },
        { zeit: 120, wert: 1 },
      ],
      fenster,
      bereich,
      MASSE,
    );
    expect(pfade.linie).toBe('M20 47 L80 3');
  });

  it('liefert ohne Punkte leere Pfade', () => {
    expect(kurvenPfade([], fenster, bereich, MASSE)).toEqual({ linie: '', flaeche: '', punkte: '' });
  });

  it('legt lauter gleiche Werte auf eine waagerechte Linie im Innern', () => {
    const gleich = skala([5, 5], {}) ?? { min: 0, max: 1 };
    const pfade = kurvenPfade(
      [
        { zeit: 0, wert: 5 },
        { zeit: 100, wert: 5 },
      ],
      fenster,
      gleich,
      MASSE,
    );
    const y = yAus(5, gleich, MASSE);
    expect(pfade.linie).toBe(`M0 ${String(y)} L100 ${String(y)}`);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(MASSE.hoehe);
  });
});

describe('zeilenMesswert', () => {
  it('liest wert, einheit, wert_max und wert_warnung aus einer Zeile (numeric als Text)', () => {
    expect(zeilenMesswert({ wert: '86', einheit: '%', wert_max: '100', wert_warnung: '85' })).toEqual({ wert: 86, einheit: '%', max: 100, warnung: 85 });
  });

  it('ohne wert gibt es keinen Messwert — die Karte bleibt wie bisher', () => {
    expect(zeilenMesswert({ einheit: '%', wert_max: '100' })).toBeUndefined();
    expect(zeilenMesswert({ wert: null })).toBeUndefined();
  });

  it('übergeht ein wert_max ≤ 0 und eine fehlende Einheit', () => {
    expect(zeilenMesswert({ wert: '3', wert_max: '0' })).toEqual({ wert: 3, einheit: '', max: undefined, warnung: undefined });
  });
});

describe('messwertAnsicht', () => {
  function punkt(stundenVor: number, wert: number | undefined): VerlaufPunkt {
    const zeitpunkt = new Date(JETZT.getTime() - stundenVor * STUNDE);
    return wert === undefined ? { zeitpunkt, status: 'gruen' } : { zeitpunkt, status: 'gruen', wert };
  }

  const basis: MesswertEingabe = {
    titel: 'Plattenplatz',
    zeile: { wert: 86, einheit: '%', max: 100, warnung: 85 },
    punkte: [punkt(30, 70), punkt(20, 80), punkt(10, undefined), punkt(0, 86)],
    jetzt: JETZT,
    fensterMs: 24 * STUNDE,
    zeitraum: 'letzte 24 Stunden',
    masse: KARTE_KURVE,
    farbe: 'gelb',
  };

  it('zeigt Wert, Einheit, Bezug, Balken und eine Kurve mit Textalternative (nur Punkte im Fenster)', () => {
    const ansicht = messwertAnsicht(basis);

    expect(ansicht).toMatchObject({ wert: '86', einheit: '%', bezug: 'von 100 %', balken: 86, farbe: 'gelb' });
    expect(ansicht?.kurve?.text).toBe('Plattenplatz, letzte 24 Stunden: 80 – 86 %, aktuell 86 %');
    expect(ansicht?.kurve?.spanne).toBe('80 – 86 %');
    expect(ansicht?.kurve?.minMax).toBe('min. 80 % · max. 86 %');
    expect(ansicht?.kurve?.warnlinie).toBe(yAus(85, { min: 0, max: 100 }, KARTE_KURVE));
    expect(ansicht?.kurve?.breite).toBe(KARTE_KURVE.breite);
  });

  it('nennt bei nur einem Wert keine Spanne, sondern den Wert', () => {
    const ansicht = messwertAnsicht({ ...basis, punkte: [punkt(1, 86)] });
    expect(ansicht?.kurve?.spanne).toBe('86 %');
    expect(ansicht?.kurve?.punkte).toMatch(/ h0$/);
    expect(ansicht?.kurve?.linie).toBe('');
  });

  it('ohne Werte im Fenster: Wert ja, Kurve nein', () => {
    expect(messwertAnsicht({ ...basis, punkte: [punkt(30, 70), punkt(2, undefined)] })?.kurve).toBeUndefined();
    expect(messwertAnsicht({ ...basis, punkte: undefined })?.kurve).toBeUndefined();
  });

  it('ohne Zeilenwert gar nichts', () => {
    expect(messwertAnsicht({ ...basis, zeile: undefined })).toBeUndefined();
  });

  it('ohne Obergrenze kein Bezug und kein Balken; ohne Warnschwelle keine Warnlinie', () => {
    const ansicht = messwertAnsicht({ ...basis, zeile: { wert: 180, einheit: 'ms', max: undefined, warnung: undefined } });
    expect(ansicht?.bezug).toBeUndefined();
    expect(ansicht?.balken).toBeUndefined();
    expect(ansicht?.kurve?.warnlinie).toBeUndefined();
  });

  it('wiederholt „von …" nicht, wenn die Einheit es schon sagt, und begrenzt den Balken auf 0–100', () => {
    const container = messwertAnsicht({ ...basis, zeile: { wert: 5, einheit: 'von 5', max: 5, warnung: undefined } });
    expect(container?.bezug).toBeUndefined();
    expect(container?.balken).toBe(100);
    expect(messwertAnsicht({ ...basis, zeile: { wert: 150, einheit: '%', max: 100, warnung: undefined } })?.balken).toBe(100);
    expect(messwertAnsicht({ ...basis, zeile: { wert: -3, einheit: '%', max: 100, warnung: undefined } })?.balken).toBe(0);
  });

  it('nutzt für die Kachel dieselbe Rechnung mit anderen Maßen', () => {
    const ansicht = messwertAnsicht({ ...basis, masse: KACHEL_KURVE, fensterMs: 7 * 24 * STUNDE, zeitraum: 'letzte 7 Tage' });
    expect(ansicht?.kurve?.hoehe).toBe(KACHEL_KURVE.hoehe);
    expect(ansicht?.kurve?.text).toBe('Plattenplatz, letzte 7 Tage: 70 – 86 %, aktuell 86 %');
  });

  it('beschriftet die 7-Tage-Kurve mit sieben Tageskürzeln, heute zuletzt', () => {
    const tage = kurvenTage(JETZT);
    expect(tage).toHaveLength(7);
    expect(tage.at(-1)).toBe('Mo');
  });
});
