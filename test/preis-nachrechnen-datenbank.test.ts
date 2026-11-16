/**
 * Der Trigger `preis_nachrechnen` (COPI-234, Migration 0058) gegen eine echte PostgreSQL: Jede Änderung an
 * `cockpit.preis` rechnet die Kosten der Verbrauchseinträge nach, ohne das Server-Kommando `verbrauch-kosten-neu`.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Jeder Test läuft in einer Transaktion und wird zurückgerollt, denn
 * `cockpit.verbrauch` und `cockpit.preis` lassen sich nicht löschen.
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const MODELL = 'test-preis-nachrechnen';

describe.skipIf(!datenbankUrl)('Preis-Trigger: Verbrauchskosten nachrechnen (echte Datenbank)', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  async function kosten(): Promise<string | null> {
    const ergebnis = await client.query<{ kosten: string | null }>('SELECT kosten FROM cockpit.verbrauch WHERE modell = $1', [MODELL]);
    return ergebnis.rows[0]?.kosten ?? null;
  }

  async function preisAnlegen(eingabe: number): Promise<void> {
    await client.query(
      `INSERT INTO cockpit.preis (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
       VALUES ($1, 'EUR', $2, 0, 0, 0, 0, '2026-01-01T00:00:00Z', 'https://example.org/preise', '2026-11-06')`,
      [MODELL, eingabe],
    );
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    // 1 Mio. Eingabe-Tokens, Modell ohne Preis.
    await client.query(
      `INSERT INTO cockpit.verbrauch (schluessel, zeitpunkt, quelle, gemeldet_von, modell, tokens_eingabe, tokens_ausgabe, tokens_cache_schreiben_5m, tokens_cache_schreiben_1h, tokens_cache_lesen)
       VALUES ('n8n:preis-nachrechnen', '2026-06-01T10:00:00Z', 'n8n', 'test', $1, 1000000, 0, 0, 0, 0)`,
      [MODELL],
    );
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  it('lässt die Kosten ohne Preiszeile leer', async () => {
    expect(await kosten()).toBeNull();
  });

  it('rechnet nach dem Anlegen einer passenden Preiszeile nach', async () => {
    await preisAnlegen(2);

    expect(Number(await kosten())).toBe(2);
  });

  it('rechnet nach dem Ändern des Preises neu', async () => {
    await preisAnlegen(2);
    await client.query('UPDATE cockpit.preis SET eingabe = 3 WHERE modell = $1', [MODELL]);

    expect(Number(await kosten())).toBe(3);
  });

  it('lässt eine Preiszeile mit Einsätzen darauf nicht löschen: die Kosten bleiben stehen', async () => {
    await preisAnlegen(2);
    await client.query('ALTER TABLE cockpit.preis DISABLE TRIGGER preis_nie_loeschen');
    await client.query('SAVEPOINT loeschen');
    // Der Fremdschlüssel `verbrauch_preis_id_fkey` greift vor dem Anweisungs-Trigger: ein DELETE kann die Kosten
    // dieser Einsätze nie auf NULL setzen. Der Weg dahin ist erst die Gültigkeit beenden (siehe nächster Test).
    await expect(client.query('DELETE FROM cockpit.preis WHERE modell = $1', [MODELL])).rejects.toThrow(/verbrauch_preis_id_fkey/);
    await client.query('ROLLBACK TO SAVEPOINT loeschen');

    expect(Number(await kosten())).toBe(2);
  });

  it('lässt das Löschen einer Preiszeile ohne Einsätze auf ihr zu, ohne Kosten zu verändern', async () => {
    await preisAnlegen(2);
    // Eine Zeile, auf die ein Einsatz verweist, lässt der Fremdschlüssel nicht löschen (`verbrauch_preis_id_fkey`,
    // er greift vor dem Trigger). Darum erst die Gültigkeit beenden: der Trigger löst den Einsatz von der Zeile.
    await client.query(`UPDATE cockpit.preis SET gueltig_bis = '2026-01-02T00:00:00Z' WHERE modell = $1`, [MODELL]);
    expect(await kosten()).toBeNull();
    // Der Löschschutz ist bewusst im Weg (`preis_nie_loeschen`); wie in 0055 (down) nur für diese Transaktion aus.
    await client.query('ALTER TABLE cockpit.preis DISABLE TRIGGER preis_nie_loeschen');
    await client.query('DELETE FROM cockpit.preis WHERE modell = $1', [MODELL]);

    expect(await kosten()).toBeNull();
  });
});
