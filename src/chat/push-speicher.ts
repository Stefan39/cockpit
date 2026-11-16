/**
 * Die Push-Abos in der Datenbank (COPI-59, Tabelle `cockpit.push_abo` aus 0024). Nie gelöscht, nur abgemeldet
 * (COPI-62): ein Abo, das der Push-Dienst nicht mehr kennt (404/410) oder das jemand entfernt, bekommt `abgemeldet_am`.
 *
 * Ein Endpoint gehört einem Gerät. Meldet sich auf demselben Gerät ein anderes Konto an und schaltet Push ein, wandert
 * der Endpoint zu ihm: das alte Abo wird abgemeldet, sonst bekäme der Vorbesitzer die Hinweise des Neuen.
 */
import type pg from 'pg';
import type { Abfrager } from '../auth/protokoll.js';

export interface NeuesAbo {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushAbo extends NeuesAbo {
  readonly id: number;
  readonly angelegtAm: Date;
  readonly zuletztErfolgreichAm: Date | undefined;
}

interface Zeile {
  readonly id: number;
  readonly endpoint: string;
  readonly schluessel_p256dh: string;
  readonly schluessel_auth: string;
  readonly angelegt_am: Date;
  readonly zuletzt_erfolgreich_am: Date | null;
}

/** Legt das Abo für dieses Konto an; ein aktives Abo desselben Endpoints (auch eines anderen Kontos) wird abgemeldet. */
export async function aboSpeichern(pool: pg.Pool, benutzerId: string, abo: NeuesAbo): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE cockpit.push_abo SET abgemeldet_am = now() WHERE endpoint = $1 AND abgemeldet_am IS NULL', [abo.endpoint]);
    const angelegt = await client.query<{ id: number }>(
      `INSERT INTO cockpit.push_abo (benutzer_id, endpoint, schluessel_p256dh, schluessel_auth)
       VALUES ($1, $2, $3, $4) RETURNING id::int AS id`,
      [benutzerId, abo.endpoint, abo.p256dh, abo.auth],
    );
    await client.query('COMMIT');
    const id = angelegt.rows[0]?.id;
    if (id === undefined) {
      throw new Error('Abo wurde nicht angelegt');
    }
    return id;
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

/** Die aktiven Abos eines Kontos, ältestes zuerst. */
export async function aktiveAbos(db: Abfrager, benutzerId: string): Promise<PushAbo[]> {
  const ergebnis = await db.query<Zeile>(
    `SELECT id::int AS id, endpoint, schluessel_p256dh, schluessel_auth, angelegt_am, zuletzt_erfolgreich_am
       FROM cockpit.push_abo WHERE benutzer_id = $1 AND abgemeldet_am IS NULL ORDER BY id`,
    [benutzerId],
  );
  return ergebnis.rows.map((zeile) => ({
    id: zeile.id,
    endpoint: zeile.endpoint,
    p256dh: zeile.schluessel_p256dh,
    auth: zeile.schluessel_auth,
    angelegtAm: zeile.angelegt_am,
    zuletztErfolgreichAm: zeile.zuletzt_erfolgreich_am ?? undefined,
  }));
}

/** Meldet ein eigenes Abo ab — nach Nummer (Liste der Geräte) oder Endpoint (das Gerät selbst). `false`: kein eigenes. */
export async function aboAbmelden(db: Abfrager, benutzerId: string, wahl: { readonly id: number } | { readonly endpoint: string }): Promise<boolean> {
  const [spalte, wert] = 'id' in wahl ? ['id', wahl.id] : ['endpoint', wahl.endpoint];
  const ergebnis = await db.query(
    `UPDATE cockpit.push_abo SET abgemeldet_am = now() WHERE benutzer_id = $1 AND ${spalte} = $2 AND abgemeldet_am IS NULL`,
    [benutzerId, wert],
  );
  return (ergebnis.rowCount ?? 0) > 0;
}

/** Der Push-Dienst hat angenommen. */
export async function aboErreicht(db: Abfrager, id: number): Promise<void> {
  await db.query('UPDATE cockpit.push_abo SET zuletzt_erfolgreich_am = now() WHERE id = $1', [id]);
}

/** Der Push-Dienst kennt das Abo nicht mehr (404/410): abgemeldet, nicht gelöscht. */
export async function aboUngueltig(db: Abfrager, id: number): Promise<void> {
  await db.query('UPDATE cockpit.push_abo SET abgemeldet_am = now() WHERE id = $1 AND abgemeldet_am IS NULL', [id]);
}
