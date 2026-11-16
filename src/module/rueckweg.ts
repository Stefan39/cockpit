/**
 * Der Rückweg einer Unterseite (COPI-100): der runde Zurück-Knopf links neben dem Titel, wie im Prototyp
 * (`views/partials/seiten-kopf.eta`, Angabe `zurueck`). Auf dem Telefon gibt es in der installierten App keine Browserleiste —
 * ohne diesen Knopf ist eine Unterseite eine Sackgasse. Am Desktop führen Sidebar, Brotkrume und Listenspalte zurück.
 *
 * Wer von einer Karte der Übersicht kommt, will dorthin zurück: deren Links tragen `?von=uebersicht`. Nur dieser eine
 * Wert zählt; alles andere ergibt den gewöhnlichen Rückweg — der Parameter ist kein Ziel, sondern eine Herkunft, und
 * kann deshalb nie auf eine fremde Seite führen.
 */

export interface Rueckweg {
  readonly href: string;
  /** Wohin es zurückgeht, für die Beschriftung „Zurück zu …". */
  readonly ziel: string;
}

/** Der Wert von `von`, den die Karten der Übersicht anhängen. */
export const VON_UEBERSICHT = 'uebersicht';

export const ZURUECK_UEBERSICHT: Rueckweg = { href: '/', ziel: 'Übersicht' };
export const ZURUECK_MODULE: Rueckweg = { href: '/module', ziel: 'Module' };

/** Der Link einer Übersichtskarte: dasselbe Ziel, mit der Herkunft. */
export function vonUebersicht(href: string): string {
  return `${href}${href.includes('?') ? '&' : '?'}von=${VON_UEBERSICHT}`;
}

/** Der Rückweg zur Übersicht, wenn die Seite von dort kam; sonst der gewöhnliche. */
export function rueckwegMitHerkunft(standard: Rueckweg, von: unknown): Rueckweg {
  return von === VON_UEBERSICHT ? ZURUECK_UEBERSICHT : standard;
}
