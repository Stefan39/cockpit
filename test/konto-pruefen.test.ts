/**
 * Die gemeinsame erste Prüfung der schreibenden Routen mit Sitzung (COPI-59, COPI-101): ohne Konto die neutrale 404,
 * ohne passende Herkunft `403` als JSON. Geprüft direkt über eine Probe-Route, `zugangLesen` und `konto` sind Fakes.
 * Ohne Datenbank.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OHNE_ZUGANG, type Zugang } from '../src/auth/berechtigung.js';
import { kontoMitHerkunft } from '../src/server/routes/konto-pruefen.js';

const HOST = 'cockpit.test';

describe('kontoMitHerkunft', () => {
  let app: FastifyInstance;
  let konto: string | undefined;
  let rueckgabe: string | undefined;
  let gelesen: number;

  beforeAll(async () => {
    // Eine kleine App ohne Tor; `render` ist ein Fake, nur die Antwort von `nichtGefunden` zählt.
    app = Fastify();
    app.decorate('render', async (vorlage: string, daten: Record<string, unknown> = {}) => `${vorlage}:${String(daten.titel)}`);
    app.post('/probe', async (request, reply) => {
      rueckgabe = await kontoMitHerkunft(
        app,
        request,
        reply,
        async () => {
          gelesen += 1;
          return OHNE_ZUGANG;
        },
        (_zugang: Zugang) => konto,
        'probe',
      );
      if (rueckgabe !== undefined) {
        return reply.code(200).send({ konto: rueckgabe });
      }
      return reply;
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    konto = undefined;
    rueckgabe = 'unberührt';
    gelesen = 0;
  });

  function senden(headers: Record<string, string>) {
    return app.inject({ method: 'POST', url: '/probe', headers: { host: HOST, ...headers } });
  }

  it('antwortet ohne Konto mit derselben neutralen 404 wie nichtGefunden und gibt undefined zurück', async () => {
    const erwartet = await app.render('nicht-gefunden.eta', { titel: 'Nicht gefunden' });
    const antwort = await senden({ origin: `https://${HOST}` });
    expect(gelesen).toBe(1);
    expect(antwort.statusCode).toBe(404);
    expect(antwort.headers['content-type']).toContain('text/html');
    expect(antwort.body).toBe(erwartet);
    expect(rueckgabe).toBeUndefined();
  });

  it('gibt bei vorhandenem Konto und passendem Origin das Konto zurück, die Route antwortet normal', async () => {
    konto = 'konto-1';
    const antwort = await senden({ origin: `https://${HOST}` });
    expect(antwort.statusCode).toBe(200);
    expect(antwort.json()).toEqual({ konto: 'konto-1' });
    expect(rueckgabe).toBe('konto-1');
  });

  it.each([
    ['fremdem Origin', { origin: 'https://fremd.example' }],
    ['Origin: null', { origin: 'null' }],
    ['fehlender Herkunftsangabe', {}],
    ['fremdem Referer', { referer: 'https://fremd.example/seite' }],
  ])('weist bei vorhandenem Konto und %s mit 403 ab', async (_name, headers) => {
    konto = 'konto-1';
    const antwort = await senden(headers);
    expect(antwort.statusCode).toBe(403);
    expect(antwort.json()).toEqual({ fehler: 'herkunft' });
    expect(antwort.headers['cache-control']).toBe('no-store');
    expect(rueckgabe).toBeUndefined();
  });

  it('lässt bei vorhandenem Konto einen Referer mit passendem Host zu', async () => {
    konto = 'konto-1';
    const antwort = await senden({ referer: `https://${HOST}/einstellungen` });
    expect(antwort.statusCode).toBe(200);
    expect(rueckgabe).toBe('konto-1');
  });
});
