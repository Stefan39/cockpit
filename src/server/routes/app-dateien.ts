/**
 * Die Dateien der installierbaren App (COPI-58, ADR 6: „Cockpit ist zwingend installierbare PWA").
 *
 *   * `GET /manifest.webmanifest` — Name der Instanz, `display: standalone`, Start und Geltungsbereich `/`, Symbole.
 *   * `GET /sw.js` — der Service Worker, an der Wurzel, damit er für das ganze Cockpit gilt. Er speichert nichts.
 *   * `GET /icons/<name>.<hash>.png` — das Symbol in 192, 512 (auch `maskable`), 180 px (`apple-touch-icon`) und 32 px
 *     (Favicon): das gezeichnete Standard-Symbol oder ein eigenes (COPI-101, `pwa/symbol-speicher.ts`). Mit dem Hash
 *     des aktuellen Satzes ein Jahr zwischenspeicherbar; ein anderer Hash bekommt das aktuelle Symbol, aber `no-cache`.
 *     Ohne Hash (`/icons/icon-512.png`, wie es installierte Apps kennen) immer das aktuelle, `no-cache`.
 *   * `GET /favicon.ico` — das Favicon (PNG), für Browser, die ohne Verweis danach fragen.
 *   * `GET /pwa.js` — meldet den Service Worker an und zeigt den Stand der Benachrichtigungen (nur angemeldet).
 *
 * Manifest, Service Worker und Symbole stehen vor dem Tor (`APP_DATEIEN` in `zwei-faktor-tor.ts`): der Browser holt das
 * Manifest ohne Cookie. Sie enthalten nichts außer dem Namen der Instanz, den ohnehin jede Seite trägt.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SymbolQuelle } from '../../pwa/symbol-speicher.js';
import { SYMBOL_PFAD, symbolPfad, type SymbolDatei, type SymbolSatz } from '../../pwa/symbol.js';
import { skriptAusliefern, skriptLesen } from './passkey-skript.js';

/** Die Markenfarben (COPI-214): Hintergrund der hellen Seite (Token `page`), Orange. Das Orange färbt auch die Leiste des Browsers (`theme-color`). */
const HINTERGRUND = '#f4f7fa';
export const AKZENT = '#ff6d20';

function manifestBauen(instanzName: string | undefined, satz: SymbolSatz): string {
  return JSON.stringify({
    id: '/',
    name: instanzName ? `Cockpit · ${instanzName}` : 'Cockpit',
    short_name: 'Cockpit',
    lang: 'de',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: HINTERGRUND,
    theme_color: AKZENT,
    icons: [
      { src: symbolPfad(satz, 'icon-192'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: symbolPfad(satz, 'icon-512'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: symbolPfad(satz, 'icon-512'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
}

const EIN_JAHR = 'public, max-age=31536000, immutable';

export function registriereAppDateien(app: FastifyInstance, instanzName: string | undefined, symbole: SymbolQuelle): void {
  app.get('/manifest.webmanifest', async (_request, reply) =>
    reply
      .type('application/manifest+json; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(manifestBauen(instanzName, (await symbole.aktuell()).satz)),
  );

  // Der Service Worker: nie lange zwischengespeichert, sonst käme eine neue Fassung erst Tage später an.
  skriptAusliefern(app, '/sw.js', skriptLesen('sw.js'));
  skriptAusliefern(app, '/pwa.js', skriptLesen('pwa.js'));

  async function symbolSenden(reply: FastifyReply, datei: SymbolDatei, hash: string | undefined): Promise<FastifyReply> {
    const { satz } = await symbole.aktuell();
    return reply
      .type('image/png')
      .header('cache-control', hash === satz.hash ? EIN_JAHR : 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .send(satz.dateien[datei]);
  }

  app.get<{ Params: { datei: string } }>('/icons/:datei', async (request, reply) => {
    const treffer = SYMBOL_PFAD.exec(`/icons/${request.params.datei}`);
    if (treffer === null) {
      return reply.code(404).header('cache-control', 'no-store').send();
    }
    return symbolSenden(reply, treffer[1] as SymbolDatei, treffer[2]);
  });
  app.get('/favicon.ico', async (_request, reply) => symbolSenden(reply, 'favicon-32', undefined));
}
