/**
 * Datenbankseite des Erststart-Tokens (Architektur-Vorschlag Abschnitt 13.2).
 *
 * Gültig ist ein Token nur, solange alle drei Bedingungen halten:
 *   1. es ist noch nicht verbraucht,
 *   2. es ist nicht älter als 24 Stunden,
 *   3. es existiert noch kein Benutzer.
 * Die dritte Bedingung ist die wichtigste: sobald ein Konto besteht, ist jedes
 * jemals ausgegebene Token wertlos — auch ein abgefangenes.
 */
import type pg from 'pg';
import { kontoAlsGeloeschtMarkieren, unbrauchbarerPasswortHash } from './konto-loeschen.js';
import { protokollSchreiben } from './protokoll.js';
import {
  erststartTokenErzeugen,
  istAbgelaufen,
  tokenHashVergleichen,
  tokenHashen,
  type ErststartToken,
} from './erststart-token.js';

interface TokenZeile {
  readonly id: string;
  readonly token_hash: string;
  readonly ablauf_am: Date;
}

export async function benutzerVorhanden(pool: pg.Pool): Promise<boolean> {
  const ergebnis = await pool.query<{ vorhanden: boolean }>(
    // Als gelöscht markierte Konten zählen nicht (COPI-62): sie bleiben nur als Nachweis im Bestand.
    'SELECT EXISTS (SELECT 1 FROM cockpit."user" WHERE geloescht_am IS NULL) AS vorhanden',
  );
  return ergebnis.rows[0]?.vorhanden === true;
}

/**
 * Entwertet alle noch offenen Token und legt genau ein neues an — beides in
 * einer Transaktion, damit nie zwei offene Token nebeneinander existieren.
 * Liefert das Klartext-Token zurück; es wird ausschließlich auf stdout
 * ausgegeben und nirgends gespeichert.
 *
 * Das Ereignis steht im Protokoll (COPI-23/24), in derselben Transaktion und ohne
 * das Token: `system` beim Start der Anwendung, `konsole` beim Server-Kommando.
 */
export async function neuesErststartTokenAnlegen(
  pool: pg.Pool,
  jetzt: Date = new Date(),
  akteur: 'system' | 'konsole' = 'system',
): Promise<ErststartToken> {
  const token = erststartTokenErzeugen(jetzt);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE cockpit.erststart_token SET verbraucht_am = now() WHERE verbraucht_am IS NULL',
    );
    await client.query(
      'INSERT INTO cockpit.erststart_token (token_hash, ablauf_am) VALUES ($1, $2)',
      [token.hash, token.ablaufAm],
    );
    await protokollSchreiben(client, { art: 'erststart_token_erzeugt', akteur });
    await client.query('COMMIT');
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
  return token;
}

/**
 * Prüft ein vorgelegtes Token, ohne es zu entwerten (für die Anzeige des
 * Formulars). Der Hash-Vergleich läuft laufzeitkonstant.
 */
export async function tokenPruefen(
  pool: pg.Pool,
  token: string,
  jetzt: Date = new Date(),
): Promise<{ gueltig: boolean; id?: string }> {
  if (await benutzerVorhanden(pool)) {
    return { gueltig: false };
  }
  const ergebnis = await pool.query<TokenZeile>(
    `SELECT id::text AS id, token_hash, ablauf_am
       FROM cockpit.erststart_token
      WHERE verbraucht_am IS NULL
      ORDER BY erstellt_am DESC
      LIMIT 1`,
  );
  const zeile = ergebnis.rows[0];
  if (!zeile) {
    return { gueltig: false };
  }
  if (!tokenHashVergleichen(tokenHashen(token), zeile.token_hash)) {
    return { gueltig: false };
  }
  if (istAbgelaufen(zeile.ablauf_am, jetzt)) {
    return { gueltig: false };
  }
  return { gueltig: true, id: zeile.id };
}

/**
 * Entwertet das Token endgültig. Eine einzelne bedingte UPDATE-Anweisung —
 * dadurch kann dasselbe Token auch bei gleichzeitigen Anfragen höchstens
 * einmal eingelöst werden (`rowCount === 1` gewinnt, alle anderen bekommen 0).
 */
export async function tokenEinloesen(pool: pg.Pool, id: string): Promise<boolean> {
  const ergebnis = await pool.query(
    `UPDATE cockpit.erststart_token
        SET verbraucht_am = now()
      WHERE id = $1
        AND verbraucht_am IS NULL
        AND ablauf_am > now()
        AND NOT EXISTS (SELECT 1 FROM cockpit."user" WHERE geloescht_am IS NULL)
      RETURNING id`,
    [id],
  );
  return ergebnis.rowCount === 1;
}

/**
 * Nimmt ein eben angelegtes Erststart-Konto zurück, wenn die Rollenvergabe danach
 * scheiterte (COPI-22). Ohne das bliebe ein Konto ohne Betreuerrolle stehen, und
 * der Erststart ließe sich erst nach Ablauf des 72-h-Verfalls wiederholen.
 *
 * Nie physisch gelöscht, nur als gelöscht markiert (COPI-62, `geloescht_von: erststart`);
 * danach zählt es für den Erststart nicht mehr. Bedingt auf „nie aktiviert": ein Konto
 * mit aktivem zweitem Faktor wird hier nie angefasst, gleich was aufgerufen wird.
 */
export async function unfertigesKontoEntfernen(pool: pg.Pool, benutzerId: string): Promise<void> {
  const passwortHash = await unbrauchbarerPasswortHash();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const unfertig = await client.query('SELECT 1 FROM cockpit."user" WHERE id = $1 AND aktiviert_am IS NULL', [benutzerId]);
    if ((unfertig.rowCount ?? 0) > 0) {
      await kontoAlsGeloeschtMarkieren(client, benutzerId, 'erststart', passwortHash);
    }
    await client.query('COMMIT');
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}
