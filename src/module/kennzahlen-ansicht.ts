/**
 * Was die Kennzahlen-Seite und ihre Karte auf der Übersicht aus den gelesenen Summen machen (COPI-98) — reine
 * Funktionen, der heutige Tag ist ein Parameter. Layout-Ziel ist der freigegebene Entwurf „Kennzahlen-Seite
 * KI-Verbrauch" (Stefan, 30.09.2026).
 *
 * **Zahlen deutsch:** Beträge als „412,38 €", große Anzahlen gekürzt („1,84 Mrd.", „812 Mio."), sonst mit
 * Tausenderpunkt. **Das Diagramm** ist ein Balken je Kalendertag des Zeitraums, auch für Tage ohne Wert; die Geometrie
 * steht hier als Zahlen, die Vorlage setzt sie als SVG-Attribute — nie als `style`. Jedes Diagramm trägt seine
 * Textalternative.
 */
import type { ModulAnteil, ModulBlock, ModulSpalte } from './block.js';
import type { AufteilungDaten, Hinweis, KartenDaten, KennzahlenDaten, KennzahlenFilter, TagesSummen } from './kennzahlen-lesen.js';
import {
  ZEITRAEUME,
  ZEITRAUM_STANDARD,
  ZEITRAUM_TEXT,
  monatsName,
  tagKurz,
  tagLang,
  tageDer,
  type Spanne,
  type Zeitraum,
} from './kennzahlen-zeitraum.js';
import { vonUebersicht } from './rueckweg.js';
import { kuerzelAus } from './uebersicht-karten.js';

/** So viele Zeilen zeigt eine Aufteilung; der Rest steht als „+ n weitere" darunter. */
const AUFTEILUNG_ZEILEN = 5;

/** Der Wert in der Adresse für „ohne Wert" (`?filter=-`) — ein Bindestrich kommt als echter Wert nicht vor. */
export const FILTER_LEER = '-';

/** So heißt eine Gruppe ohne Wert in der Aufteilung. */
const OHNE_WERT = 'nicht zugeordnet';

/** Breite und Höhe des Diagramms in Einheiten seiner `viewBox`. */
const DIAGRAMM_BREITE = 600;
const DIAGRAMM_HOEHE = 150;

const EURO = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const GANZ = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

/** „412,38 €". */
export function euroText(wert: number): string {
  return EURO.format(wert);
}

/** „9.412", „812 Mio.", „1,84 Mrd." — drei geltende Stellen ab einer Million. */
export function anzahlText(wert: number): string {
  const betrag = Math.abs(wert);
  for (const [schwelle, wort] of [
    [1e9, 'Mrd.'],
    [1e6, 'Mio.'],
  ] as const) {
    if (betrag >= schwelle) {
      const teil = wert / schwelle;
      const stellen = Math.abs(teil) >= 100 ? 0 : Math.abs(teil) >= 10 ? 1 : 2;
      return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: stellen }).format(teil)} ${wort}`;
    }
  }
  return GANZ.format(wert);
}

function wertText(wert: number, format: ModulSpalte['format']): string {
  return format === 'euro' ? euroText(wert) : anzahlText(wert);
}

/** Ganze Prozent von `teil` an `ganzes`; 0, wenn es kein Ganzes gibt. */
function prozent(teil: number, ganzes: number): number {
  return ganzes > 0 ? Math.round((teil / ganzes) * 100) : 0;
}

export interface Chip {
  readonly text: string;
  readonly href: string;
  readonly aktuell: boolean;
}

export interface Kennzahl {
  readonly label: string;
  readonly wert: string;
  readonly zusatz: string | undefined;
}

export interface Balken {
  readonly x: number;
  readonly y: number;
  readonly breite: number;
  readonly hoehe: number;
  /** Der letzte Tag des Zeitraums ist hervorgehoben. */
  readonly letzter: boolean;
  /** „30.09.: 27,40 €" — der Tooltip des Balkens. */
  readonly titel: string;
}

export interface Diagramm {
  readonly breite: number;
  readonly hoehe: number;
  readonly balken: readonly Balken[];
  /** Beschriftung der senkrechten Achse, von oben nach unten. */
  readonly skala: readonly string[];
  /** Beschriftung der waagerechten Achse, gleichmäßig verteilt. */
  readonly achse: readonly string[];
  readonly text: string;
}

export interface AufteilungZeile {
  readonly name: string;
  /** Ohne Wert in der Spalte: „nicht zugeordnet", zurückhaltend gesetzt. */
  readonly leer: boolean;
  readonly wert: string;
  readonly anteil: number;
  readonly href: string | undefined;
}

export interface Aufteilung {
  readonly label: string;
  readonly zeilen: readonly AufteilungZeile[];
  readonly weitere: string | undefined;
  readonly hinweis: string | undefined;
}

export interface AnteilAnsicht {
  readonly label: string;
  readonly wert: string;
  readonly text: string | undefined;
  readonly warnung: boolean;
}

export interface KennzahlenSeite {
  readonly chips: readonly Chip[];
  /** Nur gefiltert: die Marke und der Weg zurück. */
  readonly filter: { readonly text: string; readonly aufheben: string } | undefined;
  readonly hinweise: readonly Hinweis[];
  /** Kein einziger Wert im Zeitraum und im Vergleich: die Seite zeigt den Leerzustand statt leerer Flächen. */
  readonly leer: boolean;
  readonly kennzahlen: readonly Kennzahl[];
  readonly diagramm: { readonly titel: string; readonly spanne: string; readonly bild: Diagramm };
  readonly aufteilungen: readonly Aufteilung[];
  readonly anteile: readonly AnteilAnsicht[];
}

function adresse(kennung: string, zeitraum: string, filter: string | undefined): string {
  const teile = [zeitraum === ZEITRAUM_STANDARD ? '' : `zeitraum=${encodeURIComponent(zeitraum)}`, filter === undefined ? '' : `filter=${encodeURIComponent(filter)}`];
  const abfrage = teile.filter((teil) => teil !== '').join('&');
  return `/module/${encodeURIComponent(kennung)}${abfrage === '' ? '' : `?${abfrage}`}`;
}

/** Der Wert des Filters, wie er in der Adresse steht. */
function filterWert(filter: KennzahlenFilter | undefined): string | undefined {
  return filter === undefined ? undefined : (filter.wert ?? FILTER_LEER);
}

function summe(tage: readonly TagesSummen[], spalte: string): number {
  return tage.reduce((gesamt, tag) => gesamt + (tag.summen[spalte] ?? 0), 0);
}

/** Eine „runde" Obergrenze für die Achse: der nächste glatte Schritt (1 · 1,5 · 2 · 2,5 · 3 · 4 · 5 · 7,5 · 10 mal Zehnerpotenz) über dem größten Wert. */
function skalaFuer(groesster: number): number {
  if (groesster <= 0) {
    return 1;
  }
  const potenz = 10 ** Math.floor(Math.log10(groesster));
  for (const faktor of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (groesster <= faktor * potenz) {
      return faktor * potenz;
    }
  }
  return 10 * potenz;
}

/** Bis zu fünf gleichmäßig verteilte Tage der Spanne, für die Achse. */
function achsenTage(tage: readonly string[]): string[] {
  if (tage.length <= 5) {
    return tage.map(tagKurz);
  }
  return [0, 1, 2, 3, 4].map((nummer) => tagKurz(tage[Math.round((nummer * (tage.length - 1)) / 4)] ?? ''));
}

/** Das Balkendiagramm des Hauptwerts über alle Tage der Spanne; Tage ohne Wert haben keinen Balken. */
export function diagrammAus(tage: readonly TagesSummen[], spanne: Spanne, spalte: ModulSpalte): Diagramm {
  const werte = new Map(tage.map((tag) => [tag.tag, tag.summen[spalte.name] ?? 0]));
  const alle = tageDer(spanne);
  const reihe = alle.map((tag) => Math.max(0, werte.get(tag) ?? 0));
  const skala = skalaFuer(Math.max(0, ...reihe));
  const schritt = DIAGRAMM_BREITE / Math.max(1, alle.length);
  const nutzbar = DIAGRAMM_HOEHE - 6;
  const balken = reihe.flatMap((wert, nummer): Balken[] => {
    if (wert <= 0) {
      return [];
    }
    // Ein sehr kleiner Wert bleibt sichtbar.
    const hoehe = Math.max(1.5, (wert / skala) * nutzbar);
    return [
      {
        x: Number((nummer * schritt + schritt * 0.16).toFixed(1)),
        y: Number((DIAGRAMM_HOEHE - hoehe).toFixed(1)),
        breite: Number((schritt * 0.68).toFixed(1)),
        hoehe: Number(hoehe.toFixed(1)),
        letzter: nummer === reihe.length - 1,
        titel: `${tagKurz(alle[nummer] ?? '')}: ${wertText(wert, spalte.format)}`,
      },
    ];
  });
  const mitWert = reihe.filter((wert) => wert > 0);
  const gesamt = reihe.reduce((a, b) => a + b, 0);
  const text =
    mitWert.length === 0
      ? `${spalte.label} je Tag, ${spanneText(spanne)}: keine Werte.`
      : `${spalte.label} je Tag, ${spanneText(spanne)}: zwischen ${wertText(Math.min(...reihe), spalte.format)} und ${wertText(Math.max(...reihe), spalte.format)}, zusammen ${wertText(gesamt, spalte.format)}, zuletzt ${wertText(reihe.at(-1) ?? 0, spalte.format)}.`;
  return {
    breite: DIAGRAMM_BREITE,
    hoehe: DIAGRAMM_HOEHE,
    balken,
    skala: [wertText(skala, spalte.format), wertText(skala / 2, spalte.format), '0'],
    achse: achsenTage(alle),
    text,
  };
}

/** „01.09. bis 30.09.2026", ein einzelner Tag als „30.09.2026". */
export function spanneText(spanne: Spanne): string {
  return spanne.von === spanne.bis ? tagLang(spanne.bis) : `${tagKurz(spanne.von)} bis ${tagLang(spanne.bis)}`;
}

function aufteilungAus(kennung: string, zeitraum: Zeitraum, daten: AufteilungDaten, gesamt: number, format: ModulSpalte['format']): Aufteilung {
  const sichtbar = daten.gruppen.slice(0, AUFTEILUNG_ZEILEN);
  const rest = daten.gruppen.slice(AUFTEILUNG_ZEILEN);
  return {
    label: daten.label,
    zeilen: sichtbar.map((gruppe) => ({
      name: gruppe.schluessel ?? OHNE_WERT,
      leer: gruppe.schluessel === null,
      wert: wertText(gruppe.wert, format),
      anteil: prozent(gruppe.wert, gesamt),
      href: daten.verlinkt ? adresse(kennung, zeitraum.name, gruppe.schluessel ?? FILTER_LEER) : undefined,
    })),
    weitere: rest.length === 0 ? undefined : `+ ${String(rest.length)} weitere · ${wertText(rest.reduce((a, gruppe) => a + gruppe.wert, 0), format)}`,
    hinweis: daten.verlinkt && sichtbar.length > 0 ? 'Einen Eintrag wählen, um ihn aufzuschlüsseln.' : undefined,
  };
}

function anteilAus(anteil: ModulAnteil, tage: readonly TagesSummen[], gesamt: number): AnteilAnsicht {
  const wert = summe(tage, anteil.name);
  const anzahl = anteil.format === 'anzahl';
  return {
    label: anteil.label,
    wert: anzahl ? anzahlText(wert) : `${String(prozent(wert, gesamt))} %`,
    text: anteil.text,
    warnung: anzahl && wert > 0,
  };
}

/** Die Kennzahlen: je deklarierter Spalte eine, dazu der Tagesschnitt des Hauptwerts. */
function kennzahlenAus(block: ModulBlock, daten: KennzahlenDaten, zeitraum: Zeitraum, gefiltert: boolean): Kennzahl[] {
  const haupt = block.spalten[0];
  if (haupt === undefined) {
    return [];
  }
  const gesamt = summe(daten.tage, haupt.name);
  const kennzahlen = block.spalten.map((spalte, stelle): Kennzahl => {
    const wert = summe(daten.tage, spalte.name);
    let zusatz: string | undefined;
    if (stelle === 0) {
      zusatz =
        gefiltert && daten.ungefiltert !== null
          ? `${String(prozent(wert, daten.ungefiltert))} % von allem im Zeitraum`
          : daten.vergleich === null
            ? undefined
            : `${zeitraum.vergleichText}: ${wertText(daten.vergleich, spalte.format)}`;
    } else if (spalte.davon !== undefined) {
      zusatz = `davon ${String(prozent(summe(daten.tage, spalte.davon.name), wert))} % ${spalte.davon.text}`;
    }
    return { label: spalte.label, wert: wertText(wert, spalte.format), zusatz };
  });
  const tage = tageDer(zeitraum.spanne).length;
  if (tage > 1) {
    const hoechster = Math.max(0, ...daten.tage.map((tag) => tag.summen[haupt.name] ?? 0));
    kennzahlen.push({ label: 'Je Tag', wert: wertText(gesamt / tage, haupt.format), zusatz: `höchster Tag ${wertText(hoechster, haupt.format)}` });
  }
  return kennzahlen;
}

/** Die ganze Seite `GET /module/:kennung` eines Kennzahlen-Moduls. */
export function kennzahlenSeite(
  kennung: string,
  block: ModulBlock,
  zeitraum: Zeitraum,
  filter: KennzahlenFilter | undefined,
  daten: KennzahlenDaten,
  hinweise: readonly Hinweis[],
): KennzahlenSeite {
  const haupt = block.spalten[0] ?? { name: 'wert', label: 'Wert' };
  const gesamt = summe(daten.tage, haupt.name);
  const filterText = filterWert(filter);
  return {
    chips: ZEITRAEUME.map((name) => ({ text: ZEITRAUM_TEXT[name], href: adresse(kennung, name, filterText), aktuell: name === zeitraum.name })),
    filter: filter === undefined ? undefined : { text: filter.wert ?? OHNE_WERT, aufheben: adresse(kennung, zeitraum.name, undefined) },
    hinweise,
    leer: daten.tage.length === 0 && daten.vergleich === null,
    kennzahlen: kennzahlenAus(block, daten, zeitraum, filter !== undefined),
    diagramm: { titel: `${haupt.label} je Tag`, spanne: spanneText(zeitraum.spanne), bild: diagrammAus(daten.tage, zeitraum.spanne, haupt) },
    aufteilungen: daten.aufteilungen.map((aufteilung) => aufteilungAus(kennung, zeitraum, aufteilung, gesamt, haupt.format)),
    anteile: (block.anteile ?? []).map((anteil) => anteilAus(anteil, daten.tage, gesamt)),
  };
}

/** Eine Karte der Übersicht (COPI-98): der Hauptwert des laufenden Monats, der Vormonat und die letzten 30 Tage. */
export interface KennzahlenKarte {
  readonly kennung: string;
  readonly titel: string;
  readonly href: string;
  /** `false`: die View war nicht lesbar — der Abschnitt zeigt den neutralen Hinweis. */
  readonly verfuegbar: boolean;
  readonly kuerzel: string;
  /** „Kosten im September". */
  readonly ueberschrift: string;
  readonly wert: string;
  readonly bezug: string | undefined;
  readonly diagramm: Diagramm | undefined;
  /** Mit mindestens einem Hinweis ist die Karte gelb und zeigt dessen Überschrift. */
  readonly warnung: string | undefined;
  readonly reihenfolge: number;
}

export function kennzahlenKarte(
  kennung: string,
  block: ModulBlock,
  heute: string,
  verlauf: Spanne,
  daten: KartenDaten | undefined,
  hinweise: readonly Hinweis[],
  reihenfolge: number,
): KennzahlenKarte {
  const haupt = block.spalten[0] ?? { name: 'wert', label: 'Wert' };
  const titel = block.uebersicht?.titel ?? block.menuename;
  return {
    kennung,
    titel,
    href: vonUebersicht(`/module/${encodeURIComponent(kennung)}`),
    verfuegbar: daten !== undefined,
    kuerzel: kuerzelAus(titel),
    ueberschrift: `${haupt.label} im ${monatsName(heute)}`,
    wert: wertText(daten?.monat ?? 0, haupt.format),
    bezug: daten === undefined || daten.vormonat === null ? undefined : `Vormonat ${wertText(daten.vormonat, haupt.format)}`,
    diagramm: daten === undefined ? undefined : diagrammAus(daten.tage, verlauf, haupt),
    warnung: hinweise[0]?.titel,
    reihenfolge,
  };
}
