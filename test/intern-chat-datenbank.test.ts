/**
 * Der Antwortweg des Koordinators über die Agenten-API (COPI-55), mit echten Anfragen gegen die echte Datenbank:
 * `POST /intern/chat/antwort` und `GET /intern/zustand`.
 *
 * Was er aushalten muss: nur mit dem richtigen Recht, nur Fragen im Assistenten-Kanal (nichts über fremde Kanäle
 * verraten), eine Antwort je Frage, strenge Eingabe mit Obergrenze — und `GET /intern/zustand` liefert nie, was der
 * Kunde nicht sieht. Läuft nur mit `TEST_DATABASE_URL` und räumt dort Chat, Konten, Befunde und Zugänge ab.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatEreignisse } from '../src/chat/ereignisse.js';
import { assistentKanal, nachrichtAnlegen, teamKanal, type Nachricht } from '../src/chat/nachricht-speicher.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import type { ApiScope } from '../src/intern/token.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { chatLeeren, kontenLoeschen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const JETZT = new Date('2026-09-23T10:00:00.000Z');
const GEHEIM = 'GEHEIM-ROHBEFUND-4711';

describe.skipIf(!datenbankUrl)('Agenten-API für den Koordinator (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let gemeldet: Nachricht[];
  let koordinator: string;
  let admin: string;

  async function token(name: string, scopes: ApiScope[]): Promise<string> {
    return (await apiTokenAnlegen(pool, { name, scopes })).token;
  }

  function antwort(koerper: unknown, mit = koordinator) {
    return app.inject({
      method: 'POST',
      url: '/intern/chat/antwort',
      headers: { authorization: `Bearer ${mit}`, 'content-type': 'application/json' },
      payload: JSON.stringify(koerper),
    });
  }

  async function frage(inhalt = 'Wie viele Gäste reisen heute an?'): Promise<Nachricht> {
    return nachrichtAnlegen(pool, { kanalId: (await assistentKanal(pool, 'anna')).id, absenderArt: 'mensch', absenderId: 'anna', inhalt });
  }

  async function antworten(): Promise<{ inhalt: string; dringend: boolean; antwort_auf: number }[]> {
    const ergebnis = await pool.query<{ inhalt: string; dringend: boolean; antwort_auf: number }>(
      `SELECT inhalt, dringend, antwort_auf::int AS antwort_auf FROM cockpit.nachricht WHERE absender_art = 'agent' ORDER BY id`,
    );
    return ergebnis.rows;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query(
      `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt") VALUES ('anna', 'anna@example.org', 'Anna', true, now(), now())`,
    );
    gemeldet = [];
    const ereignisse = new ChatEreignisse();
    ereignisse.abonnieren((nachricht) => gemeldet.push(nachricht));
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT, chatEreignisse: ereignisse });
    await app.ready();
    koordinator = await token('koordinator', ['chat_antworten', 'zustand_lesen']);
    admin = await token('admin-agent', ['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten']);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.end();
  });

  describe('POST /intern/chat/antwort', () => {
    it('speichert die Antwort im Kanal der Frage, meldet sie weiter und antwortet mit 201', async () => {
      const f = await frage();

      const ergebnis = await antwort({ nachricht_id: f.id, text: 'Heute reisen 3 Gäste an.', dringend: true });

      expect(ergebnis.statusCode).toBe(201);
      expect(ergebnis.headers['cache-control']).toBe('no-store');
      expect(ergebnis.json()).toMatchObject({ nachricht_id: f.id, id: expect.any(Number) as unknown, erstellt_am: expect.any(String) as unknown });
      expect(await antworten()).toEqual([{ inhalt: 'Heute reisen 3 Gäste an.', dringend: true, antwort_auf: f.id }]);
      expect(gemeldet.map((n) => [n.absenderArt, n.kanalId, n.inhalt])).toEqual([['agent', f.kanalId, 'Heute reisen 3 Gäste an.']]);
    });

    it('ist ohne Angabe nicht dringend, und speichert den Text verbatim (Zeilenumbrüche vereinheitlicht)', async () => {
      const f = await frage();
      await antwort({ nachricht_id: f.id, text: '<b>fett?</b>\r\nhttps://example.org' });
      expect(await antworten()).toEqual([{ inhalt: '<b>fett?</b>\nhttps://example.org', dringend: false, antwort_auf: f.id }]);
    });

    it('weist eine zweite Antwort auf dieselbe Frage ab (409) — die erste bleibt', async () => {
      const f = await frage();
      await antwort({ nachricht_id: f.id, text: 'erste' });

      const zweite = await antwort({ nachricht_id: f.id, text: 'zweite' });

      expect(zweite.statusCode).toBe(409);
      expect(zweite.json()).toEqual({ fehler: 'schon_beantwortet' });
      expect((await antworten()).map((a) => a.inhalt)).toEqual(['erste']);
      expect(gemeldet).toHaveLength(1);
    });

    it('antwortet mit derselben 404 auf eine unbekannte Frage, eine Team-Nachricht und eine Nachricht des Agenten', async () => {
      const team = await nachrichtAnlegen(pool, { kanalId: (await teamKanal(pool)).id, absenderArt: 'mensch', absenderId: 'anna', inhalt: 'Team' });
      const f = await frage();
      await antwort({ nachricht_id: f.id, text: 'Antwort' });
      const [agent] = (await pool.query<{ id: number }>(`SELECT id::int AS id FROM cockpit.nachricht WHERE absender_art = 'agent'`)).rows;

      for (const id of [f.id + 1000, team.id, agent?.id ?? 0]) {
        const ergebnis = await antwort({ nachricht_id: id, text: 'darf nicht' });
        expect({ id, status: ergebnis.statusCode, body: ergebnis.json() as unknown }).toEqual({ id, status: 404, body: { fehler: 'nicht_gefunden' } });
      }
      expect((await antworten()).map((a) => a.inhalt)).toEqual(['Antwort']);
    });

    it.each<[string, unknown, string[]]>([
      ['ohne Text', { nachricht_id: 1 }, ['text']],
      ['mit leerem Text', { nachricht_id: 1, text: ' \n ' }, ['text']],
      ['mit zu langem Text', { nachricht_id: 1, text: 'x'.repeat(4001) }, ['text']],
      ['ohne Frage', { text: 'hallo' }, ['nachricht_id']],
      ['mit einer Frage, die keine Zahl ist', { nachricht_id: '1', text: 'hallo' }, ['nachricht_id']],
      ['mit einem unbekannten Feld', { nachricht_id: 1, text: 'hallo', kanal_id: 2 }, ['kanal_id']],
      ['mit dringend als Text', { nachricht_id: 1, text: 'hallo', dringend: 'ja' }, ['dringend']],
    ])('weist eine Antwort %s ab (400) und nennt nur die Felder', async (_fall, koerper, felder) => {
      const ergebnis = await antwort(koerper);

      expect(ergebnis.statusCode).toBe(400);
      expect(ergebnis.json()).toEqual({ fehler: 'ungueltige_anfrage', felder });
      expect(ergebnis.body).not.toContain('hallo');
    });

    it('nimmt genau 4000 Zeichen (Code-Points) an', async () => {
      const f = await frage();
      expect((await antwort({ nachricht_id: f.id, text: '😀'.repeat(4000) })).statusCode).toBe(201);
    });

    it('weist einen zu großen Rumpf ab (413)', async () => {
      const ergebnis = await antwort({ nachricht_id: 1, text: 'x'.repeat(30 * 1024) });
      expect(ergebnis.statusCode).toBe(413);
    });

    it('verlangt ein Token (401) und das Recht chat_antworten (403) — und speichert dann nichts', async () => {
      const f = await frage();
      const ohne = await app.inject({ method: 'POST', url: '/intern/chat/antwort', headers: { 'content-type': 'application/json' }, payload: '{}' });
      expect(ohne.statusCode).toBe(401);
      const nurLesen = await token('nur-lesen', ['zustand_lesen']);

      expect((await antwort({ nachricht_id: f.id, text: 'x' }, admin)).statusCode).toBe(403);
      expect((await antwort({ nachricht_id: f.id, text: 'x' }, nurLesen)).statusCode).toBe(403);
      expect(await antworten()).toEqual([]);
    });
  });

  describe('GET /intern/zustand', () => {
    function zustand(mit = koordinator) {
      return app.inject({ method: 'GET', url: '/intern/zustand', headers: { authorization: `Bearer ${mit}` } });
    }

    const befund = { taktSekunden: 300, quelle: 'admin-agent', jetzt: new Date(JETZT.getTime() - 60_000) };

    it('liefert genau die Kundensicht: sichtbare Bereiche im Klartext, nie einen Rohbefund, nie eine Kennung', async () => {
      await befundMelden(pool, {
        ...befund,
        wache: 'rechnung',
        status: 'gelb',
        textIntern: `${GEHEIM}-1`,
        textKunde: 'Zustellung verzögert.',
        kundensichtbar: true,
        anzeigename: 'Rechnungs-Agent',
        messwert: { wert: 12, einheit: 'offen', warnung: 10 },
      });
      await befundMelden(pool, { ...befund, wache: 'container', status: 'rot', textIntern: `${GEHEIM}-2`, kundensichtbar: false, messwert: { wert: 4711, einheit: 'geheim' } });
      await befundMelden(pool, { ...befund, wache: 'backup', status: 'gruen', textIntern: `${GEHEIM}-3`, textKunde: 'Gesichert.', kundensichtbar: true });
      // Ein jüngerer interner Befund derselben Wache mit Messwert (COPI-83): weder er noch sein Wert zählt für den Kunden.
      await befundMelden(pool, { ...befund, wache: 'backup', status: 'rot', textIntern: `${GEHEIM}-4`, kundensichtbar: false, messwert: { wert: 4712, einheit: 'geheim' } });

      const ergebnis = await zustand();

      expect(ergebnis.statusCode).toBe(200);
      expect(ergebnis.headers['cache-control']).toBe('no-store');
      expect(ergebnis.json()).toEqual({
        stand: '2026-09-23T10:00:00.000Z',
        status: { farbe: 'gelb', satz: 'Alles läuft, 1 Sache im Blick', detail: 'Zustellung verzögert.' },
        bereiche: [
          {
            name: 'Rechnungs-Agent',
            farbe: 'gelb',
            status_wort: 'Achtung',
            text: 'Zustellung verzögert.',
            geprueft: 'vor 1 Min. geprüft',
            ueberfaellig: false,
            messwert: { wert: 12, einheit: 'offen', warnung: 10 },
          },
          { name: 'Bereich', farbe: 'gruen', status_wort: 'Läuft', text: 'Gesichert.', geprueft: 'vor 1 Min. geprüft', ueberfaellig: false, messwert: null },
        ],
      });
      expect(ergebnis.body).not.toContain(GEHEIM);
      expect(ergebnis.body).not.toMatch(/4711|4712|geheim/);
      expect(ergebnis.body).not.toMatch(/container|rechnung"|backup|admin-agent/);
    });

    it('sagt ohne sichtbaren Befund nichts Falsches', async () => {
      await befundMelden(pool, { ...befund, wache: 'container', status: 'rot', textIntern: GEHEIM, kundensichtbar: false });

      const ergebnis = await zustand();

      expect(ergebnis.json()).toMatchObject({ status: { farbe: 'leer', satz: 'Noch keine Meldungen' }, bereiche: [] });
      expect(ergebnis.body).not.toContain(GEHEIM);
    });

    it('verlangt das Recht zustand_lesen (403)', async () => {
      expect((await zustand(admin)).statusCode).toBe(403);
      expect((await zustand(await token('nur-antworten', ['chat_antworten']))).statusCode).toBe(403);
    });
  });

  describe('die neuen Rechte', () => {
    it('lassen sich vergeben; ein unbekanntes Recht lehnt die Datenbank ab', async () => {
      const ping = await app.inject({ method: 'GET', url: '/intern/ping', headers: { authorization: `Bearer ${koordinator}` } });
      expect(ping.json()).toMatchObject({ name: 'koordinator', scopes: ['chat_antworten', 'zustand_lesen'] });
      await expect(
        pool.query(`INSERT INTO cockpit.api_token (name, token_hash, scopes) VALUES ('x', $1, ARRAY['chat_lesen'])`, ['a'.repeat(64)]),
      ).rejects.toThrow('api_token_scopes_bekannt');
    });
  });
});
