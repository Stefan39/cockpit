import pg from 'pg';
import { migrationenAnwenden, migrationZuruecknehmen } from '../src/datenbank/migrationen.js';

/**
 * Der Aufruf für die Entwicklung: `npm run migrate` (anwenden) und `npm run migrate:down` (die
 * letzte Migration zurücknehmen), dazu das Setup der Testdatenbank und die CI.
 *
 * Die Arbeit macht `src/datenbank/migrationen.ts` — derselbe Runner, den das Image für den Befehl
 * `migrieren` des Server-Kommandos mitbringt (COPI-31). Diese Datei ist nur der Einstieg über `tsx`
 * und bleibt bewusst dünn: eine zweite Implementierung würde von der im Image abweichen.
 *
 * Nutzung: `tsx db/migrate.ts up` oder `tsx db/migrate.ts down` (nimmt genau die zuletzt
 * angewendete Migration zurück). Liest nur `DATABASE_URL`.
 */

async function main(): Promise<void> {
  const richtung = process.argv[2];
  if (richtung !== 'up' && richtung !== 'down') {
    throw new Error('Nutzung: tsx db/migrate.ts <up|down>');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL ist nicht gesetzt');
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    if (richtung === 'up') {
      await migrationenAnwenden(pool, {
        // eslint-disable-next-line no-console
        angewendet: (id) => console.log(`angewendet: ${id}`),
      });
    } else {
      const id = await migrationZuruecknehmen(pool);
      // eslint-disable-next-line no-console
      console.log(id === undefined ? 'keine Migration zum Zurücknehmen' : `zurückgenommen: ${id}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
