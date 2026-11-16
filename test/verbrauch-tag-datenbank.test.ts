/**
 * Die Tageswerte des KI-Verbrauchs (COPI-98, `cockpit.verbrauch_tag` aus Migration 0034) und
 * `GET /intern/verbrauch/tickets` gegen eine echte PostgreSQL: mitgeführte Verdichtung je Meldung, Berliner
 * Kalendertag, ersetzte und verschobene Einträge, Neuberechnung — und die Summen je Ticket in Euro.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { buildApp } from '../src/server/app.js';
import { kostenNeuBerechnen } from '../src/verbrauch/verbrauch-speicher.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-30T12:00:00Z');

/** 1 Mio. Eingabe-Tokens auf Sonnet 5: genau 2 USD. */
const EINTRAG = {
  schluessel: 'n8n:lauf-1',
  zeitpunkt: '2026-09-29T10:00:00Z',
  quelle: 'n8n',
  modell: 'claude-sonnet-5',
  ticket: 'JAC-630',
  tokens_eingabe: 1_000_000,
  tokens_ausgabe: 0,
  tokens_cache_schreiben_5m: 0,
  tokens_cache_schreiben_1h: 0,
  tokens_cache_lesen: 0,
};

interface Tageswert {
  tag: string;
  ticket: string | null;
  modell: string;
  qualitaet: string;
  waehrung: string | null;
  einsaetze: number;
  tokens_eingabe: string;
  kosten: string | null;
}

describe.skipIf(!datenbankUrl)('Tageswerte des KI-Verbrauchs (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let schreiber: string;
  let leser: string;

  async function melden(rumpf: unknown): Promise<void> {
    const antwort = await app.inject({ method: 'POST', url: '/intern/verbrauch', headers: { authorization: `Bearer ${schreiber}` }, payload: rumpf as object });
    expect(antwort.statusCode).toBe(200);
  }

  async function kurs(tag: string, usdJeEur: number): Promise<void> {
    await app.inject({ method: 'POST', url: '/intern/wechselkurs', headers: { authorization: `Bearer ${schreiber}` }, payload: { tag, usd_je_eur: usdJeEur } });
  }

  async function tickets(query = '', mit: string = leser) {
    const antwort = await app.inject({ method: 'GET', url: `/intern/verbrauch/tickets${query}`, headers: { authorization: `Bearer ${mit}` } });
    return { status: antwort.statusCode, json: antwort.json() as { tickets: Record<string, unknown>[]; weitere: boolean; fehler?: string; felder?: string[] } };
  }

  async function tageswerte(): Promise<Tageswert[]> {
    return (
      await pool.query<Tageswert>(
        `SELECT to_char(tag, 'YYYY-MM-DD') AS tag, ticket, modell, qualitaet, waehrung, einsaetze, tokens_eingabe, kosten
           FROM cockpit.verbrauch_tag ORDER BY tag, ticket NULLS LAST, modell, qualitaet`,
      )
    ).rows;
  }

  async function leeren(): Promise<void> {
    await pool.query('TRUNCATE cockpit.verbrauch, cockpit.verbrauch_tag, cockpit.wechselkurs RESTART IDENTITY');
    await pool.query('DELETE FROM cockpit.api_token');
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT });
    await app.ready();
  });

  beforeEach(async () => {
    await leeren();
    schreiber = (await apiTokenAnlegen(pool, { name: 'n8n-verbrauch', scopes: ['verbrauch_schreiben'] })).token;
    leser = (await apiTokenAnlegen(pool, { name: 'jira-abgleich', scopes: ['verbrauch_lesen'] })).token;
  });

  afterAll(async () => {
    await app.close();
    await leeren();
    await pool.end();
  });

  describe('Verdichtung', () => {
    it('fasst Einsätze desselben Tages, Tickets, Modells, der Quelle und Qualität zu einer Zeile zusammen', async () => {
      await melden({ eintraege: [EINTRAG, { ...EINTRAG, schluessel: 'n8n:lauf-2' }] });

      expect(await tageswerte()).toEqual([
        { tag: '2026-09-29', ticket: 'JAC-630', modell: 'claude-sonnet-5', qualitaet: 'gemessen', waehrung: 'USD', einsaetze: 2, tokens_eingabe: '2000000', kosten: '4.000000' },
      ]);
    });

    it('trennt nach Ticket, Modell und Qualität — und führt Einsätze ohne Ticket als eigene Zeile', async () => {
      await melden({
        eintraege: [
          EINTRAG,
          { ...EINTRAG, schluessel: 'n8n:lauf-2', ticket: 'COPI-98' },
          { ...EINTRAG, schluessel: 'n8n:lauf-3', modell: 'claude-haiku-4-5' },
          { ...EINTRAG, schluessel: 'n8n:lauf-4', qualitaet: 'geschaetzt' },
          { ...EINTRAG, schluessel: 'n8n:lauf-5', ticket: null },
        ],
      });

      expect((await tageswerte()).map((zeile) => [zeile.ticket, zeile.modell, zeile.qualitaet])).toEqual([
        ['COPI-98', 'claude-sonnet-5', 'gemessen'],
        ['JAC-630', 'claude-haiku-4-5', 'gemessen'],
        ['JAC-630', 'claude-sonnet-5', 'gemessen'],
        ['JAC-630', 'claude-sonnet-5', 'geschaetzt'],
        [null, 'claude-sonnet-5', 'gemessen'],
      ]);
    });

    it('rechnet nach dem Berliner Kalendertag: 22:30 UTC im Sommer gehört zum nächsten Tag', async () => {
      await melden({ ...EINTRAG, zeitpunkt: '2026-09-29T22:30:00Z' });

      expect((await tageswerte()).map((zeile) => zeile.tag)).toEqual(['2026-09-30']);
    });

    it('zählt eine wiederholte Meldung nicht doppelt und übernimmt ersetzte Werte', async () => {
      await melden(EINTRAG);
      await melden(EINTRAG);
      await melden({ ...EINTRAG, tokens_eingabe: 3_000_000 });

      expect(await tageswerte()).toMatchObject([{ einsaetze: 1, tokens_eingabe: '3000000', kosten: '6.000000' }]);
    });

    it('räumt den alten Tag, wenn eine ersetzte Meldung ihren Tag wechselt', async () => {
      await melden({ eintraege: [EINTRAG, { ...EINTRAG, schluessel: 'n8n:lauf-2' }] });

      await melden({ ...EINTRAG, schluessel: 'n8n:lauf-2', zeitpunkt: '2026-09-27T10:00:00Z' });

      expect((await tageswerte()).map((zeile) => [zeile.tag, zeile.einsaetze])).toEqual([
        ['2026-09-27', 1],
        ['2026-09-29', 1],
      ]);
    });

    it('lässt die Tage unberührt, die eine Meldung nicht betrifft', async () => {
      await melden(EINTRAG);
      await melden({ ...EINTRAG, schluessel: 'n8n:lauf-2', zeitpunkt: '2026-09-28T10:00:00Z' });

      expect((await tageswerte()).map((zeile) => zeile.tag)).toEqual(['2026-09-28', '2026-09-29']);
    });

    it('führt Einsätze ohne Preis ohne Währung und ohne Kosten, und zieht sie bei der Neuberechnung nach', async () => {
      await melden({ ...EINTRAG, zeitpunkt: '2026-08-15T10:00:00Z' });
      expect(await tageswerte()).toMatchObject([{ tag: '2026-08-15', waehrung: null, kosten: null }]);

      await pool.query(`UPDATE cockpit.preis SET gueltig_ab = '2026-08-01T00:00:00Z' WHERE modell = 'claude-sonnet-5'`);
      try {
        await kostenNeuBerechnen(pool);

        expect(await tageswerte()).toMatchObject([{ tag: '2026-08-15', waehrung: 'USD', kosten: '2.000000', einsaetze: 1 }]);
      } finally {
        await pool.query(`UPDATE cockpit.preis SET gueltig_ab = '2026-09-01T00:00:00Z' WHERE modell = 'claude-sonnet-5'`);
      }
    });

    it('stimmt mit dem Protokoll überein, auch nach vielen gemischten Meldungen', async () => {
      const eintraege = Array.from({ length: 60 }, (_, nummer) => ({
        ...EINTRAG,
        schluessel: `n8n:lauf-${String(nummer)}`,
        zeitpunkt: new Date(Date.UTC(2026, 8, 20 + (nummer % 9), 8 + (nummer % 14))).toISOString(),
        ticket: nummer % 4 === 0 ? null : `JAC-${String(600 + (nummer % 3))}`,
        tokens_eingabe: 1000 * (nummer + 1),
      }));
      await melden({ eintraege });
      await melden({ eintraege: eintraege.slice(10, 30).map((eintrag) => ({ ...eintrag, tokens_eingabe: 7 })) });

      const summen = await pool.query<{ protokoll: string; tage: string; einsaetze: string }>(
        `SELECT (SELECT sum(tokens_eingabe) FROM cockpit.verbrauch) AS protokoll,
                (SELECT sum(tokens_eingabe) FROM cockpit.verbrauch_tag) AS tage,
                (SELECT sum(einsaetze) FROM cockpit.verbrauch_tag) AS einsaetze`,
      );
      expect(summen.rows[0]?.tage).toBe(summen.rows[0]?.protokoll);
      expect(summen.rows[0]?.einsaetze).toBe('60');
    });
  });

  describe('GET /intern/verbrauch/tickets', () => {
    beforeEach(async () => {
      await kurs('2026-09-28', 1.25);
      await melden({
        eintraege: [
          EINTRAG,
          { ...EINTRAG, schluessel: 'n8n:lauf-2', zeitpunkt: '2026-09-30T08:00:00Z', modell: 'claude-haiku-4-5', tokens_ausgabe: 1_000_000, qualitaet: 'geschaetzt' },
          { ...EINTRAG, schluessel: 'n8n:lauf-3', modell: 'openai/gpt-oss-120b', tokens_cache_lesen: 5 },
          { ...EINTRAG, schluessel: 'n8n:lauf-4', ticket: 'COPI-98', zeitpunkt: '2026-09-20T08:00:00Z' },
          { ...EINTRAG, schluessel: 'n8n:lauf-5', ticket: 'COPI-98', zeitpunkt: '2026-09-21T08:00:00Z', modell: 'unbekanntes-modell' },
          { ...EINTRAG, schluessel: 'n8n:lauf-6', ticket: null },
        ],
      });
    });

    it('liefert je Ticket die Gesamtsummen, Kosten in Euro zum Tageskurs, ohne die nicht zugeordneten Einsätze', async () => {
      const antwort = await tickets();

      expect(antwort.status).toBe(200);
      expect(antwort.json.weitere).toBe(false);
      expect(antwort.json.tickets.map((ticket) => ticket.ticket)).toEqual(['COPI-98', 'JAC-630']);
      expect(antwort.json.tickets[1]).toEqual({
        ticket: 'JAC-630',
        jira_projekt: 'JAC',
        modelle: ['claude-haiku-4-5', 'claude-sonnet-5', 'openai/gpt-oss-120b'],
        einsaetze: 3,
        tokens_eingabe: 3_000_000,
        tokens_ausgabe: 1_000_000,
        tokens_cache: 5,
        // Sonnet 2 USD + Haiku 6 USD = 8 USD zu 1,25 = 6,40 EUR; dazu gpt-oss 0,150001 EUR (gerundet auf 6 Stellen).
        kosten_eur: 6.550001,
        kosten_usd: 8,
        geschaetzt: 1,
        ohne_preis: 0,
        ohne_kurs: 0,
        letzter_tag: '2026-09-30',
      });
    });

    it('zählt Einsätze ohne Preis und ohne Wechselkurs, statt einen Betrag zu raten', async () => {
      const copi = (await tickets()).json.tickets[0];

      // Der 20.09. liegt vor dem ersten Kurs; das unbekannte Modell hat keinen Preis.
      expect(copi).toMatchObject({ ticket: 'COPI-98', einsaetze: 2, kosten_eur: 0, kosten_usd: 2, ohne_preis: 1, ohne_kurs: 1 });
    });

    it('wählt mit seit die Tickets mit einem Einsatz ab diesem Tag — die Summen bleiben Gesamtsummen', async () => {
      const antwort = await tickets('?seit=2026-09-30');

      expect(antwort.json.tickets).toHaveLength(1);
      expect(antwort.json.tickets[0]).toMatchObject({ ticket: 'JAC-630', einsaetze: 3 });
    });

    it('wählt mit projekt ein Projekt', async () => {
      expect((await tickets('?projekt=COPI')).json.tickets.map((ticket) => ticket.ticket)).toEqual(['COPI-98']);
      expect((await tickets('?projekt=WPLER')).json.tickets).toEqual([]);
    });

    it.each([
      ['seit', '?seit=gestern'],
      ['projekt', '?projekt=jac'],
      ['tage', '?tage=7'],
    ])('weist einen ungültigen Parameter %s ab', async (feld, query) => {
      const antwort = await tickets(query);

      expect(antwort.status).toBe(400);
      expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder: [feld] });
    });

    it('verlangt das Recht verbrauch_lesen: wer nur melden darf, liest nicht', async () => {
      expect((await tickets('', schreiber)).status).toBe(403);
    });
  });
});
