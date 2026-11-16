/**
 * Einladungs-Token (Architektur-Vorschlag Abschnitt 7).
 *
 * Gleiches Verfahren wie beim Erststart-Token — 32 Byte Zufall, nur der
 * SHA-256-Hash wird gespeichert, laufzeitkonstanter Vergleich —, aber eine
 * **andere Gültigkeitsdauer: 3 Stunden statt 24**. Eine Einladung geht an
 * ein fremdes Postfach und soll deshalb deutlich kürzer offen stehen als das
 * Konsolen-Token, das nur der Betreiber der Instanz sieht.
 */
import { einmalTokenErzeugen, type EinmalToken } from './einmal-token.js';

export type EinladungsToken = EinmalToken;

/** 3 Stunden — bewusst kürzer als die 24 Stunden des Erststart-Tokens. */
export const EINLADUNG_GUELTIGKEIT_MS = 3 * 60 * 60 * 1000;

export function einladungsTokenErzeugen(jetzt: Date = new Date()): EinladungsToken {
  return einmalTokenErzeugen(EINLADUNG_GUELTIGKEIT_MS, jetzt);
}
