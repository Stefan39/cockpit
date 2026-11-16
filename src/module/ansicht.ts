/**
 * Was die Modulseiten aus den Rohdaten machen (COPI-78) — reine Funktionen, der Zeitpunkt ist ein Parameter.
 *
 * **Status als Punkt und Wort**, wie überall im Cockpit (WCAG 1.4.1: die Farbe steht nie allein). Die
 * Pflichtspalte `status` trägt denselben Wertebereich wie ein Befund (`gruen`/`gelb`/`rot`,
 * `status/zustand.ts`) — das einzige Beispiel der ADR (`v_modul_server_zustand`) bildet genau diese drei
 * Zustände ab, und dieselbe Sprache gilt für jedes Modul. Ein Fachmodul, das einen anderen Wert liefert
 * (ein Fehler in seiner View), zeigt sich defensiv mit einem neutralen Punkt und seinem eigenen Text, statt
 * die Seite scheitern zu lassen.
 *
 * **Werte formatieren** je deklariertem `format` (`text`, `zeitpunkt`, `zahl`); `aktualisiert_am` formatiert
 * wie überall im Cockpit über `zeitText` (Europe/Berlin, `chat/ansicht.ts`) — eine eigene Zeitformatierung
 * hier wäre dieselbe Regel ein zweites Mal. `NULL` zeigt sich als „—".
 *
 * **Links (COPI-91)** nur aus dem Format `link`, nur `https`, nur für Hosts aus der Domain-Liste der Spalte; der Text
 * ist der Host, nie die ganze URL. Alles andere bleibt Text.
 */
import { zeitText } from '../chat/ansicht.js';
import { STATUS_WORT } from '../status/uebersicht.js';
import { BEFUND_STATUS, type BefundStatus } from '../status/zustand.js';
import type { ModulSpalte, SpaltenFormat, Statuswoerter } from './block.js';
import { textBloecke, type TextBlock } from './einfacher-text.js';
import type { ModulZeileRoh } from './liste-detail.js';
import type { AktivesModul } from './modul-speicher.js';
import { sperrMarkeFuer, type SperrMarke, type VorgangSperre } from './vorgang-sperre.js';

/** Ein Eintrag der Seite `/module`: Kennung und Menüname eines für die Rolle sichtbaren aktiven Moduls. */
export interface ModulUebersichtEintrag {
  readonly kennung: string;
  readonly menuename: string;
  /** Die aktive Version aus der Registry (COPI-84). */
  readonly version: number;
}

/** Die Module, wie `GET /module` sie zeigt — schon nach Sichtbarkeit gefiltert (`sichtbarkeit.ts`), hier nur sortiert. */
export function moduleAnsicht(module: readonly AktivesModul[]): readonly ModulUebersichtEintrag[] {
  return module
    .map((modul): ModulUebersichtEintrag => ({ kennung: modul.kennung, menuename: modul.block.menuename, version: modul.version }))
    .sort((a, b) => a.menuename.localeCompare(b.menuename, 'de') || (a.kennung < b.kennung ? -1 : a.kennung > b.kennung ? 1 : 0));
}

export type ModulStatusFarbe = BefundStatus | 'unbekannt';

export interface ModulStatusAnsicht {
  readonly farbe: ModulStatusFarbe;
  readonly wort: string;
}

function istBefundStatus(wert: string): wert is BefundStatus {
  return (BEFUND_STATUS as readonly string[]).includes(wert);
}

/**
 * Status einer Zeile als Punkt + Wort (siehe Kopf); ein unbekannter Wert bleibt sein eigener Text, neutral markiert.
 * `woerter` (COPI-91, Block-Feld `statuswoerter`) ersetzt das Wort einer Farbe, nie die Farbe.
 */
export function modulStatusAnsicht(wert: string, woerter?: Statuswoerter): ModulStatusAnsicht {
  return istBefundStatus(wert) ? { farbe: wert, wort: woerter?.[wert] ?? STATUS_WORT[wert] } : { farbe: 'unbekannt', wort: wert };
}

/** Ein Link nach außen (COPI-91): die geprüfte Adresse und der Host als Text. */
export interface ModulLink {
  readonly href: string;
  readonly text: string;
}

/**
 * Die URL eines Werts als Link, wenn sie `https` ist, keine Zugangsdaten trägt und ihr Host einer der `domains` ist
 * (genau oder als Subdomain); sonst `undefined`. Der Text ist der Host ohne `www.`.
 */
export function modulLink(wert: unknown, domains: readonly string[]): ModulLink | undefined {
  if (typeof wert !== 'string' || wert.length > 2000) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(wert);
  } catch {
    return undefined;
  }
  const host = url.hostname;
  const erlaubt = domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || !erlaubt) {
    return undefined;
  }
  return { href: url.href, text: host.replace(/^www\./, '') };
}

/**
 * `NULL` als „—"; sonst je Format: Zeitpunkt über `zeitText`, Zahl deutsch formatiert, Text unverändert. Exportiert
 * (COPI-82), damit die Kachel-Darstellung (`modul-kacheln.ts`) dieselbe Formatierung für ihre Felder nutzt statt
 * sie zu kopieren.
 */
export function wertFormatieren(wert: unknown, format: SpaltenFormat, jetzt: Date): string {
  if (wert === null || wert === undefined) {
    return '—';
  }
  if (format === 'link') {
    // Außerhalb der Detailseite (Kachel) nur der Host, nie die ganze URL; eine ungültige bleibt, wie sie ist.
    try {
      return new URL(String(wert)).hostname.replace(/^www\./, '');
    } catch {
      return String(wert);
    }
  }
  if (format === 'zeitpunkt') {
    return wert instanceof Date ? zeitText(wert, jetzt) : String(wert);
  }
  if (format === 'zahl' || format === 'euro') {
    const zahl = typeof wert === 'number' ? wert : Number(wert);
    if (!Number.isFinite(zahl)) {
      return String(wert);
    }
    // Ein Betrag (COPI-137, Finanzen): „12.345,67 €" — dieselbe Schreibweise wie die Kennzahlen.
    return format === 'euro' ? zahl.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }) : zahl.toLocaleString('de-DE');
  }
  return String(wert);
}

function text(wert: unknown): string {
  return typeof wert === 'string' ? wert : String(wert ?? '');
}

/** Höchstens so viele Zeichen zeigt ein Langtext-Abschnitt (COPI-103), gleich was die View liefert. */
export const LANGTEXT_HOECHSTENS = 10_000;

/**
 * Unsichtbare und steuernde Zeichen, die einen Fremdtext anders aussehen lassen als er ist: C0-Steuerzeichen außer Tab
 * und Zeilenumbruch, DEL, Richtungs- und Bidi-Zeichen (`U+202E` dreht „fdp.exe" zu „exe.pdf"), Breiten-Nullzeichen.
 */
// eslint-disable-next-line no-control-regex -- genau diese Steuerzeichen sollen gefunden und entfernt werden.
const UNSICHTBAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Ein Langtext, wie er gezeigt wird: Zeilenenden vereinheitlicht, unsichtbare Zeichen entfernt. Maskiert wird beim Ausgeben. */
export function langtextBereinigen(roh: string): string {
  return roh.replace(/\r\n?/g, '\n').replace(UNSICHTBAR, '');
}

/** Ein Langtext-Abschnitt der Detailseite (COPI-103). */
export interface ModulDetailAbschnitt {
  readonly label: string;
  readonly text: string;
  /** Der Satz unter dem Text, wenn er gekürzt ist; sonst `undefined`. */
  readonly hinweisGekuerzt: string | undefined;
  /** Nur mit `formatierung: einfach` (COPI-131): der Text als Blöcke mit fett und kursiv. */
  readonly bloecke?: readonly TextBlock[];
}

/**
 * Die Langtext-Spalten einer Zeile als eigene Abschnitte, in der Reihenfolge des Blocks. Ein leerer Text ergibt keinen
 * Abschnitt. Liefert die View mehr als `LANGTEXT_HOECHSTENS` Zeichen, kürzt die Seite selbst und sagt es.
 */
export function modulDetailAbschnitte(spalten: readonly ModulSpalte[], zeile: ModulZeileRoh): readonly ModulDetailAbschnitt[] {
  const abschnitte: ModulDetailAbschnitt[] = [];
  for (const spalte of spalten) {
    if (spalte.format !== 'langtext') {
      continue;
    }
    const roh = zeile.werte[spalte.name];
    const bereinigt = typeof roh === 'string' ? langtextBereinigen(roh) : '';
    if (bereinigt.trim() === '') {
      continue;
    }
    const zuLang = bereinigt.length > LANGTEXT_HOECHSTENS;
    const gemeldet = spalte.gekuerzt !== undefined && zeile.werte[spalte.gekuerzt.spalte] === true;
    const text = zuLang ? bereinigt.slice(0, LANGTEXT_HOECHSTENS) : bereinigt;
    abschnitte.push({
      label: spalte.label,
      text,
      hinweisGekuerzt: gemeldet ? spalte.gekuerzt?.hinweis : zuLang ? 'Gekürzt auf 10.000 Zeichen.' : undefined,
      ...(spalte.formatierung === 'einfach' ? { bloecke: textBloecke(text, true) } : {}),
    });
  }
  return abschnitte;
}

export interface ModulListenZeile {
  readonly id: string;
  readonly titel: string;
  readonly status: ModulStatusAnsicht;
  readonly aktualisiertAm: string;
  readonly href: string;
  /** Die Marke „übernommen · Stefan" (COPI-85); `undefined`: der Vorgang ist frei. */
  readonly sperre: SperrMarke | undefined;
  /** Die Marke aus der View (optionale Spalte `marke`, COPI-91), etwa „Grenzfall". */
  readonly marke: string | undefined;
  /** Die geltende Entscheidung (COPI-91), etwa „Interessant · Stefan". */
  readonly entscheidung: string | undefined;
}

/**
 * Die Zeilen der Seite `/module/:kennung`, in der Reihenfolge, die die Abfrage schon sortiert hat. `sperren` sind die
 * aktiven Übernahmen dieser Zeilen (COPI-85, `aktiveSperren`); ohne Angabe trägt keine Zeile eine Marke.
 */
export function modulListeAnsicht(
  kennung: string,
  zeilen: readonly ModulZeileRoh[],
  jetzt: Date,
  sperren?: ReadonlyMap<string, VorgangSperre>,
  statuswoerter?: Statuswoerter,
  entscheidungen?: ReadonlyMap<string, string>,
): readonly ModulListenZeile[] {
  return zeilen.map((zeile) => {
    const id = text(zeile.werte.id);
    const marke = text(zeile.werte.marke).trim();
    return {
      id,
      titel: text(zeile.werte.titel),
      status: modulStatusAnsicht(text(zeile.werte.status), statuswoerter),
      aktualisiertAm: wertFormatieren(zeile.werte.aktualisiert_am, 'zeitpunkt', jetzt),
      href: `/module/${encodeURIComponent(kennung)}/${encodeURIComponent(id)}`,
      sperre: sperrMarkeFuer(sperren, id, jetzt),
      marke: marke === '' ? undefined : marke.slice(0, 40),
      entscheidung: entscheidungen?.get(id),
    };
  });
}

/**
 * Ein Feld der Detailseite: entweder ein formatierter Text, oder — für die Pflichtspalte `status` — Punkt
 * + Wort wie in der Liste (Review COPI-78: „Status: gelb" roh war zu wenig, die Farbe soll nie allein stehen).
 */
export type ModulDetailFeld =
  | { readonly label: string; readonly art: 'text'; readonly wert: string }
  | { readonly label: string; readonly art: 'link'; readonly link: ModulLink }
  | { readonly label: string; readonly art: 'status'; readonly status: ModulStatusAnsicht };

/** Label, wenn der Block die Pflichtspalte `status` nicht selbst deklariert (siehe `modulDetailAnsicht`). */
const STATUS_LABEL_OHNE_DEKLARATION = 'Status';

/** Der Titel einer Zeile für den Seitenkopf der Detailseite — Klartext, falls die Zeile keinen eigenen hat. */
export function modulZeilenTitel(zeile: ModulZeileRoh): string {
  return text(zeile.werte.titel);
}

function detailFeld(spalte: ModulSpalte, zeile: ModulZeileRoh, jetzt: Date, statuswoerter: Statuswoerter | undefined): ModulDetailFeld {
  if (spalte.name === 'status') {
    return { label: spalte.label, art: 'status', status: modulStatusAnsicht(text(zeile.werte.status), statuswoerter) };
  }
  if (spalte.format === 'link') {
    const link = modulLink(zeile.werte[spalte.name], spalte.domains ?? []);
    if (link !== undefined) {
      return { label: spalte.label, art: 'link', link };
    }
    // Nicht erlaubt: die Adresse bleibt Text, nie ein Link.
    return { label: spalte.label, art: 'text', wert: wertFormatieren(zeile.werte[spalte.name], 'text', jetzt) };
  }
  return { label: spalte.label, art: 'text', wert: wertFormatieren(zeile.werte[spalte.name], spalte.format ?? 'text', jetzt) };
}

/**
 * Alle deklarierten Spalten mit Label, in der Reihenfolge des Blocks — die Seite `/module/:kennung/:id`.
 * Die Pflichtspalte `status` erscheint **immer** als Punkt + Wort, gleich ob der Block sie in `spalten`
 * deklariert (dann mit dessen Label, an dessen Stelle) oder nicht (dann vorangestellt, mit dem Label „Status").
 */
export function modulDetailAnsicht(spalten: readonly ModulSpalte[], zeile: ModulZeileRoh, jetzt: Date, statuswoerter?: Statuswoerter): readonly ModulDetailFeld[] {
  // Ein Langtext steht nicht in der Wertliste, sondern als eigener Abschnitt (`modulDetailAbschnitte`, COPI-103).
  const felder = spalten.filter((spalte) => spalte.format !== 'langtext').map((spalte) => detailFeld(spalte, zeile, jetzt, statuswoerter));
  if (spalten.some((spalte) => spalte.name === 'status')) {
    return felder;
  }
  return [{ label: STATUS_LABEL_OHNE_DEKLARATION, art: 'status', status: modulStatusAnsicht(text(zeile.werte.status), statuswoerter) }, ...felder];
}
