/**
 * Einmal je Testlauf, vor allen Testdateien (COPI-21): Die Datenbank-Tests
 * bekommen eine eigene Datenbank und nie die Dev-Datenbank.
 *
 *   1. Ohne `TEST_DATABASE_URL` passiert nichts; die Datenbank-Tests werden
 *      übersprungen (mit einem Hinweis, damit „grün" nicht täuscht).
 *   2. Mit `TEST_DATABASE_URL` bricht der Lauf ab, wenn der Datenbankname nicht
 *      auf `_test` endet — bevor irgendein Test etwas löschen kann.
 *   3. Fehlt die Testdatenbank, wird sie angelegt (über die Wartungsdatenbank
 *      `postgres` desselben Servers), und ihr Schema wird migriert. Dafür
 *      braucht es weder einen Docker-Init-Schritt noch einen von Hand
 *      ausgeführten Befehl.
 *
 * Parallel (COPI-73): Nach dem Migrieren entsteht aus `cockpit_test` je Vitest-Worker eine Kopie
 * `<basis>_w<N>_test` (`CREATE DATABASE … TEMPLATE`), `N` = 1 bis `maxWorkers`. `testdatenbank.ts` gibt jedem
 * Worker über `VITEST_POOL_ID` die URL seiner Kopie; so laufen Testdateien gleichzeitig, ohne sich gegenseitig
 * Tabellen abzuräumen. Alte Kopien werden zuvor mit `DROP DATABASE … WITH (FORCE)` ersetzt. Die Kopien heißen
 * auf `_test`, die Schutzschicht aus COPI-21 gilt für sie unverändert.
 *
 * Migriert wird mit demselben Runner wie `npm run migrate`, in einem eigenen
 * Prozess mit ausdrücklich gesetzter `DATABASE_URL`: Der Runner liest nur diese
 * Variable, und die des Aufrufers (die Dev-Datenbank) darf ihn nie erreichen.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { pruefeTestDatenbankUrl, workerDatenbankName } from './testdatenbank.js';

const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Nur ein Name, den `pruefeTestDatenbankUrl` schon auf `[A-Za-z0-9_]+_test` geprüft hat. */
async function datenbankAnlegenFallsFehlt(url: string, name: string): Promise<void> {
  const wartung = new URL(url);
  wartung.pathname = '/postgres';
  const client = new pg.Client({ connectionString: wartung.toString() });
  try {
    await client.connect();
    const vorhanden = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (vorhanden.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name}"`);
    }
    // Tests räumen ihre Tabellen ab; die Sperre `nie_loeschen()` (0025) lässt das nur hier zu — mit dieser
    // Einstellung und in einer Datenbank, deren Name auf `_test` endet. Gilt für jede neue Verbindung.
    await client.query(`ALTER DATABASE "${name}" SET cockpit.testdaten_loeschen = 'ja'`);
  } catch (fehler) {
    const grund = fehler instanceof Error ? fehler.message : 'unbekannt';
    throw new Error(
      `Testdatenbank "${name}" konnte nicht angelegt werden (${grund}). ` +
        `Von Hand anlegen: createdb ${name}`,
      { cause: fehler },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Ersetzt die Worker-Kopien `1..anzahl` durch frische Kopien der migrierten Vorlage (COPI-73). Die Vorlage darf
 * dabei keine offene Verbindung haben — migriert wurde in einem eigenen Prozess, der beendet ist. Namen kommen aus
 * `workerDatenbankName` und bestehen nur aus [A-Za-z0-9_].
 */
async function workerKopienAnlegen(url: string, vorlage: string, anzahl: number): Promise<void> {
  const wartung = new URL(url);
  wartung.pathname = '/postgres';
  const client = new pg.Client({ connectionString: wartung.toString() });
  try {
    await client.connect();
    for (let n = 1; n <= anzahl; n += 1) {
      const name = workerDatenbankName(vorlage, n);
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await client.query(`CREATE DATABASE "${name}" TEMPLATE "${vorlage}"`);
      // TEMPLATE kopiert keine Datenbank-Einstellungen: je Kopie neu setzen (siehe `datenbankAnlegenFallsFehlt`).
      await client.query(`ALTER DATABASE "${name}" SET cockpit.testdaten_loeschen = 'ja'`);
    }
  } catch (fehler) {
    const grund = fehler instanceof Error ? fehler.message : 'unbekannt';
    throw new Error(`Worker-Kopien der Testdatenbank konnten nicht angelegt werden (${grund}).`, { cause: fehler });
  } finally {
    await client.end().catch(() => undefined);
  }
}

function migrieren(url: string): void {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', 'db/migrate.ts', 'up'], {
      cwd: wurzel,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  } catch (fehler) {
    const ausgabe =
      fehler instanceof Error && 'stderr' in fehler ? String((fehler as { stderr: unknown }).stderr) : '';
    throw new Error(`Migration der Testdatenbank fehlgeschlagen:\n${ausgabe}`, { cause: fehler });
  }
}

export default async function setup(projekt: TestProject): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    process.stderr.write(
      'Datenbank-Tests übersprungen: TEST_DATABASE_URL ist nicht gesetzt ' +
        '(DATABASE_URL lesen die Tests nie).\n',
    );
    return;
  }
  const name = pruefeTestDatenbankUrl(url);
  await datenbankAnlegenFallsFehlt(url, name);
  migrieren(url);
  await workerKopienAnlegen(url, name, projekt.config.maxWorkers);
}
