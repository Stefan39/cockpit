/**
 * Meldungen (COPI-43, Prototyp „Meldungen" und „Letzte Meldungen") — reine Funktionen, der Zeitpunkt ist ein
 * Parameter.
 *
 * **Eine Meldung ist ein Wechsel:** ein Befund, dessen Status oder Text sich gegenüber dem vorigen derselben Wache
 * geändert hat. Eine Wache meldet alle paar Minuten, meist dasselbe; jeder Befund als Meldung wäre eine Liste voller
 * „Alles läuft.". Welche Befunde Wechsel sind, entscheidet die Abfrage (`meldungen-speicher.ts`), getrennt je Sicht:
 * die Kundensicht sieht nur kundensichtbare Befunde mit ihrem Klartext und nie die Kennung einer Wache; der Betreuer
 * alle, mit Rohbefund.
 *
 * Die Filter des Prototyps: „Warnung" ist Gelb, „Fehler" ist Rot, „Info" ist Grün.
 */
import { type BefundStatus, vorKurz } from './zustand.js';
import { NAME_OHNE_ANZEIGENAME } from './uebersicht.js';

/** Längste Suche: eine Suche, kein Text. */
export const MELDUNGEN_SUCHE_HOECHSTENS = 100;

/** Wie die Filter in der Adresse heißen (`?art=`). */
const ART: Readonly<Record<string, BefundStatus>> = { warnung: 'gelb', fehler: 'rot', info: 'gruen' };

export interface MeldungenFilter {
  readonly art: BefundStatus | undefined;
  readonly suche: string | undefined;
  /** Der Wert von `?art=`, wie ihn die Seite für den aktiven Filter braucht; leer für „Alle". */
  readonly artWert: string;
}

/** Ein Wechsel, wie ihn die Abfrage liefert. */
export interface MeldungZeile {
  readonly status: BefundStatus;
  /** Kundensicht: der Klartext; Betreuersicht: der Rohbefund. */
  readonly text: string;
  readonly gemeldetAm: Date;
  /** Kundensicht: der Anzeigename oder nichts; Betreuersicht: Anzeigename oder Kennung. */
  readonly name: string | undefined;
  /** Nur Betreuersicht: der Kunde sieht diesen Befund nicht. */
  readonly intern: boolean;
}

export interface Meldung {
  readonly titel: string;
  readonly farbe: BefundStatus;
  /** „vor 2 Std." — wie „Letzte Meldungen" im Prototyp. */
  readonly zeit: string;
  /** „vor 2 Std. · Rechnungs-Agent" — wie die Seite „Meldungen" im Prototyp. */
  readonly meta: string;
  readonly intern: boolean;
}

/** Die Filter aus der Anfrage. Ein unbekannter oder mehrfacher Wert heißt „Alle"; eine zu lange Suche wird gekürzt. */
export function filterAus(anfrage: { readonly art?: unknown; readonly q?: unknown }): MeldungenFilter {
  const artWert = typeof anfrage.art === 'string' && anfrage.art in ART ? anfrage.art : '';
  const suche = typeof anfrage.q === 'string' ? anfrage.q.trim().slice(0, MELDUNGEN_SUCHE_HOECHSTENS) : '';
  return { art: artWert === '' ? undefined : ART[artWert], suche: suche === '' ? undefined : suche, artWert };
}

export function meldungenAnsicht(zeilen: readonly MeldungZeile[], jetzt: Date): Meldung[] {
  return zeilen.map((zeile) => {
    // Springt die Uhr zurück, liegt die Meldung scheinbar in der Zukunft: Alter null, nie ein negatives.
    const zeit = vorKurz(Math.max(0, Math.floor((jetzt.getTime() - zeile.gemeldetAm.getTime()) / 1000)));
    return {
      titel: zeile.text,
      farbe: zeile.status,
      zeit,
      meta: `${zeit} · ${zeile.name ?? NAME_OHNE_ANZEIGENAME}`,
      intern: zeile.intern,
    };
  });
}

export interface FilterChip {
  readonly text: string;
  readonly href: string;
  readonly aktuell: boolean;
}

/** Die Filter des Prototyps als Links, die die Suche mitnehmen: ohne Skript, jeder Filter ist eine Adresse. */
export function filterChips(filter: MeldungenFilter): FilterChip[] {
  return (
    [
      ['', 'Alle'],
      ['warnung', 'Warnung'],
      ['fehler', 'Fehler'],
      ['info', 'Info'],
    ] as const
  ).map(([art, text]) => {
    const parameter = new URLSearchParams();
    if (art !== '') {
      parameter.set('art', art);
    }
    if (filter.suche !== undefined) {
      parameter.set('q', filter.suche);
    }
    const anfrage = parameter.toString();
    return { text, href: anfrage === '' ? '/meldungen' : `/meldungen?${anfrage}`, aktuell: filter.artWert === art };
  });
}
