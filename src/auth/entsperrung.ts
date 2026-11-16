/**
 * Entsperrung bei verlorenem zweitem Faktor (COPI-28, Migration 0014).
 *
 * ADR Abschnitt 7: verlorener zweiter Faktor → Wiederherstellungscode, sonst Entsperrung
 * durch den Betreuer per Server-Kommando, mit Protokolleintrag, **kein E-Mail-Reset**.
 *
 * Die Bedrohung, die das Design bestimmt: Würde das Kommando nur den Faktor entfernen,
 * könnte danach jeder, der das Passwort kennt, ein eigenes Gerät binden — der Angriff aus
 * COPI-17. Für ein neues Konto begrenzt ihn der 72-h-Verfall, für ein aktiviertes Konto
 * (`aktiviert_am` gesetzt) greift der Verfall bewusst nicht. Also schließt das Kommando
 * das Fenster anders: Es entwertet auch das **Passwort**. Danach öffnet das alte Passwort
 * weder eine Anmeldung noch die Einrichtung eines Faktors; nur der Link, der persönlich
 * übergeben wird, führt zu einem neuen Passwort.
 *
 * `kontoEntsperren` tut alles in **einer Transaktion**: alle Faktoren weg (TOTP, Passkeys,
 * Ersatzcodes, offene Vorgänge), alle Sitzungen beendet, Passwort entwertet, ein Link
 * ausgestellt, ein Protokolleintrag. Scheitert etwas, bleibt das Konto unverändert. Der Link
 * ist ein Einmal-Token wie bei der Einladung (`einmal-token.ts`): 3 Stunden, nur der Hash
 * wird gespeichert.
 *
 * Das Passwort wird nicht durch einen Marker ersetzt, sondern durch einen **gültigen
 * Argon2id-Hash eines zufälligen Geheimnisses**, das sofort verworfen wird. Ein Marker, den
 * Argon2 auf einen Blick verwirft, ließe die Anmeldung eines entsperrten Kontos messbar
 * schneller scheitern als jeden anderen Fehlversuch: Better Auth rechnet für unbekannte
 * Adressen einen Blind-Hash, damit falsches Passwort und unbekanntes Konto gleich lang
 * dauern, und der Zeitunterschied verriete „dieses Konto existiert und ist in Wiederherstellung".
 */
import type pg from 'pg';
import { einmalTokenErzeugen, gueltigeZeile, tokenHashen } from './einmal-token.js';
import { unbrauchbarerPasswortHash, zugangEntwerten } from './konto-loeschen.js';
import { protokollSchreiben } from './protokoll.js';

/** 3 Stunden, wie bei der Einladung: der Link wird persönlich übergeben. */
export const WIEDERHERSTELLUNG_GUELTIGKEIT_MS = 3 * 60 * 60 * 1000;

/** Der feste Begriff im Protokoll für das Einlösen: wer den Link hat, ist noch nicht angemeldet. */
const EINLOESEN_AKTEUR = 'wiederherstellung';

export interface Entsperrung {
  /** Klartext-Token — nur für die einmalige Ausgabe auf stdout, nirgends gespeichert. */
  readonly token: string;
  readonly email: string;
  readonly rolle: string;
  readonly ablaufAm: Date;
}

/**
 * Wer entsperrt (COPI-46): ohne Angabe die Konsole, wie seit COPI-28. Aus der Oberfläche das handelnde Konto, mit
 * `weg: oberflaeche` im Protokoll, und einer Prüfung, die an der gesperrten Zeile des Kontos läuft — in derselben
 * Transaktion wie das Entsperren, damit eine Rolle, die sich inzwischen geändert hat, nicht übersehen wird.
 */
export interface EntsperrenAusloeser {
  readonly akteur: string;
  readonly weg: 'oberflaeche';
  /** Darf das entsperrt werden? Sieht Kennung und Rolle, wie sie in der Transaktion stehen. */
  readonly erlaubt: (ziel: { readonly id: string; readonly rolle: string }) => boolean;
}

/** Das Konto gibt es, aber dieser Auslöser darf es nicht entsperren. Es hat sich nichts geändert. */
export class EntsperrenNichtErlaubt extends Error {
  constructor() {
    super('Dieses Konto darf von hier aus nicht entsperrt werden.');
    this.name = 'EntsperrenNichtErlaubt';
  }
}

/** Zu dieser Kennung gibt es kein Konto. Es hat sich nichts geändert. */
export class EntsperrenKontoUnbekannt extends Error {
  constructor() {
    super('Zu dieser Adresse gibt es kein Konto.');
    this.name = 'EntsperrenKontoUnbekannt';
  }
}

/**
 * Entsperrt ein Konto (siehe Kopf der Datei). Wirft, wenn es das Konto nicht gibt, der Auslöser es nicht darf oder
 * es kein Passwort-Konto ist; die Transaktion wird dann zurückgenommen.
 */
export async function kontoEntsperren(
  pool: pg.Pool,
  benutzerId: string,
  jetzt: Date = new Date(),
  ausloeser?: EntsperrenAusloeser,
): Promise<Entsperrung> {
  // Argon2id rechnet, bevor die Transaktion die Zeile des Kontos sperrt.
  const passwortHash = await unbrauchbarerPasswortHash();
  const token = einmalTokenErzeugen(WIEDERHERSTELLUNG_GUELTIGKEIT_MS, jetzt);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const konto = await client.query<{ email: string; rolle: string }>(
      // Ein als gelöscht markiertes Konto gibt es für das Entsperren nicht (COPI-62).
      'SELECT email, rolle FROM cockpit."user" WHERE id = $1 AND geloescht_am IS NULL FOR UPDATE',
      [benutzerId],
    );
    const zeile = konto.rows[0];
    if (zeile === undefined) {
      throw new EntsperrenKontoUnbekannt();
    }
    if (ausloeser !== undefined && !ausloeser.erlaubt({ id: benutzerId, rolle: zeile.rolle })) {
      throw new EntsperrenNichtErlaubt();
    }

    // Faktoren, Sitzungen, offene Anmeldungen, Passwort und ein offener Link — der gemeinsame Kern mit dem Löschen.
    if ((await zugangEntwerten(client, benutzerId, passwortHash)) !== 1) {
      throw new Error('Das Konto hat kein Passwort, das sich entwerten ließe.');
    }
    await client.query(
      'INSERT INTO cockpit.zugang_wiederherstellung (benutzer_id, token_hash, ablauf_am) VALUES ($1, $2, $3)',
      [benutzerId, token.hash, token.ablaufAm],
    );
    await protokollSchreiben(client, {
      art: 'konto_entsperrt',
      akteur: ausloeser?.akteur ?? 'konsole',
      ziel: benutzerId,
      einzelheiten: ausloeser === undefined ? { rolle: zeile.rolle } : { rolle: zeile.rolle, weg: ausloeser.weg },
    });
    await client.query('COMMIT');
    return { token: token.token, email: zeile.email, rolle: zeile.rolle, ablaufAm: token.ablaufAm };
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

export interface WiederherstellungPruefung {
  readonly gueltig: boolean;
  readonly id?: string;
  readonly email?: string;
}

/**
 * Prüft einen Link, ohne ihn zu entwerten (für die Anzeige des Formulars). Gesucht wird über
 * den Hash, verglichen laufzeitkonstant — wie bei Einladung und Erststart.
 */
export async function wiederherstellungPruefen(
  pool: pg.Pool,
  token: string,
  jetzt: Date = new Date(),
): Promise<WiederherstellungPruefung> {
  const hash = tokenHashen(token);
  const ergebnis = await pool.query<{ id: string; token_hash: string; ablauf_am: Date; email: string }>(
    `SELECT z.id::text AS id, z.token_hash, z.ablauf_am, u.email
       FROM cockpit.zugang_wiederherstellung z
       JOIN cockpit."user" u ON u.id = z.benutzer_id
      WHERE z.token_hash = $1 AND z.verbraucht_am IS NULL
      LIMIT 1`,
    [hash],
  );
  const zeile = gueltigeZeile(ergebnis.rows[0], hash, jetzt);
  return zeile === undefined ? { gueltig: false } : { gueltig: true, id: zeile.id, email: zeile.email };
}

/**
 * Löst den Link ein: entwertet ihn, setzt das neue Passwort und protokolliert — in **einer**
 * Transaktion. Das Entwerten ist eine einzige bedingte Anweisung, sodass derselbe Link auch
 * bei gleichzeitigen Anfragen höchstens einmal wirkt. Liefert Konto und Adresse aus der
 * Datenbank; `undefined`, wenn der Link nicht (mehr) gilt.
 */
export async function wiederherstellungEinloesen(
  pool: pg.Pool,
  id: string,
  passwortHash: string,
  jetzt: Date = new Date(),
): Promise<{ readonly benutzerId: string; readonly email: string } | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const link = await client.query<{ benutzer_id: string }>(
      `UPDATE cockpit.zugang_wiederherstellung
          SET verbraucht_am = now()
        WHERE id = $1 AND verbraucht_am IS NULL AND ablauf_am > $2
    RETURNING benutzer_id`,
      [id, jetzt],
    );
    const benutzerId = link.rows[0]?.benutzer_id;
    if (benutzerId === undefined) {
      await client.query('ROLLBACK');
      return undefined;
    }
    const passwort = await client.query<{ email: string }>(
      `UPDATE cockpit.account a SET password = $2, "updatedAt" = now()
         FROM cockpit."user" u
        WHERE a."userId" = $1 AND a."providerId" = 'credential' AND u.id = a."userId"
    RETURNING u.email`,
      [benutzerId, passwortHash],
    );
    const email = passwort.rows[0]?.email;
    if (passwort.rowCount !== 1 || email === undefined) {
      throw new Error('Das Konto hat kein Passwort, das sich setzen ließe.');
    }
    await protokollSchreiben(client, {
      art: 'zugang_wiederhergestellt',
      akteur: EINLOESEN_AKTEUR,
      ziel: benutzerId,
    });
    await client.query('COMMIT');
    return { benutzerId, email };
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}
