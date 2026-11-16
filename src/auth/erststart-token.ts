/**
 * Erststart-Token (Architektur-Vorschlag Abschnitt 13.2).
 *
 * Nur noch die Festlegungen, die den Erststart von anderen Einmal-Token
 * unterscheiden: Gültigkeit 24 Stunden. Erzeugung, Hashing und Vergleich
 * stehen seit COPI-11 in `einmal-token.ts` und werden von der Einladung
 * mitbenutzt.
 *
 * Zusätzlich entwertet wird ein Erststart-Token durch die erste Nutzung und
 * dadurch, dass überhaupt ein Benutzer existiert — beides liegt im
 * Speicher-Modul.
 */
import { einmalTokenErzeugen, type EinmalToken } from './einmal-token.js';

export {
  tokenHashen,
  tokenHashVergleichen,
  istAbgelaufen,
  TOKEN_LAENGE_BYTES,
} from './einmal-token.js';

export type ErststartToken = EinmalToken;

export const GUELTIGKEIT_MS = 24 * 60 * 60 * 1000;

export function erststartTokenErzeugen(jetzt: Date = new Date()): ErststartToken {
  return einmalTokenErzeugen(GUELTIGKEIT_MS, jetzt);
}
