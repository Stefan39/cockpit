/**
 * Die gemeinsame erste Prüfung der Routen, die mit einer Sitzung etwas ändern und dafür ein Recht brauchen (Push,
 * COPI-59; App-Symbol, COPI-101): Konto mit Recht, sonst die neutrale 404; dann die Herkunft (`herkunftBelegt`), sonst
 * `403` als JSON.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Zugang, ZugangLesen } from '../../auth/berechtigung.js';
import { herkunftBelegt } from '../../auth/herkunft.js';
import { nichtGefunden } from './neutral.js';

/**
 * Das Konto, wenn `konto` eines liefert und die Anfrage aus dem Cockpit kommt; sonst ist die Antwort schon gesendet.
 * `bereich` steht im Log, wenn die Herkunft fehlt.
 */
export async function kontoMitHerkunft(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  zugangLesen: ZugangLesen,
  konto: (zugang: Zugang) => string | undefined,
  bereich: string,
): Promise<string | undefined> {
  const gefunden = konto(await zugangLesen(request));
  if (gefunden === undefined) {
    await nichtGefunden(app, reply);
    return undefined;
  }
  const { origin, referer, host } = request.headers;
  if (!herkunftBelegt(origin, referer, host)) {
    request.log.warn(`${bereich}: Anfrage abgewiesen (Herkunft)`);
    await reply.code(403).header('cache-control', 'no-store').send({ fehler: 'herkunft' });
    return undefined;
  }
  return gefunden;
}
