/**
 * Einstieg des Server-Kommandos (COPI-24): nur Verdrahtung. Alles Prüfbare steht
 * in `befehle.ts`.
 *
 *   docker compose exec cockpit node dist/cli/index.js <befehl> ...
 *   npm run cli -- <befehl> ...            (lokal, mit geladener .env)
 *
 * Liest `DATABASE_URL` und `COCKPIT_DOMAIN`/`PORT` wie die Anwendung. Ohne
 * `DATABASE_URL` endet es mit Exit-Code 2.
 */
import { text } from 'node:stream/consumers';
import pg from 'pg';
import { basisUrl, loadEnv } from '../server/env.js';
import { befehlLesen, cliAusfuehren, EXIT_BEDIENUNG } from './befehle.js';

const env = loadEnv();
const argumente = process.argv.slice(2);

// Nur ein Befehl, der die Datenbank braucht, verlangt DATABASE_URL: Hilfe und
// falsche Bedienung sollen auch ohne sie antworten.
const gelesen = befehlLesen(argumente);
const brauchtDatenbank = 'befehl' in gelesen && gelesen.befehl !== 'hilfe' && gelesen.befehl !== 'vapid-erzeugen';
if (brauchtDatenbank && !env.databaseUrl) {
  process.stderr.write('DATABASE_URL ist nicht gesetzt.\n');
  process.exit(EXIT_BEDIENUNG);
}

// Ein Pool verbindet erst bei der ersten Abfrage; ohne Befehl mit Datenbank
// bleibt er ungenutzt.
const pool = new pg.Pool(env.databaseUrl ? { connectionString: env.databaseUrl } : {});
try {
  process.exitCode = await cliAusfuehren(argumente, {
    pool,
    basisUrl: basisUrl(env),
    ausgabe: (zeile) => process.stdout.write(`${zeile}\n`),
    fehlerausgabe: (zeile) => process.stderr.write(`${zeile}\n`),
    // `modul-einspielen` liest den Block von hier; jeder andere Befehl ruft es nie auf.
    eingabeLesen: () => text(process.stdin),
  });
} finally {
  await pool.end();
}
