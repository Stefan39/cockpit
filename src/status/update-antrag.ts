/**
 * Der Update-Antrag (COPI-40, ADR 13.1) — reine Funktionen, der Zeitpunkt ist ein Parameter.
 *
 * „Das Cockpit aktualisiert nichts. Es beantragt." Der Betreuer gibt in den Einstellungen einen Ziel-Digest ein,
 * sieht auf einer Bestätigungsseite beide Digests und stellt erst dort den Antrag. Hier stehen die zwei Regeln, die
 * dafür ohne Datenbank gelten:
 *
 *   * **Die Form des Ziel-Digests** ist streng: `sha256:` und 64 Zeichen `0–9a–f`, nichts sonst — kein Tag, keine
 *     Version, kein gekürzter Digest, keine Großbuchstaben, kein Bildname davor. Nur Leerraum an den Rändern fällt
 *     weg, er kommt beim Einfügen oft mit. Die Freigabe lautet auf genau diesen Wert.
 *   * **Die Bestätigung** ist ein HMAC-SHA-256 über Konto, Ziel-Digest, laufenden Digest und Ablauf
 *     (`auth/bestaetigung.ts`, seit COPI-46 für alle Aktionen aus zwei Schritten). Ein fremdes Formular kennt sie
 *     nicht (CSRF); ein nachträglich geändertes Ziel, ein inzwischen anderer laufender Digest oder ein anderes
 *     Konto passen nicht mehr; nach zehn Minuten ist sie verfallen.
 */
import {
  bestaetigungAusstellen as signiertAusstellen,
  bestaetigungPruefen as signiertPruefen,
  type BestaetigungsFelder,
} from '../auth/bestaetigung.js';
import { ZIEL_COMMIT_FORM } from './eingriff.js';
import { DIGEST_FORM } from './instanz.js';

export { BESTAETIGUNG_GUELTIG_MS, type BestaetigungsFelder } from '../auth/bestaetigung.js';

/** Der Ziel-Digest aus einem Formularfeld, oder `undefined`, wenn er nicht genau die verlangte Form hat. */
export function zielDigestAus(wert: unknown): string | undefined {
  if (typeof wert !== 'string') {
    return undefined;
  }
  const digest = wert.trim();
  return DIGEST_FORM.test(digest) ? digest : undefined;
}

/** Wofür eine Bestätigung gilt. */
export interface AntragsDaten {
  readonly kontoId: string;
  readonly ziel: string;
  /** Der laufende Digest, der Weg zurück. */
  readonly vorher: string;
}

/** Der Zweck in der Signatur: eine Bestätigung für etwas anderes gilt hier nicht. */
const ZWECK = 'cockpit-update-antrag';

function inhalt(daten: AntragsDaten): readonly string[] {
  return [daten.kontoId, daten.ziel, daten.vorher];
}

export function bestaetigungAusstellen(schluessel: Uint8Array, daten: AntragsDaten, jetzt: Date): BestaetigungsFelder {
  return signiertAusstellen(schluessel, ZWECK, inhalt(daten), jetzt);
}

/**
 * Gilt die Bestätigung aus dem Formular für genau diesen Antrag, jetzt? Alles, was nicht genau passt, ist ein Nein —
 * auch ein Ablauf, der weiter reicht als die Gültigkeit.
 */
export function bestaetigungPruefen(
  schluessel: Uint8Array,
  felder: { readonly bis?: unknown; readonly token?: unknown },
  daten: AntragsDaten,
  jetzt: Date,
): boolean {
  return signiertPruefen(schluessel, felder, ZWECK, inhalt(daten), jetzt);
}

/**
 * Der Modul-Antrag (COPI-106): der Ziel-Commit in agent-blueprints, 7–40 Zeichen `0–9a–f` — kein Branch, kein Tag, keine
 * Großbuchstaben. Wie beim Digest fällt nur Leerraum an den Rändern weg.
 */
export function zielCommitAus(wert: unknown): string | undefined {
  if (typeof wert !== 'string') {
    return undefined;
  }
  const commit = wert.trim();
  return ZIEL_COMMIT_FORM.test(commit) ? commit : undefined;
}

/** Wofür die Bestätigung eines Modul-Antrags gilt: Konto, Modul, Ziel und die Herkunft davor (der Weg zurück). */
export interface ModulAntragsDaten {
  readonly kontoId: string;
  readonly modul: string;
  readonly ziel: string;
  readonly herkunftVorher: string;
}

/** Ein eigener Zweck: eine Bestätigung für das Image gilt nie für ein Modul und umgekehrt. */
const MODUL_ZWECK = 'modul-update-antrag';

function modulInhalt(daten: ModulAntragsDaten): readonly string[] {
  return [daten.kontoId, daten.modul, daten.ziel, daten.herkunftVorher];
}

export function modulBestaetigungAusstellen(schluessel: Uint8Array, daten: ModulAntragsDaten, jetzt: Date): BestaetigungsFelder {
  return signiertAusstellen(schluessel, MODUL_ZWECK, modulInhalt(daten), jetzt);
}

export function modulBestaetigungPruefen(
  schluessel: Uint8Array,
  felder: { readonly bis?: unknown; readonly token?: unknown },
  daten: ModulAntragsDaten,
  jetzt: Date,
): boolean {
  return signiertPruefen(schluessel, felder, MODUL_ZWECK, modulInhalt(daten), jetzt);
}
