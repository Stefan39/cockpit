/**
 * Die Kachel-Darstellung der Modulseite (COPI-82, `darstellung: kacheln` im `cockpit:`-Block): dieselben Zeilen
 * wie die Liste (`liste-detail.ts`, schon rot → gelb → grün, dann Titel sortiert), aber als Kartenraster mit
 * einem 7-Tage-Band statt Textzeilen. Reine Funktionen, der Zeitpunkt ist ein Parameter; gelesen wird weiterhin
 * über `liste-detail.ts` (Zeilen) und `uebersicht-lesen.ts` (`modulVerlaufLesen`, derselbe Verlauf wie das
 * Dashboard) — hier wird nur aufbereitet.
 *
 * **Baut auf COPI-81 auf, statt zu kopieren:** `kuerzelAus` (`uebersicht-karten.ts`) und die Eimer-Rechnung mit
 * Eimergröße/-anzahl als Parameter (`bandFuer`/`bandText`/`verfuegbarkeitText`, `zeitraster.ts`) — die
 * Dashboard-Karte (24 Eimer zu je einer Stunde) und die Kachel (28 Eimer zu je sechs Stunden) nutzen denselben
 * Code. `wertFormatieren` (`ansicht.ts`) formatiert die Felder wie die Detailseite.
 *
 * **Filter ohne Skript** (`?status=rot|gelb|gruen`): serverseitig gefiltert, ein fehlender oder unbekannter Wert
 * zeigt alle. Die Chips zählen immer **alle** Kacheln der Seite, auch bei aktivem Filter — sonst verschwände
 * „Läuft · 4" beim Filtern auf „Störung". Ein Status außerhalb von gruen/gelb/rot (ein Fehler in der Fach-View)
 * gehört zu keinem der drei Chips: dieselbe defensive Behandlung wie in der Liste (`ansicht.ts`), **kein** „im
 * Zweifel gelb" wie im Dashboard (COPI-81) — das ist eine Regel für die Aggregation im Zustandsband, keine für
 * die einzelne Zeile (Entscheidung COPI-82).
 *
 * **Messwert (COPI-83).** Trägt die Zeile einen `wert`, steht er rechts im Kopf; über dem (dann schmaleren)
 * 7-Tage-Band liegt eine 7-Tage-Kurve mit Warnlinie bei `wert_warnung` — derselbe Code wie die Dashboard-Karte
 * (`messwert-kurve.ts`), nur Zeitfenster und Maße sind andere.
 *
 * **Kein Verlauf, kein Band.** Anders als das Dashboard, das ohne lesbaren Verlauf ein neutrales Band zeigt,
 * entfällt auf der Kachel der ganze Block „Letzte 7 Tage", wenn das Modul keine Verlaufs-View hat oder sie nicht
 * lesbar ist (Entscheidung COPI-82: auf der Modulseite ist „kein Verlauf" kein eigener Zustand, der eine leere
 * Grafik verdient — anders als im Dashboard, wo das Band Teil der immer gleichen Kartenform ist).
 */
import { STATUS_WORT } from '../status/uebersicht.js';
import { BEFUND_STATUS, type BefundStatus } from '../status/zustand.js';
import { modulStatusAnsicht, wertFormatieren, type ModulStatusAnsicht } from './ansicht.js';
import type { ModulBlock, ModulSpalte } from './block.js';
import type { ModulZeileRoh } from './liste-detail.js';
import { KACHEL_KURVE, kurvenTage, messwertAnsicht, zeilenMesswert, type MesswertAnsicht } from './messwert-kurve.js';
import { kuerzelAus, type Band } from './uebersicht-karten.js';
import { sperrMarkeFuer, type SperrMarke, type VorgangSperre } from './vorgang-sperre.js';
import { bandFuer, bandText, eimerZaehlen, STUNDE_MS, verfuegbarkeitProzent, verfuegbarkeitText, type VerlaufPunkt } from './zeitraster.js';

/** Segmente des 7-Tage-Bands: 28 Eimer zu je sechs Stunden (7 Tage × 24 Std. / 6 Std.). */
export const KACHEL_BAND_EIMER = 28;
export const KACHEL_EIMER_GROESSE_MS = 6 * STUNDE_MS;

/** Die Pflichtspalten, die schon im Kopf (`titel`, `status`) bzw. der Fußzeile (`aktualisiert_am`) stehen — kein eigenes Feld. */
const OHNE_EIGENES_FELD = new Set<string>(['titel', 'status', 'aktualisiert_am']);

function text(wert: unknown): string {
  return wert === null || wert === undefined ? '' : typeof wert === 'string' ? wert : String(wert);
}

export interface KachelFeld {
  readonly label: string;
  readonly wert: string;
}

export interface Kachel {
  readonly id: string;
  readonly titel: string;
  readonly kuerzel: string;
  readonly status: ModulStatusAnsicht;
  /** Die deklarierten Spalten außer titel/status/aktualisiert_am, in der Reihenfolge des Blocks. */
  readonly felder: readonly KachelFeld[];
  /** `undefined`: keine (lesbare) Verlaufs-View — der Block „Letzte 7 Tage" entfällt ganz (siehe Kopf). */
  readonly band: Band | undefined;
  readonly verfuegbarkeit: string | undefined;
  /** Aktueller Wert im Kopf und 7-Tage-Kurve (COPI-83); `undefined`: die Zeile trägt keinen `wert`. */
  readonly messwert: MesswertAnsicht | undefined;
  /** Die Tageskürzel unter der 7-Tage-Kurve, der älteste zuerst. */
  readonly kurvenTage: readonly string[];
  /** „Zuletzt gemeldet: heute, 09:50" — derselbe Zeitpunkt wie die Pflichtspalte `aktualisiert_am`. */
  readonly geprueft: string;
  readonly href: string;
  /** Die Marke „übernommen · Stefan · seit 14:02" (COPI-85); `undefined`: der Vorgang ist frei. */
  readonly sperre: SperrMarke | undefined;
}

/** Die deklarierten Spalten außer den Pflichtspalten, formatiert wie die Detailseite (`wertFormatieren`). */
function kachelFelder(spalten: readonly ModulSpalte[], zeile: ModulZeileRoh, jetzt: Date): readonly KachelFeld[] {
  return spalten
    // Ein Langtext (COPI-103) gehört nicht auf eine Kachel, nur auf die Detailseite.
    .filter((spalte) => !OHNE_EIGENES_FELD.has(spalte.name) && spalte.format !== 'langtext')
    .map((spalte) => ({ label: spalte.label, wert: wertFormatieren(zeile.werte[spalte.name], spalte.format ?? 'text', jetzt) }));
}

/** Das Band einer Kachel: `undefined`, wenn für dieses Modul kein Verlauf bekannt ist (siehe Kopf). */
function kachelBand(punkte: readonly VerlaufPunkt[] | undefined, aktuell: BefundStatus, jetzt: Date): { readonly band: Band; readonly verfuegbarkeit: string } {
  const segmente = bandFuer(punkte, aktuell, jetzt, KACHEL_BAND_EIMER, KACHEL_EIMER_GROESSE_MS);
  return {
    band: { segmente, text: bandText('Letzte 7 Tage', segmente, 6) },
    verfuegbarkeit: verfuegbarkeitText(verfuegbarkeitProzent(eimerZaehlen(segmente))),
  };
}

function kachelAus(
  kennung: string,
  block: ModulBlock,
  zeile: ModulZeileRoh,
  verlaufJeId: ReadonlyMap<string, readonly VerlaufPunkt[]> | undefined,
  jetzt: Date,
  sperren: ReadonlyMap<string, VorgangSperre> | undefined,
): Kachel {
  const id = text(zeile.werte.id);
  const status = modulStatusAnsicht(text(zeile.werte.status), block.statuswoerter);
  // Nur für die Übernahme in den jüngsten Eimer des Bands (mitAktuellem verlangt einen bekannten Status); die
  // Kachel selbst zeigt weiterhin ihr eigenes Wort (status.wort), unverändert.
  const bandStatus: BefundStatus = status.farbe === 'unbekannt' ? 'gelb' : status.farbe;
  // `?? []`, nicht `undefined`, wenn diese id im (bekannten) Verlauf fehlt: „null Punkte" ist etwas anderes als
  // „kein Verlauf bekannt" — der jüngste Eimer soll trotzdem den aktuellen Status spiegeln (wie beim Dashboard,
  // `uebersicht-karten.ts`, `karteAus`).
  const punkte = verlaufJeId === undefined ? undefined : (verlaufJeId.get(id) ?? []);
  const bekannt = punkte !== undefined ? kachelBand(punkte, bandStatus, jetzt) : undefined;
  const titel = text(zeile.werte.titel);
  return {
    id,
    titel,
    kuerzel: kuerzelAus(titel),
    status,
    felder: kachelFelder(block.spalten, zeile, jetzt),
    band: bekannt?.band,
    verfuegbarkeit: bekannt?.verfuegbarkeit,
    messwert: messwertAnsicht({
      titel,
      zeile: zeilenMesswert(zeile.werte),
      punkte,
      jetzt,
      fensterMs: KACHEL_BAND_EIMER * KACHEL_EIMER_GROESSE_MS,
      zeitraum: 'letzte 7 Tage',
      masse: KACHEL_KURVE,
      farbe: bandStatus,
    }),
    kurvenTage: kurvenTage(jetzt),
    geprueft: `Zuletzt gemeldet: ${wertFormatieren(zeile.werte.aktualisiert_am, 'zeitpunkt', jetzt)}`,
    href: `/module/${encodeURIComponent(kennung)}/${encodeURIComponent(id)}`,
    sperre: sperrMarkeFuer(sperren, id, jetzt),
  };
}

/**
 * Alle Zeilen als Kacheln, in der Reihenfolge der Abfrage (rot → gelb → grün, dann Titel — wie die Liste). `sperren`:
 * die aktiven Übernahmen (COPI-85), wie bei der Liste.
 */
export function kachelnAnsicht(
  kennung: string,
  block: ModulBlock,
  zeilen: readonly ModulZeileRoh[],
  verlauf: ReadonlyMap<string, readonly VerlaufPunkt[]> | undefined,
  jetzt: Date,
  sperren?: ReadonlyMap<string, VorgangSperre>,
): readonly Kachel[] {
  return zeilen.map((zeile) => kachelAus(kennung, block, zeile, verlauf, jetzt, sperren));
}

export interface KachelFilter {
  readonly status: BefundStatus | undefined;
}

function istBefundStatus(wert: string): wert is BefundStatus {
  return (BEFUND_STATUS as readonly string[]).includes(wert);
}

/** Der Filter aus der Adresse (`?status=`); ein fehlender oder unbekannter Wert heißt „Alle". */
export function kachelFilterAus(anfrage: { readonly status?: unknown }): KachelFilter {
  return { status: typeof anfrage.status === 'string' && istBefundStatus(anfrage.status) ? anfrage.status : undefined };
}

/** Nur die Kacheln, deren Status zum Filter passt; ohne Filter (oder einen unbekannten Wert) alle. */
export function kachelnGefiltert(kacheln: readonly Kachel[], filter: KachelFilter): readonly Kachel[] {
  return filter.status === undefined ? kacheln : kacheln.filter((kachel) => kachel.status.farbe === filter.status);
}

/** Die Reihenfolge der Filter-Chips: rot → gelb → grün, wie überall im Cockpit sortiert wird. */
const CHIP_REIHENFOLGE = ['rot', 'gelb', 'gruen'] as const satisfies readonly BefundStatus[];

export interface KachelChip {
  readonly text: string;
  readonly href: string;
  readonly aktuell: boolean;
  /** `undefined` für „Alle" (kein Punkt, keine Zustandsfarbe). */
  readonly farbe: BefundStatus | undefined;
}

/**
 * Die Filter-Chips mit Anzahl: „Alle · n", dann je Zustand „<Wort> · n" — immer aus **allen** Kacheln gezählt
 * (siehe Kopf). Ein Chip mit Anzahl 0 erscheint trotzdem, damit die Reihenfolge der Chips nicht wechselt.
 */
export function kachelChips(kennung: string, kacheln: readonly Kachel[], filter: KachelFilter): readonly KachelChip[] {
  const basis = `/module/${encodeURIComponent(kennung)}`;
  const alle: KachelChip = { text: `Alle · ${String(kacheln.length)}`, href: basis, aktuell: filter.status === undefined, farbe: undefined };
  // Reihenfolge der Chips wie überall im Cockpit rot → gelb → grün (nicht die Deklarationsreihenfolge von
  // BEFUND_STATUS, die grün zuerst nennt).
  const jeStatus = CHIP_REIHENFOLGE.map((status): KachelChip => {
    const anzahl = kacheln.filter((kachel) => kachel.status.farbe === status).length;
    return { text: `${STATUS_WORT[status]} · ${String(anzahl)}`, href: `${basis}?status=${status}`, aktuell: filter.status === status, farbe: status };
  });
  return [alle, ...jeStatus];
}
