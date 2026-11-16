/**
 * Wegwerfbare Datenbanken für die Migrationstests (COPI-31).
 *
 * Die übrigen Datenbank-Tests teilen sich eine migrierte Testdatenbank. Ob aus einer **leeren**
 * Datenbank das ganze Schema entsteht, lässt sich damit nicht prüfen — dafür braucht jeder Test
 * seine eigene, frische. Sie liegt auf demselben Server wie `TEST_DATABASE_URL`, heißt
 * `<testdatenbank>_leer_<zufall>_test` (und endet damit auf `_test`, wie es die Schutzschicht
 * verlangt) und wird am Ende samt Verbindungen gelöscht.
 *
 * Dazu ein Ordner mit erfundenen Migrationen (`migrationsOrdnerBauen`), um Fehlerfälle zu
 * erzeugen, die die echten Migrationen nicht hergeben (eine kaputte, eine fehlende `down`).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pruefeTestDatenbankUrl } from './testdatenbank.js';

export interface LeereDatenbank {
  readonly name: string;
  /** Die URL dieser Datenbank, etwa für einen Prozess, der sie über `DATABASE_URL` bekommt. */
  readonly url: string;
  /** Ein neuer Pool auf diese Datenbank; `aufraeumen` schließt alle. */
  neuerPool(): pg.Pool;
  aufraeumen(): Promise<void>;
}

/**
 * Zeitgrenze je Test für Tests auf einer leeren Datenbank (COPI-110): Sie spielen die ganze Kette der Migrationen ein,
 * oft vor- und rückwärts, und werden mit jeder Migration langsamer. Auf dem CI-Runner (zwei Kerne) riss beim Release
 * v0.15.0 die Standardgrenze von 5 s; lokal braucht der langsamste Test unter einer Sekunde.
 */
export const LEERE_DATENBANK_TIMEOUT_MS = 60_000;

/** `admin_shutdown`: Postgres hat die Verbindung beendet, hier durch unser eigenes `DROP DATABASE … WITH (FORCE)`. */
const VON_AUSSEN_BEENDET = '57P01';

/** Wie lange das Aufräumen höchstens wartet, bis die Verbindungen der Pools wirklich zu sind. */
const SCHLIESSEN_HOECHSTENS_MS = 5000;

function wartungsUrl(url: string): string {
  const wartung = new URL(url);
  wartung.pathname = '/postgres';
  return wartung.toString();
}

export async function leereDatenbankAnlegen(testDatenbankUrl: string): Promise<LeereDatenbank> {
  const basis = pruefeTestDatenbankUrl(testDatenbankUrl).replace(/_test$/, '');
  const name = `${basis}_leer_${randomBytes(4).toString('hex')}_test`;
  const adresse = new URL(testDatenbankUrl);
  adresse.pathname = `/${name}`;
  const url = adresse.toString();

  const wartung = new pg.Client({ connectionString: wartungsUrl(testDatenbankUrl) });
  await wartung.connect();
  try {
    // `name` besteht nur aus [a-z0-9_] (Schutzschicht plus hex): kein Fremdwert im SQL.
    await wartung.query(`CREATE DATABASE "${name}"`);
    // Wie in `global-setup.ts`: Tests dürfen hier abräumen (0025).
    await wartung.query(`ALTER DATABASE "${name}" SET cockpit.testdaten_loeschen = 'ja'`);
  } finally {
    await wartung.end();
  }

  const pools: pg.Pool[] = [];
  return {
    name,
    url,
    neuerPool() {
      const pool = new pg.Pool({ connectionString: url });
      // Ohne Listener schlägt ein Fehler einer ruhenden Verbindung bis zum Prozess durch (COPI-44). Erwartet ist
      // genau einer: das Aufräumen beendet die Verbindungen mit FORCE. Jeder andere bleibt ein Fehler.
      pool.on('error', (fehler: Error & { code?: string }) => {
        if (fehler.code !== VON_AUSSEN_BEENDET) {
          throw fehler;
        }
      });
      pools.push(pool);
      return pool;
    },
    async aufraeumen() {
      await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
      const client = new pg.Client({ connectionString: wartungsUrl(testDatenbankUrl) });
      await client.connect();
      try {
        // `pool.end()` meldet „fertig", bevor die Verbindungen wirklich zu sind (COPI-44). Erst warten, bis die
        // Datenbank keine mehr hat; FORCE bleibt der Rückfall für eine, die hängt (etwa die eines beendeten Prozesses).
        const ende = Date.now() + SCHLIESSEN_HOECHSTENS_MS;
        while (Date.now() < ende) {
          const offen = await client.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
            [name],
          );
          if ((offen.rows[0]?.n ?? 0) === 0) {
            break;
          }
          await new Promise((weiter) => setTimeout(weiter, 50));
        }
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

export interface ErfundeneMigration {
  readonly id: string;
  readonly up: string;
  /** Ohne Angabe: kein `down`-Paar (die Datei fehlt). */
  readonly down?: string;
}

/** Ein Ordner mit erfundenen Migrationen; `aufraeumen` löscht ihn. */
export async function migrationsOrdnerBauen(
  migrationen: readonly ErfundeneMigration[],
): Promise<{ readonly ordner: string; aendern(id: string, up: string): Promise<void>; aufraeumen(): Promise<void> }> {
  const ordner = await mkdtemp(path.join(tmpdir(), 'cockpit-migrationen-'));
  await mkdir(ordner, { recursive: true });
  for (const migration of migrationen) {
    await writeFile(path.join(ordner, `${migration.id}.up.sql`), migration.up);
    if (migration.down !== undefined) {
      await writeFile(path.join(ordner, `${migration.id}.down.sql`), migration.down);
    }
  }
  return {
    ordner,
    async aendern(id, up) {
      await writeFile(path.join(ordner, `${id}.up.sql`), up);
    },
    async aufraeumen() {
      await rm(ordner, { recursive: true, force: true });
    },
  };
}
