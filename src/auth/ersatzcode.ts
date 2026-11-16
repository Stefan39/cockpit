/**
 * Ersatzcodes für Konten, deren erster Faktor ein Passkey ist (COPI-26, COPI-27).
 *
 * Die Codes von Better Auth gibt es nur bei aktivem TOTP (gemessen: `TWO_FACTOR_NOT_ENABLED`),
 * deshalb eine eigene Tabelle: `cockpit.ersatzcode` (Migration 0012), nur Argon2id-Hash,
 * jeder Code gilt einmal. Erzeugt werden sie bei der Einrichtung des Passkeys
 * (`passkey.ts`) oder neu auf `/sicherheit` (COPI-94, `faktoren.ts`) und dort **einmal** angezeigt; eingelöst
 * werden sie im zweiten Anmeldeschritt (`routes/anmelden.ts`) und bei der frischen Bestätigung (COPI-94).
 */
import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { passwortPruefen } from './passwort.js';

export const ERSATZCODE_ANZAHL = 10;

/** Ohne die leicht zu verwechselnden Zeichen i, l, o, 0 und 1: die Codes werden abgeschrieben. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** So sieht ein Code aus: zweimal fünf Zeichen. Alles andere ist keiner und kostet keinen Hash. */
const CODE_FORM = /^[a-z0-9]{5}-[a-z0-9]{5}$/;

function ersatzcodeErzeugen(): string {
  const zeichen = Array.from({ length: 10 }, () => CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length)));
  return `${zeichen.slice(0, 5).join('')}-${zeichen.slice(5).join('')}`;
}

/** Zehn verschiedene Codes im Format der Better-Auth-Ersatzcodes (`xxxxx-xxxxx`). */
export function ersatzcodesErzeugen(): string[] {
  const codes = new Set<string>();
  while (codes.size < ERSATZCODE_ANZAHL) {
    codes.add(ersatzcodeErzeugen());
  }
  return [...codes];
}

/**
 * Löst einen Code ein: wahr, wenn er zu einem noch offenen Code des Kontos passt und
 * **dieser Aufruf** ihn verbraucht hat. Zwei gleichzeitige Versuche mit demselben Code
 * bekommen nie beide wahr: das Verbrauchen ist eine einzige bedingte Anweisung.
 *
 * Alle offenen Hashes werden geprüft, auch nach einem Treffer: die Dauer verrät so
 * nicht, an welcher Stelle der Code steht. Es sind höchstens zehn.
 */
export async function ersatzcodeEinloesen(
  pool: pg.Pool,
  benutzerId: string,
  eingabe: string,
): Promise<boolean> {
  const code = eingabe.trim().toLowerCase();
  if (!CODE_FORM.test(code)) {
    return false;
  }
  const offene = await pool.query<{ id: string; code_hash: string }>(
    // Ein entwerteter Code (COPI-94, „Neu erzeugen") ist keiner mehr, auch wenn er nie verbraucht wurde.
    'SELECT id, code_hash FROM cockpit.ersatzcode WHERE benutzer_id = $1 AND verbraucht_am IS NULL AND entwertet_am IS NULL ORDER BY id',
    [benutzerId],
  );
  let treffer: string | undefined;
  for (const zeile of offene.rows) {
    if ((await passwortPruefen({ hash: zeile.code_hash, password: code })) && treffer === undefined) {
      treffer = zeile.id;
    }
  }
  if (treffer === undefined) {
    return false;
  }
  const verbraucht = await pool.query(
    'UPDATE cockpit.ersatzcode SET verbraucht_am = now() WHERE id = $1 AND verbraucht_am IS NULL AND entwertet_am IS NULL RETURNING id',
    [treffer],
  );
  return verbraucht.rowCount === 1;
}
