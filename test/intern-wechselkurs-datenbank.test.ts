/**
 * `POST /intern/wechselkurs` (COPI-99) gegen eine echte PostgreSQL: der Referenzkurs je Tag — Recht
 * `verbrauch_schreiben`, ein Kurs oder mehrere, Idempotenz je Tag, strenge Validierung — und die Umrechnung
 * `cockpit.in_eur` (Migration 0033) samt Kurswahl bei fehlendem Tag.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import type { ApiScope } from '../src/intern/token.js';
import { buildApp } from '../src/server/app.js';
import { wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

/** Die Uhr der Anwendung in diesen Tests: Mittwoch, 30.09.2026, mittags (UTC). */
const JETZT = new Date('2026-09-30T12:00:00Z');

interface Zeile {
  tag: string;
  usd_je_eur: string;
  quelle: string;
  gemeldet_von: string;
}

describe.skipIf(!datenbankUrl)('POST /intern/wechselkurs (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let n8n: string;

  async function token(name: string, scopes: ApiScope[]): Promise<string> {
    return (await apiTokenAnlegen(pool, { name, scopes })).token;
  }

  async function melden(rumpf: unknown, mit: string = n8n) {
    const antwort = await app.inject({ method: 'POST', url: '/intern/wechselkurs', headers: { authorization: `Bearer ${mit}` }, payload: rumpf as object });
    return { status: antwort.statusCode, json: antwort.json() as Record<string, unknown>, body: antwort.body };
  }

  async function zeilen(): Promise<Zeile[]> {
    return (await pool.query<Zeile>(`SELECT to_char(tag, 'YYYY-MM-DD') AS tag, usd_je_eur, quelle, gemeldet_von FROM cockpit.wechselkurs ORDER BY tag`)).rows;
  }

  async function inEur(betrag: number, waehrung: string, tag: string): Promise<string | null> {
    return (await pool.query<{ eur: string | null }>('SELECT cockpit.in_eur($1, $2, $3::date) AS eur', [betrag, waehrung, tag])).rows[0]?.eur ?? null;
  }

  async function leeren(): Promise<void> {
    await pool.query('TRUNCATE cockpit.wechselkurs');
    await pool.query('DELETE FROM cockpit.api_token');
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT });
    await app.ready();
  });

  beforeEach(async () => {
    await leeren();
    n8n = await token('n8n-verbrauch', ['verbrauch_schreiben']);
  });

  afterAll(async () => {
    await app.close();
    await leeren();
    await pool.end();
  });

  describe('annehmen', () => {
    it('speichert den Kurs eines Tages, mit der EZB als Quelle und dem Zugang als Melder', async () => {
      const antwort = await melden({ tag: '2026-09-30', usd_je_eur: 1.1712 });

      expect(antwort.status).toBe(200);
      expect(antwort.json).toEqual({ kurse: 1, neu: 1, ersetzt: 0 });
      expect(await zeilen()).toEqual([{ tag: '2026-09-30', usd_je_eur: '1.171200', quelle: 'EZB', gemeldet_von: 'n8n-verbrauch' }]);
    });

    it('nimmt mehrere Tage in einer Meldung an, mit genannter Quelle', async () => {
      const antwort = await melden({
        kurse: [
          { tag: '2026-09-28', usd_je_eur: 1.16, quelle: 'frankfurter.dev' },
          { tag: '2026-09-29', usd_je_eur: 1.17 },
        ],
      });

      expect(antwort.json).toEqual({ kurse: 2, neu: 2, ersetzt: 0 });
      expect((await zeilen()).map((zeile) => zeile.quelle)).toEqual(['frankfurter.dev', 'EZB']);
    });

    it('nimmt den Kurs für morgen noch an (Zeitzonen), für übermorgen nicht', async () => {
      expect((await melden({ tag: '2026-10-01', usd_je_eur: 1.17 })).status).toBe(200);
      expect((await melden({ tag: '2026-10-02', usd_je_eur: 1.17 })).json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['tag'] });
    });
  });

  describe('Idempotenz', () => {
    it('ersetzt den Kurs desselben Tages, statt einen zweiten anzulegen', async () => {
      await melden({ tag: '2026-09-30', usd_je_eur: 1.1712 });

      const antwort = await melden({ tag: '2026-09-30', usd_je_eur: 1.18 });

      expect(antwort.json).toEqual({ kurse: 1, neu: 0, ersetzt: 1 });
      expect(await zeilen()).toMatchObject([{ tag: '2026-09-30', usd_je_eur: '1.180000' }]);
    });

    it('weist zwei Kurse zum selben Tag in einer Meldung ab und speichert nichts', async () => {
      const antwort = await melden({ kurse: [{ tag: '2026-09-30', usd_je_eur: 1.17 }, { tag: '2026-09-30', usd_je_eur: 1.18 }] });

      expect(antwort.status).toBe(400);
      expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['kurse'] });
      expect(await zeilen()).toHaveLength(0);
    });
  });

  describe('Validierung', () => {
    it.each([
      ['tag', { tag: '30.09.2026' }],
      ['tag', { tag: '2026-02-30' }],
      ['tag', { tag: '2026-09-30T00:00:00Z' }],
      ['usd_je_eur', { usd_je_eur: 0 }],
      ['usd_je_eur', { usd_je_eur: 117.12 }],
      ['usd_je_eur', { usd_je_eur: '1.17' }],
      ['quelle', { quelle: '' }],
      ['eur_je_usd', { eur_je_usd: 0.85 }],
    ])('weist einen Kurs mit ungültigem %s ab und nennt nur den Feldnamen', async (feld, aenderung) => {
      const antwort = await melden({ tag: '2026-09-30', usd_je_eur: 1.1712, ...aenderung });

      expect(antwort.status).toBe(400);
      expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder: [feld] });
      expect(await zeilen()).toHaveLength(0);
    });

    it.each(['tag', 'usd_je_eur'])('verlangt das Pflichtfeld %s', async (feld) => {
      const voll: Record<string, unknown> = { tag: '2026-09-30', usd_je_eur: 1.1712 };

      const antwort = await melden(Object.fromEntries(Object.entries(voll).filter(([name]) => name !== feld)));

      expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder: [feld] });
    });

    it('nennt bei mehreren Kursen die Stelle des Fehlers und speichert nichts — alles oder nichts', async () => {
      const antwort = await melden({ kurse: [{ tag: '2026-09-29', usd_je_eur: 1.17 }, { tag: '2026-10-05', usd_je_eur: 1.17 }] });

      expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['kurse.1.tag'] });
      expect(await zeilen()).toHaveLength(0);
    });

    it('weist eine leere und eine zu lange Liste ab', async () => {
      expect((await melden({ kurse: [] })).json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['kurse'] });

      const tage = Array.from({ length: 101 }, (_, nummer) => ({ tag: new Date(Date.UTC(2026, 0, 1 + nummer)).toISOString().slice(0, 10), usd_je_eur: 1.17 }));
      expect((await melden({ kurse: tage })).json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['kurse'] });
    });
  });

  describe('Zugang', () => {
    it('verlangt das Recht verbrauch_schreiben: ohne es 403, ohne Token 401', async () => {
      const fremd = await token('admin-agent', ['befund_schreiben']);

      expect((await melden({ tag: '2026-09-30', usd_je_eur: 1.17 }, fremd)).status).toBe(403);
      const ohne = await app.inject({ method: 'POST', url: '/intern/wechselkurs', payload: { tag: '2026-09-30', usd_je_eur: 1.17 } });
      expect(ohne.statusCode).toBe(401);
      expect(await zeilen()).toHaveLength(0);
    });
  });

  describe('cockpit.in_eur (Migration 0033)', () => {
    beforeEach(async () => {
      // Freitag und Montag; dazwischen das Wochenende ohne Kurs.
      await melden({ kurse: [{ tag: '2026-09-25', usd_je_eur: 1.25 }, { tag: '2026-09-28', usd_je_eur: 1.6 }] });
    });

    it('rechnet US-Dollar zum Kurs des Tages in Euro um', async () => {
      expect(await inEur(10, 'USD', '2026-09-25')).toBe('8.000000');
      expect(await inEur(10, 'USD', '2026-09-28')).toBe('6.250000');
    });

    it('nimmt an einem Tag ohne Kurs den letzten davor — auch Tage später', async () => {
      expect(await inEur(10, 'USD', '2026-09-26')).toBe('8.000000');
      expect(await inEur(10, 'USD', '2026-09-27')).toBe('8.000000');
      expect(await inEur(10, 'USD', '2026-10-15')).toBe('6.250000');
    });

    it('liefert vor dem ersten Kurs NULL statt eines geratenen Betrags', async () => {
      expect(await inEur(10, 'USD', '2026-09-24')).toBeNull();
    });

    it('lässt Euro unverändert, auch ohne jeden Kurs, und kennt keine dritte Währung', async () => {
      expect(await inEur(10, 'EUR', '2026-01-01')).toBe('10');
      expect(await inEur(10, 'CHF', '2026-09-28')).toBeNull();
    });

    it('gibt NULL weiter: ein Eintrag ohne Preis hat auch in Euro keine Kosten', async () => {
      expect((await pool.query<{ eur: string | null }>(`SELECT cockpit.in_eur(NULL, NULL, '2026-09-28') AS eur`)).rows[0]?.eur).toBeNull();
    });
  });

  it('weist DELETE ab wie jede Nachweistabelle (nie löschen)', async () => {
    await melden({ tag: '2026-09-30', usd_je_eur: 1.17 });

    await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.wechselkurs')).rejects.toThrow(/nie_loeschen/);
  });
});
