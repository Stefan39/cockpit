/**
 * Das Browser-Skript für Passkeys (`assets/js/passkey.js`, COPI-26 und COPI-27).
 *
 * Eine Datei für beide Seiten: die Einrichtung (`/zwei-faktor`) und die Anmeldung
 * (`/anmelden/code`). Das Skript sucht sein Formular selbst (`data-passkey` oder
 * `data-passkey-anmelden`) und tut nichts, wenn keines da ist. Ausgeliefert wird es vom
 * Cockpit selbst, an zwei Adressen: hinter dem Tor für die Einrichtung, und unter
 * `/anmelden/…` schon ohne Sitzung für die Anmeldung. Es enthält kein Geheimnis.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/** Von `src/server/routes` und `dist/server/routes` aus zeigen drei Ordner nach oben auf die Wurzel. */
const SKRIPT_ORDNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'js');

/** Ein Browser-Skript aus `assets/js`, beim Start gelesen: fehlt die Datei im Image, startet die Anwendung nicht. */
export function skriptLesen(datei: 'passkey.js' | 'chat.js' | 'pwa.js' | 'sw.js' | 'erscheinungsbild.js'): string {
  return readFileSync(path.join(SKRIPT_ORDNER, datei), 'utf8');
}

export function passkeySkriptLesen(): string {
  return skriptLesen('passkey.js');
}

export function skriptAusliefern(app: FastifyInstance, pfad: string, skript: string): void {
  app.get(pfad, async (_request, reply) => {
    return reply
      .type('text/javascript; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-cache')
      .send(skript);
  });
}
