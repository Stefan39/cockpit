/**
 * `migrieren` mit genau den Rechten, die `docs/installation.md` (Schritt 2) der Rolle `cockpit` gibt (COPI-66). Läuft
 * nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * Die Verwaltung legt die Rolle mit `LOGIN` an und das Schema `cockpit` mit ihr als Eigentümerin, sonst nichts. Die
 * Rolle darf in der Datenbank **keine** weiteren Schemas anlegen. Postgres prüft dieses Recht aber schon bei
 * `CREATE SCHEMA IF NOT EXISTS`, auch wenn das Schema längst da ist. Auf FEWOTEST brach `migrieren` daran bei der
 * ersten Migration mit `permission denied for database` ab. Hier läuft die ganze Kette unter dieser Rolle, damit
 * auch keine spätere Migration mehr verlangt.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationenAnwenden, migrationenLaden } from '../src/datenbank/migrationen.js';
import { leereDatenbankAnlegen, type LeereDatenbank, LEERE_DATENBANK_TIMEOUT_MS } from './leere-datenbank.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

describe.skipIf(!datenbankUrl)('migrieren mit der Rolle aus der Installationsanleitung', { timeout: LEERE_DATENBANK_TIMEOUT_MS }, () => {
  let datenbank: LeereDatenbank;
  let rolle: string;
  let rollenPool: pg.Pool;

  /** Als Verwaltung (der Benutzer von `TEST_DATABASE_URL`) in der frischen Datenbank. */
  async function alsVerwaltung(sql: string): Promise<void> {
    const client = new pg.Client({ connectionString: datenbank.url });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  beforeEach(async () => {
    datenbank = await leereDatenbankAnlegen(datenbankUrl ?? '');
    // Rollen gelten für den ganzen Server: je Test ein eigener Name, nur [a-z0-9_].
    rolle = `cockpit_rolle_${randomBytes(4).toString('hex')}`;
    const passwort = randomBytes(16).toString('hex');
    // Wörtlich Schritt 2 der Anleitung, nur mit Testnamen.
    await alsVerwaltung(`
      CREATE ROLE ${rolle} LOGIN PASSWORD '${passwort}';
      CREATE SCHEMA IF NOT EXISTS cockpit AUTHORIZATION ${rolle};
    `);
    const adresse = new URL(datenbank.url);
    adresse.username = rolle;
    adresse.password = passwort;
    rollenPool = new pg.Pool({ connectionString: adresse.toString() });
  });

  afterEach(async () => {
    await rollenPool.end();
    await datenbank.aufraeumen();
    // Erst nach der Datenbank: dort gehört der Rolle noch das Schema.
    const client = new pg.Client({ connectionString: datenbankUrl });
    await client.connect();
    try {
      await client.query(`DROP ROLE IF EXISTS ${rolle}`);
    } finally {
      await client.end();
    }
  });

  it('hat wirklich kein Recht, Schemas anzulegen', async () => {
    const ergebnis = await rollenPool.query<{ darf: boolean }>(
      "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS darf",
    );
    expect(ergebnis.rows[0]?.darf).toBe(false);
  });

  it('wendet die ganze Kette an, ohne mehr Rechte zu brauchen', async () => {
    const alle = (await migrationenLaden()).map((migration) => migration.id);
    await expect(migrationenAnwenden(rollenPool)).resolves.toEqual(alle);
    // Zweiter Lauf: nichts mehr zu tun, und auch das Verzeichnis sicherzustellen verlangt kein Recht.
    await expect(migrationenAnwenden(rollenPool)).resolves.toEqual([]);
  });
});
