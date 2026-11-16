/**
 * Zeiträume, Zahlen und Diagramm der Kennzahlen-Seite (COPI-98) — reine Funktionen, ohne Datenbank.
 */
import { describe, expect, it } from 'vitest';
import type { ModulBlock } from '../src/module/block.js';
import { anzahlText, diagrammAus, euroText, kennzahlenKarte, kennzahlenSeite, spanneText } from '../src/module/kennzahlen-ansicht.js';
import type { KennzahlenDaten } from '../src/module/kennzahlen-lesen.js';
import { kartenSpannen, tageDer, zeitraumAus } from '../src/module/kennzahlen-zeitraum.js';

const HEUTE = '2026-09-30';

const BLOCK = {
  kennung: 'ki-verbrauch',
  menuename: 'KI-Verbrauch',
  ansicht: 'kennzahlen',
  view: 'v_modul_ki_verbrauch',
  spalten: [
    { name: 'wert', label: 'Kosten', format: 'euro' },
    { name: 'tokens', label: 'Tokens', format: 'zahl', davon: { name: 'tokens_cache_lesen', text: 'aus dem Cache gelesen' } },
    { name: 'einsaetze', label: 'Einsätze' },
  ],
  aufteilungen: [{ name: 'projekt', label: 'Je Projekt', filter: true, darunter: { name: 'ticket', label: 'Je Ticket' } }],
  anteile: [
    { name: 'wert_geschaetzt', label: 'geschätzt', text: 'Anteil aus Schätzungen' },
    { name: 'ohne_preis', label: 'ohne Preis', format: 'anzahl' },
  ],
  rollen: ['betreuer'],
  eingriffe: [],
  uebersicht: { titel: 'KI-Verbrauch' },
} satisfies ModulBlock;

function tag(datum: string, wert: number, mehr: Record<string, number | null> = {}) {
  return { tag: datum, summen: { wert, tokens: 1000, tokens_cache_lesen: 950, einsaetze: 10, wert_geschaetzt: 0, ohne_preis: 0, ...mehr } };
}

const DATEN: KennzahlenDaten = {
  tage: [tag('2026-09-28', 10), tag('2026-09-29', 30, { wert_geschaetzt: 4, ohne_preis: 3 }), tag('2026-09-30', 20)],
  vergleich: 45.5,
  ungefiltert: null,
  aufteilungen: [
    {
      spalte: 'projekt',
      label: 'Je Projekt',
      verlinkt: true,
      gruppen: [
        { schluessel: 'JAC', wert: 36 },
        { schluessel: 'COPI', wert: 18 },
        { schluessel: null, wert: 6 },
      ],
    },
  ],
};

describe('Zeiträume', () => {
  it('rechnet „Heute" mit gestern als Vergleich', () => {
    expect(zeitraumAus('heute', HEUTE)).toMatchObject({ spanne: { von: HEUTE, bis: HEUTE }, vergleich: { von: '2026-09-29', bis: '2026-09-29' } });
  });

  it('rechnet 7 und 30 Tage einschließlich heute, der Vergleich liegt gleich lang unmittelbar davor', () => {
    expect(zeitraumAus('7', HEUTE)).toMatchObject({ spanne: { von: '2026-09-24', bis: HEUTE }, vergleich: { von: '2026-09-17', bis: '2026-09-23' } });
    expect(zeitraumAus('30', HEUTE)).toMatchObject({ spanne: { von: '2026-09-01', bis: HEUTE }, vergleich: { von: '2026-08-02', bis: '2026-08-31' } });
  });

  it('vergleicht den laufenden Monat mit dem Vormonat bis zum selben Tag', () => {
    expect(zeitraumAus('monat', '2026-09-12')).toMatchObject({ spanne: { von: '2026-09-01', bis: '2026-09-12' }, vergleich: { von: '2026-08-01', bis: '2026-08-12' } });
  });

  it('schneidet den Vergleich am Ende eines kürzeren Vormonats ab', () => {
    expect(zeitraumAus('monat', '2026-03-31').vergleich).toEqual({ von: '2026-02-01', bis: '2026-02-28' });
  });

  it('rechnet den Vormonat ganz, auch über den Jahreswechsel', () => {
    expect(zeitraumAus('vormonat', '2026-01-15')).toMatchObject({ spanne: { von: '2025-12-01', bis: '2025-12-31' }, vergleich: { von: '2025-11-01', bis: '2025-11-30' } });
  });

  it('verliert über die Umstellung der Sommerzeit keinen Tag', () => {
    expect(tageDer({ von: '2026-10-24', bis: '2026-10-26' })).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
  });

  it('gibt der Karte den laufenden Monat, den ganzen Vormonat und die letzten 30 Tage', () => {
    expect(kartenSpannen(HEUTE)).toEqual({
      monat: { von: '2026-09-01', bis: HEUTE },
      vormonat: { von: '2026-08-01', bis: '2026-08-31' },
      verlauf: { von: '2026-09-01', bis: HEUTE },
    });
  });
});

describe('Zahlen', () => {
  it('schreibt Beträge deutsch in Euro', () => {
    expect(euroText(412.38)).toBe('412,38 €');
    expect(euroText(1234.5)).toBe('1.234,50 €');
  });

  it.each([
    [9412, '9.412'],
    [999_999, '999.999'],
    [812_400_000, '812 Mio.'],
    [12_340_000, '12,3 Mio.'],
    [1_840_000_000, '1,84 Mrd.'],
    [0, '0'],
  ])('kürzt %d zu „%s"', (wert, text) => {
    expect(anzahlText(wert)).toBe(text);
  });

  it('nennt eine Spanne mit Anfang und Ende, einen einzelnen Tag nur einmal', () => {
    expect(spanneText({ von: '2026-09-01', bis: HEUTE })).toBe('01.09. bis 30.09.2026');
    expect(spanneText({ von: HEUTE, bis: HEUTE })).toBe('30.09.2026');
  });
});

describe('Diagramm', () => {
  const spalte = { name: 'wert', label: 'Kosten', format: 'euro' } as const;

  it('zeichnet je Tag mit Wert einen Balken, hebt den letzten Tag hervor und lässt leere Tage frei', () => {
    const bild = diagrammAus(DATEN.tage, { von: '2026-09-27', bis: HEUTE }, spalte);

    expect(bild.balken).toHaveLength(3);
    expect(bild.balken.map((balken) => balken.letzter)).toEqual([false, false, true]);
    // Vier Tage auf 600 Einheiten: der erste Balken gehört zum zweiten Tag.
    expect(bild.balken[0]?.x).toBe(174);
    expect(bild.balken[0]?.titel).toBe('28.09.: 10,00 €');
  });

  it('wählt eine runde Skala über dem größten Wert und bleibt in der Fläche', () => {
    const bild = diagrammAus(DATEN.tage, { von: '2026-09-28', bis: HEUTE }, spalte);

    expect(bild.skala).toEqual(['30,00 €', '15,00 €', '0']);
    for (const balken of bild.balken) {
      expect(balken.y).toBeGreaterThanOrEqual(0);
      expect(balken.y + balken.hoehe).toBeCloseTo(bild.hoehe, 0);
    }
  });

  it('trägt eine Textalternative mit Spanne, kleinstem, größtem und letztem Wert', () => {
    expect(diagrammAus(DATEN.tage, { von: '2026-09-28', bis: HEUTE }, spalte).text).toBe(
      'Kosten je Tag, 28.09. bis 30.09.2026: zwischen 10,00 € und 30,00 €, zusammen 60,00 €, zuletzt 20,00 €.',
    );
    expect(diagrammAus([], { von: '2026-09-28', bis: HEUTE }, spalte).text).toBe('Kosten je Tag, 28.09. bis 30.09.2026: keine Werte.');
  });

  it('beschriftet die Achse mit höchstens fünf Tagen, dem ersten und dem letzten', () => {
    const achse = diagrammAus([], { von: '2026-09-01', bis: HEUTE }, spalte).achse;

    expect(achse).toHaveLength(5);
    expect(achse[0]).toBe('01.09.');
    expect(achse[4]).toBe('30.09.');
  });
});

describe('Seite', () => {
  const zeitraum = zeitraumAus('7', HEUTE);

  it('zeigt je Spalte eine Kennzahl und dazu den Tagesschnitt', () => {
    const seite = kennzahlenSeite('ki-verbrauch', BLOCK, zeitraum, undefined, DATEN, []);

    expect(seite.kennzahlen).toEqual([
      { label: 'Kosten', wert: '60,00 €', zusatz: 'Zeitraum davor: 45,50 €' },
      { label: 'Tokens', wert: '3.000', zusatz: 'davon 95 % aus dem Cache gelesen' },
      { label: 'Einsätze', wert: '30', zusatz: undefined },
      { label: 'Je Tag', wert: '8,57 €', zusatz: 'höchster Tag 30,00 €' },
    ]);
    expect(seite.leer).toBe(false);
  });

  it('markiert den gewählten Zeitraum und lässt den Standard ohne Parameter', () => {
    const seite = kennzahlenSeite('ki-verbrauch', BLOCK, zeitraum, undefined, DATEN, []);

    expect(seite.chips.map((chip) => [chip.text, chip.href, chip.aktuell])).toEqual([
      ['Heute', '/module/ki-verbrauch?zeitraum=heute', false],
      ['7 Tage', '/module/ki-verbrauch?zeitraum=7', true],
      ['30 Tage', '/module/ki-verbrauch', false],
      ['Monat', '/module/ki-verbrauch?zeitraum=monat', false],
      ['Vormonat', '/module/ki-verbrauch?zeitraum=vormonat', false],
    ]);
  });

  it('teilt auf mit Anteil und Link auf den Filter; Zeilen ohne Wert heißen „nicht zugeordnet"', () => {
    const [projekte] = kennzahlenSeite('ki-verbrauch', BLOCK, zeitraum, undefined, DATEN, []).aufteilungen;

    expect(projekte?.zeilen).toEqual([
      { name: 'JAC', leer: false, wert: '36,00 €', anteil: 60, href: '/module/ki-verbrauch?zeitraum=7&filter=JAC' },
      { name: 'COPI', leer: false, wert: '18,00 €', anteil: 30, href: '/module/ki-verbrauch?zeitraum=7&filter=COPI' },
      { name: 'nicht zugeordnet', leer: true, wert: '6,00 €', anteil: 10, href: '/module/ki-verbrauch?zeitraum=7&filter=-' },
    ]);
  });

  it('fasst mehr als fünf Gruppen zu „weitere" zusammen', () => {
    const gruppen = Array.from({ length: 8 }, (_, nummer) => ({ schluessel: `P${String(nummer)}`, wert: 8 - nummer }));
    const daten = { ...DATEN, aufteilungen: [{ spalte: 'projekt', label: 'Je Projekt', verlinkt: false, gruppen }] };

    const [projekte] = kennzahlenSeite('ki-verbrauch', BLOCK, zeitraum, undefined, daten, []).aufteilungen;

    expect(projekte?.zeilen).toHaveLength(5);
    expect(projekte?.weitere).toBe('+ 3 weitere · 6,00 €');
    expect(projekte?.hinweis).toBeUndefined();
  });

  it('zeigt gefiltert die Marke, den Weg zurück und den Anteil an allem', () => {
    const seite = kennzahlenSeite('ki-verbrauch', BLOCK, zeitraum, { spalte: 'projekt', wert: 'JAC' }, { ...DATEN, ungefiltert: 120 }, []);

    expect(seite.filter).toEqual({ text: 'JAC', aufheben: '/module/ki-verbrauch?zeitraum=7' });
    expect(seite.kennzahlen[0]?.zusatz).toBe('50 % von allem im Zeitraum');
    expect(seite.chips[0]?.href).toBe('/module/ki-verbrauch?zeitraum=heute&filter=JAC');
  });

  it('nennt den Filter auf „ohne Wert" beim Namen', () => {
    expect(kennzahlenSeite('ki-verbrauch', BLOCK, zeitraum, { spalte: 'projekt', wert: null }, DATEN, []).filter?.text).toBe('nicht zugeordnet');
  });

  it('rechnet Anteile in Prozent des Hauptwerts und warnt bei einer Anzahl über null', () => {
    expect(kennzahlenSeite('ki-verbrauch', BLOCK, zeitraum, undefined, DATEN, []).anteile).toEqual([
      { label: 'geschätzt', wert: '7 %', text: 'Anteil aus Schätzungen', warnung: false },
      { label: 'ohne Preis', wert: '3', text: undefined, warnung: true },
    ]);
  });

  it('ist leer, wenn weder der Zeitraum noch der Vergleich einen Wert hat', () => {
    const seite = kennzahlenSeite('ki-verbrauch', BLOCK, zeitraum, undefined, { tage: [], vergleich: null, ungefiltert: null, aufteilungen: [] }, []);

    expect(seite.leer).toBe(true);
  });
});

describe('Karte der Übersicht', () => {
  const spannen = kartenSpannen(HEUTE);

  it('zeigt den Monat, den Vormonat und die letzten 30 Tage', () => {
    const karte = kennzahlenKarte('ki-verbrauch', BLOCK, HEUTE, spannen.verlauf, { tage: DATEN.tage, monat: 412.38, vormonat: 356.4 }, [], 20);

    expect(karte).toMatchObject({
      titel: 'KI-Verbrauch',
      href: '/module/ki-verbrauch?von=uebersicht',
      verfuegbar: true,
      kuerzel: 'KV',
      ueberschrift: 'Kosten im September',
      wert: '412,38 €',
      bezug: 'Vormonat 356,40 €',
      warnung: undefined,
    });
    expect(karte.diagramm?.balken).toHaveLength(3);
  });

  it('warnt mit dem ersten Hinweis des Moduls', () => {
    const karte = kennzahlenKarte('ki-verbrauch', BLOCK, HEUTE, spannen.verlauf, { tage: [], monat: null, vormonat: null }, [{ titel: '37 Einsätze ohne Preis', text: '…' }], 20);

    expect(karte.warnung).toBe('37 Einsätze ohne Preis');
    expect(karte.wert).toBe('0,00 €');
    expect(karte.bezug).toBeUndefined();
  });

  it('ist ohne lesbare View nicht verfügbar', () => {
    expect(kennzahlenKarte('ki-verbrauch', BLOCK, HEUTE, spannen.verlauf, undefined, [], 20)).toMatchObject({ verfuegbar: false, diagramm: undefined });
  });
});
