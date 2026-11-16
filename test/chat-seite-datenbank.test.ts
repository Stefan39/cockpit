/**
 * Die Chat-Seite (COPI-53) mit echten Anfragen gegen die echte Datenbank: wer sie sieht, wer schreibt, was geschrieben
 * wird — und dass Inhalte nie etwas anderes werden als Text.
 *
 * Sicherheitskritisch sind drei Dinge: nur mit Recht `chat_nutzen` (sonst die neutrale 404), Schreiben nur mit
 * eigener Herkunft (CSRF), und jeder Inhalt escaped, nie verlinkt (ADR 10, JAC-577). Der Assistenten-Kanal gehört
 * einem Benutzer; kein anderer sieht ihn.
 *
 * Die Sitzung ist ein Stub (angemeldet, zweiter Faktor aktiv); wer angemeldet ist, bestimmt `angemeldet`. Läuft nur mit
 * `TEST_DATABASE_URL` und räumt dort Chat und Konten ab.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import {
  assistentKanal,
  nachrichtAlsGeloeschtMarkieren,
  nachrichtAnlegen,
  teamKanal,
  ungeleseneGesamt,
  ungeleseneZaehlen,
} from '../src/chat/nachricht-speicher.js';
import { ChatEreignisse } from '../src/chat/ereignisse.js';
import { signatur } from '../src/chat/koordinator.js';
import { NICHT_ERREICHBAR } from '../src/server/routes/chat.js';
import { buildApp } from '../src/server/app.js';
import { chatLeeren, FORMULAR_KOPF, formular, kontenLoeschen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const JETZT = new Date('2026-09-23T08:15:00.000Z');
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HERKUNFT = { host: 'localhost:3000', origin: 'http://localhost:3000' };
const KOORDINATOR = { url: 'https://n8n.example.org/webhook/koordinator', geheimnis: 'ein-gemeinsames-geheimnis-mit-mehr-als-32-zeichen', fristMs: 120_000 };

describe.skipIf(!datenbankUrl)('Chat-Seite (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let angemeldet: Zugang;
  /** Was beim Fake-Webhook ankam, und wie er antwortet (COPI-54). */
  let webhookAufrufe: { url: string; kopf: Record<string, string>; rumpf: string }[];
  let webhookAntwort: () => Promise<Response>;
  /** Was die Seite an den Verteiler meldet (COPI-55). */
  let gemeldet: { art: string; inhalt: string | undefined }[] = [];
  const chatEreignisse = new ChatEreignisse();
  chatEreignisse.abonnieren((nachricht) => gemeldet.push({ art: nachricht.absenderArt, inhalt: nachricht.inhalt }));
  const holen = ((url: string, init: RequestInit) => {
    webhookAufrufe.push({ url, kopf: init.headers as Record<string, string>, rumpf: String(init.body) });
    return webhookAntwort();
  }) as unknown as typeof fetch;

  /** `ohne`: angemeldet, aber ohne bekannte Rolle — und damit ohne Recht. */
  function als(benutzerId: string, rolle: Rolle | 'ohne' = 'betrieb_mitarbeiter'): void {
    angemeldet = { angemeldet: true, rolle: rolle === 'ohne' ? undefined : rolle, zweiterFaktorAktiv: true, benutzerId };
  }

  function seite(url: string) {
    return app.inject({ method: 'GET', url });
  }

  function senden(url: string, inhalt: string, kopf: Record<string, string> = HERKUNFT) {
    return app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...kopf }, payload: formular({ inhalt }) });
  }

  async function inhalte(): Promise<{ kanal: string; absender: string | null; inhalt: string }[]> {
    const ergebnis = await pool.query<{ kanal: string; absender: string | null; inhalt: string }>(
      `SELECT k.art AS kanal, n.absender_id AS absender, n.inhalt FROM cockpit.nachricht n JOIN cockpit.kanal k ON k.id = n.kanal_id ORDER BY n.id`,
    );
    return ergebnis.rows;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    app = buildApp(
      { nodeEnv: 'test' },
      { pool, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(angemeldet), jetzt: () => JETZT, koordinator: KOORDINATOR, holen, chatEreignisse },
    );
    await app.ready();
  });

  beforeEach(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    for (const [id, name] of [
      ['anna', 'Anna Berg'],
      ['bert', 'Bert Vogt'],
    ]) {
      await pool.query(
        `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1 || '@example.org', $2, true, now(), now())`,
        [id, name],
      );
    }
    als('anna');
    webhookAufrufe = [];
    gemeldet = [];
    webhookAntwort = () => Promise.resolve(new Response('', { status: 200 }));
  });

  afterAll(async () => {
    await app.close();
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('wer', () => {
    it.each(['/chat', '/chat/team'])('zeigt %s jeder Rolle, rollenabhängig und nie aus dem Cache', async (pfad) => {
      for (const rolle of ['betrieb_mitarbeiter', 'betriebs_admin', 'betreuer'] as const) {
        als('anna', rolle);
        const antwort = await seite(pfad);
        expect({ rolle, status: antwort.statusCode }).toEqual({ rolle, status: 200 });
        expect(antwort.headers['cache-control']).toBe('no-store');
      }
    });

    it.each(['/chat', '/chat/team'])('antwortet auf %s ohne Recht mit der neutralen 404 — lesend und schreibend, und speichert nichts', async (pfad) => {
      als('anna', 'ohne');

      expect((await seite(pfad)).statusCode).toBe(404);
      expect((await senden(pfad, 'hallo')).statusCode).toBe(404);
      expect(await inhalte()).toEqual([]);
    });

    it('zeigt den Assistenten-Kanal nur seinem Besitzer', async () => {
      await senden('/chat', 'Nur für mich');
      als('bert');

      const antwort = await seite('/chat');
      expect(antwort.body).not.toContain('Nur für mich');
      expect(antwort.body).toContain('Noch keine Nachrichten.');
    });
  });

  describe('schreiben', () => {
    it('speichert eine Nachricht im Assistenten-Kanal und kehrt dorthin zurück (303)', async () => {
      const antwort = await senden('/chat', 'Wie viele Buchungen gibt es heute?');

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/chat');
      expect(await inhalte()).toEqual([{ kanal: 'assistent', absender: 'anna', inhalt: 'Wie viele Buchungen gibt es heute?' }]);
      expect((await seite('/chat')).body).toContain('<p class="chat-blase">Wie viele Buchungen gibt es heute?</p>');
    });

    it('schreibt in den Team-Kanal, und die anderen sehen es mit Namen', async () => {
      expect((await senden('/chat/team', 'Wer übernimmt heute?')).headers.location).toBe('/chat/team');

      expect((await seite('/chat/team')).body).toMatch(/<article class="chat-nachricht chat-nachricht-eigen" id="nachricht-\d+">[^]*?Du · <time/);
      als('bert');
      const bei = (await seite('/chat/team')).body;
      expect(bei).toContain('Wer übernimmt heute?');
      expect(bei).toMatch(/<article class="chat-nachricht" id="nachricht-\d+">[^]*?Anna Berg · <time/);
    });

    it.each([
      ['ohne Herkunft', {}],
      ['von einer fremden Adresse', { host: 'localhost:3000', origin: 'https://boese.example.org' }],
      ['von einer Nachbar-Subdomain', { host: 'kunde.example.com', origin: 'https://andere.example.com' }],
    ])('weist eine Nachricht %s ab (403) und speichert nichts', async (_fall, kopf) => {
      const antwort = await senden('/chat', 'untergeschoben', kopf);

      expect(antwort.statusCode).toBe(403);
      expect(antwort.body).toContain('Diese Nachricht kam nicht aus dem Cockpit und wurde nicht gespeichert.');
      expect(await inhalte()).toEqual([]);
    });

    it.each([
      ['leer', '', 'Bitte eine Nachricht eingeben.'],
      ['nur Leerraum', ' \r\n\t ', 'Bitte eine Nachricht eingeben.'],
      ['zu lang', 'x'.repeat(4001), 'Die Nachricht ist zu lang: höchstens 4000 Zeichen.'],
    ])('weist eine Nachricht ab: %s (400), mit Hinweis und ohne zu speichern', async (_fall, inhalt, hinweis) => {
      const antwort = await senden('/chat', inhalt);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain(hinweis);
      expect(antwort.body).toContain('aria-invalid="true"');
      expect(await inhalte()).toEqual([]);
    });

    it('lässt eine zu lange Nachricht im Feld stehen, damit nichts verloren geht', async () => {
      const antwort = await senden('/chat', `Anfang ${'x'.repeat(4001)}`);
      expect(antwort.body).toMatch(/<textarea[^>]*>Anfang x+<\/textarea>/);
    });

    it('zählt Zeichen wie die Datenbank: 4000 Emoji gehen durch', async () => {
      expect((await senden('/chat', '😀'.repeat(4000))).statusCode).toBe(303);
      expect((await senden('/chat', '😀'.repeat(4001))).statusCode).toBe(400);
    });

    it('vereinheitlicht Zeilenumbrüche und behält sie', async () => {
      await senden('/chat', 'Zeile 1\r\nZeile 2');
      expect((await inhalte())[0]?.inhalt).toBe('Zeile 1\nZeile 2');
    });
  });

  describe('Inhalte bleiben Text', () => {
    it('escaped HTML und verlinkt nichts — weder Adressen noch javascript:-Links noch Markdown', async () => {
      const boese = '<script>alert(1)</script> <img src=x onerror=alert(2)> [klick](javascript:alert(3)) https://example.org www.example.org';
      await senden('/chat', boese);

      const html = (await seite('/chat')).body;
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toMatch(/href="(https:\/\/example\.org|www\.example\.org|javascript:)/);
      expect(html).toContain('[klick](javascript:alert(3)) https://example.org www.example.org');
    });

    it('kennzeichnet Antworten des Koordinators als KI, und der Assistenten-Kanal trägt die KI-Marke', async () => {
      const kanal = await assistentKanal(pool, 'anna');
      const frage = await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'mensch', absenderId: 'anna', inhalt: 'Frage' });
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', antwortAuf: frage.id, inhalt: 'Antwort', dringend: true });

      const html = (await seite('/chat')).body;
      expect(html).toContain('KI-gestützt · Antworten erzeugt eine KI');
      expect(html).toMatch(/Koordinator · <abbr title="von einer KI erzeugt">KI<\/abbr> · dringend · <time datetime="[^"]+">[^<]+<\/time>/);
      expect((await seite('/chat/team')).body).not.toContain('KI-gestützt');
    });

    it('zeigt eine als gelöscht markierte Nachricht ohne ihren Inhalt', async () => {
      const team = await teamKanal(pool);
      const nachricht = await nachrichtAnlegen(pool, { kanalId: team.id, absenderArt: 'mensch', absenderId: 'bert', inhalt: 'geheim-4711' });
      await nachrichtAlsGeloeschtMarkieren(pool, team.id, nachricht.id, 'bert');

      const html = (await seite('/chat/team')).body;
      expect(html).toContain('Nachricht gelöscht');
      expect(html).not.toContain('geheim-4711');
    });
  });

  describe('Lesestand und Verlauf', () => {
    it('zählt Ungelesenes in Navigation und Verlauf, bis der Kanal angesehen ist', async () => {
      const team = await teamKanal(pool);
      await nachrichtAnlegen(pool, { kanalId: team.id, absenderArt: 'mensch', absenderId: 'bert', inhalt: 'eins' });
      await nachrichtAnlegen(pool, { kanalId: team.id, absenderArt: 'mensch', absenderId: 'bert', inhalt: 'zwei' });

      const vorher = (await seite('/chat')).body;
      expect(vorher).toContain('<span class="hauptnav-zahl"><span aria-hidden="true">2</span><span class="sr-only">, 2 ungelesen</span></span>');
      expect(vorher).toMatch(/Team <span class="chat-zahl">/);
      expect(await ungeleseneGesamt(pool, 'anna')).toBe(2);

      const danach = (await seite('/chat/team')).body;
      expect(danach).not.toContain('hauptnav-zahl');
      expect(await ungeleseneGesamt(pool, 'anna')).toBe(0);
      // Für Bert war nichts ungelesen: es sind seine eigenen.
      expect(await ungeleseneGesamt(pool, 'bert')).toBe(0);
    });

    it('zeigt die jüngsten 50, blättert zu älteren, und das Blättern ändert den Lesestand nicht', async () => {
      const team = await teamKanal(pool);
      await pool.query(
        `INSERT INTO cockpit.nachricht (kanal_id, absender_art, absender_id, inhalt)
         SELECT $1, 'mensch', 'bert', 'Nachricht ' || i FROM generate_series(1, 55) i`,
        [team.id],
      );

      const aelter = /<a href="\/chat\/team\?vor=(\d+)">Ältere Nachrichten<\/a>/;
      const juengste = (await seite('/chat/team')).body;
      expect(juengste).toContain('Nachricht 55');
      expect(juengste).not.toContain('Nachricht 5<');
      const vor = aelter.exec(juengste)?.[1] ?? '';
      expect(vor).not.toBe('');

      await nachrichtAnlegen(pool, { kanalId: team.id, absenderArt: 'mensch', absenderId: 'bert', inhalt: 'neu dazu' });
      const frueher = (await seite(`/chat/team?vor=${vor}`)).body;
      expect(frueher).toContain('Nachricht 1<');
      expect(frueher).toContain('Nachricht 5<');
      expect(frueher).not.toContain('Nachricht 55');
      expect(frueher).toContain('<a href="/chat/team">Zu den neuesten Nachrichten</a>');
      expect(await ungeleseneGesamt(pool, 'anna')).toBe(1);
    });

    it('bindet den Stream nur auf der jüngsten Seite ein, ab der jüngsten Nachricht (COPI-56)', async () => {
      const leer = (await seite('/chat/team')).body;
      expect(leer).toContain('data-chat-strom="/chat/team/ereignisse"');
      expect(leer).toContain('<script type="module" src="/chat/skript.js"></script>');

      await senden('/chat/team', 'eins');
      await senden('/chat/team', 'zwei');
      const [juengste] = (await pool.query<{ id: number }>('SELECT max(id)::int AS id FROM cockpit.nachricht')).rows;
      const html = (await seite('/chat/team')).body;
      expect(html).toContain(`data-chat-strom="/chat/team/ereignisse?seit=${String(juengste?.id)}"`);

      const aelter = (await seite(`/chat/team?vor=${String(juengste?.id)}`)).body;
      expect(aelter).not.toContain('data-chat-strom');
      // Das Skript lädt trotzdem: es macht Enter zum Absenden (COPI-64); den Stream öffnet es hier nicht.
      expect(aelter).toContain('/chat/skript.js');
    });

    it('liefert das Skript des Chats aus', async () => {
      const skript = await seite('/chat/skript.js');
      expect(skript.statusCode).toBe(200);
      expect(skript.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(skript.body).toContain('export function nachrichtEinfuegen');
    });

    it('übergeht eine unbrauchbare Seitenangabe und zeigt die jüngsten', async () => {
      await senden('/chat', 'jüngste');
      for (const vor of ['0', '-1', 'abc', '1e5', '9'.repeat(20)]) {
        const antwort = await seite(`/chat?vor=${encodeURIComponent(vor)}`);
        expect({ vor, status: antwort.statusCode }).toEqual({ vor, status: 200 });
        expect(antwort.body).toContain('jüngste');
      }
    });
  });
  describe('Weiterleitung an den Koordinator (COPI-54)', () => {
    it('leitet eine Nachricht im Assistenten-Kanal signiert weiter — mit ID, Konto und Text, ohne Sitzung', async () => {
      als('anna', 'betriebs_admin');
      expect((await senden('/chat', 'Wie viele Gäste reisen heute an?')).statusCode).toBe(303);

      const [aufruf] = webhookAufrufe;
      const [gespeichert] = (await pool.query<{ id: number }>('SELECT id::int AS id FROM cockpit.nachricht')).rows;
      expect(aufruf?.url).toBe(KOORDINATOR.url);
      expect(JSON.parse(aufruf?.rumpf ?? '{}')).toMatchObject({
        nachricht_id: gespeichert?.id,
        kanal: 'assistent',
        benutzer: { id: 'anna', rolle: 'betriebs_admin', name: 'Anna Berg' },
        text: 'Wie viele Gäste reisen heute an?',
      });
      const zeitpunkt = Number(aufruf?.kopf['x-cockpit-zeitpunkt']);
      expect(zeitpunkt).toBe(Math.floor(JETZT.getTime() / 1000));
      expect(aufruf?.kopf['x-cockpit-signatur']).toBe(signatur(KOORDINATOR.geheimnis, zeitpunkt, aufruf?.rumpf ?? ''));
      expect(Object.keys(aufruf?.kopf ?? {}).sort()).toEqual(['content-type', 'x-cockpit-signatur', 'x-cockpit-zeitpunkt']);
    });

    it('meldet jede gespeicherte Nachricht an den Verteiler — die eigene und die Meldung des Cockpits, sonst nichts', async () => {
      await senden('/chat/team', 'ans Team');
      webhookAntwort = () => Promise.resolve(new Response('', { status: 503 }));
      await senden('/chat', 'an den Assistenten');
      await senden('/chat', '');

      expect(gemeldet).toEqual([
        { art: 'mensch', inhalt: 'ans Team' },
        { art: 'mensch', inhalt: 'an den Assistenten' },
        { art: 'system', inhalt: NICHT_ERREICHBAR },
      ]);
    });

    it('leitet den Team-Kanal nicht weiter, und nichts, was abgewiesen wurde', async () => {
      await senden('/chat/team', 'unter uns');
      await senden('/chat', '');
      await senden('/chat', 'ohne Herkunft', {});
      expect(webhookAufrufe).toEqual([]);
    });

    it.each([
      ['eine Antwort mit 500', () => Promise.resolve(new Response('', { status: 500 }))],
      ['einen Netzfehler', () => Promise.reject(new TypeError('fetch failed'))],
    ])('zeigt bei %s eine Meldung des Cockpits — die Frage bleibt gespeichert', async (_fall, antwort) => {
      webhookAntwort = antwort;

      expect((await senden('/chat', 'Frage ins Leere')).statusCode).toBe(303);

      const zeilen = await pool.query<{ absender_art: string; inhalt: string; bezug: boolean }>(
        `SELECT absender_art, inhalt, antwort_auf = (SELECT min(id) FROM cockpit.nachricht) AS bezug FROM cockpit.nachricht ORDER BY id`,
      );
      expect(zeilen.rows).toEqual([
        { absender_art: 'mensch', inhalt: 'Frage ins Leere', bezug: null },
        { absender_art: 'system', inhalt: NICHT_ERREICHBAR, bezug: true },
      ]);
      const html = (await seite('/chat')).body;
      expect(html).toContain(NICHT_ERREICHBAR);
      expect(html).toContain('Cockpit · <time');
      expect(html).not.toContain('arbeitet an einer Antwort');
    });

    it('zeigt unter der letzten Frage, dass die Antwort aussteht — und nach der Frist, dass sie ausbleibt', async () => {
      // Den Kanal jedes Mal neu holen: nach `chatLeeren` beginnen die IDs von vorn.
      const frage = async (vorSekunden: number) =>
        pool.query(
          `INSERT INTO cockpit.nachricht (kanal_id, absender_art, absender_id, inhalt, erstellt_am) VALUES ($1, 'mensch', 'anna', 'Frage', $2)`,
          [(await assistentKanal(pool, 'anna')).id, new Date(JETZT.getTime() - vorSekunden * 1000)],
        );

      await frage(30);
      expect((await seite('/chat')).body).toContain('Der Assistent arbeitet an einer Antwort …');

      await chatLeeren(pool);
      await frage(121);
      const html = (await seite('/chat')).body;
      expect(html).toContain('Der Assistent antwortet gerade nicht. Ihre Nachricht ist gespeichert.');
      expect(html).not.toContain('arbeitet an einer Antwort');
      expect((await seite('/chat/team')).body).not.toContain('Der Assistent');
    });

    it('sagt ohne Koordinator, dass keiner angebunden ist, nimmt im Assistenten-Kanal nichts an — und das Team geht weiter', async () => {
      const ohne = buildApp({ nodeEnv: 'test' }, { pool, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(angemeldet), jetzt: () => JETZT });
      await ohne.ready();
      try {
        const seiteOhne = (await ohne.inject({ method: 'GET', url: '/chat' })).body;
        expect(seiteOhne).toContain('Auf dieser Instanz ist noch kein Assistent angebunden.');
        expect(seiteOhne).not.toContain('<textarea');

        const abgewiesen = await ohne.inject({ method: 'POST', url: '/chat', headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: formular({ inhalt: 'hallo' }) });
        expect(abgewiesen.statusCode).toBe(409);
        expect(await inhalte()).toEqual([]);

        const team = await ohne.inject({ method: 'POST', url: '/chat/team', headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: formular({ inhalt: 'geht' }) });
        expect(team.statusCode).toBe(303);
        expect((await ohne.inject({ method: 'GET', url: '/chat/team' })).body).toContain('<textarea');
      } finally {
        await ohne.close();
      }
    });
  });

  describe('Häkchen und Trenner "Neu" (COPI-69)', () => {
    /** Der Stand der Haken, in Reihenfolge der eigenen Nachrichten auf der Seite. */
    function staende(html: string): string[] {
      return [...html.matchAll(/data-chat-status="([a-z]+)"/g)].map((treffer) => treffer[1] ?? '');
    }

    it('zeigt nach der Quittung des Webhooks zwei Haken: angenommen, mit Zeitpunkt in der Datenbank', async () => {
      await senden('/chat', 'Frage');

      const zeile = await pool.query<{ zugestellt_am: Date | null }>('SELECT zugestellt_am FROM cockpit.nachricht');
      expect(zeile.rows[0]?.zugestellt_am).toBeInstanceOf(Date);
      const html = (await seite('/chat')).body;
      expect(staende(html)).toEqual(['angenommen']);
      expect(html).toMatch(/data-chat-status="angenommen"[^>]*>.*?<span class="sr-only">angenommen<\/span>/s);
      expect(html).toMatch(/<svg class="symbol"[^>]*aria-hidden="true"/);
    });

    it('bleibt bei einem Haken (gesendet), wenn die Quittung ausbleibt — und setzt keinen Zeitpunkt', async () => {
      webhookAntwort = () => Promise.resolve(new Response('', { status: 500 }));
      await senden('/chat', 'Frage');

      const zeile = await pool.query<{ zugestellt_am: Date | null }>(`SELECT zugestellt_am FROM cockpit.nachricht WHERE absender_art = 'mensch'`);
      expect(zeile.rows[0]?.zugestellt_am).toBeNull();
      // Die Meldung des Cockpits steht im Verlauf, die Frage bleibt gesendet — kein zusätzlicher Stand.
      const html = (await seite('/chat')).body;
      expect(html).toContain(NICHT_ERREICHBAR);
      expect(staende(html)).toEqual(['gesendet']);
    });

    it('zeigt nach der Antwort des Koordinators beantwortet — bei allen eigenen Nachrichten davor, nicht bei späteren', async () => {
      await senden('/chat', 'Erste');
      await senden('/chat', 'Zweite');
      const kanal = await assistentKanal(pool, 'anna');
      const zweite = (await pool.query<{ id: number }>(`SELECT id::int AS id FROM cockpit.nachricht WHERE inhalt = 'Zweite'`)).rows[0]?.id ?? 0;
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', antwortAuf: zweite, inhalt: 'Antwort' });
      await senden('/chat', 'Dritte');

      expect(staende((await seite('/chat')).body)).toEqual(['beantwortet', 'beantwortet', 'angenommen']);
    });

    it('zählt die Meldung des Cockpits nicht als Antwort', async () => {
      const kanal = await assistentKanal(pool, 'anna');
      const frage = await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'mensch', absenderId: 'anna', inhalt: 'Frage' });
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'system', antwortAuf: frage.id, inhalt: NICHT_ERREICHBAR });

      expect(staende((await seite('/chat')).body)).toEqual(['gesendet']);
    });

    it('zeigt im Team-Kanal weder Haken noch Trenner', async () => {
      const team = await teamKanal(pool);
      await nachrichtAnlegen(pool, { kanalId: team.id, absenderArt: 'mensch', absenderId: 'bert', inhalt: 'von Bert' });
      await senden('/chat/team', 'von Anna');

      const html = (await seite('/chat/team')).body;
      expect(html).not.toContain('data-chat-status');
      expect(html).not.toContain('chat-neu');
    });

    it('setzt den Trenner vor die erste ungelesene fremde Nachricht — beim ersten Aufruf, beim zweiten nicht mehr', async () => {
      const kanal = await assistentKanal(pool, 'anna');
      const gelesen = await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', inhalt: 'Schon gesehen' });
      await seite('/chat');
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'mensch', absenderId: 'anna', inhalt: 'Meine Frage' });
      const erste = await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', inhalt: 'Neue Antwort 1' });
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', inhalt: 'Neue Antwort 2' });

      const html = (await seite('/chat')).body;
      expect(html.match(/role="separator" aria-label="Neue Nachrichten"/g)).toHaveLength(1);
      const trenner = html.indexOf('role="separator"');
      expect(trenner).toBeGreaterThan(html.indexOf(`id="nachricht-${String(gelesen.id)}"`));
      expect(trenner).toBeLessThan(html.indexOf(`id="nachricht-${String(erste.id)}"`));
      expect(trenner).toBeGreaterThan(html.indexOf('Meine Frage'));
      expect((await seite('/chat')).body).not.toContain('role="separator"');
    });

    it('setzt keinen Trenner, wenn nichts ungelesen ist, und keinen vor eigenen Nachrichten', async () => {
      await seite('/chat');
      await senden('/chat', 'Nur ich');

      expect((await seite('/chat')).body).not.toContain('role="separator"');
    });

    it('zeigt eine live gelesene Antwort nach dem nächsten Absenden nicht wieder hinter „Neu“', async () => {
      await senden('/chat', 'Erste');
      await seite('/chat');
      // Die Antwort kommt per SSE, während die Seite offen ist — ein Neuladen, das den Lesestand setzt, gibt es nicht.
      const kanal = await assistentKanal(pool, 'anna');
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', inhalt: 'Live gelesen' });
      await senden('/chat', 'Zweite');

      expect((await seite('/chat')).body).not.toContain('role="separator"');
      expect(await ungeleseneZaehlen(pool, 'anna', kanal.id)).toBe(0);
    });
  });
});
