/**
 * Die eine Better-Auth-Instanz für Werkzeuge außerhalb des Servers.
 *
 * Diese Datei ist die Konfigurationsdatei für die Better-Auth-CLI:
 *   npx auth@latest generate --config src/auth/auth.ts
 * Daher der Export unter dem von der CLI erwarteten Namen `auth`.
 *
 * Der Server selbst baut seine Instanz in `src/server/index.ts`, weil er
 * denselben Verbindungspool auch für die Erststart-Tabelle braucht.
 */
import { basisUrl, loadEnv } from '../server/env.js';
import { erzeugeAuth, geheimnisBesorgen } from './konfiguration.js';

const env = loadEnv();

export const auth = erzeugeAuth({
  databaseUrl: env.databaseUrl ?? '',
  basisUrl: basisUrl(env),
  secret: geheimnisBesorgen(env),
});
