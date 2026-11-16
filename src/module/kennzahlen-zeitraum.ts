/**
 * Die Zeiträume einer Kennzahlen-Seite (COPI-98) — reine Funktionen auf Kalendertagen `YYYY-MM-DD`. Der Tag ist der
 * Berliner Kalendertag; gerechnet wird in UTC-Mitternacht, damit eine Umstellung der Sommerzeit keinen Tag
 * verschiebt.
 *
 * Jeder Zeitraum hat einen **Vergleich**: bei „Heute", „7 Tage" und „30 Tage" die gleich langen Tage unmittelbar
 * davor, bei „Monat" der Vormonat bis zum selben Tag, bei „Vormonat" der Monat davor.
 */

export const ZEITRAEUME = ['heute', '7', '30', 'monat', 'vormonat'] as const;

export type ZeitraumName = (typeof ZEITRAEUME)[number];

/** Ohne Angabe (oder mit einer unbekannten) zeigt die Seite die letzten 30 Tage. */
export const ZEITRAUM_STANDARD: ZeitraumName = '30';

export const ZEITRAUM_TEXT: Readonly<Record<ZeitraumName, string>> = {
  heute: 'Heute',
  '7': '7 Tage',
  '30': '30 Tage',
  monat: 'Monat',
  vormonat: 'Vormonat',
};

/** Tage von … bis, beide einschließlich. */
export interface Spanne {
  readonly von: string;
  readonly bis: string;
}

export interface Zeitraum {
  readonly name: ZeitraumName;
  readonly spanne: Spanne;
  readonly vergleich: Spanne;
  /** Wie der Vergleich heißt: „Zeitraum davor" oder „Vormonat". */
  readonly vergleichText: string;
}

const TAG_MS = 24 * 60 * 60 * 1000;

function zeit(tag: string): number {
  return Date.parse(`${tag}T00:00:00Z`);
}

function tagAus(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Der Tag `tage` Tage nach `tag` (negativ: davor). */
export function tagPlus(tag: string, tage: number): string {
  return tagAus(zeit(tag) + tage * TAG_MS);
}

/** Alle Tage der Spanne, aufsteigend. */
export function tageDer(spanne: Spanne): string[] {
  const anzahl = Math.round((zeit(spanne.bis) - zeit(spanne.von)) / TAG_MS) + 1;
  return Array.from({ length: Math.max(0, anzahl) }, (_, nummer) => tagPlus(spanne.von, nummer));
}

/** Der Erste des Monats, `monate` Monate vom Monat des Tages entfernt. */
function monatsErster(tag: string, monate: number): string {
  const datum = new Date(zeit(tag));
  return tagAus(Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth() + monate, 1));
}

/** Der letzte Tag des Monats, in dem `erster` liegt. */
function monatsLetzter(erster: string): string {
  return tagPlus(monatsErster(erster, 1), -1);
}

export function istZeitraum(wert: unknown): wert is ZeitraumName {
  return typeof wert === 'string' && (ZEITRAEUME as readonly string[]).includes(wert);
}

/** Der Zeitraum zum Namen, gerechnet vom heutigen Berliner Kalendertag aus. */
export function zeitraumAus(name: ZeitraumName, heute: string): Zeitraum {
  const davor = (spanne: Spanne): Spanne => {
    const laenge = tageDer(spanne).length;
    return { von: tagPlus(spanne.von, -laenge), bis: tagPlus(spanne.von, -1) };
  };
  switch (name) {
    case 'heute': {
      const spanne = { von: heute, bis: heute };
      return { name, spanne, vergleich: davor(spanne), vergleichText: 'Gestern' };
    }
    case '7':
    case '30': {
      const spanne = { von: tagPlus(heute, 1 - Number(name)), bis: heute };
      return { name, spanne, vergleich: davor(spanne), vergleichText: 'Zeitraum davor' };
    }
    case 'monat': {
      const spanne = { von: monatsErster(heute, 0), bis: heute };
      const vormonat = monatsErster(heute, -1);
      // Bis zum selben Tag des Vormonats — am 31. bis zu dessen letztem Tag.
      const selberTag = tagPlus(vormonat, tageDer(spanne).length - 1);
      const letzter = monatsLetzter(vormonat);
      return { name, spanne, vergleich: { von: vormonat, bis: selberTag < letzter ? selberTag : letzter }, vergleichText: 'Vormonat bis zum selben Tag' };
    }
    case 'vormonat': {
      const von = monatsErster(heute, -1);
      const davorVon = monatsErster(heute, -2);
      return { name, spanne: { von, bis: monatsLetzter(von) }, vergleich: { von: davorVon, bis: monatsLetzter(davorVon) }, vergleichText: 'Monat davor' };
    }
  }
}

/** Der laufende Monat bis heute, der ganze Vormonat und die letzten 30 Tage — was die Karte der Übersicht zeigt. */
export function kartenSpannen(heute: string): { readonly monat: Spanne; readonly vormonat: Spanne; readonly verlauf: Spanne } {
  const vormonat = monatsErster(heute, -1);
  return {
    monat: { von: monatsErster(heute, 0), bis: heute },
    vormonat: { von: vormonat, bis: monatsLetzter(vormonat) },
    verlauf: { von: tagPlus(heute, -29), bis: heute },
  };
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** „September" — der Monat des Tages. */
export function monatsName(tag: string): string {
  return MONATE[Number(tag.slice(5, 7)) - 1] ?? '';
}

/** „30.09." — für Achsen. */
export function tagKurz(tag: string): string {
  return `${tag.slice(8, 10)}.${tag.slice(5, 7)}.`;
}

/** „30.09.2026". */
export function tagLang(tag: string): string {
  return `${tagKurz(tag)}${tag.slice(0, 4)}`;
}
