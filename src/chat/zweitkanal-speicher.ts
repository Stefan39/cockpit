/**
 * Die Datenbankseite des E-Mail-Zweitkanals (COPI-60, Migration 0027): die Kandidaten und der Vermerk des Versands.
 */
import type pg from 'pg';
import type { Abfrager } from '../auth/protokoll.js';

/** Eine dringende, ungelesene, noch nicht gemeldete Nachricht im Assistenten-Kanal eines bestehenden Kontos. */
export interface ZweitkanalKandidat {
  readonly nachrichtId: number;
  readonly erstelltAm: Date;
  /** Der Besitzer des Kanals. */
  readonly benutzerId: string;
  /** Die jüngste Mail des Zweitkanals an dieses Konto, für die Drosselung. */
  readonly letzteMail: Date | undefined;
}

/**
 * Nur Assistenten-Kanäle: dringend schreiben nur Koordinator und Cockpit, und beide schreiben dort. Nicht die als
 * gelöscht markierten Nachrichten, nicht die als gelöscht markierten Konten, nichts nach dem Zeitpunkt `jetzt`.
 */
export async function zweitkanalKandidaten(db: Abfrager, jetzt: Date): Promise<ZweitkanalKandidat[]> {
  const ergebnis = await db.query<{ id: number; erstellt_am: Date; benutzer_id: string; letzte_mail: Date | null }>(
    `SELECT n.id::int AS id, n.erstellt_am, k.besitzer_id AS benutzer_id,
            (SELECT max(m.gesendet_am) FROM cockpit.chat_mail m WHERE m.benutzer_id = k.besitzer_id) AS letzte_mail
       FROM cockpit.nachricht n
       JOIN cockpit.kanal k ON k.id = n.kanal_id AND k.art = 'assistent'
       JOIN cockpit."user" u ON u.id = k.besitzer_id AND u.geloescht_am IS NULL
      WHERE n.dringend AND n.geloescht_am IS NULL AND n.erstellt_am <= $1
        AND n.id > COALESCE((SELECT l.bis_id FROM cockpit.nachricht_lesestand l
                              WHERE l.benutzer_id = k.besitzer_id AND l.kanal_id = n.kanal_id), 0)
        AND NOT EXISTS (SELECT 1 FROM cockpit.chat_mail m WHERE m.nachricht_id = n.id)
      ORDER BY n.id`,
    [jetzt],
  );
  return ergebnis.rows.map((zeile) => ({
    nachrichtId: zeile.id,
    erstelltAm: zeile.erstellt_am,
    benutzerId: zeile.benutzer_id,
    letzteMail: zeile.letzte_mail ?? undefined,
  }));
}

export interface Vermerk {
  /** Wie viele der Nachrichten dieser Lauf vermerkt hat; schon vermerkte zählen nicht. */
  readonly anzahl: number;
  /** Die Adresse des Kontos, `undefined` wenn es inzwischen als gelöscht markiert ist. */
  readonly email: string | undefined;
}

/**
 * Vermerkt die Nachrichten als gemeldet, im Client der Transaktion des Versands. Eine Nachricht, die ein anderer Lauf
 * schon vermerkt hat, zählt nicht (Primärschlüssel); die Adresse wird hier gelesen, nicht bei der Auswahl.
 */
export async function chatMailVermerken(
  client: pg.PoolClient,
  mail: { readonly benutzerId: string; readonly nachrichtIds: readonly number[] },
  jetzt: Date,
): Promise<Vermerk> {
  const konto = await client.query<{ email: string }>(
    `SELECT email FROM cockpit."user" WHERE id = $1 AND geloescht_am IS NULL`,
    [mail.benutzerId],
  );
  const email = konto.rows[0]?.email;
  if (email === undefined) {
    return { anzahl: 0, email: undefined };
  }
  const vermerkt = await client.query(
    `INSERT INTO cockpit.chat_mail (nachricht_id, benutzer_id, gesendet_am)
     SELECT unnest($1::bigint[]), $2, $3
     ON CONFLICT (nachricht_id) DO NOTHING`,
    [mail.nachrichtIds, mail.benutzerId, jetzt],
  );
  return { anzahl: vermerkt.rowCount ?? 0, email };
}
