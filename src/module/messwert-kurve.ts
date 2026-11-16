/**
 * Messwert, Balken und Kurve einer Dashboard-Karte (COPI-81) oder einer Modul-Kachel (COPI-82) — COPI-83. Reine
 * Funktionen, der Zeitpunkt ist ein Parameter; Karte und Kachel nutzen denselben Code, nur Zeitfenster und Maße der
 * Kurve (`KARTE_KURVE`, `KACHEL_KURVE`) sind Parameter.
 *
 * **Woher die Zahlen kommen.** Der aktuelle Wert steht in der Zeile der Modul-View (optionale Spalten `wert`,
 * `einheit`, `wert_max`, `wert_warnung`), die Kurve aus den Punkten der Verlaufs-View mit Spalte `wert`. Beide
 * Spalten prüft der Katalog (`registry.ts`); was eine Kundenrolle sieht, bestimmt allein die View (die Beispiele
 * lesen nur kundensichtbare Befunde).
 *
 * **Ohne `style`-Attribut** (`test/layout.test.ts`): die Kurve ist ein Inline-SVG mit `viewBox` in festen Maßen;
 * Lage und Form stehen in Attributen (`d`, `y1` …), die Farbe in Klassen. Der Balken braucht nicht einmal eine
 * `viewBox`: seine Breite ist ein Prozent-Attribut (`width="86%"`).
 *
 * **Skalierung** (`skala`): mit Obergrenze `0..max` (bzw. weiter, wenn Werte oder Warnschwelle darüber liegen),
 * sonst kleinster bis größter Wert mit 10 % Luft — bei lauter nicht-negativen Werten nie unter 0. Die Warnschwelle
 * liegt immer im Bereich. **Lücken:** ein Punkt ohne Wert unterbricht die Linie; keine Werte, keine Kurve.
 */
import type { BefundStatus } from '../status/zustand.js';
import { berlinTage, type VerlaufPunkt } from './zeitraster.js';

export interface KurvenMasse {
  readonly breite: number;
  readonly hoehe: number;
}

/** Die 24-Std.-Kurve der Dashboard-Karte: 48 px hoch (die Breite dehnt sich, `preserveAspectRatio="none"`). */
export const KARTE_KURVE: KurvenMasse = { breite: 240, hoehe: 48 };

/** Die 7-Tage-Kurve der Modul-Kachel: 90 px hoch. */
export const KACHEL_KURVE: KurvenMasse = { breite: 300, hoehe: 90 };

/** Abstand der Linie zum oberen und unteren Rand, in Einheiten der `viewBox` — sonst schnitte der Rand sie an. */
const RAND = 3;

export interface Spanne {
  readonly min: number;
  readonly max: number;
}

/** Zahlen deutsch: `86`, `0,5`, `1.234` (höchstens zwei Nachkommastellen); eine auf null gerundete Zahl ohne Minuszeichen; NaN und ±Infinity (numeric kennt sie) als „–“. */
export function zahlText(zahl: number): string {
  if (!Number.isFinite(zahl)) {
    return '–';
  }
  return zahl.toLocaleString('de-DE', { maximumFractionDigits: 2, signDisplay: 'negative' });
}

/** Zahl und Einheit mit Leerzeichen: `86 %`, `180 ms`, `5 von 5`; ohne Einheit nur die Zahl; eine nicht endliche Zahl nur als „–“. */
export function mitEinheit(zahl: number, einheit: string): string {
  return einheit === '' || !Number.isFinite(zahl) ? zahlText(zahl) : `${zahlText(zahl)} ${einheit}`;
}

/** Kleinster und größter Wert; ohne Werte `undefined`. */
export function minMax(werte: readonly number[]): Spanne | undefined {
  if (werte.length === 0) {
    return undefined;
  }
  return { min: Math.min(...werte), max: Math.max(...werte) };
}

/** Der y-Bereich der Kurve (siehe Kopf); ohne Werte `undefined`. Die Spanne ist immer größer als null. */
export function skala(werte: readonly number[], bezug: { readonly max?: number | undefined; readonly warnung?: number | undefined }): Spanne | undefined {
  const daten = minMax(werte);
  if (daten === undefined) {
    return undefined;
  }
  const alle = minMax(bezug.warnung === undefined ? [daten.min, daten.max] : [daten.min, daten.max, bezug.warnung]) ?? daten;
  if (bezug.max !== undefined && bezug.max > 0) {
    return { min: Math.min(0, alle.min), max: Math.max(bezug.max, alle.max) };
  }
  const breite = alle.max - alle.min || Math.abs(alle.max) || 1;
  const luft = breite * 0.1;
  const unten = alle.min - luft;
  return { min: alle.min >= 0 && unten < 0 ? 0 : unten, max: alle.max + luft };
}

/** Zwei Nachkommastellen genügen für SVG-Koordinaten. */
function runden(wert: number): number {
  return Math.round(wert * 100) / 100;
}

/** Die y-Koordinate eines Werts in der `viewBox` (oben ist 0). */
export function yAus(wert: number, bereich: Spanne, masse: KurvenMasse): number {
  const anteil = (wert - bereich.min) / (bereich.max - bereich.min);
  return runden(RAND + (1 - anteil) * (masse.hoehe - 2 * RAND));
}

export interface KurvenPunkt {
  /** Millisekunden seit 1970. */
  readonly zeit: number;
  /** `undefined`: kein Wert — die Linie bricht hier ab. */
  readonly wert: number | undefined;
}

export interface KurvenPfade {
  /** `d` der Linie, je zusammenhängendem Stück mit mindestens zwei Punkten. */
  readonly linie: string;
  /**
   * `d` der einzelnen Punkte zwischen zwei Lücken: je ein Strich der Länge null, den die runde, dickere Kappe
   * (`.kurve-punkt`) als Punkt zeichnet — so bleibt etwa der erste Wert nach einem Ausfall sichtbar.
   */
  readonly punkte: string;
  /** `d` der Fläche unter der Linie, je zusammenhängendem Stück mit mindestens zwei Punkten. */
  readonly flaeche: string;
}

/** Linie und Fläche der Punkte im Zeitfenster `von..bis`, zeitlich sortiert, mit Lücken (siehe Kopf). */
export function kurvenPfade(punkte: readonly KurvenPunkt[], fenster: Spanne, bereich: Spanne, masse: KurvenMasse): KurvenPfade {
  const dauer = Math.max(1, fenster.max - fenster.min);
  const stuecke: { x: number; y: number }[][] = [[]];
  for (const punkt of [...punkte].filter((p) => p.zeit >= fenster.min && p.zeit <= fenster.max).sort((a, b) => a.zeit - b.zeit)) {
    if (punkt.wert === undefined) {
      stuecke.push([]);
      continue;
    }
    stuecke[stuecke.length - 1]?.push({ x: runden(((punkt.zeit - fenster.min) / dauer) * masse.breite), y: yAus(punkt.wert, bereich, masse) });
  }
  const linie: string[] = [];
  const flaeche: string[] = [];
  const einzelne: string[] = [];
  for (const stueck of stuecke.filter((s) => s.length > 0)) {
    const [erster] = stueck;
    const letzter = stueck[stueck.length - 1];
    if (erster === undefined || letzter === undefined) {
      continue;
    }
    const zuege = stueck.map((p, i) => `${i === 0 ? 'M' : 'L'}${String(p.x)} ${String(p.y)}`).join(' ');
    if (stueck.length === 1) {
      einzelne.push(`${zuege} h0`);
      continue;
    }
    linie.push(zuege);
    flaeche.push(`M${String(erster.x)} ${String(masse.hoehe)} ${zuege.replace(/^M/, 'L')} L${String(letzter.x)} ${String(masse.hoehe)} Z`);
  }
  return { linie: linie.join(' '), flaeche: flaeche.join(' '), punkte: einzelne.join(' ') };
}

/** Der aktuelle Messwert einer Zeile der Modul-View (optionale Spalten, siehe Kopf). */
export interface ZeilenMesswert {
  readonly wert: number;
  readonly einheit: string;
  readonly max: number | undefined;
  readonly warnung: number | undefined;
}

/** Ein `numeric` aus `pg` (dort Text) als endliche Zahl; `NULL` oder Unlesbares heißt „kein Wert". */
export function zahlAus(wert: unknown): number | undefined {
  if (wert === null || wert === undefined || wert === '') {
    return undefined;
  }
  const zahl = typeof wert === 'number' ? wert : Number(wert);
  return Number.isFinite(zahl) ? zahl : undefined;
}

/** Der Messwert einer Zeile; ohne `wert` `undefined` — die Karte bleibt dann genau wie bisher. */
export function zeilenMesswert(werte: Readonly<Record<string, unknown>>): ZeilenMesswert | undefined {
  const wert = zahlAus(werte.wert);
  if (wert === undefined) {
    return undefined;
  }
  const max = zahlAus(werte.wert_max);
  return {
    wert,
    einheit: typeof werte.einheit === 'string' ? werte.einheit.trim() : '',
    max: max !== undefined && max > 0 ? max : undefined,
    warnung: zahlAus(werte.wert_warnung),
  };
}

export interface KurveAnsicht {
  readonly breite: number;
  readonly hoehe: number;
  readonly linie: string;
  readonly flaeche: string;
  readonly punkte: string;
  /** y der Warnlinie; `undefined` ohne `wert_warnung`. */
  readonly warnlinie: number | undefined;
  /** Textalternative: „Plattenplatz, letzte 24 Stunden: 80 – 86 %, aktuell 86 %". */
  readonly text: string;
  /** „80 – 86 %". */
  readonly spanne: string;
  /** „min. 71 % · max. 86 %". */
  readonly minMax: string;
}

export interface MesswertAnsicht {
  /** Die Zahl, deutsch formatiert. */
  readonly wert: string;
  readonly einheit: string;
  /** „von 100 %" — nur mit `wert_max`, und nicht, wenn die Einheit selbst schon „von …" sagt („5 von 5"). */
  readonly bezug: string | undefined;
  /** Füllung des Balkens in Prozent (0–100), nur mit `wert_max`. */
  readonly balken: number | undefined;
  /** Zustandsfarbe für Zahl, Balken und Kurve. */
  readonly farbe: BefundStatus;
  /** `undefined`: keine Werte im Zeitfenster — keine Kurve. */
  readonly kurve: KurveAnsicht | undefined;
}

export interface MesswertEingabe {
  readonly titel: string;
  readonly zeile: ZeilenMesswert | undefined;
  /** Die Verlaufspunkte dieser Zeile; `undefined`: kein Verlauf bekannt. */
  readonly punkte: readonly VerlaufPunkt[] | undefined;
  readonly jetzt: Date;
  readonly fensterMs: number;
  /** „letzte 24 Stunden". */
  readonly zeitraum: string;
  readonly masse: KurvenMasse;
  readonly farbe: BefundStatus;
}

function spanneText(spanne: Spanne, einheit: string): string {
  return spanne.min === spanne.max ? mitEinheit(spanne.max, einheit) : `${zahlText(spanne.min)} – ${mitEinheit(spanne.max, einheit)}`;
}

function kurveAus(eingabe: MesswertEingabe, zeile: ZeilenMesswert): KurveAnsicht | undefined {
  const fenster = { min: eingabe.jetzt.getTime() - eingabe.fensterMs, max: eingabe.jetzt.getTime() };
  const punkte = (eingabe.punkte ?? [])
    .map((p): KurvenPunkt => ({ zeit: p.zeitpunkt.getTime(), wert: p.wert }))
    .filter((p) => p.zeit >= fenster.min && p.zeit <= fenster.max);
  const werte = punkte.flatMap((p) => (p.wert === undefined ? [] : [p.wert]));
  const daten = minMax(werte);
  const bereich = skala(werte, zeile);
  if (daten === undefined || bereich === undefined) {
    return undefined;
  }
  const spanne = spanneText(daten, zeile.einheit);
  return {
    ...eingabe.masse,
    ...kurvenPfade(punkte, fenster, bereich, eingabe.masse),
    warnlinie: zeile.warnung === undefined ? undefined : yAus(zeile.warnung, bereich, eingabe.masse),
    text: `${eingabe.titel}, ${eingabe.zeitraum}: ${spanne}, aktuell ${mitEinheit(zeile.wert, zeile.einheit)}`,
    spanne,
    minMax: `min. ${mitEinheit(daten.min, zeile.einheit)} · max. ${mitEinheit(daten.max, zeile.einheit)}`,
  };
}

/** Wert, Bezug, Balken und Kurve einer Zeile; ohne `wert` in der Zeile `undefined` (siehe `zeilenMesswert`). */
export function messwertAnsicht(eingabe: MesswertEingabe): MesswertAnsicht | undefined {
  const zeile = eingabe.zeile;
  if (zeile === undefined) {
    return undefined;
  }
  const { max, einheit } = zeile;
  return {
    wert: zahlText(zeile.wert),
    einheit,
    bezug: max === undefined || einheit.startsWith('von ') ? undefined : `von ${mitEinheit(max, einheit)}`,
    balken: max === undefined ? undefined : runden(Math.min(100, Math.max(0, (zeile.wert / max) * 100))),
    farbe: eingabe.farbe,
    kurve: kurveAus(eingabe, zeile),
  };
}

/** Die Kürzel der letzten sieben Kalendertage (Europe/Berlin) für die Achse der 7-Tage-Kurve, der älteste zuerst. */
export function kurvenTage(jetzt: Date): readonly string[] {
  return berlinTage(jetzt, 7).map((tag) => tag.kuerzel);
}
