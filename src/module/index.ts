/**
 * Modulseiten datengetrieben (Epic E5, Architektur-Vorschlag „Modulseiten sind deklariert, nicht
 * programmiert"): die Registry `cockpit.modul` (Migration 0028), fünf Ansichtstypen (bisher nur
 * Liste+Detail umgesetzt), der Vertrag zum Fachmodul über eine SQL-View mit festen Spaltennamen.
 *
 *   * `block.ts` — der `cockpit:`-Block einer Blueprint-YAML: Schema, Wrapper-Regel, YAML-Text → Block
 *     (COPI-77).
 *   * `registry.ts` — die Katalogprüfung gegen die Datenbank: View, Pflichtspalten, `text_intern` nur
 *     für den Betreuer (COPI-77).
 *   * `modul-speicher.ts` — Einspielen (in einer Transaktion, mit Versionierung) und Lesen der aktiven
 *     Module (COPI-77).
 *
 *   * `zeitraster.ts`, `uebersicht-karten.ts`, `uebersicht-lesen.ts` — die Karten der Übersicht aus dem
 *     optionalen Abschnitt `uebersicht:` (COPI-81): Stunden-Eimer, Dashboard-Modell, Lesen mit Verlauf.
 *
 * Die Oberfläche der Modulseiten selbst (Navigation, Routen je Ansichtstyp) ist ein späteres Ticket
 * (COPI-78 und folgende): `aktiveModule` ist schon die Lesefunktion, die es dafür braucht.
 */
export {
  ANSICHT_LISTE_DETAIL,
  ANSICHTSTYPEN,
  PFLICHTSPALTEN_LISTE_DETAIL,
  PFLICHTSPALTEN_VERLAUF,
  SPALTEN_FORMATE,
  modulBlockAusText,
  modulBlockEntpacken,
  modulBlockPruefen,
} from './block.js';
export type { Ansichtstyp, ModulBlock, ModulUebersicht, ModulBlockErgebnis, ModulSpalte, SpaltenFormat } from './block.js';
export { hinweiseViewPruefen, katalogPruefen, kennzahlenViewPruefen, modulViewPruefen, verlaufViewPruefen } from './registry.js';
export type { KatalogErgebnis } from './registry.js';
export { aktiveModule, modulEinspielen, pruefsummeBerechnen } from './modul-speicher.js';
export type { AktivesModul, ModulEinspielenEingabe, ModulEinspielenErgebnis } from './modul-speicher.js';
