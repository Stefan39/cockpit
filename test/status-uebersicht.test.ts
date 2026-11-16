/**
 * Das Bild der Übersicht aus den Wachen (COPI-37) — reine Funktionen, ohne Datenbank und ohne Uhr.
 *
 * Zwei Sichten mit getrennten Eingaben:
 *
 *   * **Kunde** (Betriebs-Admin, Mitarbeiter): `KundenZeile` kennt nur den **kundensichtbaren** Befund
 *     einer Wache. Ein Rohbefund kann in dieser Sicht nicht vorkommen, weil die Eingabe gar kein Feld
 *     dafür hat — nicht, weil eine Bedingung ihn filtert. Auch „zuletzt geprüft" und die Farbe
 *     kommen aus diesem einen Befund: ein interner Befund ändert die Kundenseite nicht.
 *   * **Betreuer**: alle Wachen mit dem letzten Befund gleich welcher Sichtbarkeit.
 *
 * Das Cockpit übersetzt nichts (ADR 4): der Text einer Kachel ist der Klartext, den der Schreiber des
 * Befunds mitgeliefert hat. Die Sätze der Statuskarte sind Oberflächentext des Cockpits und stehen hier
 * als Literale.
 */
import { describe, expect, it } from 'vitest';
import {
  betreuerUebersicht,
  kundenUebersicht,
  type BetreuerZeile,
  type KundenZeile,
} from '../src/status/uebersicht.js';
import type { BefundStatus } from '../src/status/zustand.js';

const JETZT = new Date('2026-09-21T12:00:00.000Z');
const vor = (sekunden: number): Date => new Date(JETZT.getTime() - sekunden * 1000);

function kunde(
  kennung: string,
  status: BefundStatus,
  text: string,
  teil: Partial<KundenZeile & { vorSekunden: number }> = {},
): KundenZeile {
  return {
    kennung,
    anzeigename: teil.anzeigename,
    taktSekunden: teil.taktSekunden ?? 300,
    sichtbar: { status, textKunde: text, gemeldetAm: vor(teil.vorSekunden ?? 60) },
  };
}

describe('kundenUebersicht — Leerzustand', () => {
  it('sagt ohne eine einzige Meldung, dass noch nichts gemeldet ist, statt „alles läuft" zu behaupten', () => {
    const uebersicht = kundenUebersicht([], JETZT);

    expect(uebersicht.kacheln).toEqual([]);
    expect(uebersicht.status).toEqual({
      farbe: 'leer',
      satz: 'Noch keine Meldungen',
      detail: 'Sobald der Betrieb meldet, erscheint hier der Stand.',
    });
  });
});

describe('kundenUebersicht — der Satz der Statuskarte', () => {
  it('sagt bei lauter grünen Kacheln „Alles läuft" und zählt die Bereiche', () => {
    const uebersicht = kundenUebersicht(
      [kunde('a', 'gruen', 'läuft', { anzeigename: 'Buchungen' }), kunde('b', 'gruen', 'läuft', { anzeigename: 'Reinigung' })],
      JETZT,
    );

    expect(uebersicht.status).toEqual({ farbe: 'gruen', satz: 'Alles läuft', detail: 'Alle 2 gemeldeten Bereiche sind in Ordnung.' });
  });

  it('sagt bei einer einzelnen grünen Kachel „Der gemeldete Bereich"', () => {
    expect(kundenUebersicht([kunde('a', 'gruen', 'läuft')], JETZT).status.detail).toBe('Der gemeldete Bereich ist in Ordnung.');
  });

  it.each([
    [1, 'Alles läuft, 1 Sache im Blick'],
    [2, 'Alles läuft, 2 Sachen im Blick'],
  ])('sagt bei %i gelben Kacheln ohne Störung: %s', (anzahl, satz) => {
    const zeilen = [
      kunde('grün', 'gruen', 'alles gut'),
      ...Array.from({ length: anzahl }, (_, i) => kunde(`gelb-${String(i)}`, 'gelb', `Hinweis ${String(i)}`, { anzeigename: `Gelb ${String(i)}` })),
    ];

    const status = kundenUebersicht(zeilen, JETZT).status;

    expect(status.farbe).toBe('gelb');
    expect(status.satz).toBe(satz);
    // Der Text darunter ist der der ersten gelben Kachel: das Cockpit erfindet keinen.
    expect(status.detail).toBe('Hinweis 0');
  });

  it.each([
    [1, '1 Sache braucht Ihre Aufmerksamkeit'],
    [2, '2 Sachen brauchen Ihre Aufmerksamkeit'],
  ])('sagt bei %i roten Kacheln: %s', (anzahl, satz) => {
    const zeilen = Array.from({ length: anzahl }, (_, i) => kunde(`rot-${String(i)}`, 'rot', `Störung ${String(i)}`, { anzeigename: `Rot ${String(i)}` }));

    const status = kundenUebersicht(zeilen, JETZT).status;

    expect(status.farbe).toBe('rot');
    expect(status.satz).toBe(satz);
    expect(status.detail).toBe('Störung 0');
  });

  it('zählt bei Rot und Gelb zusammen nur die roten Sachen und nimmt den Text der ersten roten Kachel', () => {
    const uebersicht = kundenUebersicht(
      [
        kunde('gelb', 'gelb', 'gelber Text', { anzeigename: 'Aaa' }),
        kunde('rot', 'rot', 'roter Text', { anzeigename: 'Zzz' }),
        kunde('gruen', 'gruen', 'grüner Text', { anzeigename: 'Mmm' }),
      ],
      JETZT,
    );

    expect(uebersicht.status).toEqual({ farbe: 'rot', satz: '1 Sache braucht Ihre Aufmerksamkeit', detail: 'roter Text' });
  });
});

describe('kundenUebersicht — die Kacheln', () => {
  it('nimmt Name, Text, Farbe und Statuswort aus dem sichtbaren Befund', () => {
    const uebersicht = kundenUebersicht([kunde('buchung', 'rot', 'Die Buchungen sind gerade nicht erreichbar.', { anzeigename: 'Buchungs-Agent' })], JETZT);

    expect(uebersicht.kacheln).toEqual([
      {
        name: 'Buchungs-Agent',
        farbe: 'rot',
        statusWort: 'Störung',
        text: 'Die Buchungen sind gerade nicht erreichbar.',
        geprueft: 'vor 1 Min. geprüft',
        ueberfaellig: false,
      },
    ]);
  });

  it.each([
    ['gruen', 'Läuft'],
    ['gelb', 'Achtung'],
    ['rot', 'Störung'],
  ] as const)('gibt der Farbe %s das Wort „%s": Farbe allein ist keine Auskunft (WCAG 1.4.1)', (farbe, wort) => {
    expect(kundenUebersicht([kunde('a', farbe, 'x')], JETZT).kacheln[0]?.statusWort).toBe(wort);
  });

  it('nennt eine Kachel ohne Anzeigenamen „Bereich", nie die technische Kennung', () => {
    const kachel = kundenUebersicht([kunde('postgres-container-7', 'gruen', 'läuft')], JETZT).kacheln[0];

    expect(kachel?.name).toBe('Bereich');
    expect(JSON.stringify(kachel)).not.toContain('postgres');
  });

  it('sortiert Rot vor Gelb vor Grün, dann nach Namen', () => {
    const uebersicht = kundenUebersicht(
      [
        kunde('1', 'gruen', 'x', { anzeigename: 'Aaa' }),
        kunde('2', 'gelb', 'x', { anzeigename: 'Zzz' }),
        kunde('3', 'rot', 'x', { anzeigename: 'Mmm' }),
        kunde('4', 'gelb', 'x', { anzeigename: 'Bbb' }),
        kunde('5', 'rot', 'x', { anzeigename: 'Ääh' }),
      ],
      JETZT,
    );

    expect(uebersicht.kacheln.map((kachel) => `${kachel.farbe}:${kachel.name}`)).toEqual([
      'rot:Ääh',
      'rot:Mmm',
      'gelb:Bbb',
      'gelb:Zzz',
      'gruen:Aaa',
    ]);
  });

  it('sortiert bei gleichem Namen stabil nach Kennung, damit die Reihenfolge nicht zufällig ist', () => {
    const uebersicht = kundenUebersicht(
      [kunde('b', 'gruen', 'zweite'), kunde('a', 'gruen', 'erste')],
      JETZT,
    );

    expect(uebersicht.kacheln.map((kachel) => kachel.text)).toEqual(['erste', 'zweite']);
  });

  it('hat in einer Kundenkachel genau diese Felder und kein Feld für Kennung, Rohbefund oder Herkunft', () => {
    const kachel = kundenUebersicht([kunde('a', 'gruen', 'x', { anzeigename: 'A' })], JETZT).kacheln[0];

    // Ein Feld, das nicht existiert, kann nicht durch einen Fehler in der Vorlage auf die Seite geraten.
    // `messwert` (COPI-83) stammt aus demselben kundensichtbaren Befund wie der Klartext.
    expect(Object.keys(kachel ?? {}).sort()).toEqual(['farbe', 'geprueft', 'messwert', 'name', 'statusWort', 'text', 'ueberfaellig']);
  });
});

describe('kundenUebersicht — eine Wache, die ausbleibt', () => {
  it('wird gelb, sobald ihr sichtbarer Befund länger als Takt plus Toleranz zurückliegt, und sagt, wie lange', () => {
    const uebersicht = kundenUebersicht(
      [kunde('a', 'gruen', 'Alles läuft.', { anzeigename: 'Buchungen', vorSekunden: 3 * 86_400 })],
      JETZT,
    );

    expect(uebersicht.kacheln[0]).toMatchObject({
      farbe: 'gelb',
      statusWort: 'Achtung',
      ueberfaellig: true,
      geprueft: 'vor 3 Tagen geprüft',
      text: 'Alles läuft.',
    });
    expect(uebersicht.status.satz).toBe('Alles läuft, 1 Sache im Blick');
  });

  it('lässt ein gemeldetes Rot rot, auch wenn es lange her ist', () => {
    const kachel = kundenUebersicht([kunde('a', 'rot', 'Nicht erreichbar.', { vorSekunden: 5 * 86_400 })], JETZT).kacheln[0];

    expect(kachel?.farbe).toBe('rot');
  });

  it('rechnet die Frist mit dem Takt der Wache', () => {
    const woechentlich = 7 * 86_400;

    const zeilen = [kunde('a', 'gruen', 'x', { taktSekunden: woechentlich, vorSekunden: 3 * 86_400 })];

    expect(kundenUebersicht(zeilen, JETZT).kacheln[0]?.ueberfaellig).toBe(false);
  });
});

describe('kundenUebersicht — reine Funktion', () => {
  it('hängt nur an den übergebenen Werten und verändert seine Eingabe nicht', () => {
    const zeilen = [kunde('a', 'rot', 'x', { anzeigename: 'A' }), kunde('b', 'gruen', 'y', { anzeigename: 'B' })];
    const kopie = JSON.stringify(zeilen);

    const erste = kundenUebersicht(zeilen, JETZT);
    const zweite = kundenUebersicht(zeilen, JETZT);

    expect(zweite).toEqual(erste);
    expect(JSON.stringify(zeilen)).toBe(kopie);
    // Derselbe Befund, einen Tag alt: mit der Uhr von heute ist die Wache überfällig, mit einer Uhr, die vor
    // dem Befund steht, nicht (das Alter ist dann null). Das Ergebnis hängt nur am übergebenen Zeitpunkt.
    const einTagAlt = [kunde('a', 'gruen', 'x', { vorSekunden: 86_400 })];
    expect(kundenUebersicht(einTagAlt, JETZT).kacheln[0]?.ueberfaellig).toBe(true);
    expect(kundenUebersicht(einTagAlt, new Date(JETZT.getTime() - 100 * 86_400_000)).kacheln[0]?.ueberfaellig).toBe(false);
  });

  it('gibt für dieselben Eingaben in beliebiger Reihenfolge dieselbe Übersicht', () => {
    const zeilen = [kunde('a', 'rot', 'x', { anzeigename: 'A' }), kunde('b', 'gelb', 'y', { anzeigename: 'B' }), kunde('c', 'gruen', 'z', { anzeigename: 'C' })];

    expect(kundenUebersicht([...zeilen].reverse(), JETZT)).toEqual(kundenUebersicht(zeilen, JETZT));
  });
});

describe('betreuerUebersicht', () => {
  function betreuer(
    kennung: string,
    teil: Partial<Omit<BetreuerZeile, 'kennung'>> & { status?: BefundStatus; vorSekunden?: number; sichtbar?: boolean; textIntern?: string; textKunde?: string } = {},
  ): BetreuerZeile {
    const vorSekunden = teil.vorSekunden ?? 60;
    return {
      kennung,
      anzeigename: teil.anzeigename,
      taktSekunden: teil.taktSekunden ?? 300,
      letzterLauf: 'letzterLauf' in teil ? teil.letzterLauf : vor(vorSekunden),
      letzter:
        'letzter' in teil
          ? teil.letzter
          : {
              status: teil.status ?? 'gruen',
              textIntern: teil.textIntern ?? 'intern',
              textKunde: teil.textKunde,
              kundensichtbar: teil.sichtbar ?? false,
              gemeldetAm: vor(vorSekunden),
            },
    };
  }

  it('zeigt jede Wache mit Rohbefund und Kennung, auch eine ohne sichtbaren Befund', () => {
    const uebersicht = betreuerUebersicht(
      [betreuer('container', { status: 'rot', textIntern: 'postgres beendet (Exit 137)' })],
      JETZT,
    );

    expect(uebersicht.kacheln).toEqual([
      {
        name: 'container',
        kennung: 'container',
        farbe: 'rot',
        statusWort: 'Störung',
        text: 'postgres beendet (Exit 137)',
        geprueft: 'vor 1 Min. geprüft',
        ueberfaellig: false,
        kundensichtbar: false,
        kundenText: undefined,
      },
    ]);
    expect(uebersicht.status.satz).toBe('1 Sache braucht Ihre Aufmerksamkeit');
  });

  it('nennt den Anzeigenamen, wenn es einen gibt, und die Kennung daneben', () => {
    const kachel = betreuerUebersicht([betreuer('buchung', { anzeigename: 'Buchungs-Agent' })], JETZT).kacheln[0];

    expect(kachel).toMatchObject({ name: 'Buchungs-Agent', kennung: 'buchung' });
  });

  it('zeigt an, ob der Befund für Kunden sichtbar ist, und den Klartext, den der Kunde dazu sähe', () => {
    const kachel = betreuerUebersicht(
      [betreuer('a', { sichtbar: true, textKunde: 'Alles läuft.' }), betreuer('b', { sichtbar: false, textKunde: 'Noch nicht freigegeben.' })],
      JETZT,
    ).kacheln;

    expect(kachel.map((eintrag) => [eintrag.kennung, eintrag.kundensichtbar, eintrag.kundenText])).toEqual([
      ['a', true, 'Alles läuft.'],
      ['b', false, 'Noch nicht freigegeben.'],
    ]);
  });

  it('rechnet die Überfälligkeit aus dem Herzschlag der Wache: jeder Befund zählt, auch ein interner', () => {
    const frisch = betreuer('a', { status: 'gruen', vorSekunden: 30 });
    const alt = betreuer('b', { status: 'gruen', vorSekunden: 2 * 86_400 });

    const uebersicht = betreuerUebersicht([frisch, alt], JETZT);

    expect(uebersicht.kacheln.find((kachel) => kachel.kennung === 'a')?.ueberfaellig).toBe(false);
    expect(uebersicht.kacheln.find((kachel) => kachel.kennung === 'b')).toMatchObject({ ueberfaellig: true, farbe: 'gelb' });
  });

  it('zeigt eine Wache ohne Befund als „noch nie geprüft", gelb', () => {
    const kachel = betreuerUebersicht([betreuer('a', { letzterLauf: undefined, letzter: undefined })], JETZT).kacheln[0];

    expect(kachel).toMatchObject({
      farbe: 'gelb',
      ueberfaellig: true,
      geprueft: 'noch nie geprüft',
      text: 'Noch kein Befund gemeldet.',
      kundensichtbar: undefined,
    });
  });

  it('bildet den Leerzustand wie die Kundensicht', () => {
    expect(betreuerUebersicht([], JETZT).status).toEqual(kundenUebersicht([], JETZT).status);
  });

  it('zählt für den Satz alle Wachen, auch die, die der Kunde nie sähe', () => {
    const uebersicht = betreuerUebersicht(
      [betreuer('a', { status: 'gruen' }), betreuer('b', { status: 'rot', textIntern: 'intern rot' }), betreuer('c', { status: 'rot', textIntern: 'noch ein Fehler' })],
      JETZT,
    );

    expect(uebersicht.status).toEqual({ farbe: 'rot', satz: '2 Sachen brauchen Ihre Aufmerksamkeit', detail: 'intern rot' });
  });
});
