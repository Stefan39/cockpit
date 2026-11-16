/**
 * Stylesheet und Schriften unter `/assets/<name>` (COPI-30).
 *
 * Der Name trägt den Hash des Inhalts; deshalb darf der Browser die Datei ein Jahr behalten
 * (`immutable`). Ausgeliefert wird nur, was im Manifest des Builds steht: der Name aus der
 * Anfrage ist ein Schlüssel in einer Tabelle, kein Dateipfad — es gibt keinen Weg aus dem
 * Ordner hinaus, und das Manifest selbst ist nicht abrufbar.
 *
 * Die Route steht in jedem Zustand offen (Tor: `/assets`): schon die Anmeldeseite braucht ihr
 * Stylesheet, und die Einrichtung des zweiten Faktors braucht es, bevor der Faktor da ist.
 */
import type { FastifyInstance } from 'fastify';
import { ASSETS_PFAD, type Assets } from '../../assets/manifest.js';

const UNVERAENDERLICH = 'public, max-age=31536000, immutable';

export function registriereAssetsRoute(app: FastifyInstance, assets: () => Assets): void {
  app.get<{ Params: { datei: string } }>(`${ASSETS_PFAD}/:datei`, async (request, reply) => {
    const asset = assets().datei(request.params.datei);
    if (asset === undefined) {
      return reply.callNotFound();
    }
    return reply
      .type(asset.typ)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', UNVERAENDERLICH)
      .send(asset.inhalt);
  });
}
