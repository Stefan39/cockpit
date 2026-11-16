/**
 * Eine schreibende Transaktion mit einer Regel (COPI-40, gemeinsam seit COPI-85): `undefined` als Ergebnis nimmt sie
 * zurück, ebenso jede Ausnahme — sonst gilt sie. Für Speicher, die eine Änderung und ihren Protokolleintrag zusammen
 * schreiben (Update-Antrag, Übernahme-Sperre): beides gilt oder keins.
 */
import type pg from 'pg';

export async function inTransaktion<T>(pool: pg.Pool, arbeit: (client: pg.PoolClient) => Promise<T | undefined>): Promise<T | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ergebnis = await arbeit(client);
    await client.query(ergebnis === undefined ? 'ROLLBACK' : 'COMMIT');
    return ergebnis;
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}
