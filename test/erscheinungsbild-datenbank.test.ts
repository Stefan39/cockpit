/**
 * Das App-Symbol der Instanz (COPI-101) gegen die echte Datenbank: wer es ändern darf (Betreuer, Betriebs-Admin, nicht
 * der Mitarbeiter), dass nur ein passendes PNG ankommt, dass das neue Symbol unter neuen Adressen (Hash) in Manifest
 * und Seiten steht, das Protokoll, und dass Zurücksetzen nur markiert, nie löscht.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort Konten und Symbole ab.
 */
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { pngLesen, pngSchreiben } from '../src/pwa/png.js';
import { standardSymbolSatz } from '../src/pwa/symbol.js';
import { buildApp } from '../src/server/app.js';
import { FORMULAR_KOPF, kontenLoeschen, protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HERKUNFT = { host: 'localhost:3000', origin: 'http://localhost:3000' };
const STANDARD = standardSymbolSatz().hash;

/** Ein PNG mit 512 × 512 Pixeln wie aus dem Browser: links Rot, rechts Grün. */
function logoPng(): Buffer {
  const pixel = Buffer.alloc(512 * 512 * 3);
  for (let i = 0; i < 512 * 512; i++) {
    pixel[i * 3 + (i % 512 < 256 ? 0 : 1)] = 200;
  }
  return pngSchreiben({ breite: 512, hoehe: 512, pixel });
}

describe.skipIf(!datenbankUrl)('App-Symbol ändern (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let angemeldet: Zugang;

  function als(rolle: Rolle, benutzerId = 'anna'): void {
    angemeldet = { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId };
  }

  function hochladen(png: Buffer | string, kopf: Record<string, string> = HERKUNFT) {
    return app.inject({
      method: 'POST',
      url: '/einstellungen/app-symbol',
      headers: { 'content-type': 'application/json', ...kopf },
      payload: JSON.stringify({ png: typeof png === 'string' ? png : png.toString('base64') }),
    });
  }

  function zuruecksetzen(kopf: Record<string, string> = HERKUNFT) {
    return app.inject({ method: 'POST', url: '/einstellungen/app-symbol/zuruecksetzen', headers: { ...FORMULAR_KOPF, ...kopf }, payload: '' });
  }

  async function manifestHash(): Promise<string> {
    const manifest = (await app.inject({ method: 'GET', url: '/manifest.webmanifest' })).json<{ icons: { src: string }[] }>();
    return /\.([0-9a-f]{12})\.png$/.exec(manifest.icons[0]?.src ?? '')?.[1] ?? '';
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  // Je Fall eine eigene App: sie hält das aktuelle Symbol im Speicher, und die Fälle räumen die Tabelle ab.
  beforeEach(async () => {
    await kontenLoeschen(pool);
    await pool.query(
      `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ('anna', 'anna@example.org', 'Anna Admin', true, now(), now())`,
    );
    als('betriebs_admin');
    app = buildApp(
      { nodeEnv: 'test' },
      {
        pool,
        sitzungLesen: MIT_FAKTOR,
        zugangLesen: () => Promise.resolve(angemeldet),
        logStrom: new Writable({ write: (_teil, _kodierung, fertig) => fertig() }),
      },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await kontenLoeschen(pool);
    await pool.end();
  });

  it('übernimmt ein Logo: neue Adressen in Manifest und Seiten, neu kodiert, protokolliert', async () => {
    const marke = await protokollMarke(pool);

    const antwort = await hochladen(logoPng());

    expect(antwort.statusCode).toBe(201);
    const { hash } = antwort.json<{ hash: string }>();
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(hash).not.toBe(STANDARD);
    expect(await manifestHash()).toBe(hash);

    const seite = await app.inject({ method: 'GET', url: '/einstellungen?symbol=gespeichert' });
    expect(seite.body).toContain(`href="/icons/apple-touch-icon.${hash}.png"`);
    expect(seite.body).toContain(`href="/icons/favicon-32.${hash}.png"`);
    expect(seite.body).toContain('Das neue Symbol ist gespeichert.');
    expect(seite.body).toContain('Eigenes Logo');
    expect(seite.body).toContain('von Anna Admin');
    expect(seite.body).toContain('Auf Standard zurücksetzen');

    const klein = await app.inject({ method: 'GET', url: `/icons/icon-192.${hash}.png` });
    expect(klein.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const bild = pngLesen(klein.rawPayload, 192);
    expect([...bild.pixel.subarray(0, 3)]).toEqual([200, 0, 0]);
    expect([...bild.pixel.subarray((192 - 1) * 3, 192 * 3)]).toEqual([0, 200, 0]);

    const zeilen = await pool.query<{ id: string; angelegt_von: string; hash: string }>('SELECT id::text, angelegt_von, hash FROM cockpit.app_symbol');
    expect(zeilen.rows).toEqual([{ id: expect.any(String) as string, angelegt_von: 'anna', hash }]);
    expect(await protokollSeit(pool, marke)).toEqual([
      { art: 'erscheinungsbild_geaendert', akteur: 'anna', ziel: null, einzelheiten: { weg: 'hochgeladen', app_symbol_id: Number(zeilen.rows[0]?.id) } },
    ]);
  });

  it('setzt auf den Standard zurück, markiert nur und protokolliert', async () => {
    await hochladen(logoPng());
    const marke = await protokollMarke(pool);

    const antwort = await zuruecksetzen();

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/einstellungen?symbol=zurueckgesetzt');
    expect(await manifestHash()).toBe(STANDARD);
    const zeilen = await pool.query<{ geloescht_von: string | null }>('SELECT geloescht_von FROM cockpit.app_symbol');
    expect(zeilen.rows).toEqual([{ geloescht_von: 'anna' }]);
    expect(await protokollSeit(pool, marke)).toEqual([
      { art: 'erscheinungsbild_geaendert', akteur: 'anna', ziel: null, einzelheiten: { weg: 'zurueckgesetzt' } },
    ]);
    const seite = await app.inject({ method: 'GET', url: '/einstellungen?symbol=zurueckgesetzt' });
    expect(seite.body).toContain('Das Standard-Symbol gilt wieder.');
    expect(seite.body).not.toContain('Auf Standard zurücksetzen');

    // Ohne eigenes Symbol ändert Zurücksetzen nichts und schreibt nichts.
    const nochmal = await protokollMarke(pool);
    expect((await zuruecksetzen()).statusCode).toBe(303);
    expect(await protokollSeit(pool, nochmal)).toEqual([]);
  });

  // Die Sperre gegen DELETE prüft `nie-loeschen-datenbank.test.ts` (die Testdatenbank darf abräumen).
  it('lässt ein gespeichertes Symbol nicht verändern', async () => {
    await hochladen(logoPng());
    await expect(pool.query("UPDATE cockpit.app_symbol SET hash = '000000000000'")).rejects.toThrow(/app_symbol_unveraenderlich/);
  });

  it.each<[string, () => Buffer | string]>([
    ['zu klein', () => pngSchreiben({ breite: 256, hoehe: 256, pixel: Buffer.alloc(256 * 256 * 3) })],
    ['kein PNG (SVG)', () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['kein Base64', () => '<svg>'],
  ])('weist ab: %s — nichts gespeichert, nichts protokolliert', async (_name, datei) => {
    const marke = await protokollMarke(pool);

    const antwort = await hochladen(datei());

    expect(antwort.statusCode).toBe(400);
    expect((await pool.query('SELECT 1 FROM cockpit.app_symbol')).rowCount).toBe(0);
    expect(await protokollSeit(pool, marke)).toEqual([]);
    expect(await manifestHash()).toBe(STANDARD);
  });

  it('nimmt nur JSON an und nur aus dem Cockpit', async () => {
    const formular = await app.inject({
      method: 'POST',
      url: '/einstellungen/app-symbol',
      headers: { ...FORMULAR_KOPF, ...HERKUNFT },
      payload: `png=${encodeURIComponent(logoPng().toString('base64'))}`,
    });
    expect(formular.statusCode).toBe(415);
    expect((await hochladen(logoPng(), { host: 'localhost:3000', origin: 'https://fremd.example' })).statusCode).toBe(403);
    expect((await hochladen(logoPng(), { host: 'localhost:3000' })).statusCode).toBe(403);
    expect((await zuruecksetzen({ host: 'localhost:3000', origin: 'https://fremd.example' })).statusCode).toBe(403);
    expect((await pool.query('SELECT 1 FROM cockpit.app_symbol')).rowCount).toBe(0);
  });

  it('gibt dem Mitarbeiter weder Abschnitt noch Routen', async () => {
    als('betrieb_mitarbeiter');

    expect((await hochladen(logoPng())).statusCode).toBe(404);
    expect((await zuruecksetzen()).statusCode).toBe(404);
    const seite = await app.inject({ method: 'GET', url: '/einstellungen' });
    expect(seite.body).not.toContain('Erscheinungsbild');
    expect(seite.body).not.toContain('/einstellungen/app-symbol/skript.js');
    // Das Symbol selbst gilt für alle Seiten, auch seine.
    expect(seite.body).toContain(`href="/icons/favicon-32.${STANDARD}.png"`);
  });

  it('zeigt dem Betreuer den Abschnitt und lässt ihn hochladen', async () => {
    als('betreuer');

    const seite = await app.inject({ method: 'GET', url: '/einstellungen' });
    expect(seite.body).toContain('Erscheinungsbild');
    expect(seite.body).toContain('data-symbol="/einstellungen/app-symbol"');
    expect(seite.body).toContain(`src="/icons/apple-touch-icon.${STANDARD}.png"`);
    expect(seite.body).not.toContain('Auf Standard zurücksetzen');
    expect((await hochladen(logoPng())).statusCode).toBe(201);
  });
});
