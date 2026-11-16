/**
 * Das Dashboard der Übersicht aus den Modulen mit `uebersicht:` (COPI-81) — reine Funktionen, der Zeitpunkt ist
 * ein Parameter. Die Daten liest `uebersicht-lesen.ts`; hier wird nur gerechnet und für die Vorlage aufbereitet.
 *
 * **Karten.** Eine Karte ist eine Zeile der Modul-View (`id`, `titel`, `status`, `aktualisiert_am` und die in
 * `uebersicht.kurztext` genannte Spalte), sortiert rot → gelb → grün, dann nach Titel. Je Modul höchstens
 * `KARTEN_HOECHSTENS` (die schlimmsten), der Rest als „+ n weitere". Ein Status außerhalb von gruen/gelb/rot (ein
 * Fehler in der Fach-View) zeigt sich wie auf der Modulseite neutral mit seinem eigenen Wort, **zählt** aber als
 * gelb: im Zweifel gelb, wie bei den Wachen (`status/zustand.ts`).
 *
 * **Bänder und Woche.** Das 24-Stunden-Band je Karte, die Verfügbarkeit und das Wochendiagramm stammen aus dem
 * Verlauf (`zeitraster.ts`). Ist der Verlauf unbekannt (kein `verlauf` deklariert, Katalogprüfung oder Lesen
 * gescheitert), bleiben die Bänder ganz neutral — auch der jüngste Eimer bekommt dann nicht den aktuellen Status,
 * damit „keine Daten" nicht wie „eine Stunde Daten" aussieht.
 *
 * **Messwert (COPI-83).** Trägt die Zeile einen `wert` (optionale Spalten der Modul-View), zeigt die Karte Wert,
 * Balken und eine 24-Std.-Kurve statt des Bands (`messwert-kurve.ts`, derselbe Code wie die Modul-Kachel).
 *
 * **Statuszeile, Bereiche, Team-Listen (COPI-122).** Die Statuszeile nennt aufgeklappt jeden offenen Punkt einzeln
 * (`zustand.punkte`). Je Bereich (Modul mit Karten) zählt `zaehlung` rot, gelb und grün; `offen` klappt ihn auf, sobald
 * etwas nicht grün oder er nicht lesbar ist. Module mit `uebersicht.art: liste` sind keine Dienste, sondern die Arbeit
 * eines Agenten: sie stehen als kompakte Liste in der Team-Reihe (`listen`, offene Zeilen zuerst, dann die jüngsten,
 * höchstens `LISTE_HOECHSTENS`) und zählen weder in Zustand noch in Kennzahlen oder Woche.
 *
 * **Nie nur Farbe** (WCAG 1.4.1): jede Farbe hat ein Wort daneben, jedes Band und das Diagramm eine
 * Textalternative (`text`), die die Vorlage als `<title>`/`aria-label` setzt.
 */
import { standText } from '../chat/ansicht.js';
import { vorKurz, type BefundStatus } from '../status/zustand.js';
import { UEBERSICHT_REIHENFOLGE_STANDARD, type ModulBlock } from './block.js';
import { modulStatusAnsicht, type ModulStatusAnsicht } from './ansicht.js';
import type { ModulZeileRoh } from './liste-detail.js';
import { KARTE_KURVE, messwertAnsicht, zeilenMesswert, type MesswertAnsicht } from './messwert-kurve.js';
import { vonUebersicht } from './rueckweg.js';
import { sperrMarkeFuer, type SperrMarke, type VorgangSperre } from './vorgang-sperre.js';
import {
  bandFuer,
  bandText,
  berlinTage,
  eimerBelegen,
  eimerZaehlen,
  mitAktuellem,
  schlimmsterJeEimer,
  STUNDE_MS,
  tagesGrenzen,
  verfuegbarkeitProzent,
  verfuegbarkeitText,
  type EimerStatus,
  type EimerZaehlung,
  type VerlaufPunkt,
} from './zeitraster.js';

/** Höchstens so viele Karten je Modul (COPI-81); mehr → die schlimmsten, dazu ein Hinweis mit Link aufs Modul. */
export const KARTEN_HOECHSTENS = 24;

/** Höchstens so viele Zeilen zeigt eine Team-Liste (COPI-122). */
export const LISTE_HOECHSTENS = 4;

/** Stunden des Bands je Karte. */
export const BAND_STUNDEN = 24;

/** Kalendertage des Wochendiagramms. */
export const WOCHE_TAGE = 7;

/** Was `uebersicht-lesen.ts` je sichtbarem Modul liefert. */
export interface ModulMitKarten {
  readonly kennung: string;
  readonly block: ModulBlock;
  /** Die Zeilen der Modul-View; `undefined`, wenn sie nicht gelesen werden konnte. */
  readonly zeilen: readonly ModulZeileRoh[] | undefined;
  /** Verlaufspunkte je `id`; `undefined`, wenn kein Verlauf bekannt ist (siehe Kopf). */
  readonly verlauf: ReadonlyMap<string, readonly VerlaufPunkt[]> | undefined;
  /** Die aktiven Übernahmen der Zeilen (COPI-85); ohne Angabe trägt keine Karte eine Marke. */
  readonly sperren?: ReadonlyMap<string, VorgangSperre>;
}

export interface Band {
  readonly segmente: readonly EimerStatus[];
  /** Textalternative, etwa „Letzte 24 Stunden: 22 Std. Läuft, 2 Std. Achtung". */
  readonly text: string;
}

export interface DashboardKarte {
  readonly id: string;
  readonly titel: string;
  readonly kuerzel: string;
  readonly status: ModulStatusAnsicht;
  /** Wie die Karte zählt und getönt wird: ein unbekannter Status gilt als gelb (siehe Kopf). */
  readonly wertung: BefundStatus;
  readonly kurztext: string;
  readonly href: string;
  readonly band: Band;
  /** „92 % in Ordnung" oder „keine Daten". */
  readonly verfuegbarkeit: string;
  /** „Zuletzt geprüft vor 12 Min." */
  readonly geprueft: string;
  /** Für die Kennzahl „Letzte Prüfung"; `undefined`, wenn die Zeile keinen Zeitpunkt trägt. */
  readonly aktualisiertAm: Date | undefined;
  /** Die Verlaufspunkte dieser Karte für das Wochendiagramm; `undefined`: kein Verlauf bekannt. */
  readonly verlauf: readonly VerlaufPunkt[] | undefined;
  /**
   * Wert, Balken und 24-Std.-Kurve (COPI-83), nur wenn die Zeile einen `wert` trägt — dann ersetzt die Kurve das
   * Statusband. `undefined`: die Karte bleibt genau wie vor COPI-83.
   */
  readonly messwert: MesswertAnsicht | undefined;
  /** Die Marke „übernommen · Stefan" (COPI-85); `undefined`: der Vorgang ist frei. */
  readonly sperre: SperrMarke | undefined;
}

export interface DashboardAbschnitt {
  readonly kennung: string;
  readonly titel: string;
  readonly href: string;
  /** `false`: die Modul-View war nicht lesbar — der Abschnitt zeigt einen neutralen Hinweis. */
  readonly verfuegbar: boolean;
  readonly karten: readonly DashboardKarte[];
  /** Karten jenseits von `KARTEN_HOECHSTENS`. */
  readonly weitere: number;
  /** Wie viele Karten rot, gelb (auch unbekannt) und grün sind (COPI-122) — die Zusammenfassung im zugeklappten Kopf. */
  readonly zaehlung: { readonly rot: number; readonly gelb: number; readonly gruen: number };
  /** Aufgeklappt, sobald etwas nicht grün oder der Bereich nicht lesbar ist (COPI-122). */
  readonly offen: boolean;
  /** „vor 4 Min." — die jüngste Prüfung im Bereich; „–" ohne. */
  readonly geprueft: string;
}

/** Eine Zeile einer Team-Liste (COPI-122). */
export interface DashboardListenZeile {
  readonly titel: string;
  readonly text: string;
  readonly status: ModulStatusAnsicht;
  /** „vor 3 Std." aus `aktualisiert_am`; leer ohne Zeitpunkt. */
  readonly zeit: string;
  readonly href: string;
}

/** Ein Modul mit `uebersicht.art: liste` in der Team-Reihe (COPI-122). */
export interface DashboardListe {
  readonly kennung: string;
  readonly titel: string;
  readonly href: string;
  readonly verfuegbar: boolean;
  /** Zeilen mit Rot oder Gelb: die Zahl im Kopf. */
  readonly offen: number;
  readonly zeilen: readonly DashboardListenZeile[];
}

/** Ein offener Punkt der Statuszeile (COPI-122). */
export interface ZustandPunkt {
  readonly titel: string;
  readonly wertung: 'rot' | 'gelb';
  readonly wort: string;
  readonly text: string;
  readonly href: string;
}

export type ZustandFarbe = BefundStatus | 'leer';

/** Das Zustandsband oben (weiterentwickelte Statuskarte): Satz, Detail und das Ziel von „Jetzt ansehen". */
export interface Zustand {
  readonly farbe: ZustandFarbe;
  readonly satz: string;
  readonly detail: string;
  readonly ziel: string | undefined;
  /** Jeder offene Punkt einzeln, rot vor gelb (COPI-122) — aufgeklappt in der Statuszeile. */
  readonly punkte: readonly ZustandPunkt[];
}

export interface Kennzahlen {
  readonly dienste: string;
  readonly verfuegbarkeit: string;
  readonly verfuegbarkeitBand: Band;
  readonly offen: number;
  readonly offenZusatz: string;
  readonly letztePruefung: string;
}

export interface SaeulenStueck {
  readonly status: EimerStatus;
  /** Oberkante und Höhe in Prozent der Säule (0–100), für die SVG-Attribute. */
  readonly y: number;
  readonly hoehe: number;
}

export interface WochenTag {
  readonly kuerzel: string;
  readonly zaehlung: EimerZaehlung;
  readonly stuecke: readonly SaeulenStueck[];
}

export interface Woche {
  readonly tage: readonly WochenTag[];
  readonly text: string;
}

export interface Dashboard {
  /** „heute, 10:02". */
  readonly stand: string;
  readonly zustand: Zustand;
  readonly kennzahlen: Kennzahlen;
  readonly abschnitte: readonly DashboardAbschnitt[];
  readonly woche: Woche;
  /** Die Team-Listen (COPI-122), sortiert wie die Abschnitte. */
  readonly listen: readonly DashboardListe[];
}

const SCHWERE: Readonly<Record<BefundStatus, number>> = { rot: 0, gelb: 1, gruen: 2 };

function text(wert: unknown): string {
  return wert === null || wert === undefined ? '' : typeof wert === 'string' ? wert : String(wert);
}

/** Zwei Buchstaben aus dem Titel: Anfänge der ersten beiden Wörter, sonst die ersten beiden Zeichen. */
export function kuerzelAus(titel: string): string {
  const woerter = titel.match(/[\p{L}\p{N}]+/gu) ?? [];
  const [erstes, zweites] = woerter;
  if (erstes === undefined) {
    return '?';
  }
  const kuerzel = zweites === undefined ? [...erstes].slice(0, 2).join('') : `${[...erstes][0] ?? ''}${[...zweites][0] ?? ''}`;
  return kuerzel.toLocaleUpperCase('de-DE');
}

/** Ganze Sekunden seit `zeitpunkt`, nie negativ (eine vorgehende Uhr der Quelle ist „gerade eben"). */
function alterSekunden(zeitpunkt: Date, jetzt: Date): number {
  return Math.max(0, Math.floor((jetzt.getTime() - zeitpunkt.getTime()) / 1000));
}

function prozentText(prozent: number | undefined): string {
  return prozent === undefined ? '–' : `${String(prozent)} %`;
}

function karteAus(modul: ModulMitKarten, zeile: ModulZeileRoh, jetzt: Date): DashboardKarte {
  const { kennung, block, verlauf } = modul;
  const id = text(zeile.werte.id);
  const titel = text(zeile.werte.titel);
  const status = modulStatusAnsicht(text(zeile.werte.status), block.statuswoerter);
  const wertung: BefundStatus = status.farbe === 'unbekannt' ? 'gelb' : status.farbe;
  const punkte = verlauf === undefined ? undefined : (verlauf.get(id) ?? []);
  const segmente = bandFuer(punkte, wertung, jetzt, BAND_STUNDEN, STUNDE_MS);
  const prozent = verfuegbarkeitProzent(eimerZaehlen(segmente));
  const aktualisiert = zeile.werte.aktualisiert_am instanceof Date ? zeile.werte.aktualisiert_am : undefined;
  return {
    id,
    titel,
    kuerzel: kuerzelAus(titel),
    status,
    wertung,
    kurztext: text(zeile.werte[block.uebersicht?.kurztext ?? '']),
    // Mit Herkunft: der Zurück-Knopf der Detailseite führt dann zur Übersicht zurück (COPI-100).
    href: vonUebersicht(`/module/${encodeURIComponent(kennung)}/${encodeURIComponent(id)}`),
    band: { segmente, text: bandText('Letzte 24 Stunden', segmente) },
    verfuegbarkeit: verfuegbarkeitText(prozent),
    geprueft: aktualisiert === undefined ? 'Noch nie geprüft' : `Zuletzt geprüft ${vorKurz(alterSekunden(aktualisiert, jetzt))}`,
    aktualisiertAm: aktualisiert,
    verlauf: punkte,
    messwert: messwertAnsicht({
      titel,
      zeile: zeilenMesswert(zeile.werte),
      punkte,
      jetzt,
      fensterMs: BAND_STUNDEN * STUNDE_MS,
      zeitraum: 'letzte 24 Stunden',
      masse: KARTE_KURVE,
      farbe: wertung,
    }),
    sperre: sperrMarkeFuer(modul.sperren, id, jetzt),
  };
}

function kartenSortieren(karten: readonly DashboardKarte[]): DashboardKarte[] {
  return [...karten].sort(
    (a, b) => SCHWERE[a.wertung] - SCHWERE[b.wertung] || a.titel.localeCompare(b.titel, 'de') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Ein Abschnitt je Modul, mit allen Karten (vor dem Kürzen) — die Kennzahlen zählen nur, was gezeigt wird. */
function abschnittAus(modul: ModulMitKarten, jetzt: Date): DashboardAbschnitt {
  const alle = kartenSortieren((modul.zeilen ?? []).map((zeile) => karteAus(modul, zeile, jetzt)));
  const zaehlung = {
    rot: alle.filter((karte) => karte.wertung === 'rot').length,
    gelb: alle.filter((karte) => karte.wertung === 'gelb').length,
    gruen: alle.filter((karte) => karte.wertung === 'gruen').length,
  };
  const verfuegbar = modul.zeilen !== undefined;
  return {
    kennung: modul.kennung,
    titel: modul.block.uebersicht?.titel ?? modul.block.menuename,
    href: vonUebersicht(`/module/${encodeURIComponent(modul.kennung)}`),
    verfuegbar,
    karten: alle.slice(0, KARTEN_HOECHSTENS),
    weitere: Math.max(0, alle.length - KARTEN_HOECHSTENS),
    zaehlung,
    offen: !verfuegbar || zaehlung.rot + zaehlung.gelb > 0,
    geprueft: juengstePruefung(alle, jetzt),
  };
}

/** „vor 4 Min." für die jüngste Prüfung unter den Karten; „–" ohne Zeitpunkt. */
function juengstePruefung(karten: readonly DashboardKarte[], jetzt: Date): string {
  const juengste = karten.reduce((bisher, karte) => Math.max(bisher, karte.aktualisiertAm?.getTime() ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
  return Number.isFinite(juengste) ? vorKurz(alterSekunden(new Date(juengste), jetzt)) : '–';
}

/** Eine Team-Liste (COPI-122): offene Zeilen zuerst, dann die jüngsten; höchstens `LISTE_HOECHSTENS`. */
function listeAus(modul: ModulMitKarten, jetzt: Date): DashboardListe {
  const { kennung, block } = modul;
  const zeilen = (modul.zeilen ?? []).map((zeile) => {
    const status = modulStatusAnsicht(text(zeile.werte.status), block.statuswoerter);
    const aktualisiert = zeile.werte.aktualisiert_am instanceof Date ? zeile.werte.aktualisiert_am : undefined;
    return {
      // Offen ist, was jemand tun muss: Rot und Gelb. Ein eigenes Wort ohne Farbe („Nicht gewählt") zählt nicht (COPI-125).
      offen: status.farbe === 'rot' || status.farbe === 'gelb',
      zeitpunkt: aktualisiert?.getTime() ?? Number.NEGATIVE_INFINITY,
      ansicht: {
        titel: text(zeile.werte.titel),
        text: text(zeile.werte[block.uebersicht?.kurztext ?? '']),
        status,
        zeit: aktualisiert === undefined ? '' : vorKurz(alterSekunden(aktualisiert, jetzt)),
        href: vonUebersicht(`/module/${encodeURIComponent(kennung)}/${encodeURIComponent(text(zeile.werte.id))}`),
      },
    };
  });
  const sortiert = [...zeilen].sort((a, b) => Number(b.offen) - Number(a.offen) || b.zeitpunkt - a.zeitpunkt);
  return {
    kennung,
    titel: block.uebersicht?.titel ?? block.menuename,
    href: vonUebersicht(`/module/${encodeURIComponent(kennung)}`),
    verfuegbar: modul.zeilen !== undefined,
    offen: zeilen.filter((zeile) => zeile.offen).length,
    zeilen: sortiert.slice(0, LISTE_HOECHSTENS).map((zeile) => zeile.ansicht),
  };
}

function reihenfolge(modul: ModulMitKarten): number {
  return modul.block.uebersicht?.reihenfolge ?? UEBERSICHT_REIHENFOLGE_STANDARD;
}

function anzahl(n: number, einzahl: string, mehrzahl: string): string {
  return `${String(n)} ${n === 1 ? einzahl : mehrzahl}`;
}

/** Wie viele Kurztexte das Zustandsband höchstens nennt; der Rest steht als „und n weitere". */
const DETAIL_HOECHSTENS = 3;

/**
 * Das Zustandsband: „1 Störung, 1 Hinweis" und die Kurztexte der roten und gelben Karten, oder „Alles in Ordnung".
 * „Jetzt ansehen" führt zur schlimmsten Karte, wenn sie die einzige ihrer Farbe ist, sonst zu ihrem Modul.
 */
function zustandAus(abschnitte: readonly DashboardAbschnitt[]): Zustand {
  const eintraege = abschnitte.flatMap((abschnitt) => abschnitt.karten.map((karte) => ({ karte, modulHref: abschnitt.href })));
  if (eintraege.length === 0) {
    return { farbe: 'leer', satz: 'Noch keine Meldungen', detail: 'Sobald der Betrieb meldet, erscheint hier der Stand.', ziel: undefined, punkte: [] };
  }
  const rot = eintraege.filter((eintrag) => eintrag.karte.wertung === 'rot');
  const gelb = eintraege.filter((eintrag) => eintrag.karte.wertung === 'gelb');
  const schlimmste = rot.length > 0 ? rot : gelb;
  const erste = schlimmste[0];
  if (erste === undefined) {
    const detail = eintraege.length === 1 ? 'Der gemeldete Dienst ist in Ordnung.' : `Alle ${String(eintraege.length)} gemeldeten Dienste sind in Ordnung.`;
    return { farbe: 'gruen', satz: 'Alles in Ordnung', detail, ziel: undefined, punkte: [] };
  }
  const satz = [rot.length > 0 ? anzahl(rot.length, 'Störung', 'Störungen') : '', gelb.length > 0 ? anzahl(gelb.length, 'Hinweis', 'Hinweise') : '']
    .filter((teil) => teil !== '')
    .join(', ');
  const offen = [...rot, ...gelb];
  const texte = offen.slice(0, DETAIL_HOECHSTENS).map(({ karte }) => (karte.kurztext === '' ? karte.titel : `${karte.titel}: ${karte.kurztext}`));
  const rest = offen.length - DETAIL_HOECHSTENS;
  const detail = rest > 0 ? `${texte.join(' · ')} · und ${String(rest)} weitere` : texte.join(' · ');
  return {
    farbe: rot.length > 0 ? 'rot' : 'gelb',
    satz,
    detail,
    ziel: schlimmste.length === 1 ? erste.karte.href : erste.modulHref,
    punkte: offen.map(({ karte }) => ({ titel: karte.titel, wertung: karte.wertung === 'rot' ? 'rot' : 'gelb', wort: karte.status.wort, text: karte.kurztext, href: karte.href })),
  };
}

function kennzahlenAus(karten: readonly DashboardKarte[], jetzt: Date): Kennzahlen {
  const gruen = karten.filter((karte) => karte.wertung === 'gruen').length;
  const rot = karten.filter((karte) => karte.wertung === 'rot').length;
  const offen = karten.length - gruen;
  const summe = karten.reduce(
    (bisher, karte) => {
      const z = eimerZaehlen(karte.band.segmente);
      return { rot: bisher.rot + z.rot, gelb: bisher.gelb + z.gelb, gruen: bisher.gruen + z.gruen, leer: bisher.leer + z.leer };
    },
    { rot: 0, gelb: 0, gruen: 0, leer: 0 },
  );
  const gesamtBand = schlimmsterJeEimer(
    karten.map((karte) => karte.band.segmente),
    BAND_STUNDEN,
  );
  return {
    dienste: `${String(gruen)} von ${String(karten.length)}`,
    verfuegbarkeit: prozentText(verfuegbarkeitProzent(summe)),
    verfuegbarkeitBand: { segmente: gesamtBand, text: bandText('Alle Dienste, letzte 24 Stunden', gesamtBand) },
    offen,
    offenZusatz: offen === 0 ? 'Nichts zu tun' : rot === 0 ? 'keine davon Störung' : `${String(rot)} davon Störung`,
    letztePruefung: juengstePruefung(karten, jetzt),
  };
}

/** Zwei Nachkommastellen genügen für SVG-Koordinaten. */
function runden(wert: number): number {
  return Math.round(wert * 100) / 100;
}

/** Säule eines Tages: oben ohne Daten, dann rot, gelb, unten grün — Anteile an den Stunden des Tages. */
function saeule(zaehlung: EimerZaehlung): SaeulenStueck[] {
  const gesamt = zaehlung.rot + zaehlung.gelb + zaehlung.gruen + zaehlung.leer;
  if (gesamt === 0) {
    return [];
  }
  const stuecke: SaeulenStueck[] = [];
  let y = 0;
  for (const status of ['leer', 'rot', 'gelb', 'gruen'] as const) {
    if (zaehlung[status] > 0) {
      const hoehe = (zaehlung[status] * 100) / gesamt;
      stuecke.push({ status, y: runden(y), hoehe: runden(hoehe) });
      y += hoehe;
    }
  }
  return stuecke;
}

/**
 * Die letzten sieben Kalendertage (Europe/Berlin): je Stunde der schlimmste Status über alle Karten (mit
 * Übernahme, der jüngste Eimer mit dem aktuellen Status wie beim Band), je Tag gezählt. Ein Raster über alle
 * sieben Tage, damit ein Punkt genau auf Mitternacht nur einmal zählt.
 */
export function wocheAus(verlaeufe: readonly { readonly punkte: readonly VerlaufPunkt[] | undefined; readonly aktuell: BefundStatus }[], jetzt: Date): Woche {
  const tage = berlinTage(jetzt, WOCHE_TAGE);
  const grenzenJeTag = tage.map((tag) => tagesGrenzen(tag));
  const eimerJeTag = grenzenJeTag.map((grenzen) => Math.max(0, grenzen.length - 1));
  const grenzen = [...grenzenJeTag.flatMap((g) => g.slice(0, -1)), jetzt.getTime()];
  const anzahlEimer = grenzen.length - 1;
  const reihen = verlaeufe.map(({ punkte, aktuell }) =>
    punkte === undefined ? Array.from({ length: anzahlEimer }, (): EimerStatus => 'leer') : mitAktuellem(eimerBelegen(punkte, grenzen), aktuell),
  );
  const gesamt = schlimmsterJeEimer(reihen, anzahlEimer);
  let beginn = 0;
  const wochenTage = tage.map((tag, i): WochenTag => {
    const laenge = eimerJeTag[i] ?? 0;
    const zaehlung = eimerZaehlen(gesamt.slice(beginn, beginn + laenge));
    beginn += laenge;
    return { kuerzel: tag.kuerzel, zaehlung, stuecke: saeule(zaehlung) };
  });
  const text = wochenTage
    .map((tag) => {
      const z = tag.zaehlung;
      const teile = [
        z.rot > 0 ? `${String(z.rot)} Std. Störung` : '',
        z.gelb > 0 ? `${String(z.gelb)} Std. Achtung` : '',
        z.gruen > 0 ? `${String(z.gruen)} Std. Läuft` : '',
        z.leer > 0 ? `${String(z.leer)} Std. ohne Daten` : '',
      ].filter((teil) => teil !== '');
      return `${tag.kuerzel}: ${teile.length > 0 ? teile.join(', ') : 'keine Stunden'}`;
    })
    .join('; ');
  return { tage: wochenTage, text: `Zustand der letzten 7 Tage — ${text}` };
}

/** Das ganze Dashboard aus den sichtbaren Modulen mit `uebersicht:`. */
export function dashboardAnsicht(module: readonly ModulMitKarten[], jetzt: Date): Dashboard {
  const sortiert = [...module].sort(
    (a, b) =>
      reihenfolge(a) - reihenfolge(b) ||
      a.block.menuename.localeCompare(b.block.menuename, 'de') ||
      (a.kennung < b.kennung ? -1 : a.kennung > b.kennung ? 1 : 0),
  );
  const abschnitte = sortiert.filter((modul) => modul.block.uebersicht?.art !== 'liste').map((modul) => abschnittAus(modul, jetzt));
  const listen = sortiert.filter((modul) => modul.block.uebersicht?.art === 'liste').map((modul) => listeAus(modul, jetzt));
  const karten = abschnitte.flatMap((abschnitt) => abschnitt.karten);

  return {
    stand: standText(jetzt),
    zustand: zustandAus(abschnitte),
    kennzahlen: kennzahlenAus(karten, jetzt),
    abschnitte,
    woche: wocheAus(
      karten.map((karte) => ({ punkte: karte.verlauf, aktuell: karte.wertung })),
      jetzt,
    ),
    listen,
  };
}
