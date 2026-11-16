/**
 * Zeitraster für die Bänder und das Wochendiagramm der Übersicht (COPI-81) — reine Funktionen, der Zeitpunkt
 * ist immer ein Parameter.
 *
 * **Eimer.** Ein Raster sind aufeinanderfolgende Zeitspannen („Eimer"), gegeben durch ihre Grenzen in
 * Millisekunden. Der Status eines Eimers ist der **schlimmste** Status der Verlaufspunkte darin. Ein leerer Eimer
 * übernimmt den zuletzt bekannten Status davor (auch aus einem Punkt vor dem ersten Eimer): ein Dienst, der
 * stündlich „grün" meldet und dann eine Stunde schweigt, war in dieser Stunde nicht „unbekannt", sondern so, wie
 * er zuletzt gemeldet hat. Ist gar nichts bekannt, bleibt der Eimer `leer`.
 *
 * **Kalendertage in Europe/Berlin.** Das Wochendiagramm zählt je Kalendertag der deutschen Zeit, nicht je
 * UTC-Tag. Ein Tag beginnt um Mitternacht Ortszeit und hat 23, 24 oder 25 Stunden (Sommerzeit-Umstellung). Die
 * Ortszeit liefert `Intl` (keine eigene Regeltabelle); da Berlin nur um ganze Stunden versetzt ist, liegen alle
 * Tagesgrenzen auf vollen UTC-Stunden, und ein Stundenraster über mehrere Tage bleibt lückenlos.
 */
import type { BefundStatus } from '../status/zustand.js';

export type EimerStatus = BefundStatus | 'leer';

/** Ein Punkt einer Verlaufs-View: wann welcher Status galt. */
export interface VerlaufPunkt {
  readonly zeitpunkt: Date;
  readonly status: BefundStatus;
  /** Der Messwert zu diesem Zeitpunkt (COPI-83), nur wenn die Verlaufs-View eine Spalte `wert` trägt und sie belegt ist. */
  readonly wert?: number;
}

export const STUNDE_MS = 3_600_000;

const SCHWERE: Readonly<Record<EimerStatus, number>> = { leer: 0, gruen: 1, gelb: 2, rot: 3 };

/** Der schlimmere von zwei Zuständen; `leer` verliert gegen jeden bekannten. */
export function schlimmster(a: EimerStatus, b: EimerStatus): EimerStatus {
  return SCHWERE[b] > SCHWERE[a] ? b : a;
}

/**
 * Belegt die Eimer zwischen `grenzen` (aufsteigend, `n + 1` Werte für `n` Eimer) mit den Punkten (siehe Kopf).
 * Punkte nach der letzten Grenze zählen nicht (eine vorgehende Uhr bei der Quelle); Punkte genau auf der letzten
 * Grenze zählen zum letzten Eimer, damit ein Befund „jetzt" nicht verloren geht.
 */
export function eimerBelegen(punkte: readonly VerlaufPunkt[], grenzen: readonly number[]): EimerStatus[] {
  const sortiert = [...punkte].sort((a, b) => a.zeitpunkt.getTime() - b.zeitpunkt.getTime());
  const anzahl = Math.max(0, grenzen.length - 1);
  const ergebnis: EimerStatus[] = [];
  let zuletzt: EimerStatus = 'leer';
  let index = 0;
  const zeit = (i: number): number => sortiert[i]?.zeitpunkt.getTime() ?? Number.POSITIVE_INFINITY;

  // Alles vor dem ersten Eimer liefert nur den Ausgangszustand.
  while (index < sortiert.length && zeit(index) < (grenzen[0] ?? Number.NEGATIVE_INFINITY)) {
    zuletzt = sortiert[index]?.status ?? zuletzt;
    index += 1;
  }
  for (let eimer = 0; eimer < anzahl; eimer += 1) {
    const ende = grenzen[eimer + 1] ?? Number.NEGATIVE_INFINITY;
    const letzter = eimer === anzahl - 1;
    const davor = zuletzt;
    let schlimmsterDarin: EimerStatus = 'leer';
    while (index < sortiert.length && (zeit(index) < ende || (letzter && zeit(index) === ende))) {
      const status = sortiert[index]?.status ?? 'leer';
      schlimmsterDarin = schlimmster(schlimmsterDarin, status);
      zuletzt = status;
      index += 1;
    }
    ergebnis.push(schlimmsterDarin === 'leer' ? davor : schlimmsterDarin);
  }
  return ergebnis;
}

/**
 * Die Grenzen von `anzahl` gleitenden Eimern zu je `eimerGroesseMs` bis `jetzt` (der letzte Eimer endet genau bei
 * `jetzt`) — verallgemeinert von `stundenGrenzen` (COPI-81) für den 24×1-Std.-Band des Dashboards **und** den
 * 28×6-Std.-Band der Modul-Kacheln (COPI-82): dieselbe Rechnung, nur die Eimergröße ist ein Parameter.
 * Ist `anzahl` keine ganze Zahl ab 1, ist die Liste leer (kein RangeError, keine Grenzen abseits der Eimergrenze).
 */
export function gleitendeGrenzen(jetzt: Date, anzahl: number, eimerGroesseMs: number): number[] {
  if (!Number.isInteger(anzahl) || anzahl < 1) {
    return [];
  }
  const ende = jetzt.getTime();
  return Array.from({ length: anzahl + 1 }, (_, i) => ende - (anzahl - i) * eimerGroesseMs);
}

/** Die Grenzen von `anzahl` gleitenden Stunden bis `jetzt` — `gleitendeGrenzen` mit einer Stunde je Eimer. */
export function stundenGrenzen(jetzt: Date, anzahl: number): number[] {
  return gleitendeGrenzen(jetzt, anzahl, STUNDE_MS);
}

/** Der jüngste Eimer spiegelt zusätzlich den aktuellen Status (schlimmster von beiden) — ein überfälliges Gelb soll man sehen. */
export function mitAktuellem(eimer: readonly EimerStatus[], aktuell: BefundStatus): EimerStatus[] {
  if (eimer.length === 0) {
    return [];
  }
  const kopie = [...eimer];
  kopie[kopie.length - 1] = schlimmster(kopie[kopie.length - 1] ?? 'leer', aktuell);
  return kopie;
}

/** Je Eimer der schlimmste Status über mehrere Reihen gleicher Länge (etwa alle Karten). */
export function schlimmsterJeEimer(reihen: readonly (readonly EimerStatus[])[], anzahl: number): EimerStatus[] {
  return Array.from({ length: anzahl }, (_, i) => reihen.reduce<EimerStatus>((bisher, reihe) => schlimmster(bisher, reihe[i] ?? 'leer'), 'leer'));
}

export interface EimerZaehlung {
  readonly rot: number;
  readonly gelb: number;
  readonly gruen: number;
  readonly leer: number;
}

export function eimerZaehlen(eimer: readonly EimerStatus[]): EimerZaehlung {
  const zaehlung = { rot: 0, gelb: 0, gruen: 0, leer: 0 };
  for (const status of eimer) {
    zaehlung[status] += 1;
  }
  return zaehlung;
}

/** Anteil grüner unter den nicht-leeren Eimern in ganzen Prozent, abgerundet („100 %" nur, wenn wirklich alles grün war); ohne Daten `undefined`. */
export function verfuegbarkeitProzent(zaehlung: EimerZaehlung): number | undefined {
  const belegt = zaehlung.rot + zaehlung.gelb + zaehlung.gruen;
  return belegt === 0 ? undefined : Math.floor((zaehlung.gruen * 100) / belegt);
}

/** „92 % in Ordnung" oder „keine Daten" — die Verfügbarkeit auf einer Dashboard-Karte oder Modul-Kachel (COPI-81/82). */
export function verfuegbarkeitText(prozent: number | undefined): string {
  return prozent === undefined ? 'keine Daten' : `${String(prozent)} % in Ordnung`;
}

/** Wie ein Zustand im Wort heißt, für die Textalternative eines Bands (COPI-81/82). */
const BAND_WORT: Readonly<Record<EimerStatus, string>> = { gruen: 'Läuft', gelb: 'Achtung', rot: 'Störung', leer: 'ohne Daten' };

/**
 * Textalternative eines Bands (WCAG 1.4.1): je Zustand die Stunden, schlimmster zuerst. `stundenJeEimer` rechnet
 * Eimer in Stunden um — die 24 Eimer des Dashboard-Bands (COPI-81) sind je eine Stunde, die 28 Eimer der
 * Modul-Kachel (COPI-82) je sechs.
 */
export function bandText(praefix: string, segmente: readonly EimerStatus[], stundenJeEimer = 1): string {
  const zaehlung = eimerZaehlen(segmente);
  const teile = (['rot', 'gelb', 'gruen', 'leer'] as const)
    .filter((status) => zaehlung[status] > 0)
    .map((status) => `${String(zaehlung[status] * stundenJeEimer)} Std. ${BAND_WORT[status]}`);
  return `${praefix}: ${teile.join(', ')}`;
}

/**
 * Das Band einer Dashboard-Karte oder Modul-Kachel: `anzahl` gleitende Eimer zu je `eimerGroesseMs`, ohne
 * bekannten Verlauf ganz `leer`; der jüngste Eimer spiegelt zusätzlich den aktuellen Status (`mitAktuellem`) —
 * ein überfälliges Gelb soll man sehen, gleich auf welchem Band (COPI-81/82).
 */
export function bandFuer(verlauf: readonly VerlaufPunkt[] | undefined, aktuell: BefundStatus, jetzt: Date, anzahl: number, eimerGroesseMs: number): EimerStatus[] {
  if (verlauf === undefined) {
    return Array.from({ length: anzahl }, (): EimerStatus => 'leer');
  }
  return mitAktuellem(eimerBelegen(verlauf, gleitendeGrenzen(jetzt, anzahl, eimerGroesseMs)), aktuell);
}

const BERLIN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

interface Ortszeit {
  readonly jahr: number;
  readonly monat: number;
  readonly tag: number;
  readonly stunde: number;
  readonly minute: number;
  readonly sekunde: number;
}

function ortszeit(ms: number): Ortszeit {
  const teile = Object.fromEntries(BERLIN.formatToParts(new Date(ms)).map((teil) => [teil.type, Number(teil.value)]));
  return {
    jahr: teile.year ?? 0,
    monat: teile.month ?? 1,
    tag: teile.day ?? 1,
    stunde: teile.hour ?? 0,
    minute: teile.minute ?? 0,
    sekunde: teile.second ?? 0,
  };
}

/** Versatz der Berliner Ortszeit gegen UTC zu einem Zeitpunkt (eine oder zwei Stunden), in Millisekunden. */
function berlinVersatz(ms: number): number {
  const o = ortszeit(ms);
  return Date.UTC(o.jahr, o.monat - 1, o.tag, o.stunde, o.minute, o.sekunde) - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * Mitternacht Ortszeit des Kalendertags (`Date.UTC`-Zählweise, Monat ab 0, Tag darf überlaufen). Der Versatz
 * wird zwei Stunden vorher gemessen: die Umstellung liegt in Berlin immer um 01:00 UTC, Mitternacht und der
 * Messpunkt liegen also stets auf derselben Seite.
 */
function berlinMitternacht(jahr: number, monat: number, tag: number): number {
  const alsUtc = Date.UTC(jahr, monat, tag);
  return alsUtc - berlinVersatz(alsUtc - 2 * STUNDE_MS);
}

const WOCHENTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

export interface Kalendertag {
  /** „Mo" … „So". */
  readonly kuerzel: string;
  /** Mitternacht Ortszeit, in Millisekunden. */
  readonly beginn: number;
  /** Nächste Mitternacht Ortszeit — für heute `jetzt`. */
  readonly ende: number;
}

/** Die letzten `anzahl` Kalendertage in Europe/Berlin bis einschließlich heute, der älteste zuerst; heute endet bei `jetzt`. */
export function berlinTage(jetzt: Date, anzahl: number): Kalendertag[] {
  const heute = ortszeit(jetzt.getTime());
  return Array.from({ length: anzahl }, (_, i) => {
    const versatzTage = anzahl - 1 - i;
    const beginn = berlinMitternacht(heute.jahr, heute.monat - 1, heute.tag - versatzTage);
    const naechste = berlinMitternacht(heute.jahr, heute.monat - 1, heute.tag - versatzTage + 1);
    const wochentag = new Date(Date.UTC(heute.jahr, heute.monat - 1, heute.tag - versatzTage)).getUTCDay();
    return { kuerzel: WOCHENTAG[wochentag] ?? '', beginn, ende: Math.min(naechste, jetzt.getTime()) };
  });
}

/** Die Stundengrenzen eines Tages: volle Stunden ab Mitternacht, die letzte Stunde endet am Tagesende (heute: bei `jetzt`). */
export function tagesGrenzen(tag: Kalendertag): number[] {
  const grenzen: number[] = [];
  for (let beginn = tag.beginn; beginn < tag.ende; beginn += STUNDE_MS) {
    grenzen.push(beginn);
  }
  grenzen.push(tag.ende);
  return grenzen.length === 1 ? [] : grenzen;
}
