/**
 * Das Bild der Übersicht aus den Wachen (COPI-37) — reine Funktionen, der Zeitpunkt ist ein Parameter.
 *
 * Zwei Sichten mit **getrennten Eingaben**:
 *
 *   * **Kunde** (Betriebs-Admin, Mitarbeiter): `KundenZeile` kennt nur den **kundensichtbaren** Befund
 *     einer Wache. Ein Rohbefund kann in dieser Sicht nicht vorkommen, weil die Eingabe gar kein Feld
 *     dafür hat — nicht, weil eine Bedingung ihn wegfiltert. Auch die Farbe und „zuletzt geprüft" kommen
 *     aus diesem einen Befund: ein interner Befund kann die Kundenseite nicht verändern (Architektur-
 *     Vorschlag 4 und 10: der Kunde sieht nie den Rohbefund). Die Abfrage liefert dieser Sicht nicht einmal
 *     eine Wache ohne sichtbaren Befund (`uebersicht-speicher.ts`).
 *   * **Betreuer**: alle Wachen, mit dem letzten Befund gleich welcher Sichtbarkeit.
 *
 * Das Cockpit **übersetzt nichts**: der Text einer Kachel ist der Klartext, den der Schreiber des Befunds
 * mitgeliefert hat (später der Koordinator, E4). Nur die Sätze der Statuskarte und die Statuswörter sind
 * Oberflächentext des Cockpits. Die Farbe folgt `wachenZustand`: ausbleibende Wache gelb, gemeldetes Rot
 * bleibt rot.
 */
import type { Messwert } from './messwert.js';
import { wachenZustand, type BefundStatus } from './zustand.js';

/** Wie eine Kachel den Zustand nennt. Farbe allein ist keine Auskunft (WCAG 1.4.1), das Wort steht daneben. */
export const STATUS_WORT: Readonly<Record<BefundStatus, string>> = {
  gruen: 'Läuft',
  gelb: 'Achtung',
  rot: 'Störung',
};

/** Wie der Kunde eine Wache nennt, für die der Agent keinen Anzeigenamen geliefert hat — nie die Kennung. */
export const NAME_OHNE_ANZEIGENAME = 'Bereich';

/** Die Sortierung: die schwerste Farbe zuerst. */
const SCHWERE: Readonly<Record<BefundStatus, number>> = { rot: 0, gelb: 1, gruen: 2 };

/** Der jüngste kundensichtbare Befund einer Wache. */
export interface SichtbarerBefund {
  readonly status: BefundStatus;
  readonly textKunde: string;
  readonly gemeldetAm: Date;
  /** Der Messwert genau dieses Befunds (COPI-83); `undefined`: ohne Messwert. */
  readonly messwert?: Messwert | undefined;
}

/** Eine Wache, wie die Kundensicht sie kennt. */
export interface KundenZeile {
  readonly kennung: string;
  readonly anzeigename: string | undefined;
  readonly taktSekunden: number;
  readonly sichtbar: SichtbarerBefund;
}

/** Der jüngste Befund einer Wache, gleich welcher Sichtbarkeit. */
export interface LetzterBefund {
  readonly status: BefundStatus;
  readonly textIntern: string;
  readonly textKunde: string | undefined;
  readonly kundensichtbar: boolean;
  readonly gemeldetAm: Date;
}

/** Eine Wache, wie die Betreuersicht sie kennt. */
export interface BetreuerZeile {
  readonly kennung: string;
  readonly anzeigename: string | undefined;
  readonly taktSekunden: number;
  readonly letzterLauf: Date | undefined;
  readonly letzter: LetzterBefund | undefined;
}

/** Eine Kachel der Kundensicht: genau diese Felder, kein Feld für Kennung, Rohbefund oder Herkunft. */
export interface Kachel {
  readonly name: string;
  readonly farbe: BefundStatus;
  readonly statusWort: string;
  readonly text: string;
  /** Die kurze Form des Prototyps, etwa: vor 4 Min. geprüft (COPI-43). */
  readonly geprueft: string;
  readonly ueberfaellig: boolean;
  /** Nur in der Kundensicht: der Messwert des jüngsten kundensichtbaren Befunds (COPI-83, `GET /intern/zustand`). */
  readonly messwert?: Messwert | undefined;
}

/** Eine Kachel der Betreuersicht: dazu die Kennung und ob der Kunde den Befund sieht. */
export interface BetreuerKachel extends Kachel {
  readonly kennung: string;
  /** `undefined`: die Wache hat noch keinen Befund gemeldet. */
  readonly kundensichtbar: boolean | undefined;
  /** Der Klartext, den der Kunde zu diesem Befund sähe (oder sehen wird, sobald er freigegeben ist). */
  readonly kundenText: string | undefined;
}

export type StatusFarbe = BefundStatus | 'leer';

/** Die Karte oben: ein Satz, und der Text der Kachel, die ihn ausgelöst hat. */
export interface StatusKarte {
  readonly farbe: StatusFarbe;
  readonly satz: string;
  readonly detail: string;
}

export interface KundenUebersicht {
  readonly status: StatusKarte;
  readonly kacheln: readonly Kachel[];
}

export interface BetreuerUebersicht {
  readonly status: StatusKarte;
  readonly kacheln: readonly BetreuerKachel[];
}

interface Sortierbar<T> {
  readonly kachel: T;
  readonly kennung: string;
}

/** Schwerste Farbe zuerst, dann nach Namen (deutsche Sortierung), zuletzt nach Kennung: die Reihenfolge ist nie zufällig. */
function sortieren<T extends Kachel>(eintraege: readonly Sortierbar<T>[]): T[] {
  return [...eintraege]
    .sort(
      (a, b) =>
        SCHWERE[a.kachel.farbe] - SCHWERE[b.kachel.farbe] ||
        a.kachel.name.localeCompare(b.kachel.name, 'de') ||
        (a.kennung < b.kennung ? -1 : a.kennung > b.kennung ? 1 : 0),
    )
    .map((eintrag) => eintrag.kachel);
}

function sache(anzahl: number, einzahl: string, mehrzahl: string): string {
  return `${String(anzahl)} ${anzahl === 1 ? einzahl : mehrzahl}`;
}

/**
 * Der Satz der Karte. Sie meldet Rot als „braucht Ihre Aufmerksamkeit", Gelb als „im Blick" und nur bei
 * lauter Grün „Alles läuft". Ohne eine einzige Kachel behauptet sie nichts. Der Text darunter ist der
 * der ersten Kachel der schwersten Farbe — das Cockpit erfindet keinen.
 */
function statusKarte(kacheln: readonly Kachel[]): StatusKarte {
  const anzahl = kacheln.length;
  if (anzahl === 0) {
    return { farbe: 'leer', satz: 'Noch keine Meldungen', detail: 'Sobald der Betrieb meldet, erscheint hier der Stand.' };
  }
  const rot = kacheln.filter((kachel) => kachel.farbe === 'rot');
  const gelb = kacheln.filter((kachel) => kachel.farbe === 'gelb');
  const erste = rot[0] ?? gelb[0];
  if (rot.length > 0 && erste) {
    const brauchen = rot.length === 1 ? 'braucht' : 'brauchen';
    return { farbe: 'rot', satz: `${sache(rot.length, 'Sache', 'Sachen')} ${brauchen} Ihre Aufmerksamkeit`, detail: erste.text };
  }
  if (gelb.length > 0 && erste) {
    return { farbe: 'gelb', satz: `Alles läuft, ${sache(gelb.length, 'Sache', 'Sachen')} im Blick`, detail: erste.text };
  }
  return {
    farbe: 'gruen',
    satz: 'Alles läuft',
    detail: anzahl === 1 ? 'Der gemeldete Bereich ist in Ordnung.' : `Alle ${String(anzahl)} gemeldeten Bereiche sind in Ordnung.`,
  };
}

export function kundenUebersicht(zeilen: readonly KundenZeile[], jetzt: Date): KundenUebersicht {
  const kacheln = sortieren(
    zeilen.map((zeile): Sortierbar<Kachel> => {
      // Der Herzschlag ist hier der des sichtbaren Befunds: ein interner Befund ändert die Kundenseite nicht.
      const zustand = wachenZustand(
        { taktSekunden: zeile.taktSekunden, letzterLauf: zeile.sichtbar.gemeldetAm, letzterStatus: zeile.sichtbar.status },
        jetzt,
      );
      return {
        kennung: zeile.kennung,
        kachel: {
          name: zeile.anzeigename ?? NAME_OHNE_ANZEIGENAME,
          farbe: zustand.farbe,
          statusWort: STATUS_WORT[zustand.farbe],
          text: zeile.sichtbar.textKunde,
          geprueft: zustand.geprueftKurz,
          ueberfaellig: zustand.ueberfaellig,
          messwert: zeile.sichtbar.messwert,
        },
      };
    }),
  );
  return { status: statusKarte(kacheln), kacheln };
}

export function betreuerUebersicht(zeilen: readonly BetreuerZeile[], jetzt: Date): BetreuerUebersicht {
  const kacheln = sortieren(
    zeilen.map((zeile): Sortierbar<BetreuerKachel> => {
      // Der Betreuer sieht den Herzschlag der Wache selbst: jeder Befund zählt, auch ein interner.
      const zustand = wachenZustand(
        { taktSekunden: zeile.taktSekunden, letzterLauf: zeile.letzterLauf, letzterStatus: zeile.letzter?.status },
        jetzt,
      );
      return {
        kennung: zeile.kennung,
        kachel: {
          name: zeile.anzeigename ?? zeile.kennung,
          kennung: zeile.kennung,
          farbe: zustand.farbe,
          statusWort: STATUS_WORT[zustand.farbe],
          text: zeile.letzter?.textIntern ?? 'Noch kein Befund gemeldet.',
          geprueft: zustand.geprueftKurz,
          ueberfaellig: zustand.ueberfaellig,
          kundensichtbar: zeile.letzter?.kundensichtbar,
          kundenText: zeile.letzter?.textKunde,
        },
      };
    }),
  );
  return { status: statusKarte(kacheln), kacheln };
}
