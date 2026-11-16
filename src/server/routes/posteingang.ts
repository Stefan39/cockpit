/**
 * Der Posteingang im Kopf der Seiten (COPI-112): zwei Routen neben dem Badge, das jede Seite über ihre Navigation zeigt.
 *
 *   * `GET /posteingang` — nur das Badge samt Panel, als fertig escaptes HTML-Stück (`partials/posteingang.eta`). Das
 *     Skript (`pwa.js`) holt es jede Minute, damit die Zahl ohne Neuladen stimmt. Ohne Posteingang (keine Sitzung samt
 *     zweitem Faktor) die neutrale 404.
 *   * `POST /posteingang/gelesen` — „Alle als gelesen": Chat-Lesestand in jedem Kanal auf die jüngste Nachricht, die
 *     Stände der Meldungen und jedes sichtbaren Postfachs auf jetzt. Dieselben Rechte wie beim Lesen (`lesen.ts`).
 *     Die Herkunft ist Pflicht (`herkunftBelegt`, wie beim Chat); danach zurück auf die Seite, von der das Formular kam
 *     — nur deren Pfad, nie ein fremder Host.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { hatRecht, type ZugangLesen } from '../../auth/berechtigung.js';
import { herkunftBelegt } from '../../auth/herkunft.js';
import { alleNachrichtenGelesen } from '../../chat/nachricht-speicher.js';
import { aktiveModule } from '../../module/modul-speicher.js';
import { sichtbarePostfaecher } from '../../posteingang/lesen.js';
import { modulQuelle, QUELLE_MELDUNGEN } from '../../posteingang/posteingang.js';
import { standSetzen } from '../../posteingang/posteingang-speicher.js';
import { nichtGefunden } from './neutral.js';

export interface PosteingangAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly zugangLesen: ZugangLesen;
  readonly jetzt: () => Date;
}

/** Der Pfad (samt Suche) der Seite, von der das Formular kam — nur vom eigenen Host, sonst die Übersicht. */
export function zurueckZu(referer: string | undefined, host: string | undefined): string {
  if (referer === undefined || host === undefined) {
    return '/';
  }
  try {
    const url = new URL(referer);
    return url.host === host && url.pathname.startsWith('/') && !url.pathname.startsWith('//') ? `${url.pathname}${url.search}` : '/';
  } catch {
    return '/';
  }
}

export function registrierePosteingangRouten(app: FastifyInstance, abhaengigkeiten: PosteingangAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt } = abhaengigkeiten;

  app.get('/posteingang', async (request, reply) => {
    const zugang = await zugangLesen(request);
    if (zugang.posteingang === undefined) {
      return nichtGefunden(app, reply);
    }
    const html = await app.render('partials/posteingang.eta', { posteingang: zugang.posteingang });
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });

  app.post('/posteingang/gelesen', async (request, reply) => {
    const zugang = await zugangLesen(request);
    const benutzerId = zugang.benutzerId;
    if (zugang.angemeldet !== true || zugang.zweiterFaktorAktiv !== true || benutzerId === undefined) {
      return nichtGefunden(app, reply);
    }
    const { origin, referer, host } = request.headers;
    if (!herkunftBelegt(origin, referer, host)) {
      request.log.warn('Posteingang: „Alle als gelesen" abgewiesen (Herkunft)');
      return reply.code(403).type('text/plain; charset=utf-8').header('cache-control', 'no-store').send('Die Anfrage kam nicht aus dem Cockpit.');
    }
    const zeitpunkt = jetzt();
    const postfaecher = sichtbarePostfaecher(await aktiveModule(pool), zugang);
    await Promise.all([
      hatRecht(zugang, 'chat_nutzen') ? alleNachrichtenGelesen(pool, benutzerId) : undefined,
      standSetzen(pool, benutzerId, QUELLE_MELDUNGEN, zeitpunkt),
      ...postfaecher.map(({ modul }) => standSetzen(pool, benutzerId, modulQuelle(modul.kennung), zeitpunkt)),
    ]);
    return reply.code(303).header('location', zurueckZu(referer, host)).header('cache-control', 'no-store').send();
  });
}
