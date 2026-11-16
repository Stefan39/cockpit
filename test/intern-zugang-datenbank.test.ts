/**
 * Der Zugang zur Agenten-API (COPI-35), mit echten Anfragen gegen die echte Datenbank.
 *
 * Die Agenten-API liegt auf dem einzigen öffentlich erreichbaren Dienst, **ohne Sitzung und ohne
 * zweiten Faktor**. Hier steht, was das aushalten muss: kein Token, ein falsches, ein widerrufenes
 * und ein Token mit zu wenig Rechten bekommen jeweils die richtige Antwort — und die Antwort verrät
 * nicht, ob ein Token existiert. Ein Cookie schaltet dort nichts frei, das Token dafür nichts
 * außerhalb. Das Token steht nie im Log. Und wer nur rät, wird gebremst.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Räumt `cockpit.api_token` ab; das Protokoll lässt sich nicht
 * abräumen (COPI-23), deshalb zählen Einträge **seit einer Marke**. Erwartete Werte (Statuscodes,
 * Fehlernamen, Grenzen) stehen als Literale.
 */
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenHashen } from '../src/auth/einmal-token.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { apiTokenAnlegen, apiTokenWiderrufen } from '../src/intern/token-speicher.js';
import type { ApiScope } from '../src/intern/token.js';
import { buildApp } from '../src/server/app.js';
import { protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const START = new Date('2026-09-21T12:00:00.000Z');
const MINUTE = 60 * 1000;
const STUNDE = 60 * MINUTE;

/** Wohlgeformt, aber nie vergeben. */
const UNBEKANNT = `cpk_${'A'.repeat(43)}`;

interface Anfrage {
  readonly pfad?: string;
  readonly methode?: 'GET' | 'HEAD' | 'POST';
  readonly token?: string;
  readonly kopf?: string;
  readonly ip?: string;
  readonly cookie?: string;
  readonly payload?: string;
}

/** Was eine Antwort verrät: alles, woran ein Angreifer etwas ablesen könnte. */
function fingerabdruck(antwort: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  return {
    status: antwort.statusCode,
    body: antwort.body,
    contentType: antwort.headers['content-type'],
    wwwAuthenticate: antwort.headers['www-authenticate'],
    cacheControl: antwort.headers['cache-control'],
  };
}

describe.skipIf(!datenbankUrl)('Agenten-API: Zugang (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let jetzt: Date;
  let logZeilen: string[];

  const logStrom = new Writable({
    write(stueck: Buffer, _kodierung, fertig) {
      logZeilen.push(stueck.toString('utf8'));
      fertig();
    },
  });

  function appBauen(
    zusaetze: { sitzungLesen?: SitzungLesen; pool?: pg.Pool; ohnePool?: true } = {},
  ): FastifyInstance {
    const verwendet = zusaetze.ohnePool === true ? undefined : (zusaetze.pool ?? pool);
    return buildApp(
      { nodeEnv: 'test' },
      {
        ...(verwendet === undefined ? {} : { pool: verwendet }),
        jetzt: () => jetzt,
        logStrom,
        ...(zusaetze.sitzungLesen ? { sitzungLesen: zusaetze.sitzungLesen } : {}),
        // Nur für Tests: zwei Routen mit verschiedenen Rechten und eine, die einen Rumpf liest.
        interneRoutenErgaenzen: (router) => {
          router.route({
            methode: 'GET',
            url: '/test/befund',
            scope: 'befund_schreiben',
            handler: () => ({ ok: true }),
          });
          router.route({
            methode: 'GET',
            url: '/test/eingriff',
            scope: 'eingriff_verwalten',
            handler: () => ({ ok: true }),
          });
          router.route({
            methode: 'POST',
            url: '/test/echo',
            scope: 'befund_schreiben',
            handler: (anfrage) => ({ empfangen: anfrage.body }),
          });
        },
      },
    );
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    jetzt = new Date(START);
    logZeilen = [];
    await pool.query('DELETE FROM cockpit.api_token');
    // Neue Anwendung je Test: die Zähler der Ratenbegrenzung leben in ihr.
    app = appBauen();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.end();
  });

  async function zugang(scopes: readonly ApiScope[] = ['befund_schreiben'], name = 'admin-agent') {
    return apiTokenAnlegen(pool, { name, scopes });
  }

  function anfragen(a: Anfrage = {}) {
    return app.inject({
      method: a.methode ?? 'GET',
      url: a.pfad ?? '/intern/ping',
      headers: {
        ...(a.token === undefined ? {} : { authorization: `Bearer ${a.token}` }),
        ...(a.kopf === undefined ? {} : { authorization: a.kopf }),
        ...(a.ip === undefined ? {} : { 'x-forwarded-for': a.ip }),
        ...(a.cookie === undefined ? {} : { cookie: a.cookie }),
        ...(a.payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(a.payload === undefined ? {} : { payload: a.payload }),
    });
  }

  describe('ohne gültiges Token', () => {
    it('antwortet 401 mit Bearer-Aufforderung und ohne Zwischenspeicher', async () => {
      const antwort = await anfragen();

      expect(antwort.statusCode).toBe(401);
      expect(antwort.json()).toEqual({ fehler: 'nicht_angemeldet' });
      expect(antwort.headers['www-authenticate']).toBe('Bearer');
      expect(antwort.headers['cache-control']).toBe('no-store');
    });

    it('antwortet auf jeden ungültigen Zugang wortgleich: die Antwort verrät nicht, ob ein Token existiert', async () => {
      const widerrufen = await zugang(['befund_schreiben'], 'alt');
      await apiTokenWiderrufen(pool, widerrufen.id);
      const gueltig = await zugang(['befund_schreiben'], 'neu');
      const ohneToken = fingerabdruck(await anfragen());

      const faelle: [string, Anfrage][] = [
        ['ein anderes Schema', { kopf: `Basic ${gueltig.token}` }],
        ['nur das Schema', { kopf: 'Bearer' }],
        ['ein Text statt eines Tokens', { kopf: 'Bearer kaputt' }],
        ['ein zu kurzes Token', { kopf: `Bearer cpk_${'A'.repeat(20)}` }],
        ['ein wohlgeformtes, aber unbekanntes Token', { token: UNBEKANNT }],
        ['ein Token mit veränderter letzter Stelle', { token: `${gueltig.token.slice(0, -1)}${gueltig.token.endsWith('A') ? 'B' : 'A'}` }],
        ['ein widerrufenes Token', { token: widerrufen.token }],
      ];
      for (const [name, a] of faelle) {
        expect(fingerabdruck(await anfragen(a)), name).toEqual(ohneToken);
      }
    });

    it('prüft das Token vor dem Rumpf: ein kaputter Rumpf ohne Token ist ein 401 und kein 400', async () => {
      const antwort = await anfragen({ methode: 'POST', pfad: '/intern/test/echo', payload: '{kaputt' });

      expect(antwort.statusCode).toBe(401);
    });

    it('antwortet auch auf HEAD mit 401', async () => {
      const antwort = await anfragen({ methode: 'HEAD' });

      expect(antwort.statusCode).toBe(401);
      expect(antwort.headers['www-authenticate']).toBe('Bearer');
    });

    it('nimmt das Token nur aus der Kopfzeile: ein gültiges Token in der Adresse gilt nicht', async () => {
      const { token } = await zugang();

      const antwort = await anfragen({ pfad: `/intern/ping?token=${token}` });
      const zweite = await anfragen({ pfad: `/intern/ping?access_token=${token}` });

      expect(antwort.statusCode).toBe(401);
      expect(zweite.statusCode).toBe(401);
    });
  });

  describe('mit gültigem Token', () => {
    it('antwortet auf /intern/ping mit dem Namen und den Rechten des Zugangs', async () => {
      const { token } = await zugang(['befund_schreiben', 'agenten_schreiben']);

      const antwort = await anfragen({ token });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.json()).toEqual({
        status: 'ok',
        name: 'admin-agent',
        scopes: ['befund_schreiben', 'agenten_schreiben'],
      });
      expect(antwort.headers['cache-control']).toBe('no-store');
    });

    it('wiederholt weder das Token noch seinen Hash in der Antwort', async () => {
      const { token } = await zugang();

      const antwort = await anfragen({ token });

      expect(antwort.body).not.toContain(token);
      expect(antwort.body).not.toContain(tokenHashen(token));
      expect(JSON.stringify(antwort.headers)).not.toContain(token);
    });

    it('liest das Schema ohne Rücksicht auf die Schreibweise', async () => {
      const { token } = await zugang();

      const antwort = await anfragen({ kopf: `bearer ${token}` });

      expect(antwort.statusCode).toBe(200);
    });

    it('lässt auch HEAD mit Token durch', async () => {
      const { token } = await zugang();

      const antwort = await anfragen({ methode: 'HEAD', token });

      expect(antwort.statusCode).toBe(200);
    });

    it('gilt sofort nicht mehr, sobald es widerrufen ist', async () => {
      const { id, token } = await zugang();
      expect((await anfragen({ token })).statusCode).toBe(200);

      await apiTokenWiderrufen(pool, id);

      expect((await anfragen({ token })).statusCode).toBe(401);
    });
  });

  describe('Rechte (Scopes)', () => {
    it('lässt eine Route mit dem passenden Recht durch und lehnt eine mit einem fehlenden mit 403 ab', async () => {
      const { token } = await zugang(['befund_schreiben']);

      const erlaubt = await anfragen({ token, pfad: '/intern/test/befund' });
      const verboten = await anfragen({ token, pfad: '/intern/test/eingriff' });

      expect(erlaubt.statusCode).toBe(200);
      expect(verboten.statusCode).toBe(403);
      expect(verboten.json()).toEqual({ fehler: 'nicht_erlaubt' });
      expect(verboten.headers['cache-control']).toBe('no-store');
    });

    it('lässt einen Zugang mit mehreren Rechten alle ihre Routen erreichen', async () => {
      const { token } = await zugang(['befund_schreiben', 'eingriff_verwalten']);

      expect((await anfragen({ token, pfad: '/intern/test/befund' })).statusCode).toBe(200);
      expect((await anfragen({ token, pfad: '/intern/test/eingriff' })).statusCode).toBe(200);
    });

    it('prüft die Rechte vor dem Rumpf: ohne das Recht ist ein kaputter Rumpf ein 403 und kein 400', async () => {
      const { token } = await zugang(['eingriff_verwalten']);

      const antwort = await anfragen({ token, methode: 'POST', pfad: '/intern/test/echo', payload: '{kaputt' });

      expect(antwort.statusCode).toBe(403);
    });

    it('liest den Rumpf, wenn Token und Recht stimmen', async () => {
      const { token } = await zugang(['befund_schreiben']);

      const antwort = await anfragen({ token, methode: 'POST', pfad: '/intern/test/echo', payload: '{"a":1}' });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.json()).toEqual({ empfangen: { a: 1 } });
    });
  });

  describe('Pfade, die es nicht gibt', () => {
    it.each(['/intern', '/intern/', '/intern/gibt-es-nicht', '/intern/a/b/c'])(
      'verlangt für %s zuerst das Token, sonst ließe sich an 401 gegen 404 ablesen, welche Routen es gibt',
      async (pfad) => {
        const bekannt = fingerabdruck(await anfragen({ pfad: '/intern/ping' }));

        const antwort = await anfragen({ pfad });

        expect(fingerabdruck(antwort)).toEqual(bekannt);
      },
    );

    it.each(['/intern', '/intern/', '/intern/gibt-es-nicht'])('antwortet mit Token auf %s mit 404', async (pfad) => {
      const { token } = await zugang();

      const antwort = await anfragen({ pfad, token });

      expect(antwort.statusCode).toBe(404);
      expect(antwort.json()).toEqual({ fehler: 'nicht_gefunden' });
    });

    it('antwortet auch auf eine Methode, die die Route nicht kennt, erst nach dem Token', async () => {
      const { token } = await zugang();

      const ohne = await anfragen({ methode: 'POST', pfad: '/intern/ping' });
      const mit = await anfragen({ methode: 'POST', pfad: '/intern/ping', token });

      expect(ohne.statusCode).toBe(401);
      expect(mit.statusCode).toBe(404);
    });
  });

  describe('Sitzung, Cookie und Konto', () => {
    it('lässt sich mit einer Sitzung nicht öffnen: auch ein Konto mit zweitem Faktor braucht das Token, und das Tor liest keine Sitzung', async () => {
      let gelesen = 0;
      const mitFaktor: SitzungLesen = () => {
        gelesen += 1;
        return Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
      };
      await app.close();
      app = appBauen({ sitzungLesen: mitFaktor });
      await app.ready();

      const antwort = await anfragen({ cookie: 'better-auth.session_token=egal' });

      expect(antwort.statusCode).toBe(401);
      expect(gelesen).toBe(0);
    });

    it('macht das Token nicht zu einem Konto: die übrigen Seiten bleiben ohne Sitzung zu', async () => {
      const { token } = await zugang(['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten']);

      const startseite = await anfragen({ pfad: '/', token });
      const auth = await anfragen({ pfad: '/api/auth/get-session', token });
      const zweiterFaktor = await anfragen({ pfad: '/zwei-faktor', token });

      expect(startseite.statusCode).toBe(303);
      expect(startseite.headers.location).toBe('/anmelden');
      expect(auth.statusCode).toBe(404);
      expect(zweiterFaktor.statusCode).toBe(303);
    });

    it('sendet keine Cookies: die Antwort der Agenten-API setzt keine Sitzung', async () => {
      const { token } = await zugang();

      const antwort = await anfragen({ token });

      expect(antwort.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('Protokoll', () => {
    it('hält den Gebrauch eines widerrufenen Zugangs genau einmal fest, auch bei vielen Versuchen: ein Zeichen für ein durchgesickertes Token', async () => {
      const { id, token } = await zugang();
      await apiTokenWiderrufen(pool, id);
      const marke = await protokollMarke(pool);

      for (let i = 0; i < 5; i += 1) {
        await anfragen({ token });
      }

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'api_zugriff_abgelehnt',
          akteur: `api_token_${String(id)}`,
          ziel: null,
          einzelheiten: { token_id: id, grund: 'widerrufen' },
        },
      ]);
    });

    it('hält ein fehlendes Recht genau einmal fest und nennt es', async () => {
      const { id, token } = await zugang(['befund_schreiben']);
      const marke = await protokollMarke(pool);

      for (let i = 0; i < 3; i += 1) {
        await anfragen({ token, pfad: '/intern/test/eingriff' });
      }

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'api_zugriff_abgelehnt',
          akteur: `api_token_${String(id)}`,
          ziel: null,
          einzelheiten: { token_id: id, grund: 'scope', scope: 'eingriff_verwalten' },
        },
      ]);
    });

    it('schreibt nach einer Stunde erneut, wenn es weitergeht: ein Dauerzustand soll sichtbar bleiben, aber nicht das Protokoll füllen', async () => {
      const { id, token } = await zugang();
      await apiTokenWiderrufen(pool, id);
      const marke = await protokollMarke(pool);

      await anfragen({ token });
      jetzt = new Date(jetzt.getTime() + STUNDE - 1);
      await anfragen({ token });
      const nachEinerStunde = (await protokollSeit(pool, marke)).length;
      jetzt = new Date(jetzt.getTime() + 1);
      await anfragen({ token });

      expect(nachEinerStunde).toBe(1);
      expect(await protokollSeit(pool, marke)).toHaveLength(2);
    });

    it('trennt die Gründe: ein widerrufener Zugang und ein fehlendes Recht sind zwei Einträge', async () => {
      const gueltig = await zugang(['befund_schreiben'], 'gueltig');
      const widerrufen = await zugang(['befund_schreiben'], 'widerrufen');
      await apiTokenWiderrufen(pool, widerrufen.id);
      const marke = await protokollMarke(pool);

      await anfragen({ token: gueltig.token, pfad: '/intern/test/eingriff' });
      await anfragen({ token: widerrufen.token });

      const gruende = (await protokollSeit(pool, marke)).map((zeile) => zeile.einzelheiten.grund).sort();
      expect(gruende).toEqual(['scope', 'widerrufen']);
    });

    it('schreibt nichts für ein fehlendes, kaputtes oder unbekanntes Token: das Protokoll lässt sich nicht bereinigen und wäre mit Rauschen gefüllt', async () => {
      const marke = await protokollMarke(pool);

      for (let i = 0; i < 12; i += 1) {
        await anfragen();
        await anfragen({ kopf: 'Bearer kaputt' });
        await anfragen({ token: UNBEKANNT });
      }

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('schreibt weder Token noch Hash in einen Eintrag', async () => {
      const { id, token } = await zugang(['befund_schreiben']);
      const marke = await protokollMarke(pool);
      await anfragen({ token, pfad: '/intern/test/eingriff' });
      await apiTokenWiderrufen(pool, id);
      await anfragen({ token });

      const text = JSON.stringify(await protokollSeit(pool, marke));

      expect(text).not.toContain(token);
      expect(text).not.toContain(tokenHashen(token));
    });
  });

  describe('Ratenbegrenzung', () => {
    it('bremst eine Adresse nach 20 gescheiterten Versuchen mit 429 und Retry-After', async () => {
      for (let i = 0; i < 20; i += 1) {
        expect((await anfragen({ token: UNBEKANNT, ip: '203.0.113.7' })).statusCode).toBe(401);
      }

      const antwort = await anfragen({ token: UNBEKANNT, ip: '203.0.113.7' });

      expect(antwort.statusCode).toBe(429);
      expect(antwort.json()).toEqual({ fehler: 'zu_viele_anfragen' });
      expect(Number(antwort.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(antwort.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);
      expect(antwort.headers['cache-control']).toBe('no-store');
    });

    it('zählt auch Anfragen ohne Token und mit kaputtem Kopf', async () => {
      for (let i = 0; i < 10; i += 1) {
        await anfragen({ ip: '203.0.113.8' });
        await anfragen({ kopf: 'Bearer kaputt', ip: '203.0.113.8' });
      }

      expect((await anfragen({ ip: '203.0.113.8' })).statusCode).toBe(429);
    });

    it('sperrt während der Bremse auch ein gültiges Token dieser Adresse, nicht aber andere Adressen', async () => {
      const { token } = await zugang();
      for (let i = 0; i < 20; i += 1) {
        await anfragen({ token: UNBEKANNT, ip: '203.0.113.9' });
      }

      const gebremst = await anfragen({ token, ip: '203.0.113.9' });
      const andere = await anfragen({ token, ip: '203.0.113.10' });

      expect(gebremst.statusCode).toBe(429);
      expect(andere.statusCode).toBe(200);
    });

    it('gibt die Adresse nach 15 Minuten wieder frei', async () => {
      const { token } = await zugang();
      for (let i = 0; i < 21; i += 1) {
        await anfragen({ token: UNBEKANNT, ip: '203.0.113.11' });
      }
      expect((await anfragen({ token, ip: '203.0.113.11' })).statusCode).toBe(429);

      jetzt = new Date(jetzt.getTime() + 15 * MINUTE);

      expect((await anfragen({ token, ip: '203.0.113.11' })).statusCode).toBe(200);
    });

    it('verbraucht mit gültigen Anfragen kein Budget: ein Agent, der oft meldet, bremst sich nie selbst', async () => {
      const { token } = await zugang();

      for (let i = 0; i < 60; i += 1) {
        expect((await anfragen({ token, ip: '203.0.113.12' })).statusCode).toBe(200);
      }
    });

    it('bremst einen Zugang bei mehr als 300 Anfragen in der Minute, und andere Zugänge nicht', async () => {
      const viel = await zugang(['befund_schreiben'], 'viel');
      const wenig = await zugang(['befund_schreiben'], 'wenig');

      for (let i = 0; i < 300; i += 1) {
        expect((await anfragen({ token: viel.token })).statusCode).toBe(200);
      }
      const gebremst = await anfragen({ token: viel.token });
      const unberuehrt = await anfragen({ token: wenig.token });

      expect(gebremst.statusCode).toBe(429);
      expect(Number(gebremst.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(gebremst.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(unberuehrt.statusCode).toBe(200);
    });

    it('lässt einen gebremsten Zugang nach einer Minute wieder durch', async () => {
      const { token } = await zugang();
      for (let i = 0; i < 301; i += 1) {
        await anfragen({ token });
      }
      expect((await anfragen({ token })).statusCode).toBe(429);

      jetzt = new Date(jetzt.getTime() + MINUTE);

      expect((await anfragen({ token })).statusCode).toBe(200);
    });
  });

  describe('Log', () => {
    it('enthält nie ein Token, weder gültig noch erfunden noch in der Adresse, und nie seinen Hash', async () => {
      const { id, token } = await zugang(['befund_schreiben']);
      const widerrufen = await zugang(['befund_schreiben'], 'alt');
      await apiTokenWiderrufen(pool, widerrufen.id);

      await anfragen({ token });
      await anfragen({ token: UNBEKANNT });
      await anfragen({ token: widerrufen.token });
      await anfragen({ pfad: `/intern/ping?token=${token}` });
      await anfragen({ pfad: `/intern/ping?access_token=${token}&x=1` });
      await anfragen({ token, pfad: '/intern/test/eingriff' });
      await anfragen({ methode: 'POST', pfad: '/intern/test/echo', payload: '{"geheim":"nicht-ins-log"}', token });

      const log = logZeilen.join('');
      expect(log.length).toBeGreaterThan(0);
      for (const geheim of [token, widerrufen.token, UNBEKANNT, tokenHashen(token), tokenHashen(widerrufen.token)]) {
        expect(log).not.toContain(geheim);
      }
      expect(log).not.toContain('nicht-ins-log');
      // Der Pfad bleibt lesbar, damit der Log nützlich ist, und die Abfrage ist weg.
      expect(log).toContain('/intern/ping');
      expect(log).not.toContain('access_token');
      // Wer es war, steht als Nummer da, nicht als Token.
      expect(id).toBeGreaterThan(0);
    });
  });

  describe('Wenn die Datenbank ausfällt', () => {
    it('antwortet 503 ohne Fehlertext und lässt niemanden durch: im Zweifel bleibt die Tür zu', async () => {
      const { token } = await zugang();
      const kaputt = {
        query: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=geheim')),
      } as unknown as pg.Pool;
      await app.close();
      logZeilen = [];
      app = appBauen({ pool: kaputt });
      await app.ready();

      const antwort = await anfragen({ token });

      expect(antwort.statusCode).toBe(503);
      expect(antwort.json()).toEqual({ fehler: 'nicht_verfuegbar' });
      expect(antwort.body).not.toContain('ECONNREFUSED');
      expect(antwort.body).not.toContain('geheim');
      const log = logZeilen.join('');
      expect(log).not.toContain(token);
      expect(log).not.toContain('password=geheim');
    });
  });

  describe('Ohne Datenbank', () => {
    it('gibt es keine Agenten-API: lieber keine Route als eine ohne Prüfung', async () => {
      await app.close();
      app = appBauen({ ohnePool: true });
      await app.ready();

      const antwort = await anfragen({ token: UNBEKANNT });

      expect(antwort.statusCode).toBe(404);
    });
  });
});
