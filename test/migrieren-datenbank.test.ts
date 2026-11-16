/**
 * Der Befehl `migrieren` des Server-Kommandos gegen eine echte PostgreSQL (COPI-31). Läuft nur,
 * wenn `TEST_DATABASE_URL` gesetzt ist. Jeder Test bekommt eine eigene, leere Datenbank.
 *
 * Das ist der Weg, auf dem auf einer neuen Kundeninstanz das Schema entsteht und bei einem Update
 * nachgezogen wird: `docker compose run --rm cockpit node dist/cli/index.js migrieren`. Geprüft
 * werden Ausgabe und Exit-Codes, so wie ein Betreiber sie sieht.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONEN_ORDNER, migrationenLaden } from '../src/datenbank/migrationen.js';
import { cliAusfuehren } from '../src/cli/befehle.js';
import { leereDatenbankAnlegen, migrationsOrdnerBauen, type LeereDatenbank, LEERE_DATENBANK_TIMEOUT_MS } from './leere-datenbank.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

interface Lauf {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe.skipIf(!datenbankUrl)('Befehl migrieren (echte Datenbank)', { timeout: LEERE_DATENBANK_TIMEOUT_MS }, () => {
  let datenbank: LeereDatenbank;
  let pool: pg.Pool;
  const aufraeumer: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    datenbank = await leereDatenbankAnlegen(datenbankUrl ?? '');
    pool = datenbank.neuerPool();
  });

  afterEach(async () => {
    for (const aufraeumen of aufraeumer.splice(0)) {
      await aufraeumen();
    }
    await datenbank.aufraeumen();
  });

  async function laufen(argumente: string[], migrationsOrdner?: string): Promise<Lauf> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await cliAusfuehren(['migrieren', ...argumente], {
      pool,
      basisUrl: 'http://localhost:3000',
      ausgabe: (text) => stdout.push(text),
      fehlerausgabe: (text) => stderr.push(text),
      ...(migrationsOrdner === undefined ? {} : { migrationsOrdner }),
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  async function angewendeteIds(): Promise<string[]> {
    const ergebnis = await pool.query<{ id: string }>('SELECT id FROM cockpit.schema_migrations ORDER BY id');
    return ergebnis.rows.map((zeile) => zeile.id);
  }

  describe('anwenden', () => {
    it('legt aus einer leeren Datenbank das ganze Schema an und meldet jede Migration', async () => {
      const alle = (await migrationenLaden()).map((migration) => migration.id);

      const lauf = await laufen([]);

      expect(lauf.code).toBe(0);
      expect(lauf.stderr).toBe('');
      for (const id of alle) {
        expect(lauf.stdout, id).toContain(`angewendet: ${id}`);
      }
      expect(lauf.stdout).toContain(`${String(alle.length)} Migrationen angewendet.`);
      expect(await angewendeteIds()).toEqual(alle);
    });

    it('tut beim zweiten Aufruf nichts und sagt das', async () => {
      await laufen([]);

      const zweiter = await laufen([]);

      expect(zweiter.code).toBe(0);
      expect(zweiter.stdout).toBe('Das Schema ist auf dem Stand: nichts zu tun.');
      expect(zweiter.stdout).not.toContain('angewendet:');
    });

    it('meldet eine kaputte Migration mit Namen, Exit 1, und behält die vorherigen', async () => {
      const gebaut = await migrationsOrdnerBauen([
        { id: '0001_eins', up: 'CREATE TABLE cockpit.probe_a (id int)', down: 'DROP TABLE cockpit.probe_a' },
        { id: '0002_kaputt', up: 'SELECT 1 / 0', down: 'SELECT 1' },
      ]);
      aufraeumer.push(gebaut.aufraeumen);

      const lauf = await laufen([], gebaut.ordner);

      expect(lauf.code).toBe(1);
      expect(lauf.stdout).toContain('angewendet: 0001_eins');
      expect(lauf.stderr).toContain('0002_kaputt');
      expect(lauf.stderr).toContain('division by zero');
      expect(await angewendeteIds()).toEqual(['0001_eins']);
    });

    it('nennt in keiner Ausgabe die Adresse oder die Zugangsdaten der Datenbank', async () => {
      // Auch nicht im Fehlerfall: die Meldung eines Datenbankfehlers kann eine Adresse mitführen.
      const gebaut = await migrationsOrdnerBauen([{ id: '0001_kaputt', up: 'SELECT 1 / 0', down: 'SELECT 1' }]);
      aufraeumer.push(gebaut.aufraeumen);

      const gut = await laufen([]);
      const kaputt = await laufen([], gebaut.ordner);

      const adresse = new URL(datenbank.url);
      for (const ausgabe of [gut.stdout + gut.stderr, kaputt.stdout + kaputt.stderr]) {
        expect(ausgabe).not.toContain('postgres://');
        expect(ausgabe).not.toContain(adresse.host);
        expect(ausgabe).not.toContain(`${adresse.username}:${adresse.password}`);
      }
    });
  });

  describe('--status', () => {
    it('zeigt auf einer leeren Datenbank alles als ausstehend und ändert nichts', async () => {
      const alle = (await migrationenLaden()).map((migration) => migration.id);

      const lauf = await laufen(['--status']);

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain('Das Schema cockpit fehlt in der Datenbank.');
      for (const id of alle) {
        expect(lauf.stdout, id).toContain(`ausstehend   ${id}`);
      }
      const schema = await pool.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'cockpit'`);
      expect(schema.rowCount).toBe(0);
    });

    it('zeigt angewendete, ausstehende und unbekannte Migrationen', async () => {
      await laufen([]);
      const alle = (await migrationenLaden()).map((migration) => migration.id);
      const letzte = alle[alle.length - 1] ?? '';
      await pool.query('DELETE FROM cockpit.schema_migrations WHERE id = $1', [letzte]);
      await pool.query(`INSERT INTO cockpit.schema_migrations (id) VALUES ('9999_aus_der_zukunft')`);

      const lauf = await laufen(['--status']);

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain('angewendet   0001_init');
      expect(lauf.stdout).toContain(`ausstehend   ${letzte}`);
      expect(lauf.stdout).toContain('unbekannt    9999_aus_der_zukunft');
    });
  });

  describe('--zurueck', () => {
    it('verlangt eine ausdrückliche Bestätigung und rührt ohne sie nichts an (Exit 2)', async () => {
      await laufen([]);
      const vorher = await angewendeteIds();

      const lauf = await laufen(['--zurueck']);

      expect(lauf.code).toBe(2);
      expect(lauf.stdout).toBe('');
      expect(lauf.stderr).toContain('--bestaetigt');
      expect(lauf.stderr).toMatch(/Daten/);
      expect(await angewendeteIds()).toEqual(vorher);
    });

    it('nimmt mit --bestaetigt genau die letzte Migration zurück', async () => {
      await laufen([]);
      const alle = (await migrationenLaden()).map((migration) => migration.id);

      const lauf = await laufen(['--zurueck', '--bestaetigt']);

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toBe(`zurückgenommen: ${alle[alle.length - 1] ?? ''}`);
      expect(await angewendeteIds()).toEqual(alle.slice(0, -1));
    });

    it('nimmt 0056 (Staffelpreis) auch mit einem Einsatz exakt zum Staffelbeginn zurück (COPI-223)', async () => {
      await laufen([]);
      await pool.query(
        `INSERT INTO cockpit.verbrauch (schluessel, zeitpunkt, quelle, modell, tokens_eingabe, tokens_ausgabe,
                tokens_cache_schreiben_5m, tokens_cache_schreiben_1h, tokens_cache_lesen, gemeldet_von)
         VALUES ('rollback:staffel', '2026-10-01T00:00:00Z', 'claude-code', 'claude-haiku-5-5', 150000, 0, 0, 0, 0, 'test')`,
      );
      expect((await pool.query<{ kosten: string }>(`SELECT kosten FROM cockpit.verbrauch`)).rows[0]?.kosten).toBe('0.075000');

      const down = await readFile(path.join(MIGRATIONEN_ORDNER, '0056_preis_staffel.down.sql'), 'utf8');
      await pool.query(down);

      const einsatz = await pool.query<{ kosten: string }>(`SELECT kosten FROM cockpit.verbrauch`);
      expect(einsatz.rows[0]?.kosten).toBe('0.015000');
      const spalte = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'cockpit' AND table_name = 'preis' AND column_name = 'prompt_ab'`);
      expect(spalte.rowCount).toBe(0);
    });

    it('sagt bei einer Datenbank ohne Schema, dass es nichts zurückzunehmen gibt (Exit 0)', async () => {
      const lauf = await laufen(['--zurueck', '--bestaetigt']);

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toBe('Keine Migration zum Zurücknehmen.');
    });
  });
});
