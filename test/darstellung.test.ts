/**
 * Der Schalter „Dark Mode" (COPI-43, Prototyp): ohne Skript. Ein Formular schickt `POST /darstellung`, das Cockpit
 * merkt sich die Wahl in einem Cookie und setzt beim Ausliefern jeder HTML-Seite `data-theme` auf `<html>`. Die
 * Farben wählt dann das CSS (`color-scheme`, `light-dark()`). Ohne Wahl folgt die Seite dem Gerät.
 *
 * Die Wahl hängt am Browser, nicht am Konto. Das Rücksprungziel steht in einer festen Form (nur eigene Seiten),
 * damit das Formular nirgendwohin weiterleiten kann.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';
import { DARSTELLUNG_COOKIE, darstellungAusCookie, zurueckPfad } from '../src/server/darstellung.js';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

describe('darstellungAusCookie', () => {
  it.each([
    [`${DARSTELLUNG_COOKIE}=dunkel`, 'dunkel'],
    [`${DARSTELLUNG_COOKIE}=hell`, 'hell'],
    [`andere=1; ${DARSTELLUNG_COOKIE}=dunkel; noch=2`, 'dunkel'],
  ])('liest %s als %s', (kopf, erwartet) => {
    expect(darstellungAusCookie(kopf)).toBe(erwartet);
  });

  it.each([
    ['kein Cookie', undefined],
    ['ein anderer Wert', `${DARSTELLUNG_COOKIE}=lila`],
    ['Markup im Wert', `${DARSTELLUNG_COOKIE}="><script>`],
    ['ein ähnlicher Name', 'darstellung=dunkel'],
  ])('kennt bei %s keine Wahl', (_name, kopf) => {
    expect(darstellungAusCookie(kopf)).toBeUndefined();
  });
});

describe('zurueckPfad', () => {
  it.each(['/', '/meldungen', '/mehr', '/agenten', '/einstellungen'])('lässt die eigene Seite %s zu', (pfad) => {
    expect(zurueckPfad(pfad)).toBe(pfad);
  });

  it.each([
    'https://boese.example/',
    '//boese.example',
    '/\\boese.example',
    '/meldungen?art=fehler',
    '/../api/auth/sign-out',
    '/Meldungen',
    '',
    undefined,
    ['/'],
  ])('macht aus %j die Übersicht', (wert) => {
    expect(zurueckPfad(wert)).toBe('/');
  });
});

describe('Schalter und Auslieferung', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_FAKTOR });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function schalten(felder: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/darstellung',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(felder).toString(),
    });
  }

  it('merkt sich die Wahl ein Jahr lang im Browser und kehrt zur Seite zurück', async () => {
    const antwort = await schalten({ darstellung: 'dunkel', zurueck: '/meldungen' });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/meldungen');
    expect(antwort.headers['set-cookie']).toBe(`${DARSTELLUNG_COOKIE}=dunkel; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`);
  });

  it('kehrt bei einem fremden Ziel zur Übersicht zurück', async () => {
    const antwort = await schalten({ darstellung: 'hell', zurueck: 'https://boese.example/' });

    expect(antwort.headers.location).toBe('/');
    expect(antwort.headers['set-cookie']).toContain(`${DARSTELLUNG_COOKIE}=hell;`);
  });

  it('vergisst bei „Wie System" die Wahl, damit die Seite wieder dem Gerät folgt (COPI-117)', async () => {
    const antwort = await schalten({ darstellung: 'auto', zurueck: '/agenten' });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/agenten');
    expect(antwort.headers['set-cookie']).toBe(`${DARSTELLUNG_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
  });

  it('setzt bei einem unbekannten Wert nichts', async () => {
    const antwort = await schalten({ darstellung: 'lila', zurueck: '/' });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers['set-cookie']).toBeUndefined();
  });

  it('setzt die Wahl als data-theme auf <html>, auf jeder HTML-Seite', async () => {
    for (const url of ['/', '/agenten', '/einstellungen']) {
      const mit = await app.inject({ method: 'GET', url, headers: { cookie: `${DARSTELLUNG_COOKIE}=dunkel` } });
      const ohne = await app.inject({ method: 'GET', url });

      expect(mit.body, url).toContain('<html lang="de" data-theme="dunkel">');
      expect(ohne.body, url).toContain('<html lang="de">');
      expect(ohne.body, url).not.toContain('data-theme');
    }
  });

  it('setzt bei einem unbekannten Cookie-Wert nichts', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/', headers: { cookie: `${DARSTELLUNG_COOKIE}=lila` } });

    expect(antwort.body).not.toContain('data-theme');
  });

  it('gibt einer Seite mit Wahl ein anderes ETag und sagt Zwischenspeichern, dass die Antwort vom Cookie abhängt', async () => {
    const mit = await app.inject({ method: 'GET', url: '/agenten', headers: { cookie: `${DARSTELLUNG_COOKIE}=dunkel` } });
    const ohne = await app.inject({ method: 'GET', url: '/agenten' });

    expect(mit.headers.etag).toBeDefined();
    expect(mit.headers.etag).not.toBe(ohne.headers.etag);
    expect(String(mit.headers.vary)).toMatch(/cookie/i);
  });

  it('lässt andere Antworten unberührt', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/gesund', headers: { cookie: `${DARSTELLUNG_COOKIE}=dunkel` } });

    expect(antwort.body).not.toContain('data-theme');
  });
});
