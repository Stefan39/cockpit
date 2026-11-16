/**
 * Die E-Mail-Adresse eines Kontos ändern (COPI-47, Migration 0023) — beantragen und einlösen.
 *
 * **Beantragen** (Betreuer an Admins und Mitarbeitern, Betriebs-Admin an Mitarbeitern; dieselbe Regel und derselbe Weg
 * wie in COPI-46): die Rechte werden an der gesperrten Zeile des Kontos geprüft (`amKonto`), in derselben Transaktion
 * werden ein älterer offener Antrag des Kontos entwertet, der neue angelegt und protokolliert. Am Konto ändert sich
 * **nichts** — angemeldet wird mit der E-Mail, und die neue gilt erst, wenn ihr Postfach den Link eingelöst hat.
 *
 * **Die neue Adresse muss frei sein:** nicht die bisherige, kein anderes Konto, keine offene Einladung, kein offener
 * Antrag eines anderen Kontos. Geprüft beim Antrag und beim Einlösen noch einmal (dazwischen kann ein Konto entstanden
 * sein); die Indizes der Tabelle und die Eindeutigkeit von `user.email` halten es zusätzlich fest.
 *
 * **Einlösen** (ohne Anmeldung; der Besitz des Links ist der Nachweis, wie bei Einladung und Wiederherstellung): eine
 * einzige bedingte Anweisung entwertet den Link, sodass er auch bei gleichzeitigen Anfragen höchstens einmal wirkt; in
 * derselben Transaktion gilt die neue Adresse, offene Einladungen an sie verfallen, und das Protokoll hält es fest.
 *
 * Im Protokoll steht **keine Adresse** — weder die alte noch die neue —, nur wer an welchem Konto.
 */
import type pg from 'pg';
import { amKonto, type BearbeitenErgebnis, type Handelnder } from './benutzer-bearbeiten-speicher.js';
import { emailNormalisieren } from './einladung-speicher.js';
import { einmalTokenErzeugen, gueltigeZeile, tokenHashen } from './einmal-token.js';
import { protokollSchreiben, type Abfrager } from './protokoll.js';

/** 24 Stunden: die Person soll die Mail in Ruhe öffnen können; ohne Bestätigung ändert sich nichts. */
export const EMAIL_AENDERUNG_GUELTIGKEIT_MS = 24 * 60 * 60 * 1000;

/** Der feste Begriff im Protokoll für das Einlösen: wer den Link hat, ist nicht angemeldet. */
const EINLOESEN_AKTEUR = 'email_bestaetigung';

/** Warum eine Adresse nicht in Frage kommt. */
export type AdresseBelegt = 'gleich' | 'konto' | 'einladung' | 'aenderung';

/** Ist die Adresse für dieses Konto frei? `undefined`: ja; sonst der Grund. Die Adresse kommt normalisiert. */
export async function adresseBelegt(db: Abfrager, benutzerId: string, adresse: string, jetzt: Date): Promise<AdresseBelegt | undefined> {
  const ergebnis = await db.query<{ gleich: boolean; konto: boolean; einladung: boolean; aenderung: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM cockpit."user" WHERE id = $1 AND lower(email) = $2) AS gleich,
            EXISTS (SELECT 1 FROM cockpit."user" WHERE id <> $1 AND lower(email) = $2) AS konto,
            EXISTS (SELECT 1 FROM cockpit.einladung
                     WHERE email = $2 AND verbraucht_am IS NULL AND ablauf_am > $3) AS einladung,
            EXISTS (SELECT 1 FROM cockpit.email_aenderung
                     WHERE neue_email = $2 AND benutzer_id <> $1 AND verbraucht_am IS NULL AND ablauf_am > $3) AS aenderung`,
    [benutzerId, adresse, jetzt],
  );
  const zeile = ergebnis.rows[0];
  if (zeile?.gleich === true) {
    return 'gleich';
  }
  if (zeile?.konto === true) {
    return 'konto';
  }
  if (zeile?.einladung === true) {
    return 'einladung';
  }
  return zeile?.aenderung === true ? 'aenderung' : undefined;
}

export type AntragErgebnis =
  | { readonly art: 'beantragt'; readonly token: string; readonly bisherige: string; readonly ablaufAm: Date }
  | { readonly art: 'belegt'; readonly grund: AdresseBelegt };

/**
 * Beantragt die neue Adresse (siehe Kopf). Gibt das Token für die Mail an die neue Adresse zurück und die bisherige
 * Adresse für den Hinweis — oder, warum die Adresse nicht frei ist; dann ist nichts geschrieben.
 */
export async function emailAenderungBeantragen(
  pool: pg.Pool,
  zielId: string,
  adresse: string,
  handelnder: Handelnder,
  jetzt: Date,
): Promise<BearbeitenErgebnis<AntragErgebnis>> {
  const neue = emailNormalisieren(adresse);
  const token = einmalTokenErzeugen(EMAIL_AENDERUNG_GUELTIGKEIT_MS, jetzt);
  return amKonto(pool, zielId, handelnder, async (client): Promise<AntragErgebnis> => {
    const belegt = await adresseBelegt(client, zielId, neue, jetzt);
    if (belegt !== undefined) {
      return { art: 'belegt', grund: belegt };
    }
    const konto = await client.query<{ email: string }>('SELECT email FROM cockpit."user" WHERE id = $1', [zielId]);
    // Ein älterer offener Antrag dieses Kontos gilt nicht mehr; abgelaufene an diese Adresse geben sie frei.
    await client.query(
      `UPDATE cockpit.email_aenderung SET verbraucht_am = now()
        WHERE verbraucht_am IS NULL AND (benutzer_id = $1 OR (neue_email = $2 AND ablauf_am <= $3))`,
      [zielId, neue, jetzt],
    );
    await client.query(
      `INSERT INTO cockpit.email_aenderung (benutzer_id, neue_email, token_hash, beantragt_von, ablauf_am)
       VALUES ($1, $2, $3, $4, $5)`,
      [zielId, neue, token.hash, handelnder.id, token.ablaufAm],
    );
    await protokollSchreiben(client, { art: 'email_aenderung_beantragt', akteur: handelnder.id, ziel: zielId });
    return { art: 'beantragt', token: token.token, bisherige: konto.rows[0]?.email ?? '', ablaufAm: token.ablaufAm };
  });
}

/**
 * Verwirft den offenen Antrag eines Kontos — wenn die Mail an die neue Adresse nicht rausging: ohne sie kennt niemand
 * das Token, und die Adresse soll nicht einen Tag lang für andere blockiert bleiben.
 */
export async function offeneAenderungVerwerfen(db: Abfrager, benutzerId: string): Promise<void> {
  await db.query('UPDATE cockpit.email_aenderung SET verbraucht_am = now() WHERE benutzer_id = $1 AND verbraucht_am IS NULL', [benutzerId]);
}

/** Ein offener Antrag, wie ihn die Seite des Kontos zeigt: welche Adresse, bis wann. */
export interface OffeneAenderung {
  readonly neueEmail: string;
  readonly ablaufAm: Date;
}

export async function offeneAenderungLesen(db: Abfrager, benutzerId: string, jetzt: Date): Promise<OffeneAenderung | undefined> {
  const ergebnis = await db.query<{ neue_email: string; ablauf_am: Date }>(
    `SELECT neue_email, ablauf_am FROM cockpit.email_aenderung
      WHERE benutzer_id = $1 AND verbraucht_am IS NULL AND ablauf_am > $2`,
    [benutzerId, jetzt],
  );
  const zeile = ergebnis.rows[0];
  return zeile === undefined ? undefined : { neueEmail: zeile.neue_email, ablaufAm: zeile.ablauf_am };
}

export interface LinkPruefung {
  readonly gueltig: boolean;
  readonly id?: string;
  readonly neueEmail?: string;
}

/** Prüft einen Link, ohne ihn zu entwerten (für die Seite mit dem Knopf). Gesucht über den Hash, laufzeitkonstant verglichen. */
export async function emailLinkPruefen(pool: pg.Pool, token: string, jetzt: Date): Promise<LinkPruefung> {
  const hash = tokenHashen(token);
  const ergebnis = await pool.query<{ id: string; token_hash: string; ablauf_am: Date; neue_email: string }>(
    `SELECT id::text AS id, token_hash, ablauf_am, neue_email FROM cockpit.email_aenderung
      WHERE token_hash = $1 AND verbraucht_am IS NULL
      LIMIT 1`,
    [hash],
  );
  const zeile = gueltigeZeile(ergebnis.rows[0], hash, jetzt);
  return zeile === undefined ? { gueltig: false } : { gueltig: true, id: zeile.id, neueEmail: zeile.neue_email };
}

export type EinloesenErgebnis = { readonly art: 'geaendert'; readonly neueEmail: string } | { readonly art: 'ungueltig' } | { readonly art: 'belegt' };

/**
 * Löst den Link ein (siehe Kopf). `ungueltig`: der Link gilt nicht (mehr); `belegt`: die Adresse hat inzwischen ein
 * anderes Konto — dann ist nichts geändert, und der Link bleibt, wie er war.
 */
export async function emailLinkEinloesen(pool: pg.Pool, id: string, jetzt: Date): Promise<EinloesenErgebnis> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const link = await client.query<{ benutzer_id: string; neue_email: string }>(
      `UPDATE cockpit.email_aenderung
          SET verbraucht_am = now()
        WHERE id = $1 AND verbraucht_am IS NULL AND ablauf_am > $2
    RETURNING benutzer_id, neue_email`,
      [id, jetzt],
    );
    const zeile = link.rows[0];
    if (zeile === undefined) {
      await client.query('ROLLBACK');
      return { art: 'ungueltig' };
    }
    const vergeben = await client.query('SELECT 1 FROM cockpit."user" WHERE id <> $1 AND lower(email) = $2', [zeile.benutzer_id, zeile.neue_email]);
    if ((vergeben.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return { art: 'belegt' };
    }
    await client.query('UPDATE cockpit."user" SET email = $2, "updatedAt" = now() WHERE id = $1', [zeile.benutzer_id, zeile.neue_email]);
    // Eine Adresse gehört zu genau einem Konto: eine Einladung an sie könnte nie mehr eingelöst werden.
    await client.query('UPDATE cockpit.einladung SET verbraucht_am = now() WHERE email = $1 AND verbraucht_am IS NULL', [zeile.neue_email]);
    await protokollSchreiben(client, { art: 'email_geaendert', akteur: EINLOESEN_AKTEUR, ziel: zeile.benutzer_id });
    await client.query('COMMIT');
    return { art: 'geaendert', neueEmail: zeile.neue_email };
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}
