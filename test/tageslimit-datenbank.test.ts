/**
 * Das Tageslimit des Chats (COPI-57) gegen die echte Datenbank: Nachrichten an den Assistenten zählen je Konto und
 * Berliner Kalendertag, atomar; am Limit wird nichts gespeichert und nichts weitergeleitet, und die Seite sagt es. Dazu
 * `GET /intern/chat/verbrauch` für die Budget-Wache — nur Summen, keine Kennungen.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort Chat, Konten und Zugänge ab.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { verbrauchBuchen } from '../src/chat/verbrauch-speicher.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { buildApp } from '../src/server/app.js';
import { chatLeeren, FORMULAR_KOPF, formular, kontenLoeschen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HERKUNFT = { host: 'localhost:3000', origin: 'http://localhost:3000' };
const KOORDINATOR = { url: 'https://n8n.example.org/webhook/koordinator', geheimnis: 'ein-gemeinsames-geheimnis-mit-mehr-als-32-zeichen', fristMs: 120_000 };
const LIMIT = 5;

describe.skipIf(!datenbankUrl)('Tageslimit des Chats (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let jetzt: Date;
  let angemeldet: Zugang;
  let weitergeleitet: number;

  const holen = (() => {
    weitergeleitet += 1;
    return Promise.resolve(new Response('', { status: 200 }));
  }) as unknown as typeof fetch;

  function als(benutzerId: string): void {
    angemeldet = { angemeldet: true, rolle: 'betrieb_mitarbeiter', zweiterFaktorAktiv: true, benutzerId };
  }

  function senden(url: string, inhalt: string) {
    return app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: formular({ inhalt }) });
  }

  async function sendenMehrmals(anzahl: number, url = '/chat'): Promise<number[]> {
    const status: number[] = [];
    for (let i = 1; i <= anzahl; i++) {
      status.push((await senden(url, `Frage ${String(i)}`)).statusCode);
    }
    return status;
  }

  async function verbrauch(): Promise<{ benutzer_id: string; tag: string; anzahl: number }[]> {
    const ergebnis = await pool.query<{ benutzer_id: string; tag: string; anzahl: number }>(
      `SELECT benutzer_id, to_char(tag, 'YYYY-MM-DD') AS tag, anzahl FROM cockpit.chat_verbrauch ORDER BY tag, benutzer_id`,
    );
    return ergebnis.rows;
  }

  async function menschlicheNachrichten(): Promise<number> {
    const ergebnis = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM cockpit.nachricht WHERE absender_art = 'mensch'`);
    return ergebnis.rows[0]?.n ?? -1;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    for (const id of ['anna', 'bert']) {
      await pool.query(
        `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1 || '@example.org', $1, true, now(), now())`,
        [id],
      );
    }
    jetzt = new Date('2026-09-23T10:00:00.000Z');
    weitergeleitet = 0;
    als('anna');
    app = buildApp(
      { nodeEnv: 'test' },
      { pool, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(angemeldet), jetzt: () => jetzt, koordinator: KOORDINATOR, holen, chatTageslimit: LIMIT },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.end();
  });

  describe('am Limit', () => {
    it('lässt genau das Limit durch; darüber wird nichts gespeichert und nichts weitergeleitet (429)', async () => {
      expect(await sendenMehrmals(LIMIT)).toEqual([303, 303, 303, 303, 303]);

      const darueber = await senden('/chat', 'eine zu viel');

      expect(darueber.statusCode).toBe(429);
      expect(darueber.body).toContain('Das Tageslimit von 5 Nachrichten an den Assistenten ist erreicht. Ab 24.09.2026, 00:00 Uhr geht es wieder.');
      expect(darueber.body).toMatch(/<textarea[^>]*>eine zu viel<\/textarea>/);
      expect(await menschlicheNachrichten()).toBe(LIMIT);
      expect(weitergeleitet).toBe(LIMIT);
      expect(await verbrauch()).toEqual([{ benutzer_id: 'anna', tag: '2026-09-23', anzahl: 5 }]);
    });

    it('zeigt ab 80 % den Rest und am Limit statt der Eingabe einen Hinweis', async () => {
      await sendenMehrmals(3);
      expect((await app.inject({ method: 'GET', url: '/chat' })).body).not.toContain('Heute noch');

      await sendenMehrmals(1);
      const fast = (await app.inject({ method: 'GET', url: '/chat' })).body;
      expect(fast).toContain('Heute noch 1 Nachricht an den Assistenten.');
      expect(fast).toContain('aria-describedby="chat-rest"');

      await sendenMehrmals(1);
      const voll = (await app.inject({ method: 'GET', url: '/chat' })).body;
      expect(voll).toContain('Das Tageslimit für Nachrichten an den Assistenten ist erreicht. Ab 24.09.2026, 00:00 Uhr geht es wieder.');
      expect(voll).not.toContain('<textarea');
    });

    it('zählt je Konto, und der Team-Kanal zählt nicht und geht am Limit weiter', async () => {
      await sendenMehrmals(LIMIT);
      expect((await sendenMehrmals(3, '/chat/team'))).toEqual([303, 303, 303]);
      expect((await app.inject({ method: 'GET', url: '/chat/team' })).body).toContain('<textarea');

      als('bert');
      expect((await senden('/chat', 'Bert fragt')).statusCode).toBe(303);
      expect(await verbrauch()).toEqual([
        { benutzer_id: 'anna', tag: '2026-09-23', anzahl: 5 },
        { benutzer_id: 'bert', tag: '2026-09-23', anzahl: 1 },
      ]);
    });

    it('lässt auch bei parallelen Anfragen nie mehr als das Limit durch', async () => {
      const antworten = await Promise.all(Array.from({ length: 12 }, (_, i) => senden('/chat', `parallel ${String(i)}`)));

      expect(antworten.filter((antwort) => antwort.statusCode === 303)).toHaveLength(LIMIT);
      expect(antworten.filter((antwort) => antwort.statusCode === 429)).toHaveLength(12 - LIMIT);
      expect(await menschlicheNachrichten()).toBe(LIMIT);
      expect(await verbrauch()).toEqual([{ benutzer_id: 'anna', tag: '2026-09-23', anzahl: 5 }]);
    });

    it('bucht auch direkt in der Datenbank nie über das Limit, gleich wie viele gleichzeitig', async () => {
      const staende = await Promise.all(Array.from({ length: 20 }, () => verbrauchBuchen(pool, 'anna', '2026-09-23', 7)));

      expect(staende.filter((stand) => stand !== undefined).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(await verbrauch()).toEqual([{ benutzer_id: 'anna', tag: '2026-09-23', anzahl: 7 }]);
    });

    it('gibt eine gebuchte Nachricht zurück, wenn sie nicht gespeichert werden konnte', async () => {
      await pool.query(`CREATE FUNCTION cockpit.test_nachricht_scheitert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_nachricht_scheitert'; END $$`);
      await pool.query(`CREATE TRIGGER test_nachricht_scheitert BEFORE INSERT ON cockpit.nachricht FOR EACH ROW EXECUTE FUNCTION cockpit.test_nachricht_scheitert()`);
      try {
        expect((await senden('/chat', 'geht schief')).statusCode).toBe(500);
      } finally {
        await pool.query('DROP TRIGGER test_nachricht_scheitert ON cockpit.nachricht');
        await pool.query('DROP FUNCTION cockpit.test_nachricht_scheitert()');
      }
      expect(await verbrauch()).toEqual([{ benutzer_id: 'anna', tag: '2026-09-23', anzahl: 0 }]);
    });
  });

  describe('Tageswechsel', () => {
    it.each([
      ['in der Sommerzeit', '2026-09-23T21:59:59.000Z', '2026-09-23T22:00:00.000Z', '2026-09-23', '2026-09-24', '24.09.2026'],
      ['in der Winterzeit', '2026-12-01T22:59:59.000Z', '2026-12-01T23:00:00.000Z', '2026-12-01', '2026-12-02', '02.12.2026'],
      ['am Ende der Sommerzeit', '2026-10-25T22:59:59.000Z', '2026-10-25T23:00:00.000Z', '2026-10-25', '2026-10-26', '26.10.2026'],
      ['am Beginn der Sommerzeit', '2026-03-29T21:59:59.000Z', '2026-03-29T22:00:00.000Z', '2026-03-29', '2026-03-30', '30.03.2026'],
    ])('beginnt %s um Mitternacht in Berlin von vorn', async (_fall, vorher, nachher, tagVorher, tagNachher, ab) => {
      jetzt = new Date(vorher);
      await sendenMehrmals(LIMIT);
      const voll = await senden('/chat', 'eine zu viel');
      expect(voll.statusCode).toBe(429);
      expect(voll.body).toContain(`Ab ${ab}, 00:00 Uhr geht es wieder.`);

      jetzt = new Date(nachher);
      expect((await senden('/chat', 'neuer Tag')).statusCode).toBe(303);
      expect(await verbrauch()).toEqual([
        { benutzer_id: 'anna', tag: tagVorher, anzahl: 5 },
        { benutzer_id: 'anna', tag: tagNachher, anzahl: 1 },
      ]);
    });
  });

  describe('GET /intern/chat/verbrauch', () => {
    async function abrufen(query = '', scopes: ('zustand_lesen' | 'chat_antworten')[] = ['zustand_lesen']) {
      const { token } = await apiTokenAnlegen(pool, { name: `wache-${String(Math.random()).slice(2, 8)}`, scopes });
      return app.inject({ method: 'GET', url: `/intern/chat/verbrauch${query}`, headers: { authorization: `Bearer ${token}` } });
    }

    it('liefert Summen je Tag, jüngster zuerst, ohne Kennungen — und die Tage zurück nach ?tage=', async () => {
      await pool.query(
        `INSERT INTO cockpit.chat_verbrauch (benutzer_id, tag, anzahl) VALUES
           ('anna', '2026-09-23', 5), ('bert', '2026-09-23', 2),
           ('anna', '2026-09-21', 1), ('bert', '2026-09-10', 4), ('anna', '2026-09-22', 0)`,
      );

      const ergebnis = await abrufen();

      expect(ergebnis.statusCode).toBe(200);
      expect(ergebnis.json()).toEqual({
        limit: 5,
        heute: '2026-09-23',
        tage: [
          { tag: '2026-09-23', nachrichten: 7, benutzer: 2, am_limit: 1 },
          { tag: '2026-09-21', nachrichten: 1, benutzer: 1, am_limit: 0 },
        ],
      });
      expect(ergebnis.body).not.toMatch(/anna|bert/);
      expect((await abrufen('?tage=14')).json()).toMatchObject({ tage: [{ tag: '2026-09-23' }, { tag: '2026-09-21' }, { tag: '2026-09-10' }] });
      expect((await abrufen('?tage=1')).json()).toMatchObject({ tage: [{ tag: '2026-09-23' }] });
    });

    it.each(['?tage=0', '?tage=32', '?tage=abc', '?tage=1&konto=anna'])('weist %s ab (400)', async (query) => {
      const ergebnis = await abrufen(query);
      expect(ergebnis.statusCode).toBe(400);
      expect(ergebnis.json()).toMatchObject({ fehler: 'ungueltige_anfrage' });
    });

    it('verlangt das Recht zustand_lesen (403)', async () => {
      expect((await abrufen('', ['chat_antworten'])).statusCode).toBe(403);
    });
  });
});
