/**
 * `POST /intern/verbrauch` (COPI-97) gegen eine echte PostgreSQL: KI-Verbrauch melden — Recht `verbrauch_schreiben`,
 * Einzeleintrag und Stapel, Idempotenz über den Schlüssel, strenge Validierung, Kosten aus der Preistabelle
 * (Migration 0032) inklusive beider Cache-Laufzeiten, Einträge ohne Preis, Neuberechnung.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cliAusfuehren } from '../src/cli/befehle.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import type { ApiScope } from '../src/intern/token.js';
import { buildApp } from '../src/server/app.js';
import { wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const SITZUNG = '062e0ba4-15ba-517f-bff5-79a4d8bb86d3';

/** Ein Eintrag, wie ihn das Cowork-Skript liefert (JAC-633). */
const EINTRAG = {
  schluessel: `cowork:${SITZUNG}:msg_011CfZR1rZKGfTqD66mXDhQh`,
  zeitpunkt: '2026-09-30T09:49:23.698Z',
  quelle: 'cowork',
  modell: 'claude-opus-5-5',
  ticket: 'JAC-630',
  jira_projekt: 'JAC',
  sitzung: SITZUNG,
  qualitaet: 'gemessen',
  zuordnung: 'auftrag',
  subagent: false,
  tokens_eingabe: 2,
  tokens_ausgabe: 521,
  tokens_cache_schreiben_5m: 0,
  tokens_cache_schreiben_1h: 43_708,
  tokens_cache_lesen: 90_397,
};

/** Nur die Pflichtfelder. */
const KNAPP = {
  schluessel: 'n8n:lauf-1',
  zeitpunkt: '2026-09-30T10:00:00Z',
  quelle: 'n8n',
  modell: 'claude-sonnet-5',
  tokens_eingabe: 1_000_000,
  tokens_ausgabe: 0,
  tokens_cache_schreiben_5m: 0,
  tokens_cache_schreiben_1h: 0,
  tokens_cache_lesen: 0,
};

interface Zeile {
  schluessel: string;
  modell: string;
  ticket: string | null;
  jira_projekt: string | null;
  qualitaet: string;
  zuordnung: string;
  subagent: boolean;
  tokens_ausgabe: string;
  kosten: string | null;
  waehrung: string | null;
  gemeldet_von: string;
}

describe.skipIf(!datenbankUrl)('POST /intern/verbrauch (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let hook: string;

  async function token(name: string, scopes: ApiScope[]): Promise<string> {
    return (await apiTokenAnlegen(pool, { name, scopes })).token;
  }

  async function melden(rumpf: unknown, mit: string = hook) {
    const antwort = await app.inject({ method: 'POST', url: '/intern/verbrauch', headers: { authorization: `Bearer ${mit}` }, payload: rumpf as object });
    return { status: antwort.statusCode, json: antwort.json() as Record<string, unknown>, body: antwort.body, kopf: antwort.headers };
  }

  async function zeilen(): Promise<Zeile[]> {
    return (await pool.query<Zeile>('SELECT * FROM cockpit.verbrauch ORDER BY schluessel')).rows;
  }

  async function leeren(): Promise<void> {
    // Erst das Protokoll (es hält seine Preise), dann die Preise, die ein Test angelegt hat.
    await pool.query('TRUNCATE cockpit.verbrauch, cockpit.verbrauch_tag RESTART IDENTITY');
    await pool.query(`DELETE FROM cockpit.preis WHERE quelle = 'test'`);
    await pool.query(`UPDATE cockpit.preis SET gueltig_bis = NULL WHERE gueltig_bis IS NOT NULL`);
    await pool.query('DELETE FROM cockpit.api_token');
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    app = buildApp({ nodeEnv: 'test' }, { pool });
    await app.ready();
  });

  beforeEach(async () => {
    await leeren();
    hook = await token('claude-code-hook', ['verbrauch_schreiben']);
  });

  afterAll(async () => {
    await app.close();
    await leeren();
    await pool.end();
  });

  describe('annehmen', () => {
    it('speichert einen einzelnen Eintrag mit allen Feldern und nennt den Zugang als Melder', async () => {
      const antwort = await melden(EINTRAG);

      expect(antwort.status).toBe(200);
      expect(antwort.json).toEqual({ eintraege: 1, neu: 1, ersetzt: 0, ohne_preis: 0 });
      expect(antwort.kopf['cache-control']).toBe('no-store');
      const [zeile] = await zeilen();
      expect(zeile).toMatchObject({
        schluessel: EINTRAG.schluessel,
        modell: 'claude-opus-5-5',
        ticket: 'JAC-630',
        jira_projekt: 'JAC',
        qualitaet: 'gemessen',
        zuordnung: 'auftrag',
        subagent: false,
        gemeldet_von: 'claude-code-hook',
      });
    });

    it('nimmt die Pflichtfelder allein an: gemessen, ohne Zuordnung, kein Subagent, kein Ticket', async () => {
      expect((await melden(KNAPP)).status).toBe(200);

      const [zeile] = await zeilen();
      expect(zeile).toMatchObject({ ticket: null, jira_projekt: null, qualitaet: 'gemessen', zuordnung: 'keine', subagent: false });
    });

    it('leitet das Jira-Projekt aus dem Ticket ab, wenn es fehlt', async () => {
      await melden({ ...KNAPP, ticket: 'COPI-97' });

      expect((await zeilen())[0]).toMatchObject({ ticket: 'COPI-97', jira_projekt: 'COPI' });
    });

    it('nimmt einen Stapel an', async () => {
      const antwort = await melden({ eintraege: [EINTRAG, KNAPP, { ...KNAPP, schluessel: 'n8n:lauf-2' }] });

      expect(antwort.status).toBe(200);
      expect(antwort.json).toEqual({ eintraege: 3, neu: 3, ersetzt: 0, ohne_preis: 0 });
      expect(await zeilen()).toHaveLength(3);
    });
  });

  describe('Idempotenz', () => {
    it('zählt dieselbe Meldung nicht doppelt: der zweite Aufruf ersetzt', async () => {
      await melden({ eintraege: [EINTRAG, KNAPP] });

      const antwort = await melden({ eintraege: [EINTRAG, KNAPP] });

      expect(antwort.json).toEqual({ eintraege: 2, neu: 0, ersetzt: 2, ohne_preis: 0 });
      expect(await zeilen()).toHaveLength(2);
    });

    it('ersetzt den Eintrag mit den neuen Werten und rechnet die Kosten neu', async () => {
      await melden(KNAPP);

      await melden({ ...KNAPP, tokens_ausgabe: 1_000_000, ticket: 'JAC-631', zuordnung: 'tag' });

      const alle = await zeilen();
      expect(alle).toHaveLength(1);
      // Sonnet 5: 1 Mio. Eingabe zu 2 $, 1 Mio. Ausgabe zu 10 $.
      expect(alle[0]).toMatchObject({ tokens_ausgabe: '1000000', ticket: 'JAC-631', jira_projekt: 'JAC', zuordnung: 'tag', kosten: '12.000000' });
    });

    it('nimmt einem ersetzten Eintrag auch das Ticket, wenn die neue Meldung keins nennt', async () => {
      await melden({ ...KNAPP, ticket: 'JAC-631' });

      await melden(KNAPP);

      expect((await zeilen())[0]).toMatchObject({ ticket: null, jira_projekt: null });
    });

    it('weist einen Stapel mit doppeltem Schlüssel ab und speichert nichts', async () => {
      const antwort = await melden({ eintraege: [KNAPP, { ...KNAPP, tokens_ausgabe: 5 }] });

      expect(antwort.status).toBe(400);
      expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['eintraege'] });
      expect(await zeilen()).toHaveLength(0);
    });
  });

  describe('Kosten', () => {
    it('rechnet Eingabe, Ausgabe, beide Cache-Laufzeiten und Cache-Lesen je Tokenart', async () => {
      // Opus 5.5 je Mio.: Eingabe 4, Ausgabe 20, Cache-Schreiben 5 (5 min) und 8 (1 h), Cache-Lesen 0,20.
      await melden({
        ...EINTRAG,
        tokens_eingabe: 1_000_000,
        tokens_ausgabe: 1_000_000,
        tokens_cache_schreiben_5m: 1_000_000,
        tokens_cache_schreiben_1h: 1_000_000,
        tokens_cache_lesen: 1_000_000,
      });

      expect((await zeilen())[0]).toMatchObject({ kosten: '37.200000', waehrung: 'USD' });
    });

    it('kommt für die Testsitzung aus JAC-633 (86 Nachrichten, Summen) auf 15,57 USD — Claude Code weist 15,78 aus', async () => {
      await melden({
        ...EINTRAG,
        tokens_eingabe: 172,
        tokens_ausgabe: 79_993,
        tokens_cache_schreiben_5m: 0,
        tokens_cache_schreiben_1h: 942_883,
        tokens_cache_lesen: 32_123_344,
      });

      expect((await zeilen())[0]?.kosten).toBe('15.568281');
    });

    it('rechnet die IONOS-Modelle in Euro', async () => {
      await melden({ ...KNAPP, modell: 'openai/gpt-oss-120b', tokens_ausgabe: 1_000_000 });

      expect((await zeilen())[0]).toMatchObject({ kosten: '0.800000', waehrung: 'EUR' });
    });

    it('rechnet IONOS BAAI/bge-m3 zu 0,02 EUR je Million Eingabe-Tokens (COPI-222, Kontrollrechnung)', async () => {
      await melden({ ...KNAPP, zeitpunkt: '2026-10-28T05:00:00Z', modell: 'BAAI/bge-m3', tokens_eingabe: 1_000_000 });

      expect((await zeilen())[0]).toMatchObject({ kosten: '0.020000', waehrung: 'EUR' });
    });

    it('berichtigt eine vorhandene bge-m3-Zeile in anderer Schreibweise samt Gültigkeit (COPI-222)', async () => {
      await pool.query(
        `UPDATE cockpit.preis SET modell = 'openai/baai/bge-m3', eingabe = 1, gueltig_ab = '2026-10-30T00:00:00Z' WHERE modell = 'BAAI/bge-m3'`,
      );
      await pool.query(readFileSync(new URL('../db/migrations/0055_bge_m3_preis.up.sql', import.meta.url), 'utf8'));
      await melden({ ...KNAPP, zeitpunkt: '2026-10-28T05:00:00Z', modell: 'BAAI/bge-m3', tokens_eingabe: 1_000_000 });

      const preise = await pool.query(`SELECT modell FROM cockpit.preis WHERE lower(modell) LIKE '%bge-m3'`);
      expect(preise.rows).toEqual([{ modell: 'BAAI/bge-m3' }]);
      expect((await zeilen())[0]).toMatchObject({ kosten: '0.020000', waehrung: 'EUR' });
    });

    it('findet den Preis auch für einen Modellnamen mit Datums-Anhang', async () => {
      await melden({ ...KNAPP, modell: 'claude-haiku-4-5-20251001' });

      expect((await zeilen())[0]).toMatchObject({ modell: 'claude-haiku-4-5-20251001', kosten: '1.000000' });
    });

    it('nimmt den Preis, der zum Zeitpunkt des Einsatzes galt', async () => {
      await pool.query(`UPDATE cockpit.preis SET gueltig_bis = '2026-10-01T00:00:00Z' WHERE modell = 'claude-sonnet-5'`);
      await pool.query(
        `INSERT INTO cockpit.preis (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
         VALUES ('claude-sonnet-5', 'USD', 3, 15, 3.75, 6, 0.30, '2026-10-01T00:00:00Z', 'test', '2026-09-30')`,
      );

      await melden({ eintraege: [KNAPP, { ...KNAPP, schluessel: 'n8n:lauf-2', zeitpunkt: '2026-10-01T00:00:00Z' }] });

      expect((await zeilen()).map((zeile) => zeile.kosten)).toEqual(['2.000000', '3.000000']);
    });

    it('speichert einen Eintrag ohne Preis trotzdem, mit Kosten NULL, und meldet ihn als Warnung', async () => {
      const antwort = await melden({ eintraege: [KNAPP, { ...KNAPP, schluessel: 'n8n:lauf-2', modell: 'meta-llama/Llama-3.1-405B-Instruct' }] });

      expect(antwort.status).toBe(200);
      expect(antwort.json).toEqual({ eintraege: 2, neu: 2, ersetzt: 0, ohne_preis: 1 });
      expect((await zeilen())[1]).toMatchObject({ kosten: null, waehrung: null });
    });

    it('kennt die IONOS-Preise: Llama 3.1 8B, Llama 3.3 70B und Mistral Small 24B (COPI-118)', async () => {
      const einsatz = (schluessel: string, modell: string, mehr: object = {}) => ({
        ...KNAPP,
        schluessel,
        modell,
        tokens_eingabe: 1_000_000,
        tokens_ausgabe: 1_000_000,
        ...mehr,
      });

      const antwort = await melden({
        eintraege: [
          einsatz('n8n:acht-b', 'meta-llama/Meta-Llama-3.1-8B-Instruct'),
          einsatz('n8n:siebzig-b', 'meta-llama/Llama-3.3-70B-Instruct'),
          // Der Hub kennt keinen Prompt-Cache: gemeldete Cache-Tokens zählen wie Eingabe (0,10 je Million).
          einsatz('n8n:mistral', 'mistralai/Mistral-Small-24B-Instruct', { tokens_cache_lesen: 1_000_000 }),
        ],
      });

      expect(antwort.json).toMatchObject({ eintraege: 3, ohne_preis: 0 });
      expect((await zeilen()).map((zeile) => [zeile.schluessel, zeile.kosten, zeile.waehrung])).toEqual([
        ['n8n:acht-b', '0.300000', 'EUR'],
        ['n8n:mistral', '0.500000', 'EUR'],
        ['n8n:siebzig-b', '1.300000', 'EUR'],
      ]);
    });

    it('kennt die Gemini-Bildpreise: je Modell ein Text- und ein Bild-Eintrag (COPI-120)', async () => {
      const einsatz = (schluessel: string, modell: string, mehr: object = {}) => ({
        ...KNAPP,
        schluessel,
        modell,
        tokens_eingabe: 1_000_000,
        tokens_ausgabe: 1_000_000,
        ...mehr,
      });

      const antwort = await melden({
        eintraege: [
          einsatz('n8n:pro', 'gemini-3-pro-image'),
          einsatz('n8n:pro-bild', 'gemini-3-pro-image:bild'),
          einsatz('n8n:flash', 'gemini-3.1-flash-image'),
          einsatz('n8n:flash-bild', 'gemini-3.1-flash-image:bild'),
          // Cache-Tokens zählen wie Eingabe (0,30 je Million): implizites Caching kommt bei Bild-Prompts praktisch nicht vor.
          einsatz('n8n:alt', 'gemini-2.5-flash-image', { tokens_cache_lesen: 1_000_000 }),
          einsatz('n8n:alt-bild', 'gemini-2.5-flash-image:bild'),
        ],
      });

      expect(antwort.json).toMatchObject({ eintraege: 6, ohne_preis: 0 });
      expect((await zeilen()).map((zeile) => [zeile.schluessel, zeile.kosten, zeile.waehrung])).toEqual([
        ['n8n:alt', '3.100000', 'USD'],
        ['n8n:alt-bild', '30.300000', 'USD'],
        ['n8n:flash', '3.500000', 'USD'],
        ['n8n:flash-bild', '60.500000', 'USD'],
        ['n8n:pro', '14.000000', 'USD'],
        ['n8n:pro-bild', '122.000000', 'USD'],
      ]);
    });

    it('rechnet einen Bildaufruf aus JAC-664 auf 0,140538 USD (COPI-120, Kontrollrechnung)', async () => {
      const antwort = await melden({
        eintraege: [
          { ...KNAPP, schluessel: 'n8n:jac664', modell: 'gemini-3-pro-image', tokens_eingabe: 189, tokens_ausgabe: 480 },
          { ...KNAPP, schluessel: 'n8n:jac664:bild', modell: 'gemini-3-pro-image:bild', tokens_eingabe: 0, tokens_ausgabe: 1120 },
        ],
      });

      expect(antwort.json).toMatchObject({ ohne_preis: 0 });
      const kosten = (await zeilen()).map((zeile) => zeile.kosten);
      expect(kosten).toEqual(['0.006138', '0.134400']);
      expect(Number(kosten[0]) + Number(kosten[1])).toBeCloseTo(0.140538, 6);
    });

    it('rechnet Haiku 5.5 mit der Staffel bis 100K Prompt, gültig ab 01.10.2026 (COPI-129, Kontrollrechnung JAC-672)', async () => {
      const antwort = await melden({
        eintraege: [
          {
            ...KNAPP,
            schluessel: 'cc:jac672',
            zeitpunkt: '2026-10-08T14:00:00Z',
            modell: 'claude-haiku-5-5',
            tokens_eingabe: 2,
            tokens_ausgabe: 239,
            tokens_cache_schreiben_1h: 40_643,
            tokens_cache_lesen: 10_480,
          },
          // 1 Mio. je Tokenart: Prompt 3 Mio., also obere Staffel (COPI-223): 5 × (0,10 + 0,50 + 0,125 + 0,20 + 0,01).
          {
            ...KNAPP,
            schluessel: 'cc:je-art',
            zeitpunkt: '2026-10-08T14:00:00Z',
            modell: 'claude-haiku-5-5',
            tokens_ausgabe: 1_000_000,
            tokens_cache_schreiben_5m: 1_000_000,
            tokens_cache_schreiben_1h: 1_000_000,
            tokens_cache_lesen: 1_000_000,
          },
          { ...KNAPP, schluessel: 'cc:september', modell: 'claude-haiku-5-5' },
        ],
      });

      expect(antwort.json).toMatchObject({ eintraege: 3, ohne_preis: 1 });
      expect((await zeilen()).map((zeile) => [zeile.schluessel, zeile.kosten, zeile.waehrung])).toEqual([
        ['cc:jac672', '0.008353', 'USD'],
        ['cc:je-art', '4.675000', 'USD'],
        ['cc:september', null, null],
      ]);
    });

    it('rechnet Haiku 5.5 über 100K Prompt mit der oberen Staffel (COPI-223)', async () => {
      const haiku = { ...KNAPP, zeitpunkt: '2026-10-08T14:00:00Z', modell: 'claude-haiku-5-5' };
      await melden({
        eintraege: [
          // Genau 100.000: noch die untere Staffel, 100.000 × 0,10.
          { ...haiku, schluessel: 'cc:grenze', tokens_eingabe: 100_000 },
          { ...haiku, schluessel: 'cc:gross', tokens_eingabe: 150_000, tokens_ausgabe: 1_000 },
          // Prompt 120.002 mit Cache-Lesen: obere Staffel.
          { ...haiku, schluessel: 'cc:cache', tokens_eingabe: 2, tokens_cache_lesen: 120_000, tokens_ausgabe: 300 },
          // Mit Datums-Anhang am Modellnamen gilt dieselbe Staffel.
          { ...haiku, schluessel: 'cc:datum', modell: 'claude-haiku-5-5-20261001', tokens_eingabe: 100_001 },
        ],
      });

      expect((await zeilen()).map((zeile) => [zeile.schluessel, zeile.kosten]).sort()).toEqual([
        ['cc:cache', '0.006751'],
        ['cc:datum', '0.050001'],
        ['cc:grenze', '0.010000'],
        ['cc:gross', '0.077500'],
      ]);
    });

    it('rechnet Sonnet 4.6 ohne Staffel, gültig ab 01.10.2026 (COPI-209, Kontrollrechnung)', async () => {
      const antwort = await melden({
        eintraege: [
          // 1 Mio. Eingabe + 1 Mio. Ausgabe: 3,00 + 15,00.
          {
            ...KNAPP,
            schluessel: 'cc:sonnet-grund',
            zeitpunkt: '2026-10-21T05:00:00Z',
            modell: 'claude-sonnet-4-6',
            tokens_eingabe: 1_000_000,
            tokens_ausgabe: 1_000_000,
          },
          // 1 Mio. je Tokenart: 3,00 + 15,00 + 3,75 + 6,00 + 0,30.
          {
            ...KNAPP,
            schluessel: 'cc:sonnet-je-art',
            zeitpunkt: '2026-10-21T05:00:00Z',
            modell: 'claude-sonnet-4-6',
            tokens_eingabe: 1_000_000,
            tokens_ausgabe: 1_000_000,
            tokens_cache_schreiben_5m: 1_000_000,
            tokens_cache_schreiben_1h: 1_000_000,
            tokens_cache_lesen: 1_000_000,
          },
          { ...KNAPP, schluessel: 'cc:sonnet-september', modell: 'claude-sonnet-4-6' },
        ],
      });

      expect(antwort.json).toMatchObject({ eintraege: 3, ohne_preis: 1 });
      expect((await zeilen()).map((zeile) => [zeile.schluessel, zeile.kosten, zeile.waehrung])).toEqual([
        ['cc:sonnet-grund', '18.000000', 'USD'],
        ['cc:sonnet-je-art', '28.050000', 'USD'],
        ['cc:sonnet-september', null, null],
      ]);
    });

    it('speichert auch einen Eintrag vor dem ersten Preis ohne Kosten', async () => {
      const antwort = await melden({ ...KNAPP, zeitpunkt: '2026-08-31T23:59:59Z' });

      expect(antwort.json).toMatchObject({ ohne_preis: 1 });
    });

    it('rechnet mit dem Server-Kommando verbrauch-kosten-neu alle Kosten neu, wenn ein Preis nachgetragen wird', async () => {
      await melden({ ...KNAPP, modell: 'meta-llama/Llama-3.1-405B-Instruct' });
      await pool.query(
        `INSERT INTO cockpit.preis (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
         VALUES ('meta-llama/Llama-3.1-405B-Instruct', 'EUR', 0.1, 0.1, 0.1, 0.1, 0.1, '2026-09-01T00:00:00Z', 'test', '2026-09-30')`,
      );

      const ausgabe: string[] = [];
      const code = await cliAusfuehren(['verbrauch-kosten-neu'], {
        pool,
        basisUrl: 'http://localhost:3000',
        ausgabe: (zeile) => ausgabe.push(zeile),
        fehlerausgabe: (zeile) => ausgabe.push(zeile),
      });

      expect(code).toBe(0);
      expect(ausgabe).toEqual(['1 Einträge neu berechnet, davon 0 ohne Preis.']);
      expect((await zeilen())[0]).toMatchObject({ kosten: '0.100000', waehrung: 'EUR' });
    });
  });

  describe('Validierung', () => {
    it.each([
      ['schluessel', { schluessel: 'mit leerzeichen' }],
      ['schluessel', { schluessel: 'x'.repeat(256) }],
      ['zeitpunkt', { zeitpunkt: 'gestern' }],
      ['zeitpunkt', { zeitpunkt: '2026-09-30' }],
      ['zeitpunkt', { zeitpunkt: '2099-01-01T00:00:00Z' }],
      ['quelle', { quelle: 'chatgpt' }],
      ['modell', { modell: 'mit leerzeichen' }],
      ['modell', { modell: '' }],
      ['tokens_eingabe', { tokens_eingabe: -1 }],
      ['tokens_ausgabe', { tokens_ausgabe: 1.5 }],
      ['tokens_cache_lesen', { tokens_cache_lesen: '7' }],
      ['tokens_cache_schreiben_1h', { tokens_cache_schreiben_1h: 2 ** 53 }],
      ['ticket', { ticket: 'jac-630' }],
      ['jira_projekt', { ticket: 'JAC-630', jira_projekt: 'COPI' }],
      ['qualitaet', { qualitaet: 'geraten' }],
      ['zuordnung', { zuordnung: 'zufall' }],
      ['subagent', { subagent: 'ja' }],
      ['sitzung', { sitzung: '' }],
      ['kosten', { kosten: 1 }],
    ])('weist einen Eintrag mit ungültigem %s ab und nennt nur den Feldnamen', async (feld, aenderung) => {
      const antwort = await melden({ ...EINTRAG, ...aenderung });

      expect(antwort.status).toBe(400);
      expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder: [feld] });
      expect(await zeilen()).toHaveLength(0);
    });

    it.each(['schluessel', 'zeitpunkt', 'quelle', 'modell', 'tokens_eingabe', 'tokens_ausgabe', 'tokens_cache_schreiben_5m', 'tokens_cache_schreiben_1h', 'tokens_cache_lesen'])(
      'verlangt das Pflichtfeld %s',
      async (feld) => {
        const antwort = await melden(Object.fromEntries(Object.entries(KNAPP).filter(([name]) => name !== feld)));

        expect(antwort.status).toBe(400);
        expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder: [feld] });
      },
    );

    it('nennt im Stapel die Stelle des Fehlers und speichert nichts — alles oder nichts', async () => {
      const antwort = await melden({ eintraege: [KNAPP, { ...KNAPP, schluessel: 'n8n:lauf-2', quelle: 'chatgpt' }] });

      expect(antwort.status).toBe(400);
      expect(antwort.json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['eintraege.1.quelle'] });
      expect(await zeilen()).toHaveLength(0);
    });

    it('weist einen leeren und einen zu großen Stapel ab', async () => {
      expect((await melden({ eintraege: [] })).json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['eintraege'] });

      const zuViele = Array.from({ length: 501 }, (_, nummer) => ({ ...KNAPP, schluessel: `n8n:lauf-${String(nummer)}` }));
      expect((await melden({ eintraege: zuViele })).json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['eintraege'] });
    });

    it('weist ein unbekanntes Feld neben dem Stapel ab', async () => {
      expect((await melden({ eintraege: [KNAPP], quelle: 'n8n' })).json).toEqual({ fehler: 'ungueltige_anfrage', felder: ['quelle'] });
    });

    it('wiederholt in der Antwort nie einen Wert der Eingabe', async () => {
      const antwort = await melden({ ...EINTRAG, modell: 'geheim mit leerzeichen' });

      expect(antwort.body).not.toContain('geheim');
    });
  });

  describe('Zugang', () => {
    it('verlangt das Recht verbrauch_schreiben: ohne es 403, ohne Token 401', async () => {
      const fremd = await token('admin-agent', ['befund_schreiben']);

      expect((await melden(EINTRAG, fremd)).status).toBe(403);
      const ohne = await app.inject({ method: 'POST', url: '/intern/verbrauch', payload: EINTRAG });
      expect(ohne.statusCode).toBe(401);
      expect(await zeilen()).toHaveLength(0);
    });
  });

  describe('die Tabellen (Migration 0032)', () => {
    it('weisen DELETE ab wie jede Nachweistabelle (nie löschen)', async () => {
      await melden(EINTRAG);

      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.verbrauch')).rejects.toThrow(/nie_loeschen/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.preis')).rejects.toThrow(/nie_loeschen/);
    });

    it('lassen sich die Kosten nicht von Hand setzen: der Trigger rechnet immer selbst', async () => {
      await melden(KNAPP);

      await pool.query('UPDATE cockpit.verbrauch SET kosten = 999');

      expect((await zeilen())[0]?.kosten).toBe('2.000000');
    });

    it('belegen jeden Startpreis mit Quelle und Prüfdatum', async () => {
      const preise = await pool.query<{ modell: string; quelle: string }>(`SELECT modell, quelle FROM cockpit.preis`);

      expect(preise.rows.map((zeile) => zeile.modell).sort()).toEqual([
        // Nachgetragen mit COPI-222 (Migration 0055).
        'BAAI/bge-m3',
        'claude-fable-5',
        'claude-fable-5-1',
        'claude-haiku-4-5',
        // Nachgetragen mit COPI-129 (Migration 0047): nur die Staffel bis 100K Prompt.
        'claude-haiku-5-5',
        // Zweite Zeile als Staffel über 100K Prompt: COPI-223 (Migration 0056).
        'claude-haiku-5-5',
        'claude-opus-5',
        'claude-opus-5-5',
        // Nachgetragen mit COPI-209 (Migration 0053): keine Staffel.
        'claude-sonnet-4-6',
        'claude-sonnet-5',
        'claude-sonnet-5-5',
        // Nachgetragen mit COPI-120 (Migration 0046): Bild-Ausgabe als eigenes Modell `:bild`.
        'gemini-2.5-flash-image',
        'gemini-2.5-flash-image:bild',
        'gemini-3-pro-image',
        'gemini-3-pro-image:bild',
        'gemini-3.1-flash-image',
        'gemini-3.1-flash-image:bild',
        'meta-llama/Llama-3.3-70B-Instruct',
        // Nachgetragen mit COPI-118 (Migration 0043).
        'meta-llama/Meta-Llama-3.1-8B-Instruct',
        'mistralai/Mistral-Small-24B-Instruct',
        'openai/gpt-oss-120b',
      ]);
      expect(preise.rows.every((zeile) => zeile.quelle.startsWith('https://'))).toBe(true);
    });
  });
});
