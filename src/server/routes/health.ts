import type { FastifyInstance } from 'fastify';

/**
 * Health-Endpunkt für Container-Healthcheck und die Zustandswache
 * (Architektur-Vorschlag Abschnitt 4: das Cockpit prüft sich selbst nur auf
 * "läuft", niemals auf fachliche Zustände — die kommen aus cockpit.befund).
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/gesund', async () => {
    return { status: 'ok', zeit: new Date().toISOString() };
  });
}
