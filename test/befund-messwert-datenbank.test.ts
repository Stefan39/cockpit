/**
 * Der Hauptmesswert eines Befunds (COPI-83) gegen die echte Datenbank: `POST /intern/befund` mit `messwert`, und die
 * Bedingung `befund_messwert_form` (Migration 0029), die dieselbe Form auch ohne die Route erzwingt.
 *
 * Die Route antwortet auf eine falsche Form wie bei jedem anderen Feld: `400 ungueltige_anfrage` mit dem Feldnamen
 * (`messwert.wert` …), nie mit einem Wert, und schreibt nichts. Ohne `messwert` bleibt alles wie bisher (Spalte NULL).
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.befund`, `cockpit.wache` und `cockpit.api_token` ab.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { buildApp } from '../src/server/app.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const T0 = new Date('2026-09-28T12:00:00.000Z');

const GUELTIG = { wache: 'plattenplatz', status: 'gelb', text_intern: 'Platte 86 %', takt_sekunden: 300 };

describe.skipIf(!datenbankUrl)('Messwert je Befund (COPI-83, echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let token: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DELETE FROM cockpit.api_token');
    ({ token } = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] }));
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => T0 });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.end();
  });

  function melden(rumpf: string) {
    return app.inject({
      method: 'POST',
      url: '/intern/befund',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: rumpf,
    });
  }

  async function gespeichert(): Promise<unknown[]> {
    const zeilen = await pool.query<{ messwert: unknown }>('SELECT messwert FROM cockpit.befund ORDER BY id');
    return zeilen.rows.map((zeile) => zeile.messwert);
  }

  describe('POST /intern/befund', () => {
    it('speichert einen gültigen Messwert mit allen Feldern, die Einheit an den Rändern gekürzt', async () => {
      const antwort = await melden(JSON.stringify({ ...GUELTIG, messwert: { wert: 86, einheit: ' % ', max: 100, warnung: 85 } }));

      expect(antwort.statusCode).toBe(201);
      expect(await gespeichert()).toEqual([{ wert: 86, einheit: '%', max: 100, warnung: 85 }]);
    });

    it('nimmt einen Messwert nur mit Pflichtfeldern an, auch negativ und mit Nachkommastellen', async () => {
      const antwort = await melden(JSON.stringify({ ...GUELTIG, messwert: { wert: -0.5, einheit: '°C' } }));

      expect(antwort.statusCode).toBe(201);
      expect(await gespeichert()).toEqual([{ wert: -0.5, einheit: '°C' }]);
    });

    it('lässt ohne messwert alles wie bisher: die Spalte bleibt NULL', async () => {
      expect((await melden(JSON.stringify(GUELTIG))).statusCode).toBe(201);
      expect(await gespeichert()).toEqual([null]);
    });

    it.each([
      ['ein unbekanntes Feld im Messwert', { wert: 1, einheit: '%', minimum: 0 }, 'messwert.minimum', undefined],
      ['eine nicht-endliche Zahl (1e999 wird beim Parsen unendlich)', undefined, 'messwert.wert', '{"wert":1e999,"einheit":"%"}'],
      ['ein fehlender Wert', { einheit: '%' }, 'messwert.wert', undefined],
      ['ein Text als Wert', { wert: '86', einheit: '%' }, 'messwert.wert', undefined],
      ['eine leere Einheit', { wert: 1, einheit: '   ' }, 'messwert.einheit', undefined],
      ['eine Einheit über 12 Zeichen', { wert: 1, einheit: 'dreizehn-zchn' }, 'messwert.einheit', undefined],
      ['max = 0', { wert: 1, einheit: '%', max: 0 }, 'messwert.max', undefined],
      ['max < 0', { wert: 1, einheit: '%', max: -5 }, 'messwert.max', undefined],
      ['eine Warnschwelle als Text', { wert: 1, einheit: '%', warnung: 'hoch' }, 'messwert.warnung', undefined],
      ['ein Messwert, der kein Objekt ist', 86, 'messwert', undefined],
    ])('lehnt %s mit 400 und dem Feldnamen ab und schreibt nichts', async (_fall, messwert, feld, roh) => {
      const rumpf = roh === undefined ? JSON.stringify({ ...GUELTIG, messwert }) : JSON.stringify(GUELTIG).replace(/}$/, `,"messwert":${roh}}`);

      const antwort = await melden(rumpf);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder: [feld] });
      expect(await gespeichert()).toEqual([]);
    });
  });

  describe('Bedingung befund_messwert_form (Migration 0029)', () => {
    async function einfuegen(messwert: string | null): Promise<void> {
      await pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ('direkt', 300) ON CONFLICT DO NOTHING`);
      await pool.query(`INSERT INTO cockpit.befund (wache, status, text_intern, quelle, messwert) VALUES ('direkt', 'gruen', 'x', 'test', $1::jsonb)`, [
        messwert,
      ]);
    }

    it.each([
      ['NULL', null],
      ['nur Pflichtfelder', '{"wert": 5, "einheit": "von 5"}'],
      ['alle Felder', '{"wert": 86.5, "einheit": "%", "max": 100, "warnung": 85}'],
    ])('nimmt %s an', async (_fall, messwert) => {
      await expect(einfuegen(messwert)).resolves.toBeUndefined();
    });

    it.each([
      ['eine Zahl statt eines Objekts', '86'],
      ['ein unbekanntes Feld', '{"wert": 1, "einheit": "%", "quelle": "x"}'],
      ['einen Text als Wert', '{"wert": "86", "einheit": "%"}'],
      ['einen fehlenden Wert', '{"einheit": "%"}'],
      ['eine Zahl als Einheit', '{"wert": 1, "einheit": 5}'],
      ['eine Einheit nur aus Leerraum', '{"wert": 1, "einheit": "  "}'],
      ['eine Einheit über 12 Zeichen', '{"wert": 1, "einheit": "dreizehn-zchn"}'],
      ['max = 0', '{"wert": 1, "einheit": "%", "max": 0}'],
      ['max als Text (ohne am Cast zu scheitern)', '{"wert": 1, "einheit": "%", "max": "viel"}'],
      ['warnung als Text', '{"wert": 1, "einheit": "%", "warnung": "hoch"}'],
    ])('weist %s ab', async (_fall, messwert) => {
      await expect(einfuegen(messwert)).rejects.toThrow(/befund_messwert_form/);
    });
  });
});
