/**
 * Der Zustand einer Wache aus Takt, letztem Lauf und letztem Befund (COPI-36) — rein, ohne
 * Datenbank und ohne Uhr: der Zeitpunkt ist ein Parameter.
 *
 * Das Cockpit prüft nichts selbst und hat keinen Scheduler (Architektur-Vorschlag 4). Ob eine Wache
 * überfällig ist, folgt aus zwei Zeitpunkten, sobald jemand hinsieht: ein „alles grün" von vor drei
 * Tagen ist keine Auskunft, und die ausbleibende Meldung ist laut Admin-Vorgabe die häufigste stille
 * Fehlfunktion. Die Erwartungen stehen als Literale, damit der Test die Regeln nicht mitrechnet.
 */
import { describe, expect, it } from 'vitest';
import {
  BEFUND_STATUS,
  inText,
  toleranzSekunden,
  vorKurz,
  vorText,
  wachenZustand,
  type BefundStatus,
  type WachenStand,
} from '../src/status/zustand.js';

const JETZT = new Date('2026-09-21T12:00:00.000Z');

/** Ein Stand, dessen letzter Lauf `vorSekunden` zurückliegt; `undefined` heißt „nie gemeldet". */
function stand(taktSekunden: number, vorSekunden: number | undefined, letzterStatus: BefundStatus = 'gruen'): WachenStand {
  return {
    taktSekunden,
    letzterLauf: vorSekunden === undefined ? undefined : new Date(JETZT.getTime() - vorSekunden * 1000),
    letzterStatus: vorSekunden === undefined ? undefined : letzterStatus,
  };
}

describe('toleranzSekunden', () => {
  it.each([
    [10, 60],
    [60, 60],
    [120, 60],
    [121, 61],
    [300, 150],
    [301, 151],
    [3600, 1800],
    [604_800, 302_400],
  ])('gewährt bei einem Takt von %i Sekunden %i Sekunden Toleranz: die Hälfte, mindestens eine Minute', (takt, erwartet) => {
    expect(toleranzSekunden(takt)).toBe(erwartet);
  });
});

describe('wachenZustand — pünktlich', () => {
  it.each([
    ['gerade gemeldet', 0],
    ['mitten im Takt', 150],
    ['genau nach einem Takt', 300],
    ['genau an der Grenze aus Takt und Toleranz', 450],
  ])('lässt eine Wache %s so, wie sie gemeldet hat', (_name, vorSekunden) => {
    const zustand = wachenZustand(stand(300, vorSekunden), JETZT);

    expect(zustand.farbe).toBe('gruen');
    expect(zustand.ueberfaellig).toBe(false);
    expect(zustand.nieGemeldet).toBe(false);
    expect(zustand.alterSekunden).toBe(vorSekunden);
  });

  it.each(BEFUND_STATUS)('gibt den gemeldeten Status %s unverändert weiter, solange die Wache pünktlich ist', (status) => {
    expect(wachenZustand(stand(300, 100, status), JETZT).farbe).toBe(status);
  });
});

describe('wachenZustand — überfällig', () => {
  it('wird eine Sekunde nach Takt plus Toleranz gelb: die Wache ist ausgeblieben, ihr letztes „grün" gilt nicht mehr', () => {
    const zustand = wachenZustand(stand(300, 451), JETZT);

    expect(zustand.farbe).toBe('gelb');
    expect(zustand.ueberfaellig).toBe(true);
    expect(zustand.zuletztGeprueft).toBe('zuletzt geprüft vor 7 Minuten');
  });

  it('bleibt bei einer sehr langen Pause gelb und sagt in Tagen, wie lange es her ist', () => {
    const zustand = wachenZustand(stand(300, 3 * 86_400), JETZT);

    expect(zustand.farbe).toBe('gelb');
    expect(zustand.ueberfaellig).toBe(true);
    expect(zustand.zuletztGeprueft).toBe('zuletzt geprüft vor 3 Tagen');
  });

  it('lässt ein gemeldetes Gelb gelb', () => {
    expect(wachenZustand(stand(300, 10_000, 'gelb'), JETZT).farbe).toBe('gelb');
  });

  it.each([
    ['pünktlich', 60],
    ['knapp überfällig', 451],
    ['lange überfällig', 5 * 86_400],
  ])('lässt ein gemeldetes Rot rot, auch wenn die Wache %s ist: eine Störung wird durch Schweigen nicht besser', (_name, vorSekunden) => {
    expect(wachenZustand(stand(300, vorSekunden, 'rot'), JETZT).farbe).toBe('rot');
  });

  it('rechnet die Grenze je Wache aus ihrem eigenen Takt: eine wöchentliche Wache ist nach drei Tagen nicht überfällig', () => {
    const woechentlich = 7 * 86_400;

    expect(wachenZustand(stand(woechentlich, 3 * 86_400), JETZT).ueberfaellig).toBe(false);
    // 7 Tage plus die halbe Woche Toleranz = 10,5 Tage.
    expect(wachenZustand(stand(woechentlich, 10 * 86_400), JETZT).ueberfaellig).toBe(false);
    expect(wachenZustand(stand(woechentlich, 11 * 86_400), JETZT).ueberfaellig).toBe(true);
  });

  it('hat für eine Wache mit kurzem Takt mindestens eine Minute Spielraum', () => {
    // Takt 10 s + 60 s Toleranz = 70 s.
    expect(wachenZustand(stand(10, 70), JETZT).ueberfaellig).toBe(false);
    expect(wachenZustand(stand(10, 71), JETZT).ueberfaellig).toBe(true);
  });
});

describe('wachenZustand — nie gemeldet', () => {
  it('ist gelb und ausdrücklich „noch nie geprüft", nicht ein erfundenes „gerade eben"', () => {
    const zustand = wachenZustand(stand(300, undefined), JETZT);

    expect(zustand.farbe).toBe('gelb');
    expect(zustand.ueberfaellig).toBe(true);
    expect(zustand.nieGemeldet).toBe(true);
    expect(zustand.alterSekunden).toBeUndefined();
    expect(zustand.zuletztGeprueft).toBe('noch nie geprüft');
  });

  it('behandelt einen unlesbaren Zeitpunkt wie „nie gemeldet"', () => {
    const zustand = wachenZustand({ taktSekunden: 300, letzterLauf: new Date('kaputt'), letzterStatus: 'gruen' }, JETZT);

    expect(zustand.nieGemeldet).toBe(true);
    expect(zustand.farbe).toBe('gelb');
  });
});

describe('wachenZustand — die Uhr springt zurück', () => {
  it('rechnet ein Alter unter null als „gerade eben": die Wache ist nicht überfällig und wird nicht als Zukunft beschrieben', () => {
    const zustand = wachenZustand(stand(300, -600), JETZT);

    expect(zustand.alterSekunden).toBe(0);
    expect(zustand.ueberfaellig).toBe(false);
    expect(zustand.farbe).toBe('gruen');
    expect(zustand.zuletztGeprueft).toBe('zuletzt geprüft gerade eben');
  });

  it('täuscht damit keine Gesundheit vor: ein gemeldetes Rot bleibt rot', () => {
    expect(wachenZustand(stand(300, -600, 'rot'), JETZT).farbe).toBe('rot');
  });
});

describe('wachenZustand — im Zweifel gelb', () => {
  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'nimmt bei einem unbrauchbaren Takt (%s) an, dass die Wache überfällig ist, statt sie grün zu lassen',
    (takt) => {
      const zustand = wachenZustand(stand(takt, 10), JETZT);

      expect(zustand.ueberfaellig).toBe(true);
      expect(zustand.farbe).toBe('gelb');
    },
  );

  it('lässt ein Rot auch bei unbrauchbarem Takt rot', () => {
    expect(wachenZustand(stand(0, 10, 'rot'), JETZT).farbe).toBe('rot');
  });

  it('nimmt für einen Lauf ohne bekannten Befund nicht „grün" an', () => {
    const zustand = wachenZustand({ taktSekunden: 300, letzterLauf: new Date(JETZT.getTime() - 5000), letzterStatus: undefined }, JETZT);

    expect(zustand.farbe).toBe('gelb');
  });
});

describe('wachenZustand — „zuletzt geprüft vor …"', () => {
  it.each([
    [0, 'zuletzt geprüft gerade eben'],
    [59, 'zuletzt geprüft gerade eben'],
    [60, 'zuletzt geprüft vor 1 Minute'],
    [119, 'zuletzt geprüft vor 1 Minute'],
    [120, 'zuletzt geprüft vor 2 Minuten'],
    [3599, 'zuletzt geprüft vor 59 Minuten'],
    [3600, 'zuletzt geprüft vor 1 Stunde'],
    [7199, 'zuletzt geprüft vor 1 Stunde'],
    [7200, 'zuletzt geprüft vor 2 Stunden'],
    [86_399, 'zuletzt geprüft vor 23 Stunden'],
    [86_400, 'zuletzt geprüft vor 1 Tag'],
    [172_799, 'zuletzt geprüft vor 1 Tag'],
    [172_800, 'zuletzt geprüft vor 2 Tagen'],
    [30 * 86_400, 'zuletzt geprüft vor 30 Tagen'],
  ])('sagt bei %i Sekunden: %s', (vorSekunden, erwartet) => {
    // Ein sehr weiter Takt, damit der Text unabhängig vom Überfälligsein geprüft wird.
    expect(wachenZustand(stand(365 * 86_400, vorSekunden), JETZT).zuletztGeprueft).toBe(erwartet);
  });

  it('rundet ab: 119 Sekunden sind eine Minute, nicht zwei', () => {
    expect(wachenZustand(stand(365 * 86_400, 119), JETZT).zuletztGeprueft).toContain('1 Minute');
  });
});

describe('vorText (COPI-38)', () => {
  it.each([
    [0, 'gerade eben'],
    [59, 'gerade eben'],
    [60, 'vor 1 Minute'],
    [119, 'vor 1 Minute'],
    [120, 'vor 2 Minuten'],
    [3599, 'vor 59 Minuten'],
    [3600, 'vor 1 Stunde'],
    [86_399, 'vor 23 Stunden'],
    [86_400, 'vor 1 Tag'],
    [3 * 86_400 + 5, 'vor 3 Tagen'],
  ])('sagt für %s Sekunden „%s"', (sekunden, erwartet) => {
    expect(vorText(sekunden)).toBe(erwartet);
  });
});

describe('vorKurz (COPI-43, Prototyp: „vor 4 Min.")', () => {
  it.each([
    [0, 'gerade eben'],
    [59, 'gerade eben'],
    [60, 'vor 1 Min.'],
    [3599, 'vor 59 Min.'],
    [3600, 'vor 1 Std.'],
    [86_399, 'vor 23 Std.'],
    [86_400, 'vor 1 Tag'],
    [3 * 86_400, 'vor 3 Tagen'],
  ])('sagt für %s Sekunden „%s"', (sekunden, erwartet) => {
    expect(vorKurz(sekunden)).toBe(erwartet);
  });
});

describe('wachenZustand — „vor 4 Min. geprüft" für die Kacheln (COPI-43)', () => {
  it('nennt die kurze Form mit „geprüft"', () => {
    expect(wachenZustand(stand(300, 4 * 60), JETZT).geprueftKurz).toBe('vor 4 Min. geprüft');
    expect(wachenZustand(stand(300, 10), JETZT).geprueftKurz).toBe('gerade eben geprüft');
  });

  it('erfindet für eine Wache, die nie gemeldet hat, keine Zeit', () => {
    expect(wachenZustand(stand(300, undefined), JETZT).geprueftKurz).toBe('noch nie geprüft');
  });
});

describe('wachenZustand — reine Funktion', () => {
  it('hängt nur an den übergebenen Werten: dasselbe Argument, dasselbe Ergebnis, gleich welche Uhr läuft', () => {
    const alt = new Date('2001-03-04T05:06:07.000Z');
    const eingabe: WachenStand = { taktSekunden: 300, letzterLauf: new Date(alt.getTime() - 100_000), letzterStatus: 'gruen' };

    expect(wachenZustand(eingabe, alt)).toEqual(wachenZustand(eingabe, alt));
    expect(wachenZustand(eingabe, alt).ueberfaellig).toBe(false);
    // Mit einer Uhr von heute wäre dieselbe Wache seit 25 Jahren überfällig.
    expect(wachenZustand(eingabe, JETZT).ueberfaellig).toBe(true);
  });

  it('verändert seine Eingabe nicht', () => {
    const letzterLauf = new Date(JETZT.getTime() - 1000);
    const eingabe: WachenStand = { taktSekunden: 300, letzterLauf, letzterStatus: 'gruen' };

    wachenZustand(eingabe, JETZT);

    expect(letzterLauf.getTime()).toBe(JETZT.getTime() - 1000);
    expect(eingabe).toEqual({ taktSekunden: 300, letzterLauf, letzterStatus: 'gruen' });
  });
});

describe('BEFUND_STATUS', () => {
  it('nennt genau die drei Farben, die auch die Datenbank kennt', () => {
    expect([...BEFUND_STATUS]).toEqual(['gruen', 'gelb', 'rot']);
  });
});

describe('inText (COPI-45)', () => {
  it.each([
    [0, 'in weniger als einer Minute'],
    [59, 'in weniger als einer Minute'],
    [60, 'in 1 Minute'],
    [179, 'in 2 Minuten'],
    [3600, 'in 1 Stunde'],
    [3 * 3600 - 1, 'in 2 Stunden'],
    [86_400, 'in 1 Tag'],
    [3 * 86_400, 'in 3 Tagen'],
  ])('sagt für %i Sekunden „%s" (abgerundet, wie „vor …")', (sekunden, erwartet) => {
    expect(inText(sekunden)).toBe(erwartet);
  });
});
