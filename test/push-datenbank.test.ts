/**
 * Web Push (COPI-59) gegen die echte Datenbank, mit einem Fake-Push-Dienst: Abo an- und abmelden (nur das eigene, nur
 * mit Herkunft), die Geräte in den Einstellungen, und die Zustellung — an die Geräte des Kanalbesitzers, nie mit dem
 * Text der Nachricht, abgelaufene Abos (404/410) werden abgemeldet, nicht gelöscht, und ins Log kommt nie ein Endpoint.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort Chat, Konten und Zugänge ab.
 */
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { ChatEreignisse } from '../src/chat/ereignisse.js';
import { assistentKanal, nachrichtAnlegen, teamKanal, type Nachricht } from '../src/chat/nachricht-speicher.js';
import { pushZustellen, vapidErzeugen, type PushKonfiguration, type Versender } from '../src/chat/push.js';
import { aboSpeichern } from '../src/chat/push-speicher.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { buildApp } from '../src/server/app.js';
import { chatLeeren, FORMULAR_KOPF, kontenLoeschen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HERKUNFT = { host: 'localhost:3000', origin: 'http://localhost:3000' };
const PAAR = vapidErzeugen();
const PUSH: PushKonfiguration = { oeffentlich: PAAR.oeffentlich, privat: PAAR.privat, kontakt: 'mailto:cockpit@localhost' };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/geraet-anna-1';

function aboJson(endpoint = ENDPOINT) {
  return { endpoint, expirationTime: null, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } };
}

describe.skipIf(!datenbankUrl)('Web Push (echte Datenbank, Fake-Push-Dienst)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let angemeldet: Zugang;
  let gesendet: { endpoint: string; rumpf: string; optionen: unknown }[];
  let antwortDesDienstes: (endpoint: string) => Promise<unknown>;
  let logZeilen: string[];
  const chatEreignisse = new ChatEreignisse();

  const versender: Versender = (abo, rumpf, optionen) => {
    gesendet.push({ endpoint: abo.endpoint, rumpf, optionen });
    return antwortDesDienstes(abo.endpoint);
  };

  const log = { warn: (objekt: object, meldung: string) => logZeilen.push(`${meldung} ${JSON.stringify(objekt)}`) };

  function als(benutzerId: string): void {
    angemeldet = { angemeldet: true, rolle: 'betrieb_mitarbeiter', zweiterFaktorAktiv: true, benutzerId };
  }

  function json(url: string, koerper: unknown, kopf: Record<string, string> = HERKUNFT) {
    return app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...kopf }, payload: JSON.stringify(koerper) });
  }

  async function abos(): Promise<{ benutzer_id: string; endpoint: string; aktiv: boolean; erreicht: boolean }[]> {
    const ergebnis = await pool.query<{ benutzer_id: string; endpoint: string; aktiv: boolean; erreicht: boolean }>(
      `SELECT benutzer_id, endpoint, abgemeldet_am IS NULL AS aktiv, zuletzt_erfolgreich_am IS NOT NULL AS erreicht
         FROM cockpit.push_abo ORDER BY id`,
    );
    return ergebnis.rows;
  }

  async function antwortFuer(benutzerId: string, teil: Partial<Parameters<typeof nachrichtAnlegen>[1]> = {}): Promise<Nachricht> {
    const kanalId = (await assistentKanal(pool, benutzerId)).id;
    const frage = await nachrichtAnlegen(pool, { kanalId, absenderArt: 'mensch', absenderId: benutzerId, inhalt: 'Frage' });
    return nachrichtAnlegen(pool, { kanalId, absenderArt: 'agent', inhalt: 'GEHEIM: 3 Gäste, Familie Brandt', antwortAuf: frage.id, ...teil });
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    app = buildApp(
      { nodeEnv: 'test' },
      {
        pool,
        sitzungLesen: MIT_FAKTOR,
        zugangLesen: () => Promise.resolve(angemeldet),
        push: PUSH,
        pushVersender: versender,
        chatEreignisse,
        logStrom: new Writable({ write: (_teil, _kodierung, fertig) => fertig() }),
      },
    );
    await app.ready();
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
    als('anna');
    gesendet = [];
    logZeilen = [];
    antwortDesDienstes = () => Promise.resolve({ statusCode: 201 });
  });

  afterAll(async () => {
    await app.close();
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.end();
  });

  describe('Abo an- und abmelden', () => {
    it('legt das Abo für das angemeldete Konto an (201) — und nimmt es einem anderen Konto auf demselben Gerät weg', async () => {
      expect((await json('/push/abo', aboJson())).statusCode).toBe(201);
      als('bert');
      expect((await json('/push/abo', aboJson())).statusCode).toBe(201);

      expect(await abos()).toEqual([
        { benutzer_id: 'anna', endpoint: ENDPOINT, aktiv: false, erreicht: false },
        { benutzer_id: 'bert', endpoint: ENDPOINT, aktiv: true, erreicht: false },
      ]);
    });

    it.each<[string, unknown]>([
      ['ein http-Endpoint', { ...aboJson('http://push.example.org/x') }],
      ['ohne Schlüssel', { endpoint: ENDPOINT }],
      ['Schlüssel mit fremden Zeichen', { endpoint: ENDPOINT, keys: { p256dh: 'a b', auth: 'x' } }],
      ['ein unbekanntes Feld', { ...aboJson(), konto: 'bert' }],
    ])('weist %s ab (400) und speichert nichts', async (_fall, koerper) => {
      expect((await json('/push/abo', koerper)).statusCode).toBe(400);
      expect(await abos()).toEqual([]);
    });

    it('verlangt Herkunft (403) und JSON (415) — ein fremdes Formular kommt nicht durch', async () => {
      expect((await json('/push/abo', aboJson(), {})).statusCode).toBe(403);
      expect((await json('/push/abo', aboJson(), { host: 'localhost:3000', origin: 'https://boese.example.org' })).statusCode).toBe(403);
      const formular = await app.inject({ method: 'POST', url: '/push/abo', headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: 'endpoint=x' });
      expect(formular.statusCode).toBe(415);
      expect(await abos()).toEqual([]);
    });

    it('antwortet ohne Recht mit der neutralen 404', async () => {
      angemeldet = { ...angemeldet, rolle: undefined };
      expect((await json('/push/abo', aboJson())).statusCode).toBe(404);
    });

    it('meldet nur das eigene Abo ab — per Endpoint (Gerät) und per Nummer (Geräteliste)', async () => {
      const annasId = await aboSpeichern(pool, 'anna', { endpoint: ENDPOINT, p256dh: 'BNcR', auth: 'auth' });
      const bertsId = await aboSpeichern(pool, 'bert', { endpoint: 'https://fcm.googleapis.com/fcm/send/bert', p256dh: 'BNcR', auth: 'auth' });

      expect((await json('/push/abmelden', { endpoint: 'https://fcm.googleapis.com/fcm/send/bert' })).statusCode).toBe(204);
      const fremd = await app.inject({ method: 'POST', url: `/push/geraete/${String(bertsId)}/entfernen`, headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: '' });
      expect(fremd.statusCode).toBe(404);
      expect((await abos()).map((a) => a.aktiv)).toEqual([true, true]);

      const eigen = await app.inject({ method: 'POST', url: `/push/geraete/${String(annasId)}/entfernen`, headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: '' });
      expect(eigen.statusCode).toBe(303);
      expect(eigen.headers.location).toBe('/einstellungen?push=entfernt');
      expect((await abos()).map((a) => a.aktiv)).toEqual([false, true]);
      expect((await app.inject({ method: 'GET', url: '/einstellungen?push=entfernt' })).body).toContain('Das Gerät bekommt keine Benachrichtigungen mehr.');
    });
  });

  describe('Einstellungen', () => {
    it('zeigt die Steuerung mit dem öffentlichen Schlüssel und die eigenen Geräte mit „Entfernen"', async () => {
      await aboSpeichern(pool, 'anna', { endpoint: ENDPOINT, p256dh: 'BNcR', auth: 'auth' });
      await aboSpeichern(pool, 'bert', { endpoint: 'https://web.push.apple.com/bert', p256dh: 'BNcR', auth: 'auth' });

      const html = (await app.inject({ method: 'GET', url: '/einstellungen' })).body;

      expect(html).toContain(`data-push-schluessel="${PAAR.oeffentlich}"`);
      expect(html).not.toContain(PAAR.privat);
      expect(html).toContain('Chrome, Edge oder Android');
      expect(html).not.toContain('iPhone, iPad oder Mac (Safari)');
      expect(html).toMatch(/<form method="post" action="\/push\/geraete\/\d+\/entfernen">/);
      expect(html).toContain('noch nie erreicht');
    });

    it('sagt ohne VAPID-Paar, dass Push nicht eingerichtet ist', async () => {
      const ohne = buildApp({ nodeEnv: 'test' }, { pool, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(angemeldet) });
      await ohne.ready();
      try {
        const html = (await ohne.inject({ method: 'GET', url: '/einstellungen' })).body;
        expect(html).toContain('Push-Benachrichtigungen sind auf dieser Instanz nicht eingerichtet.');
        expect(html).not.toContain('data-push-schluessel');
        expect((await ohne.inject({ method: 'POST', url: '/push/abo', headers: { 'content-type': 'application/json', ...HERKUNFT }, payload: JSON.stringify(aboJson()) })).statusCode).toBe(404);
      } finally {
        await ohne.close();
      }
    });
  });

  describe('Zustellung', () => {
    it('schickt eine Antwort an jedes aktive Gerät des Kanalbesitzers — mit VAPID, ohne den Text, und merkt sich den Erfolg', async () => {
      await aboSpeichern(pool, 'anna', { endpoint: ENDPOINT, p256dh: 'BNcR', auth: 'auth' });
      await aboSpeichern(pool, 'anna', { endpoint: 'https://web.push.apple.com/anna', p256dh: 'BNcR', auth: 'auth' });
      await aboSpeichern(pool, 'bert', { endpoint: 'https://fcm.googleapis.com/fcm/send/bert', p256dh: 'BNcR', auth: 'auth' });

      expect(await pushZustellen(pool, PUSH, await antwortFuer('anna'), versender, log)).toBe(2);

      expect(gesendet.map((g) => g.endpoint)).toEqual([ENDPOINT, 'https://web.push.apple.com/anna']);
      expect(JSON.parse(gesendet[0]?.rumpf ?? '{}')).toEqual({ titel: 'Cockpit', text: 'Neue Antwort des Assistenten', ziel: 'chat' });
      expect(gesendet.every((g) => !g.rumpf.includes('GEHEIM'))).toBe(true);
      expect(gesendet[0]?.optionen).toMatchObject({
        vapidDetails: { subject: 'mailto:cockpit@localhost', publicKey: PAAR.oeffentlich, privateKey: PAAR.privat },
        TTL: 86400,
        urgency: 'normal',
      });
      expect((await abos()).map((a) => [a.benutzer_id, a.erreicht])).toEqual([
        ['anna', true],
        ['anna', true],
        ['bert', false],
      ]);
    });

    it('schickt Dringendes mit hoher Dringlichkeit, und nichts für eine Frage oder den Team-Kanal', async () => {
      await aboSpeichern(pool, 'anna', { endpoint: ENDPOINT, p256dh: 'BNcR', auth: 'auth' });
      const kanalId = (await assistentKanal(pool, 'anna')).id;
      const frage = await nachrichtAnlegen(pool, { kanalId, absenderArt: 'mensch', absenderId: 'anna', inhalt: 'Frage' });
      const team = await nachrichtAnlegen(pool, { kanalId: (await teamKanal(pool)).id, absenderArt: 'mensch', absenderId: 'bert', inhalt: 'Team' });

      expect(await pushZustellen(pool, PUSH, frage, versender, log)).toBe(0);
      expect(await pushZustellen(pool, PUSH, team, versender, log)).toBe(0);
      expect(gesendet).toEqual([]);

      await pushZustellen(pool, PUSH, await antwortFuer('anna', { absenderArt: 'system', dringend: true }), versender, log);
      expect(gesendet[0]?.optionen).toMatchObject({ urgency: 'high' });
      expect(JSON.parse(gesendet[0]?.rumpf ?? '{}')).toEqual({ titel: 'Cockpit', text: 'Dringende Nachricht im Chat', ziel: 'chat' });
    });

    it.each([404, 410])('meldet ein Abo ab, das der Dienst nicht mehr kennt (%i) — nicht gelöscht, und nichts im Log', async (status) => {
      await aboSpeichern(pool, 'anna', { endpoint: ENDPOINT, p256dh: 'BNcR', auth: 'auth' });
      antwortDesDienstes = () => Promise.reject(Object.assign(new Error('weg'), { statusCode: status }));

      expect(await pushZustellen(pool, PUSH, await antwortFuer('anna'), versender, log)).toBe(0);

      expect(await abos()).toEqual([{ benutzer_id: 'anna', endpoint: ENDPOINT, aktiv: false, erreicht: false }]);
      expect(logZeilen).toEqual([]);
    });

    it.each<[string, () => Promise<unknown>, string]>([
      ['eine Störung des Dienstes (500)', () => Promise.reject(Object.assign(new Error('kaputt'), { statusCode: 500 })), '500'],
      ['einen Netzfehler', () => Promise.reject(new TypeError('fetch failed')), 'netz'],
    ])('lässt das Abo bei %s stehen und loggt nur den Dienst, nie den Endpoint', async (_fall, antwort, status) => {
      await aboSpeichern(pool, 'anna', { endpoint: ENDPOINT, p256dh: 'BNcR', auth: 'auth' });
      antwortDesDienstes = antwort;

      await pushZustellen(pool, PUSH, await antwortFuer('anna'), versender, log);

      expect((await abos())[0]?.aktiv).toBe(true);
      expect(logZeilen).toHaveLength(1);
      expect(logZeilen[0]).toContain('fcm.googleapis.com');
      expect(logZeilen[0]).toContain(status);
      expect(logZeilen[0]).not.toContain('geraet-anna-1');
    });

    it('stellt eine Antwort über die Agenten-API zu, ohne dass jemand danach fragt', async () => {
      await aboSpeichern(pool, 'anna', { endpoint: ENDPOINT, p256dh: 'BNcR', auth: 'auth' });
      const kanalId = (await assistentKanal(pool, 'anna')).id;
      const frage = await nachrichtAnlegen(pool, { kanalId, absenderArt: 'mensch', absenderId: 'anna', inhalt: 'Frage' });
      const { token } = await apiTokenAnlegen(pool, { name: 'koordinator', scopes: ['chat_antworten'] });

      const antwort = await app.inject({
        method: 'POST',
        url: '/intern/chat/antwort',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ nachricht_id: frage.id, text: 'Drei Gäste.' }),
      });
      expect(antwort.statusCode).toBe(201);

      for (let versuch = 0; versuch < 50 && gesendet.length === 0; versuch++) {
        await new Promise((weiter) => setTimeout(weiter, 20));
      }
      expect(gesendet.map((g) => g.endpoint)).toEqual([ENDPOINT]);
    });
  });
});
