/**
 * Die Aufbereitung der Chat-Seite (COPI-53) als reine Funktionen: Uhrzeit in der Zeit des Betriebs, Absender, KI-Marke,
 * Vorschau und die Prüfung einer Eingabe.
 */
import { describe, expect, it } from 'vitest';
import { absenderText, datumText, eigeneStaende, eingabePruefen, nachrichtAnsicht, nachrichtStatus, neuTrennerVor, vorschau, zeitText } from '../src/chat/ansicht.js';
import type { Nachricht } from '../src/chat/nachricht-speicher.js';

function nachricht(teil: Partial<Nachricht> = {}): Nachricht {
  return {
    id: 7,
    kanalId: 1,
    absenderArt: 'mensch',
    absenderId: 'anna',
    absenderName: 'Anna Berg',
    inhalt: 'Hallo',
    dringend: false,
    antwortAuf: undefined,
    erstelltAm: new Date('2026-09-23T08:15:00.000Z'),
    geloeschtAm: undefined,
    ...teil,
  };
}

describe('zeitText', () => {
  it('zeigt am selben Tag nur die Uhrzeit, in Berliner Zeit', () => {
    expect(zeitText(new Date('2026-09-23T08:15:00.000Z'), new Date('2026-09-23T20:00:00.000Z'))).toBe('10:15');
  });

  it('zeigt an einem anderen Tag das Datum dazu — der Tag ist der in Berlin, nicht in UTC', () => {
    // 23:30 UTC am 22. ist schon der 23. in Berlin (Sommerzeit): derselbe Tag wie „jetzt".
    expect(zeitText(new Date('2026-09-22T23:30:00.000Z'), new Date('2026-09-23T08:00:00.000Z'))).toBe('01:30');
    expect(zeitText(new Date('2026-09-22T21:30:00.000Z'), new Date('2026-09-23T08:00:00.000Z'))).toBe('22.09.2026, 23:30');
  });
});

describe('datumText (COPI-84)', () => {
  it.each([
    ['über Mitternacht UTC hinaus, Sommerzeit', '2026-09-21T22:30:00.000Z', '22.09.2026'],
    ['in der Winterzeit', '2026-01-15T23:30:00.000Z', '16.01.2026'],
    ['in der Winterzeit, kurz vor Mitternacht UTC', '2026-01-15T22:30:00.000Z', '15.01.2026'],
  ])('zeigt das Datum in Berliner Zeit: %s', (_fall, zeitpunkt, erwartet) => {
    expect(datumText(new Date(zeitpunkt))).toBe(erwartet);
  });
});

describe('absenderText', () => {
  it.each<[string, Partial<Nachricht>, boolean, string]>([
    ['Koordinator', { absenderArt: 'agent', absenderId: undefined, absenderName: undefined }, false, 'Koordinator'],
    ['Cockpit', { absenderArt: 'system', absenderId: undefined, absenderName: undefined }, false, 'Cockpit'],
    ['eigene Nachricht eines Menschen', {}, true, 'Du'],
    ['fremder Mensch mit Namen', {}, false, 'Anna Berg'],
    ['fremder Mensch ohne Namen', { absenderName: undefined }, false, 'Unbekannt'],
  ])('nennt bei %s den richtigen Absender', (_fall, teil, eigen, erwartet) => {
    expect(absenderText(nachricht(teil), eigen)).toBe(erwartet);
  });
});

describe('nachrichtStatus (COPI-69)', () => {
  it.each<[string, Partial<Nachricht>, boolean, string | undefined]>([
    ['gelöscht markiert, auch mit Antwort danach', { geloeschtAm: new Date() }, true, undefined],
    ['Antwort danach', {}, true, 'beantwortet'],
    ['ohne Antwort, zugestellt', { zugestelltAm: new Date() }, false, 'angenommen'],
    ['ohne Antwort, nicht zugestellt', {}, false, 'gesendet'],
  ])('liefert bei %s den richtigen Stand', (_fall, teil, antwortDanach, erwartet) => {
    expect(nachrichtStatus(nachricht(teil), antwortDanach)).toBe(erwartet);
  });
});

describe('nachrichtAnsicht', () => {
  it.each<[string, Partial<Nachricht>, string, { absender: string; eigen: boolean; ki: boolean }]>([
    ['eigene', {}, 'anna', { absender: 'Du', eigen: true, ki: false }],
    ['von jemand anderem', {}, 'bert', { absender: 'Anna Berg', eigen: false, ki: false }],
    ['ohne bekannten Namen', { absenderName: undefined }, 'bert', { absender: 'Unbekannt', eigen: false, ki: false }],
    ['vom Koordinator', { absenderArt: 'agent', absenderId: undefined, absenderName: undefined }, 'anna', { absender: 'Koordinator', eigen: false, ki: true }],
    ['vom Cockpit', { absenderArt: 'system', absenderId: undefined, absenderName: undefined }, 'anna', { absender: 'Cockpit', eigen: false, ki: false }],
  ])('zeigt eine Nachricht %s richtig an', (_fall, teil, betrachter, erwartet) => {
    expect(nachrichtAnsicht(nachricht(teil), betrachter, new Date('2026-09-23T12:00:00.000Z'))).toMatchObject({
      ...erwartet,
      zeit: '10:15',
      zeitIso: '2026-09-23T08:15:00.000Z',
    });
  });
});

describe('vorschau', () => {
  it('fasst auf eine Zeile zusammen und kürzt nach 60 Zeichen', () => {
    expect(vorschau(nachricht({ inhalt: 'Zeile 1\n\n  Zeile 2' }))).toBe('Zeile 1 Zeile 2');
    expect(vorschau(nachricht({ inhalt: 'x'.repeat(61) }))).toBe(`${'x'.repeat(59)}…`);
    expect(vorschau(nachricht({ inhalt: 'x'.repeat(60) }))).toBe('x'.repeat(60));
  });

  it('verrät den Inhalt einer gelöschten Nachricht nicht, und ohne Nachricht gibt es keine Vorschau', () => {
    expect(vorschau(nachricht({ inhalt: undefined, geloeschtAm: new Date() }))).toBe('Nachricht gelöscht');
    expect(vorschau(undefined)).toBeUndefined();
  });
});

describe('eingabePruefen', () => {
  it.each([
    [undefined, 'Bitte eine Nachricht eingeben.'],
    [42, 'Bitte eine Nachricht eingeben.'],
    ['', 'Bitte eine Nachricht eingeben.'],
    ['\n\t  ', 'Bitte eine Nachricht eingeben.'],
    ['x'.repeat(4001), 'Die Nachricht ist zu lang: höchstens 4000 Zeichen.'],
  ])('weist %j ab', (roh, fehler) => {
    expect(eingabePruefen(roh)).toEqual({ ok: false, fehler });
  });

  it('nimmt eine Nachricht an, vereinheitlicht Zeilenumbrüche, zählt Code-Points', () => {
    expect(eingabePruefen('a\r\nb\rc')).toEqual({ ok: true, inhalt: 'a\nb\nc' });
    expect(eingabePruefen('😀'.repeat(4000))).toEqual({ ok: true, inhalt: '😀'.repeat(4000) });
  });
});

describe('eigeneStaende (COPI-69)', () => {
  const eigene = (id: number, teil: Partial<Nachricht> = {}) => nachricht({ id, ...teil });
  const agent = (id: number) => nachricht({ id, absenderArt: 'agent', absenderId: undefined, absenderName: undefined });
  const system = (id: number) => nachricht({ id, absenderArt: 'system', absenderId: undefined, absenderName: undefined });

  it('unterscheidet gesendet, angenommen und beantwortet', () => {
    const verlauf = [eigene(1, { zugestelltAm: new Date() }), agent(2), eigene(3, { zugestelltAm: new Date() }), eigene(4)];

    expect([...eigeneStaende(verlauf, 'anna')]).toEqual([
      [4, 'gesendet'],
      [3, 'angenommen'],
      [1, 'beantwortet'],
    ]);
  });

  it('macht zwei eigene Nachrichten vor einer Antwort beide beantwortet', () => {
    const staende = eigeneStaende([eigene(1), eigene(2), agent(3)], 'anna');

    expect(staende.get(1)).toBe('beantwortet');
    expect(staende.get(2)).toBe('beantwortet');
  });

  it('zählt die Meldung des Cockpits nicht als Antwort', () => {
    expect(eigeneStaende([eigene(1, { zugestelltAm: new Date() }), system(2)], 'anna').get(1)).toBe('angenommen');
  });

  it('zählt eine als gelöscht markierte Antwort noch als Antwort, gibt gelöschten eigenen aber kein Häkchen', () => {
    const staende = eigeneStaende(
      [eigene(1), eigene(2, { inhalt: undefined, geloeschtAm: new Date() }), { ...agent(3), inhalt: undefined, geloeschtAm: new Date() }],
      'anna',
    );

    expect(staende.get(1)).toBe('beantwortet');
    expect(staende.has(2)).toBe(false);
  });

  it('ignoriert fremde Nachrichten und kennt eine Antwort auf einer neueren Seite', () => {
    expect([...eigeneStaende([eigene(1, { absenderId: 'bert' })], 'anna')]).toEqual([]);
    expect(eigeneStaende([eigene(1)], 'anna', true).get(1)).toBe('beantwortet');
  });

  it('gibt die Ansicht nur eigenen Nachrichten mit Stand', () => {
    expect(nachrichtAnsicht(nachricht(), 'anna', new Date(), 'gesendet').status).toBe('gesendet');
    expect(nachrichtAnsicht(nachricht(), 'bert', new Date(), 'gesendet').status).toBeUndefined();
  });
});

describe('neuTrennerVor (COPI-69)', () => {
  const von = (id: number, absenderId: string, teil: Partial<Nachricht> = {}) => nachricht({ id, absenderId, ...teil });

  it('nimmt die erste fremde Nachricht nach dem Lesestand', () => {
    const verlauf = [von(1, 'bert'), von(2, 'anna'), von(3, 'bert'), von(4, 'bert')];

    expect(neuTrennerVor(verlauf, 'anna', 1, false)).toBe(3);
  });

  it('überspringt eigene und als gelöscht markierte Nachrichten, und meldet nichts, wenn alles gelesen ist', () => {
    const verlauf = [von(1, 'bert'), von(2, 'bert', { geloeschtAm: new Date(), inhalt: undefined }), von(3, 'anna')];

    expect(neuTrennerVor(verlauf, 'anna', 1, false)).toBeUndefined();
    expect(neuTrennerVor(verlauf, 'anna', 3, false)).toBeUndefined();
    expect(neuTrennerVor([], 'anna', 0, false)).toBeUndefined();
  });

  it('zeigt beim Blättern nur, wenn die erste ungelesene Nachricht auf der Seite liegt', () => {
    const seite = [von(10, 'bert'), von(11, 'bert')];

    // Lesestand liegt vor der Seite, davor gibt es ältere: die erste ungelesene steht weiter vorn.
    expect(neuTrennerVor(seite, 'anna', 5, true)).toBeUndefined();
    // Lesestand liegt in der Seite: der Trenner gehört hierher.
    expect(neuTrennerVor(seite, 'anna', 10, true)).toBe(11);
    // Älteste Seite (nichts davor): alles darin ist ungelesen, der Trenner steht vor der ersten.
    expect(neuTrennerVor(seite, 'anna', 0, false)).toBe(10);
  });
});
