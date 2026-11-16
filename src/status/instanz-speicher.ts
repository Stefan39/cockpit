/**
 * Die Selbstmeldung in `cockpit.instanz` (COPI-39): genau eine Zeile, die das laufende Cockpit bei jedem Start
 * ersetzt — Version, Digest, Startzeit (`instanz.ts` bestimmt die Werte). Die Tabelle lässt keine zweite Zeile zu
 * (`id` ist immer `true`) und keinen Digest, der kein vollständiger `sha256:`-Wert ist.
 *
 * Ein Start ohne Digest löscht einen früheren: in der Zeile steht immer, was **dieses** Cockpit weiß, nie ein
 * stehengebliebener Wert eines Vorgängers.
 *
 * **Der Erfolgsbeleg (COPI-41, ADR 13.1).** In derselben Transaktion setzt die Meldung einen laufenden Eingriff auf
 * `erledigt`, wenn dessen Ziel-Digest und Ziel-Version zu diesem Cockpit passen — mit dem Protokolleintrag
 * `update_erledigt` (Akteur `system`). Erfolg heißt „ein Cockpit mit dem Ziel hat sich gemeldet", nicht „der Befehl lief
 * durch"; das kann nur das Cockpit selbst sagen, kein Agent. Passt etwas nicht — anderer Digest, andere Version, kein
 * Digest —, bleibt der Eingriff in `laeuft` und hängt nach 15 Minuten. Nur `laeuft` zählt: eine Zeile, die der Agent
 * vor dem Neustart nicht auf `laeuft` gesetzt hat, bleibt stehen. Die Datenbank prüft dieselbe Regel noch einmal
 * (`eingriff_ohne_beleg`, Migration 0020).
 *
 * Meldung, Beleg und Eintrag gelten zusammen oder gar nicht. Scheitert etwas, startet das Cockpit nicht
 * (`src/server/index.ts`).
 */
import type pg from 'pg';
import { protokollSchreiben } from '../auth/protokoll.js';

export interface InstanzMeldung {
  readonly version: string;
  readonly digest: string | undefined;
}

export interface InstanzZeile extends InstanzMeldung {
  readonly gestartetAm: Date;
}

export interface InstanzErgebnis {
  /** Die Nummer des Eingriffs, den diese Meldung als erledigt belegt; sonst `undefined`. */
  readonly erledigt: number | undefined;
}

export async function instanzMelden(pool: pg.Pool, meldung: InstanzMeldung, jetzt: Date): Promise<InstanzErgebnis> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO cockpit.instanz (id, version, digest, gestartet_am)
       VALUES (true, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE
          SET version = EXCLUDED.version,
              digest = EXCLUDED.digest,
              gestartet_am = EXCLUDED.gestartet_am`,
      [meldung.version, meldung.digest ?? null, jetzt],
    );
    const erledigt = meldung.digest === undefined ? undefined : await updateBelegen(client, meldung.version, meldung.digest);
    await client.query('COMMIT');
    return { erledigt };
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

/**
 * Setzt den laufenden Eingriff auf `erledigt`, dessen Ziel dieses Cockpit ist. Die Version zählt ohne den Commit: das
 * Cockpit meldet `1.4.0+0123456`, die Freigabe nennt `1.4.0` — dieselbe Regel wie in der Datenbank.
 */
async function updateBelegen(client: pg.PoolClient, version: string, digest: string): Promise<number | undefined> {
  const ergebnis = await client.query<{ id: number }>(
    `UPDATE cockpit.eingriff SET status = 'erledigt'
      WHERE art = 'cockpit-image'
        AND status = 'laeuft'
        AND ziel_digest = $1
        AND ziel_version = split_part($2::text, '+', 1)
      RETURNING id::int AS id`,
    [digest, version],
  );
  const id = ergebnis.rows[0]?.id;
  if (id !== undefined) {
    await protokollSchreiben(client, { art: 'update_erledigt', akteur: 'system', einzelheiten: { eingriff_id: id } });
  }
  return id;
}

export async function instanzLesen(pool: pg.Pool): Promise<InstanzZeile | undefined> {
  const ergebnis = await pool.query<{ version: string; digest: string | null; gestartet_am: Date }>(
    'SELECT version, digest, gestartet_am FROM cockpit.instanz',
  );
  const zeile = ergebnis.rows[0];
  return zeile === undefined ? undefined : { version: zeile.version, digest: zeile.digest ?? undefined, gestartetAm: zeile.gestartet_am };
}
