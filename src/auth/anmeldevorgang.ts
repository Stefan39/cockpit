/**
 * Der kurzlebige Anmeldevorgang zwischen Passwort- und Codeschritt (COPI-13).
 *
 * Er hat genau eine Aufgabe: dem Codeschritt sagen, **für welches Konto** er
 * läuft. Nur damit lassen sich dessen Fehlversuche einem Konto zuordnen, ohne
 * in Better-Auth-Interna zu greifen (der `two_factor`-Cookie ist signiert und
 * verweist auf einen Verifikationsdatensatz, den wir nicht auslesen wollen).
 *
 * Der Vorgang **autorisiert nichts**. Die Anmeldung schließt allein Better Auth
 * ab, gegen seinen eigenen signierten `two_factor`-Cookie. Wer diesen Cookie
 * nicht hat, kommt auch mit einem gültigen Anmeldevorgang nicht weiter.
 *
 * Verfahren wie bei Erststart- und Einladungs-Token (`einmal-token.ts`):
 * 32 Byte Zufall, gespeichert wird nur der SHA-256-Hash, der Klartext lebt
 * ausschließlich im Cookie. Gültigkeit 10 Minuten — dieselbe Spanne, die
 * Better Auth seinem `two_factor`-Cookie gibt (600 s), damit nicht die eine
 * Hälfte länger gilt als die andere.
 */
import type pg from 'pg';
import { einmalTokenErzeugen, tokenHashVergleichen, tokenHashen } from './einmal-token.js';
import { COOKIE_PRAEFIX } from './konfiguration.js';

/** 10 Minuten — passend zum `two_factor`-Cookie von Better Auth. */
export const ANMELDEVORGANG_GUELTIGKEIT_MS = 10 * 60 * 1000;

/**
 * Name wie bei den Better-Auth-Cookies: `__Host-`-Präfix, damit der Cookie
 * host-only ist und von keiner anderen Herkunft gesetzt werden kann.
 */
export const ANMELDEVORGANG_COOKIE_NAME = `${COOKIE_PRAEFIX}.anmeldevorgang`;

/**
 * Attribute genau wie beim Sitzungs-Cookie (siehe `konfiguration.ts`):
 * `__Host-` verlangt `Secure` und `Path=/` und verträgt kein `Domain`.
 */
const COOKIE_ATTRIBUTE = 'Path=/; HttpOnly; Secure; SameSite=Lax';

export function anmeldevorgangCookie(token: string): string {
  const sekunden = String(ANMELDEVORGANG_GUELTIGKEIT_MS / 1000);
  return `${ANMELDEVORGANG_COOKIE_NAME}=${token}; ${COOKIE_ATTRIBUTE}; Max-Age=${sekunden}`;
}

export function anmeldevorgangCookieLoeschen(): string {
  return `${ANMELDEVORGANG_COOKIE_NAME}=; ${COOKIE_ATTRIBUTE}; Max-Age=0`;
}

/**
 * Liest einen Cookie-Wert aus der Kopfzeile. Bewusst ohne zusätzliche
 * Abhängigkeit: es geht um genau einen eigenen Cookie, dessen Wert
 * base64url-kodiert ist und deshalb keine Sonderzeichen enthält.
 */
export function cookieLesen(kopf: string | undefined, name: string): string | undefined {
  for (const eintrag of (kopf ?? '').split(';')) {
    const trenner = eintrag.indexOf('=');
    if (trenner < 0) {
      continue;
    }
    if (eintrag.slice(0, trenner).trim() === name) {
      const wert = eintrag.slice(trenner + 1).trim();
      return wert.length > 0 ? wert : undefined;
    }
  }
  return undefined;
}

/**
 * Legt den Vorgang an und entwertet dabei jeden offenen Vorgang desselben
 * Kontos — ein zweiter Anmeldeversuch soll den ersten ablösen, nicht neben ihm
 * stehen. Liefert das Klartext-Token für den Cookie zurück.
 */
export async function anmeldevorgangAnlegen(
  pool: pg.Pool,
  benutzerId: string,
  jetzt: Date,
): Promise<string> {
  const token = einmalTokenErzeugen(ANMELDEVORGANG_GUELTIGKEIT_MS, jetzt);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE cockpit.anmeldevorgang SET verbraucht_am = now() WHERE benutzer_id = $1 AND verbraucht_am IS NULL',
      [benutzerId],
    );
    await client.query(
      'INSERT INTO cockpit.anmeldevorgang (kennung_hash, benutzer_id, ablauf_am) VALUES ($1, $2, $3)',
      [token.hash, benutzerId, token.ablaufAm],
    );
    await client.query('COMMIT');
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
  return token.token;
}

/** Konto zu einem offenen, nicht abgelaufenen Vorgang — sonst `undefined`. */
export async function anmeldevorgangLesen(
  pool: pg.Pool,
  token: string,
  jetzt: Date,
): Promise<string | undefined> {
  const hash = tokenHashen(token);
  const ergebnis = await pool.query<{ benutzer_id: string; kennung_hash: string }>(
    `SELECT benutzer_id, kennung_hash
       FROM cockpit.anmeldevorgang
      WHERE kennung_hash = $1
        AND verbraucht_am IS NULL
        AND ablauf_am > $2
      LIMIT 1`,
    [hash, jetzt],
  );
  const zeile = ergebnis.rows[0];
  if (!zeile || !tokenHashVergleichen(hash, zeile.kennung_hash)) {
    return undefined;
  }
  return zeile.benutzer_id;
}

/**
 * Entwertet den Vorgang endgültig. Eine einzelne bedingte UPDATE-Anweisung,
 * damit derselbe Vorgang auch bei gleichzeitigen Anfragen höchstens einmal
 * wirkt.
 */
export async function anmeldevorgangVerbrauchen(
  pool: pg.Pool,
  token: string,
): Promise<boolean> {
  const ergebnis = await pool.query(
    `UPDATE cockpit.anmeldevorgang
        SET verbraucht_am = now()
      WHERE kennung_hash = $1
        AND verbraucht_am IS NULL
      RETURNING id`,
    [tokenHashen(token)],
  );
  return ergebnis.rowCount === 1;
}

/**
 * Konto-ID zu einer bereits normalisierten Adresse. Sie wird erst **nach**
 * erfolgreicher Passwortprüfung gebraucht — für den Anmeldevorgang, der dem
 * Codeschritt sein Konto nennt. Vorher gefragt wäre sie eine Kontoauskunft.
 */
export async function benutzerIdZuEmail(
  pool: pg.Pool,
  email: string,
): Promise<string | undefined> {
  const ergebnis = await pool.query<{ id: string }>(
    'SELECT id FROM cockpit."user" WHERE lower(email) = $1 LIMIT 1',
    [email],
  );
  return ergebnis.rows[0]?.id;
}

/** Entfernt abgelaufene und verbrauchte Vorgänge. */
export async function anmeldevorgaengeAufraeumen(
  pool: pg.Pool,
  jetzt: Date,
): Promise<number> {
  const ergebnis = await pool.query(
    'DELETE FROM cockpit.anmeldevorgang WHERE ablauf_am <= $1 OR verbraucht_am IS NOT NULL',
    [jetzt],
  );
  return ergebnis.rowCount ?? 0;
}
