/**
 * Die Agenten-API (COPI-35, Epic E3): der Weg, auf dem der Admin-Agent dem Cockpit meldet, statt dass
 * das Cockpit selbst prüft (Architektur-Vorschlag 4). Maschinell aufgerufen, mit einem Bearer-Token
 * je Zugang — nicht von einem Konto, also ohne Sitzung und ohne zweiten Faktor.
 *
 *   * `token.ts` — Format, Erzeugung, Lesen der Kopfzeile, die Rechte.
 *   * `token-speicher.ts` — die Zugänge in der Datenbank (nur der Hash), Erzeugen und Widerrufen.
 *   * `ratenbegrenzung.ts` — der Zähler im Arbeitsspeicher.
 *   * `zugang.ts` — die Prüfung unter `/intern` und der einzige Weg, dort Routen anzulegen.
 *
 * Die Endpunkte: Befund (`befund.ts`, COPI-36), Inventar (`agenten.ts`, COPI-38), Eingriffe (`eingriffe.ts`, COPI-41),
 * Übernahme-Sperre (`vorgaenge.ts`, COPI-85), KI-Verbrauch (`ki-verbrauch.ts`, COPI-97), Wechselkurs (`wechselkurs.ts`, COPI-99).
 */
export { registriereInternApi } from './zugang.js';
export type { InterneRoute, InterneRoutenErgaenzer, InternerRouter, InternerZugang } from './zugang.js';
