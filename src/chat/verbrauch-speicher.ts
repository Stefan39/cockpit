/**
 * Der Tagesverbrauch des Chats in der Datenbank (COPI-57, Tabelle `cockpit.chat_verbrauch` aus 0024).
 *
 * Gezählt wird **atomar**: eine einzige Anweisung legt den Tag an oder zählt weiter, aber nur, solange das Limit nicht
 * erreicht ist. Zwei gleichzeitige Nachrichten sperren dieselbe Zeile nacheinander; mehr als das Limit geht nie durch.
 */
import type { Abfrager } from '../auth/protokoll.js';

/**
 * Bucht eine Nachricht auf den Tag. Liefert den neuen Stand, oder `undefined`, wenn das Limit schon erreicht war —
 * dann ändert sich nichts.
 */
export async function verbrauchBuchen(db: Abfrager, benutzerId: string, tag: string, limit: number): Promise<number | undefined> {
  if (limit < 1) {
    return undefined;
  }
  const ergebnis = await db.query<{ anzahl: number }>(
    `INSERT INTO cockpit.chat_verbrauch AS v (benutzer_id, tag, anzahl) VALUES ($1, $2, 1)
     ON CONFLICT (benutzer_id, tag) DO UPDATE SET anzahl = v.anzahl + 1 WHERE v.anzahl < $3
     RETURNING anzahl`,
    [benutzerId, tag, limit],
  );
  return ergebnis.rows[0]?.anzahl;
}

/** Gibt eine gebuchte Nachricht zurück, wenn sie nicht gespeichert werden konnte. */
export async function verbrauchZurueckgeben(db: Abfrager, benutzerId: string, tag: string): Promise<void> {
  await db.query('UPDATE cockpit.chat_verbrauch SET anzahl = anzahl - 1 WHERE benutzer_id = $1 AND tag = $2 AND anzahl > 0', [
    benutzerId,
    tag,
  ]);
}

/** Wie viele Nachrichten das Konto an diesem Tag schon geschickt hat. */
export async function verbrauchLesen(db: Abfrager, benutzerId: string, tag: string): Promise<number> {
  const ergebnis = await db.query<{ anzahl: number }>('SELECT anzahl FROM cockpit.chat_verbrauch WHERE benutzer_id = $1 AND tag = $2', [
    benutzerId,
    tag,
  ]);
  return ergebnis.rows[0]?.anzahl ?? 0;
}

export interface TagesVerbrauch {
  /** `YYYY-MM-DD`, Berliner Zeit. */
  readonly tag: string;
  readonly nachrichten: number;
  /** Wie viele Konten an dem Tag geschrieben haben — keine Kennungen. */
  readonly benutzer: number;
  /** Wie viele davon das Limit erreicht haben. */
  readonly amLimit: number;
}

/** Der Verbrauch je Tag ab `abTag` (einschließlich), jüngster Tag zuerst — für die Budget-Wache, ohne Kennungen. */
export async function verbrauchJeTag(db: Abfrager, abTag: string, limit: number): Promise<TagesVerbrauch[]> {
  const ergebnis = await db.query<{ tag: string; nachrichten: number; benutzer: number; am_limit: number }>(
    `SELECT to_char(tag, 'YYYY-MM-DD') AS tag, sum(anzahl)::int AS nachrichten, count(*)::int AS benutzer,
            count(*) FILTER (WHERE anzahl >= $2)::int AS am_limit
       FROM cockpit.chat_verbrauch
      WHERE tag >= $1::date AND anzahl > 0
      GROUP BY tag
      ORDER BY tag DESC`,
    [abTag, limit],
  );
  return ergebnis.rows.map((zeile) => ({ tag: zeile.tag, nachrichten: zeile.nachrichten, benutzer: zeile.benutzer, amLimit: zeile.am_limit }));
}
