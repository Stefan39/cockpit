/**
 * Das Aufräumen der Wegwerf-Datenbanken (COPI-44).
 *
 * Befund aus der CI auf `main` (Lauf 35628376288): alle Tests grün, der Lauf trotzdem rot — ein unbehandelter
 * Fehler `terminating connection due to administrator command` (57P01). `pool.end()` meldet „fertig", bevor die
 * Verbindungen wirklich geschlossen sind; das `DROP DATABASE … WITH (FORCE)` danach traf eine Verbindung im
 * Schließen, Postgres beendete sie, und der Pool meldete das als `error`-Ereignis, auf das niemand hörte. Ein
 * Rennen, das lokal kaum auftritt.
 *
 * Die Tests hier erzeugen den Mechanismus deterministisch: sie beenden die Verbindungen eines Pools von außen,
 * so wie es das FORCE tut. Sie zählen Fehler, die bis zum Prozess durchschlagen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { leereDatenbankAnlegen } from './leere-datenbank.js';
import { testDatenbankUrl } from './testdatenbank.js';

/** Beendet jede Verbindung zu dieser Datenbank, so wie `DROP DATABASE … WITH (FORCE)` es tut. */
async function verbindungenBeenden(url: string, name: string): Promise<number> {
  const wartung = new URL(url);
  wartung.pathname = '/postgres';
  const client = new pg.Client({ connectionString: wartung.toString() });
  await client.connect();
  try {
    const ergebnis = await client.query<{ n: number }>(
      'SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    return ergebnis.rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

const pause = (ms: number): Promise<void> => new Promise((weiter) => setTimeout(weiter, ms));

describe.skipIf(!testDatenbankUrl)('Wegwerf-Datenbanken aufräumen (echte Datenbank)', () => {
  const durchgeschlagen: unknown[] = [];
  const merken = (fehler: unknown): void => {
    durchgeschlagen.push(fehler);
  };
  const meldungen = (): string[] => durchgeschlagen.map((fehler) => (fehler instanceof Error ? fehler.message : String(fehler)));

  beforeAll(() => {
    process.on('uncaughtException', merken);
  });

  beforeEach(() => {
    durchgeschlagen.length = 0;
  });

  afterAll(() => {
    process.off('uncaughtException', merken);
  });

  it('lässt keinen Fehler durchschlagen, wenn das Aufräumen die Verbindungen eines Pools von außen beendet', async () => {
    const datenbank = await leereDatenbankAnlegen(testDatenbankUrl ?? '');
    try {
      const pool = datenbank.neuerPool();
      // Drei Verbindungen, die danach ungenutzt im Pool liegen — wie nach einem Test, der zuletzt noch gefragt hat.
      await Promise.all([1, 2, 3].map(() => pool.query('SELECT pg_sleep(0.01)')));

      expect(await verbindungenBeenden(datenbank.url, datenbank.name)).toBe(3);
      await pause(300);

      expect(meldungen()).toEqual([]);
    } finally {
      await datenbank.aufraeumen();
    }
  });

  it('wartet vor dem Löschen, bis die Pools ihre Verbindungen wirklich geschlossen haben', async () => {
    const datenbank = await leereDatenbankAnlegen(testDatenbankUrl ?? '');
    const pool = datenbank.neuerPool();
    await Promise.all([1, 2, 3].map(() => pool.query('SELECT 1')));

    await datenbank.aufraeumen();
    await pause(200);

    expect(meldungen()).toEqual([]);
    const wartung = new URL(testDatenbankUrl ?? '');
    wartung.pathname = '/postgres';
    const client = new pg.Client({ connectionString: wartung.toString() });
    await client.connect();
    try {
      const gibtEs = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [datenbank.name]);
      expect(gibtEs.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});
