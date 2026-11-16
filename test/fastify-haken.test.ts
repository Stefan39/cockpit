/**
 * Worauf das Tor sich bei Fastify verlässt (COPI-29) — rein, ohne Datenbank.
 *
 * Das zentrale Tor ist ein `onRequest`-Haken auf der Wurzel (`registriereZweiFaktorTor`). Die
 * Aussage „jede Route liegt dahinter" gilt nur, wenn Fastify diesen Haken auch für Routen
 * anwendet, die **vor** ihm oder in **Plugins** registriert werden — sonst wäre die Reihenfolge
 * in `buildApp` eine Sicherheitsfrage. Gemessen an Fastify 5: er gilt für alle vier Fälle unten,
 * die Reihenfolge ist keine Lücke. Der Test hält das fest: ändert ein Update das Verhalten, wird er
 * rot, und die Reihenfolge in `buildApp` muss neu bedacht werden. Der Routen-Test
 * (`routen-tor-datenbank.test.ts`) prüft, dass keine Route am Tor vorbeikommt; dieser hier, warum
 * das so ist.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

function haken(app: FastifyInstance): void {
  app.addHook('onRequest', async (_anfrage, antwort) => antwort.code(401).send('zu'));
}

function offeneRoute(app: FastifyInstance): void {
  app.get('/geschuetzt', async () => 'offen');
}

async function status(aufbau: (app: FastifyInstance) => void): Promise<number> {
  const app = Fastify();
  aufbau(app);
  const antwort = await app.inject({ method: 'GET', url: '/geschuetzt' });
  await app.close();
  return antwort.statusCode;
}

describe('Ein Haken auf der Wurzel gilt für jede Route', () => {
  it.each([
    ['für eine Route, die nach ihm registriert wird', (app: FastifyInstance) => { haken(app); offeneRoute(app); }],
    ['für eine Route, die vor ihm registriert wird', (app: FastifyInstance) => { offeneRoute(app); haken(app); }],
    [
      'für eine Route in einem gekapselten Plugin, das vor ihm registriert wird',
      (app: FastifyInstance) => {
        void app.register(async (kind) => { offeneRoute(kind); });
        haken(app);
      },
    ],
    [
      'für eine Route in einem gekapselten Plugin, das nach ihm registriert wird',
      (app: FastifyInstance) => {
        haken(app);
        void app.register(async (kind) => { offeneRoute(kind); });
      },
    ],
  ])('%s', async (_beschreibung, aufbau) => {
    expect(await status(aufbau)).toBe(401);
  });

  it('lässt eine Route ohne Haken offen: der Test misst also etwas', async () => {
    expect(await status(offeneRoute)).toBe(200);
  });
});
