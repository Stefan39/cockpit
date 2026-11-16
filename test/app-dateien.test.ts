/**
 * Die Dateien der installierbaren App (COPI-58): Manifest, Service Worker und Symbole — ohne Anmeldung erreichbar, weil
 * der Browser das Manifest ohne Cookie holt, aber **genau** diese Pfade und nichts darunter. Dazu das Symbol selbst:
 * ein gültiges PNG in der verlangten Größe. Ohne Datenbank.
 */
import type { FastifyInstance } from 'fastify';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_DATEIEN, torEntscheidung } from '../src/auth/zwei-faktor-tor.js';
import { aufMotiv, iconPng } from '../src/pwa/icon.js';
import { standardSymbolSatz } from '../src/pwa/symbol.js';
import { buildApp } from '../src/server/app.js';
import { navigation } from '../src/server/navigation.js';

/** Liest Breite, Höhe und die Farbe eines Pixels aus einem PNG (RGB, 8 Bit, Filter 0), wie es `iconPng` schreibt. */
function pngLesen(png: Buffer): { breite: number; hoehe: number; pixel: (x: number, y: number) => number[] } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  const breite = png.readUInt32BE(16);
  const hoehe = png.readUInt32BE(20);
  const idatStart = png.indexOf('IDAT', 0, 'ascii');
  const laenge = png.readUInt32BE(idatStart - 4);
  const roh = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + laenge));
  const zeile = 1 + breite * 3;
  return { breite, hoehe, pixel: (x, y) => [...roh.subarray(y * zeile + 1 + x * 3, y * zeile + 4 + x * 3)] };
}

describe('Das App-Symbol', () => {
  it.each([180, 192, 512])('ist ein PNG mit %i × %i Pixeln: Akzentfarbe am Rand, Weiß auf dem Ring', (groesse) => {
    const bild = pngLesen(iconPng(groesse));
    expect([bild.breite, bild.hoehe]).toEqual([groesse, groesse]);
    expect(bild.pixel(0, 0)).toEqual([0x29, 0x54, 0xe0]);
    expect(bild.pixel(groesse - 1, groesse - 1)).toEqual([0x29, 0x54, 0xe0]);
    // Ein Punkt mitten im Ring (Mitte + 0,27 nach links): weiß.
    expect(bild.pixel(Math.round((0.5 - 0.2675) * groesse), Math.round(0.53 * groesse))).toEqual([255, 255, 255]);
  });

  it('liegt ganz in der sicheren Zone für „maskable" (Kreis mit 40 % Radius um die Mitte)', () => {
    for (let y = 0; y <= 100; y++) {
      for (let x = 0; x <= 100; x++) {
        if (aufMotiv(x / 100, y / 100)) {
          expect(Math.hypot(x / 100 - 0.5, y / 100 - 0.5)).toBeLessThanOrEqual(0.4);
        }
      }
    }
  });
});

describe('Routen der App-Dateien (ohne Anmeldung)', () => {
  let app: FastifyInstance;
  // Ohne Datenbank gilt immer das Standard-Symbol (COPI-101); seine Adressen tragen dessen Hash.
  const { hash } = standardSymbolSatz();

  beforeAll(async () => {
    app = buildApp({ nodeEnv: 'test' }, { instanzName: 'FEWOTEST' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('liefert das Manifest mit Namen der Instanz, standalone, Start und Geltungsbereich / und Symbolen', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(antwort.headers['cache-control']).toBe('no-cache');
    expect(antwort.json()).toEqual({
      id: '/',
      name: 'Cockpit · FEWOTEST',
      short_name: 'Cockpit',
      lang: 'de',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#f4f7fa',
      theme_color: '#ff6d20',
      icons: [
        { src: `/icons/icon-192.${hash}.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/icons/icon-512.${hash}.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `/icons/icon-512.${hash}.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
  });

  it('liefert den Service Worker als JavaScript, nie lange zwischengespeichert, ohne fetch-Handler (er speichert nichts)', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/sw.js' });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(antwort.headers['cache-control']).toBe('no-cache');
    expect(antwort.headers['x-content-type-options']).toBe('nosniff');
    expect(antwort.body).toContain("addEventListener('install'");
    expect(antwort.body).not.toMatch(/addEventListener\('fetch'|caches\./);
  });

  it.each([
    ['icon-192', 192],
    ['icon-512', 512],
    ['apple-touch-icon', 180],
    ['favicon-32', 32],
  ])('liefert %s als PNG — mit Hash ein Jahr zwischenspeicherbar, ohne Hash nie ohne Nachfrage', async (name, groesse) => {
    const mitHash = await app.inject({ method: 'GET', url: `/icons/${name}.${hash}.png` });
    expect(mitHash.statusCode).toBe(200);
    expect(mitHash.headers['content-type']).toBe('image/png');
    expect(mitHash.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(pngLesen(mitHash.rawPayload).breite).toBe(groesse);

    const ohneHash = await app.inject({ method: 'GET', url: `/icons/${name}.png` });
    expect(ohneHash.statusCode).toBe(200);
    expect(ohneHash.headers['cache-control']).toBe('no-cache');
    expect(ohneHash.rawPayload.equals(mitHash.rawPayload)).toBe(true);
  });

  it('liefert unter einem fremden Hash das aktuelle Symbol, aber nicht als unveränderlich', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/icons/icon-512.0123456789ab.png' });
    expect(antwort.statusCode).toBe(200);
    expect(antwort.headers['cache-control']).toBe('no-cache');
  });

  it.each(['/icons/beispiel.css', '/icons/icon-64.png', '/icons/icon-512.ABCDEF012345.png'])('kennt %s nicht', async (pfad) => {
    const antwort = await app.inject({ method: 'GET', url: pfad });
    expect(antwort.statusCode).not.toBe(200);
  });

  it('liefert das Favicon auch unter /favicon.ico', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/favicon.ico' });
    expect(antwort.statusCode).toBe(200);
    expect(antwort.headers['content-type']).toBe('image/png');
    expect(pngLesen(antwort.rawPayload).breite).toBe(32);
  });

  it('hält das Skript der angemeldeten Seiten hinter dem Tor', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/pwa.js' });
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden');
  });

  it('verweist jede Seite auf Manifest und Symbol — die angemeldeten laden dazu das Skript', async () => {
    const ohneKonto = await app.render('nicht-gefunden.eta', { titel: 'Nicht gefunden' });
    expect(ohneKonto).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(ohneKonto).toContain(`<link rel="apple-touch-icon" href="/icons/apple-touch-icon.${hash}.png" />`);
    expect(ohneKonto).toContain(`<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.${hash}.png" />`);
    expect(ohneKonto).not.toContain('/pwa.js');
    expect(ohneKonto).toContain('<meta name="theme-color" content="#ff6d20" />');

    const nav = navigation('mehr', { angemeldet: true, einladen: false, benutzerSehen: false, chat: true, chatUngelesen: 0 });
    const angemeldet = await app.render('mehr.eta', { titel: 'Mehr', nav });
    expect(angemeldet).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(angemeldet).toContain('<script type="module" src="/pwa.js"></script>');
  });
});

describe('Die Ausnahme im Tor', () => {
  const anonym = (pfad: string) => torEntscheidung({ pfad, sitzungVorhanden: false, zweiterFaktorAktiv: false });
  const ohneFaktor = (pfad: string) => torEntscheidung({ pfad, sitzungVorhanden: true, zweiterFaktorAktiv: false });

  it.each([...APP_DATEIEN, '/icons/icon-512.0123456789ab.png', '/icons/favicon-32.abcdefabcdef.png'])('lässt %s in jedem Zustand durch', (pfad) => {
    expect(anonym(pfad)).toEqual({ art: 'weiter' });
    expect(ohneFaktor(pfad)).toEqual({ art: 'weiter' });
  });

  it.each([
    '/sw.js/',
    '/sw.js/../chat',
    '/icons/',
    '/icons/icon-192.png/x',
    '/icons/../chat',
    '/manifest.webmanifest.bak',
    '/%73w.js/../benutzer',
    '/icons/%2e%2e/benutzer',
    '/pwa.js',
    // Die Symbole mit Hash (COPI-101): nur die vier Namen, nur zwölf kleine Hex-Zeichen, nichts dahinter.
    '/icons/icon-64.0123456789ab.png',
    '/icons/icon-512.0123456789a.png',
    '/icons/icon-512.0123456789abc.png',
    '/icons/icon-512.0123456789ab.png/x',
    '/icons/icon-512.0123456789ab.png/../../chat',
    '/icons/icon-512.%2e%2e.png',
    '/favicon.ico/x',
  ])('öffnet damit nichts anderes: %s bleibt zu', (pfad) => {
    expect(anonym(pfad)).not.toEqual({ art: 'weiter' });
  });
});
