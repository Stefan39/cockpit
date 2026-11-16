/**
 * Einmal-Token — die gemeinsame Grundlage von Erststart-Token (COPI-10) und
 * Einladungs-Token (COPI-11).
 *
 * Der Inhalt dieser Datei stand bis COPI-11 in `erststart-token.ts`; er ist
 * hierher gezogen, damit die Einladung dieselbe Erzeugung, dasselbe Hashing
 * und denselben Vergleich benutzt statt einer zweiten, leicht abweichenden
 * Kopie. Unterschiedlich ist zwischen den beiden Token-Arten allein die
 * Gültigkeitsdauer — sie ist deshalb Parameter, nicht Konstante.
 *
 * Reine Funktionen ohne Datenbank- und ohne Fastify-Bezug, damit Erzeugung,
 * Hashing, Vergleich und Ablauf ohne echte Postgres testbar sind.
 *
 * Grundregeln:
 * - 32 Byte kryptographisch zufällig (`crypto.randomBytes`), base64url-kodiert,
 *   damit der Wert ohne Kodierung in einen Pfad passt.
 * - Gespeichert wird **nur** der SHA-256-Hash, nie das Token selbst.
 * - Der Vergleich läuft laufzeitkonstant über `crypto.timingSafeEqual`.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const TOKEN_LAENGE_BYTES = 32;

export interface EinmalToken {
  /** Klartext-Token — nur für die einmalige Ausgabe (stdout bzw. E-Mail). */
  readonly token: string;
  /** SHA-256-Hex des Tokens — nur dieser Wert wird gespeichert. */
  readonly hash: string;
  readonly ablaufAm: Date;
}

export function tokenHashen(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function einmalTokenErzeugen(
  gueltigkeitMs: number,
  jetzt: Date = new Date(),
): EinmalToken {
  const token = randomBytes(TOKEN_LAENGE_BYTES).toString('base64url');
  return {
    token,
    hash: tokenHashen(token),
    ablaufAm: new Date(jetzt.getTime() + gueltigkeitMs),
  };
}

/**
 * Laufzeitkonstanter Vergleich zweier Hex-Hashes. Ungleiche Längen können
 * nicht laufzeitkonstant verglichen werden — sie bedeuten hier ohnehin einen
 * formal ungültigen Wert und werden vorab abgewiesen.
 */
export function tokenHashVergleichen(einer: string, anderer: string): boolean {
  const a = Buffer.from(einer, 'hex');
  const b = Buffer.from(anderer, 'hex');
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function istAbgelaufen(ablaufAm: Date, jetzt: Date = new Date()): boolean {
  return ablaufAm.getTime() <= jetzt.getTime();
}

/**
 * Die gefundene Zeile eines Einmal-Links, wenn sie gilt: vorhanden, derselbe Hash (laufzeitkonstant verglichen) und nicht
 * abgelaufen — sonst `undefined`. Für Wiederherstellung und Adressbestätigung (COPI-28, COPI-47).
 */
export function gueltigeZeile<T extends { readonly token_hash: string; readonly ablauf_am: Date }>(
  zeile: T | undefined,
  hash: string,
  jetzt: Date,
): T | undefined {
  return zeile !== undefined && tokenHashVergleichen(hash, zeile.token_hash) && !istAbgelaufen(zeile.ablauf_am, jetzt) ? zeile : undefined;
}
