/**
 * Gemeldete Ereignisse der Agenten (COPI-114) gegen eine echte PostgreSQL: `POST /intern/agenten/ereignis` (Recht,
 * Prüfung, Begrenzung je Agent und Stunde), die Tabelle (unveränderlich, nie löschen) und das Protokoll der
 * Detailseite je Sicht — die Kundensicht sieht nur Kundensichtbares im Klartext, nie Text oder Titel des Agenten.
 *
 * Läuft nur mit `TEST_DATABASE_URL`.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { agentPfad } from '../src/agenten/detail.js';
import { EREIGNISSE_JE_STUNDE } from '../src/agenten/ereignis-speicher.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { buildApp } from '../src/server/app.js';
import { inventarErsetzen } from '../src/status/agenten-speicher.js';
import { wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const JETZT = new Date('2026-10-02T10:00:00.000Z');
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

describe.skipIf(!datenbankUrl)('Ereignisse der Agenten (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let rolle: Rolle;
  let schreiben: string;
  let fremd: string;

  function melden(koerper: unknown, token = schreiben) {
    return app.inject({ method: 'POST', url: '/intern/agenten/ereignis', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(koerper) });
  }

  async function seite(url: string, als: Rolle): Promise<string> {
    rolle = als;
    return (await app.inject({ method: 'GET', url })).body;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    const basis = (): Promise<Zugang> => Promise.resolve({ angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'konto-test' });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT, sitzungLesen: MIT_FAKTOR, zugangLesen: basis });
    await app.ready();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE cockpit.agent_ereignis RESTART IDENTITY');
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query('DELETE FROM cockpit.agent');
    await inventarErsetzen(pool, [{ kennung: 'wache', rolle: 'Wache – DevOps', version: '3', grenzen: {}, zeitplan: [] }], JETZT);
    schreiben = (await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['agenten_schreiben'] })).token;
    fremd = (await apiTokenAnlegen(pool, { name: 'koordinator', scopes: ['chat_antworten'] })).token;
  });

  afterAll(async () => {
    await app.close();
    await pool.query('TRUNCATE cockpit.agent_ereignis RESTART IDENTITY');
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query('DELETE FROM cockpit.agent');
    await pool.end();
  });

  describe('die API', () => {
    it('nimmt ein Ereignis an und hält den Zugang als Quelle fest', async () => {
      const antwort = await melden({ agent: 'wache', stufe: 'fehler', titel: 'Lauf gescheitert', text: 'pg_dump abgebrochen', zeitpunkt: '2026-10-02T04:16:00Z' });
      expect(antwort.statusCode).toBe(201);
      expect(antwort.json()).toMatchObject({ zeitpunkt: '2026-10-02T04:16:00.000Z' });
      const zeile = await pool.query(`SELECT agent, stufe, titel, text, kundensichtbar, quelle FROM cockpit.agent_ereignis`);
      expect(zeile.rows).toEqual([{ agent: 'wache', stufe: 'fehler', titel: 'Lauf gescheitert', text: 'pg_dump abgebrochen', kundensichtbar: false, quelle: 'admin-agent' }]);
    });

    it.each([
      ['eine unbekannte Stufe', { agent: 'wache', stufe: 'kritisch', text: 'x' }, 'stufe'],
      ['eine ungültige Kennung', { agent: 'Wache!', stufe: 'info', text: 'x' }, 'agent'],
      ['zu langen Text', { agent: 'wache', stufe: 'info', text: 'x'.repeat(501) }, 'text'],
      ['sichtbar ohne Klartext', { agent: 'wache', stufe: 'info', text: 'x', kundensichtbar: true }, 'text_kunde'],
      ['einen Zeitpunkt in der Zukunft', { agent: 'wache', stufe: 'info', text: 'x', zeitpunkt: '2026-10-02T11:00:00Z' }, 'zeitpunkt'],
      ['einen Zeitpunkt älter als sieben Tage', { agent: 'wache', stufe: 'info', text: 'x', zeitpunkt: '2026-09-20T10:00:00Z' }, 'zeitpunkt'],
      ['ein unbekanntes Feld', { agent: 'wache', stufe: 'info', text: 'x', log: 'roh' }, 'log'],
    ])('weist %s ab (400, Feld genannt)', async (_fall, koerper, feld) => {
      const antwort = await melden(koerper);
      expect(antwort.statusCode).toBe(400);
      expect(JSON.stringify(antwort.json())).toContain(feld);
    });

    it('verlangt das Recht agenten_schreiben', async () => {
      expect((await melden({ agent: 'wache', stufe: 'info', text: 'x' }, fremd)).statusCode).toBe(403);
    });

    it(`nimmt je Agent höchstens ${String(EREIGNISSE_JE_STUNDE)} je Stunde an, ein anderer Agent bleibt frei`, async () => {
      await pool.query(
        `INSERT INTO cockpit.agent_ereignis (agent, stufe, text, zeitpunkt, quelle) SELECT 'wache', 'info', 'x', now(), 't' FROM generate_series(1, $1)`,
        [EREIGNISSE_JE_STUNDE],
      );
      const zuviel = await melden({ agent: 'wache', stufe: 'info', text: 'eins zu viel' });
      expect(zuviel.statusCode).toBe(429);
      expect(zuviel.headers['retry-after']).toBe('3600');
      expect((await melden({ agent: 'koordinator', stufe: 'info', text: 'anderer Agent' })).statusCode).toBe(201);
    });
  });

  describe('die Tabelle (Migration 0039)', () => {
    it('ist unveränderlich und weist DELETE ab', async () => {
      await melden({ agent: 'wache', stufe: 'info', text: 'x' });
      await expect(pool.query(`UPDATE cockpit.agent_ereignis SET text = 'y'`)).rejects.toThrow(/agent_ereignis_unveraenderlich/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.agent_ereignis')).rejects.toThrow(/nie_loeschen/);
    });
  });

  describe('das Protokoll', () => {
    beforeEach(async () => {
      await melden({ agent: 'wache', stufe: 'fehler', titel: 'INTERNER-TITEL', text: 'ROH-TEXT pg_dump', text_kunde: 'Die Datensicherung ist ausgefallen.', kundensichtbar: true, zeitpunkt: '2026-10-02T04:16:00Z' });
      await melden({ agent: 'wache', stufe: 'warnung', titel: 'Zertifikat', text: 'NUR-INTERN dns', zeitpunkt: '2026-10-01T23:10:00Z' });
    });

    it('zeigt dem Betreuer Titel und Text, mit Filter nach Stufe und der Fehler-Kennzahl', async () => {
      const html = await seite(agentPfad('wache', 'protokoll'), 'betreuer');
      expect(html).toContain('INTERNER-TITEL');
      expect(html).toContain('ROH-TEXT pg_dump');
      expect(html).toContain('NUR-INTERN dns');
      expect(html).toContain('Ereignis · Fehler');

      const nurFehler = await seite(`${agentPfad('wache', 'protokoll')}&art=ereignis&stufe=fehler`, 'betreuer');
      expect(nurFehler).toContain('ROH-TEXT pg_dump');
      expect(nurFehler).not.toContain('NUR-INTERN dns');
      expect(nurFehler).toContain('aria-current="true">nur Fehler<');

      const steckbrief = await seite(agentPfad('wache'), 'betreuer');
      expect(steckbrief).toMatch(/Fehler 7 Tage<\/span><span class="agent-kennzahl-wert agent-kennzahl-fehler">1</);
    });

    it.each<Rolle>(['betriebs_admin', 'betrieb_mitarbeiter'])('zeigt der Kundensicht (%s) nur Kundensichtbares im Klartext, ohne Titel und Text des Agenten', async (als) => {
      const html = await seite(agentPfad('wache', 'protokoll'), als);
      expect(html).toContain('Die Datensicherung ist ausgefallen.');
      expect(html).toContain('Fehler gemeldet');
      expect(html).not.toContain('INTERNER-TITEL');
      expect(html).not.toContain('ROH-TEXT');
      expect(html).not.toContain('NUR-INTERN');
    });
  });
});
