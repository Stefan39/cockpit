/**
 * Datenbankseite der E-Mail-Einladung (Architektur-Vorschlag Abschnitt 7).
 *
 * Gültig ist eine Einladung nur, solange beide Bedingungen halten:
 *   1. sie ist noch nicht verbraucht,
 *   2. sie ist nicht älter als 3 Stunden.
 * Die dritte Bedingung des Erststart-Tokens („es existiert noch kein
 * Benutzer") gibt es hier bewusst nicht — eingeladen wird ja gerade in eine
 * Instanz hinein, in der schon Konten existieren.
 */
import type pg from 'pg';
import {
  istVergebbareRolle,
  ROLLE_DEFAULT,
  type Rolle,
  type VergebbareRolle,
} from './berechtigung.js';
import {
  istAbgelaufen,
  tokenHashVergleichen,
  tokenHashen,
} from './einmal-token.js';
import { einladungsTokenErzeugen, type EinladungsToken } from './einladung-token.js';
import { protokollSchreiben } from './protokoll.js';

interface EinladungsZeile {
  readonly id: string;
  readonly email: string;
  readonly rolle: string;
  readonly token_hash: string;
  readonly ablauf_am: Date;
}

export interface EinladungsPruefung {
  readonly gueltig: boolean;
  readonly id?: string;
  readonly email?: string;
  readonly rolle?: VergebbareRolle;
}

/** Was eine eingelöste Einladung festlegt: die Adresse und die Rolle des neuen Kontos. */
export interface EingeloesteEinladung {
  readonly email: string;
  readonly rolle: VergebbareRolle;
}

/**
 * Die Rolle einer Einladung aus der Datenbank. Die CHECK-Bedingung lässt nur
 * vergebbare Rollen zu; fällt trotzdem etwas anderes an, gilt das kleinste Recht.
 */
function einladungsRolle(wert: string): VergebbareRolle {
  return istVergebbareRolle(wert) ? wert : ROLLE_DEFAULT;
}

/** Zeitquelle für Tests und Akteur fürs Protokoll, wenn kein Konto einlädt (`konsole`). */
export interface EinladungsOptionen {
  readonly jetzt?: Date;
  /** Wer einlädt, wenn `eingeladenVon` fehlt: Default `system`. */
  readonly akteur?: 'system' | 'konsole';
}

/** Vereinheitlicht E-Mail-Adressen für Speicherung und Vergleich. */
export function emailNormalisieren(email: string): string {
  return email.trim().toLowerCase();
}

export async function kontoVorhanden(pool: pg.Pool, email: string): Promise<boolean> {
  const ergebnis = await pool.query<{ vorhanden: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM cockpit."user" WHERE lower(email) = $1) AS vorhanden',
    [emailNormalisieren(email)],
  );
  return ergebnis.rows[0]?.vorhanden === true;
}

/**
 * Entwertet eine noch offene Einladung an dieselbe Adresse und legt genau
 * eine neue an — beides in einer Transaktion, damit je Adresse nie zwei
 * offene Einladungen nebeneinander existieren (der partielle Unique-Index in
 * 0004_einladung erzwingt das zusätzlich auf Datenbankebene).
 *
 * Liefert das Klartext-Token zurück; es geht ausschließlich in die
 * Einladungsmail und wird nirgends gespeichert oder protokolliert.
 */
export async function einladungAnlegen(
  pool: pg.Pool,
  email: string,
  eingeladenVon: string | undefined,
  rolle: VergebbareRolle = ROLLE_DEFAULT,
  optionen: EinladungsOptionen = {},
): Promise<EinladungsToken> {
  const ziel = emailNormalisieren(email);
  const token = einladungsTokenErzeugen(optionen.jetzt ?? new Date());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE cockpit.einladung SET verbraucht_am = now() WHERE email = $1 AND verbraucht_am IS NULL',
      [ziel],
    );
    const angelegt = await client.query<{ id: string }>(
      `INSERT INTO cockpit.einladung (email, token_hash, eingeladen_von, ablauf_am, rolle)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id::text AS id`,
      [ziel, token.hash, eingeladenVon ?? null, token.ablaufAm, rolle],
    );
    // Der Eintrag gehört zur Transaktion (COPI-23): keine Einladung ohne Eintrag.
    // Die Adresse steht nicht darin, nur wer eingeladen hat und mit welcher Rolle.
    await protokollSchreiben(client, {
      art: 'einladung_erzeugt',
      akteur: eingeladenVon ?? optionen.akteur ?? 'system',
      einzelheiten: { rolle, einladung_id: Number(angelegt.rows[0]?.id) },
    });
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
 * Formulars).
 *
 * Gesucht wird über den Hash-Wert, nicht über das Klartext-Token — der Hash
 * ist indiziert, und aus der Laufzeit eines Index-Treffers lässt sich das
 * Urbild eines SHA-256-Wertes nicht ableiten. Der anschließende Vergleich
 * läuft trotzdem laufzeitkonstant: er kostet nichts und hält das Verfahren
 * identisch zum Erststart-Token, falls die Suche später einmal anders
 * aufgebaut wird.
 */
export async function einladungPruefen(
  pool: pg.Pool,
  token: string,
  jetzt: Date = new Date(),
): Promise<EinladungsPruefung> {
  const hash = tokenHashen(token);
  const ergebnis = await pool.query<EinladungsZeile>(
    `SELECT id::text AS id, email, rolle, token_hash, ablauf_am
       FROM cockpit.einladung
      WHERE token_hash = $1
        AND verbraucht_am IS NULL
      LIMIT 1`,
    [hash],
  );
  const zeile = ergebnis.rows[0];
  if (!zeile) {
    return { gueltig: false };
  }
  if (!tokenHashVergleichen(hash, zeile.token_hash)) {
    return { gueltig: false };
  }
  if (istAbgelaufen(zeile.ablauf_am, jetzt)) {
    return { gueltig: false };
  }
  return { gueltig: true, id: zeile.id, email: zeile.email, rolle: einladungsRolle(zeile.rolle) };
}

/**
 * Entwertet die Einladung endgültig und liefert Zieladresse und Rolle aus der
 * Datenbank zurück — maßgeblich sind sie, nicht irgendein Formularfeld.
 *
 * Eine einzelne bedingte UPDATE-Anweisung: dadurch kann dieselbe Einladung
 * auch bei gleichzeitigen Anfragen höchstens einmal eingelöst werden
 * (`rowCount === 1` gewinnt, alle anderen bekommen 0). Gleiches Muster wie
 * `tokenEinloesen` beim Erststart, nur ohne dessen Bedingung „es existiert
 * noch kein Benutzer".
 */
export async function einladungEinloesen(
  pool: pg.Pool,
  id: string,
): Promise<EingeloesteEinladung | undefined> {
  const client = await pool.connect();
  try {
    // Entwerten und Eintrag in einer Transaktion (COPI-23): wer die Einladung
    // einlöst, hinterlässt genau einen Eintrag — wer sie nicht einlöst, keinen.
    await client.query('BEGIN');
    const ergebnis = await client.query<{ email: string; rolle: string }>(
      `UPDATE cockpit.einladung
          SET verbraucht_am = now()
        WHERE id = $1
          AND verbraucht_am IS NULL
          AND ablauf_am > now()
        RETURNING email, rolle`,
      [id],
    );
    const zeile = ergebnis.rowCount === 1 ? ergebnis.rows[0] : undefined;
    const eingeloest = zeile
      ? { email: zeile.email, rolle: einladungsRolle(zeile.rolle) }
      : undefined;
    if (eingeloest) {
      await protokollSchreiben(client, {
        art: 'einladung_eingeloest',
        akteur: 'einladung',
        einzelheiten: { einladung_id: Number(id), rolle: eingeloest.rolle },
      });
    }
    await client.query('COMMIT');
    return eingeloest;
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

/** Setzt die Rolle eines frisch angelegten Kontos ausdrücklich. */
export async function rolleSetzen(
  pool: pg.Pool,
  benutzerId: string,
  rolle: Rolle,
): Promise<void> {
  await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [
    benutzerId,
    rolle,
  ]);
}
