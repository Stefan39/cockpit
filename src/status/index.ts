/**
 * Das Zustandsbild (Epic E3, Architektur-Vorschlag 4): das Cockpit **prüft nichts selbst**, es zeigt, was
 * der Admin-Agent meldet — Befunde und den Herzschlag der Wachen aus `cockpit.befund` und `cockpit.wache`.
 *
 *   * `zustand.ts` — reine Funktion: aus Takt, letztem Lauf und letztem Befund den Zustand einer Wache
 *     (überfällig, Farbe, „zuletzt geprüft vor …"). COPI-36.
 *   * `befund-speicher.ts` — Befund und Herzschlag in einer Transaktion schreiben. COPI-36.
 *   * `uebersicht.ts` — das Bild der Übersicht: zwei Sichten (Kunde, Betreuer) mit getrennten Eingaben. COPI-37.
 *   * `uebersicht-speicher.ts` — die Abfragen dazu; die Kundensicht lädt keinen Rohbefund. COPI-37.
 *
 * Angenommen werden die Meldungen über die Agenten-API (`src/intern`); die Übersicht liest sie.
 */
export { befundMelden } from './befund-speicher.js';
export type { BefundErgebnis, BefundMeldung } from './befund-speicher.js';
export { BEFUND_STATUS, toleranzSekunden, wachenZustand } from './zustand.js';
export type { BefundStatus, WachenStand, WachenZustand } from './zustand.js';
export { betreuerUebersicht, kundenUebersicht } from './uebersicht.js';
export type { BetreuerKachel, BetreuerUebersicht, Kachel, KundenUebersicht, StatusKarte } from './uebersicht.js';
export { betreuerWachenLesen, kundenWachenLesen } from './uebersicht-speicher.js';
