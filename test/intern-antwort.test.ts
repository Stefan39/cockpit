/**
 * `antworten` (COPI-35, COPI-36): die Fehlerantworten der Agenten-API, ohne Datenbank, mit einer kleinen
 * Fastify-App und `inject`. Erwartete Werte (Statuscodes, Header, Body) stehen als Literale.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { antworten } from '../src/intern/antwort.js';

/** Eine App mit einer Route, die `antworten` mit den übergebenen Argumenten aufruft. */
function appMit(...args: [number, string, Record<string, string>?, Record<string, unknown>?]) {
  const app = Fastify();
  app.get('/probe', async (_request, reply) => antworten(reply, ...args));
  return app;
}

describe('antworten', () => {
  it('setzt den Statuscode', async () => {
    const app = appMit(403, 'verboten');
    const antwort = await app.inject({ method: 'GET', url: '/probe' });
    expect(antwort.statusCode).toBe(403);
    await app.close();
  });

  it('liefert den Body als { "fehler": "…" }', async () => {
    const app = appMit(400, 'ungueltig');
    const antwort = await app.inject({ method: 'GET', url: '/probe' });
    expect(antwort.headers['content-type']).toMatch(/^application\/json/);
    expect(antwort.json()).toEqual({ fehler: 'ungueltig' });
    await app.close();
  });

  it('setzt cache-control: no-store immer', async () => {
    const app = appMit(404, 'unbekannt');
    const antwort = await app.inject({ method: 'GET', url: '/probe' });
    expect(antwort.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('lässt zusätzliche Header aus kopf ankommen und behält no-store', async () => {
    const app = appMit(429, 'zu viele Anfragen', { 'retry-after': '30' });
    const antwort = await app.inject({ method: 'GET', url: '/probe' });
    expect(antwort.headers['retry-after']).toBe('30');
    expect(antwort.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('schreibt Felder aus zusatz neben fehler in den Body', async () => {
    const app = appMit(413, 'zu gross', {}, { grenze: 1024 });
    const antwort = await app.inject({ method: 'GET', url: '/probe' });
    expect(antwort.statusCode).toBe(413);
    expect(antwort.json()).toEqual({ fehler: 'zu gross', grenze: 1024 });
    await app.close();
  });
});
