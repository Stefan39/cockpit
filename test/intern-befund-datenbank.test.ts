/**
 * `POST /intern/befund` (COPI-36), mit echten Anfragen gegen die echte Datenbank: der Admin-Agent
 * meldet einen Befund, das Cockpit schreibt ihn und setzt den Herzschlag der Wache.
 *
 * Der Endpunkt liegt auf dem einzigen öffentlich erreichbaren Dienst. Hier steht, was er aushalten
 * muss: nur mit dem Recht `befund_schreiben`, nur gültige Eingaben, eine Obergrenze für die Größe,
 * eine Quelle, die sich nicht fälschen lässt, keine Eingabe im Echo einer Fehlermeldung, und beim
 * Scheitern bleibt nichts Halbes zurück. `kundensichtbar` bleibt ohne ausdrückliche Angabe falsch.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.befund`, `cockpit.wache` und
 * `cockpit.api_token` ab. Erwartete Werte (Statuscodes, Fehlernamen, Grenzen) stehen als Literale.
 */
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen, apiTokenWiderrufen } from '../src/intern/token-speicher.js';
import type { ApiScope } from '../src/intern/token.js';
import { buildApp } from '../src/server/app.js';
import { einfuegenScheitern } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const T0 = new Date('2026-09-21T12:00:00.000Z');

/** Ein gültiger Befund; die Tests verändern ihn Feld für Feld. */
const GUELTIG = {
  wache: 'container',
  status: 'gruen',
  text_intern: 'alle Container laufen',
  takt_sekunden: 300,
};

interface Anfrage {
  readonly token?: string;
  readonly koerper?: unknown;
  /** Der Rumpf, wie er über die Leitung geht, statt JSON zu erzeugen. */
  readonly roh?: string;
  readonly inhaltstyp?: string;
}

describe.skipIf(!datenbankUrl)('POST /intern/befund (echte Datenbank)', () => {
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

  async function appNeu(): Promise<FastifyInstance> {
    const neu = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => jetzt, logStrom });
    await neu.ready();
    return neu;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    jetzt = new Date(T0);
    logZeilen = [];
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DELETE FROM cockpit.api_token');
    app = await appNeu();
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

  async function zugang(scopes: readonly ApiScope[] = ['befund_schreiben'], name = 'admin-agent') {
    return apiTokenAnlegen(pool, { name, scopes });
  }

  function melden(a: Anfrage) {
    return app.inject({
      method: 'POST',
      url: '/intern/befund',
      headers: {
        ...(a.token === undefined ? {} : { authorization: `Bearer ${a.token}` }),
        'content-type': a.inhaltstyp ?? 'application/json',
      },
      payload: a.roh ?? JSON.stringify(a.koerper ?? GUELTIG),
    });
  }

  async function anzahl(tabelle: 'befund' | 'wache'): Promise<number> {
    const zeile = await pool.query<{ anzahl: number }>(`SELECT count(*)::int AS anzahl FROM cockpit.${tabelle}`);
    return zeile.rows[0]?.anzahl ?? -1;
  }

  async function nichtsGeschrieben(): Promise<void> {
    expect(await anzahl('befund')).toBe(0);
    expect(await anzahl('wache')).toBe(0);
  }

  describe('ein gültiger Befund', () => {
    it('antwortet 201 mit Nummer, Wache und Zeitpunkt, ohne Zwischenspeicher', async () => {
      const { token } = await zugang();

      const antwort = await melden({ token });

      expect(antwort.statusCode).toBe(201);
      expect(antwort.headers['cache-control']).toBe('no-store');
      const koerper = antwort.json<{ id: number; wache: string; gemeldet_am: string }>();
      expect(koerper).toEqual({ id: expect.any(Number) as number, wache: 'container', gemeldet_am: '2026-09-21T12:00:00.000Z' });
    });

    it('schreibt den Befund und legt die unbekannte Wache mit ihrem Takt und ihrem Herzschlag an', async () => {
      const { token } = await zugang();

      await melden({ token });

      const wache = await pool.query('SELECT kennung, takt_sekunden, letzter_lauf FROM cockpit.wache');
      expect(wache.rows).toEqual([{ kennung: 'container', takt_sekunden: 300, letzter_lauf: T0 }]);
      const befund = await pool.query('SELECT wache, status, text_intern, text_kunde, kundensichtbar, quelle, gemeldet_am FROM cockpit.befund');
      expect(befund.rows).toEqual([
        {
          wache: 'container',
          status: 'gruen',
          text_intern: 'alle Container laufen',
          text_kunde: null,
          kundensichtbar: false,
          quelle: 'admin-agent',
          gemeldet_am: T0,
        },
      ]);
    });

    it('lässt kundensichtbar ohne ausdrückliche Angabe falsch, auch wenn ein Klartext dabei ist', async () => {
      const { token } = await zugang();

      await melden({ token, koerper: { ...GUELTIG, text_kunde: 'Alles läuft.' } });

      const zeile = await pool.query<{ kundensichtbar: boolean; text_kunde: string }>('SELECT kundensichtbar, text_kunde FROM cockpit.befund');
      expect(zeile.rows[0]).toEqual({ kundensichtbar: false, text_kunde: 'Alles läuft.' });
    });

    it('macht einen Befund kundensichtbar, wenn der Agent es ausdrücklich sagt und den Klartext liefert', async () => {
      const { token } = await zugang();

      const antwort = await melden({
        token,
        koerper: { ...GUELTIG, status: 'rot', text_kunde: 'Die Buchungen sind gerade nicht erreichbar.', kundensichtbar: true },
      });

      expect(antwort.statusCode).toBe(201);
      const zeile = await pool.query<{ kundensichtbar: boolean }>('SELECT kundensichtbar FROM cockpit.befund');
      expect(zeile.rows[0]?.kundensichtbar).toBe(true);
    });

    it('nimmt für eine bekannte Wache den nächsten Befund ohne Takt an und setzt ihren Herzschlag neu', async () => {
      const { token } = await zugang();
      await melden({ token });
      jetzt = new Date(T0.getTime() + 5 * 60_000);

      const antwort = await melden({ token, koerper: { wache: 'container', status: 'gelb', text_intern: 'ein Container startet neu' } });

      expect(antwort.statusCode).toBe(201);
      const wache = await pool.query('SELECT takt_sekunden, letzter_lauf FROM cockpit.wache');
      expect(wache.rows).toEqual([{ takt_sekunden: 300, letzter_lauf: jetzt }]);
      expect(await anzahl('befund')).toBe(2);
    });

    it('übernimmt einen neuen Takt', async () => {
      const { token } = await zugang();
      await melden({ token });

      await melden({ token, koerper: { ...GUELTIG, takt_sekunden: 900 } });

      const wache = await pool.query<{ takt_sekunden: number }>('SELECT takt_sekunden FROM cockpit.wache');
      expect(wache.rows[0]?.takt_sekunden).toBe(900);
    });

    it('trägt als Quelle den Namen des Zugangs ein, und zwar für jeden Zugang seinen eigenen', async () => {
      const admin = await zugang(['befund_schreiben'], 'admin-agent');
      const koordinator = await zugang(['befund_schreiben'], 'koordinator');

      await melden({ token: admin.token });
      await melden({ token: koordinator.token });

      const quellen = await pool.query<{ quelle: string }>('SELECT quelle FROM cockpit.befund ORDER BY id');
      expect(quellen.rows.map((zeile) => zeile.quelle)).toEqual(['admin-agent', 'koordinator']);
    });

    it('schneidet den Text an den Rändern ab, lässt aber Zeilenumbrüche und Zeichen im Innern unverändert', async () => {
      const { token } = await zugang();

      await melden({ token, koerper: { ...GUELTIG, text_intern: '  Zeile 1\nZeile 2 — ä ö ü ß 🚀  ' } });

      const zeile = await pool.query<{ text_intern: string }>('SELECT text_intern FROM cockpit.befund');
      expect(zeile.rows[0]?.text_intern).toBe('Zeile 1\nZeile 2 — ä ö ü ß 🚀');
    });

    it('speichert Fremdtext, wie er kommt: Maskieren ist Sache der Ausgabe, nicht des Speicherns', async () => {
      const { token } = await zugang();
      const fremd = '<script>alert(1)</script> & "Anführungszeichen" \' https://boese.example/x';

      await melden({ token, koerper: { ...GUELTIG, text_intern: fremd } });

      const zeile = await pool.query<{ text_intern: string }>('SELECT text_intern FROM cockpit.befund');
      expect(zeile.rows[0]?.text_intern).toBe(fremd);
    });

    it('legt den Anzeigenamen der Wache an, den der Kunde auf seiner Kachel sieht (COPI-37)', async () => {
      const { token } = await zugang();

      await melden({ token, koerper: { ...GUELTIG, anzeigename: '  Buchungs-Agent  ' } });

      const wache = await pool.query<{ anzeigename: string }>('SELECT anzeigename FROM cockpit.wache');
      expect(wache.rows[0]?.anzeigename).toBe('Buchungs-Agent');
    });

    it('nimmt die größten erlaubten Werte an', async () => {
      const { token } = await zugang();

      const antwort = await melden({
        token,
        koerper: {
          wache: 'a'.repeat(63),
          status: 'gelb',
          text_intern: 'ä'.repeat(4000),
          text_kunde: 'ö'.repeat(500),
          anzeigename: 'ü'.repeat(60),
          kundensichtbar: true,
          takt_sekunden: 31_622_400,
        },
      });

      expect(antwort.statusCode).toBe(201);
    });
  });

  describe('ohne Berechtigung', () => {
    it('lehnt ohne Token mit 401 ab und schreibt nichts', async () => {
      const antwort = await melden({});

      expect(antwort.statusCode).toBe(401);
      await nichtsGeschrieben();
    });

    it('lehnt ein widerrufenes Token mit 401 ab und schreibt nichts', async () => {
      const { id, token } = await zugang();
      await apiTokenWiderrufen(pool, id);

      const antwort = await melden({ token });

      expect(antwort.statusCode).toBe(401);
      await nichtsGeschrieben();
    });

    it('lehnt ein Token ohne das Recht befund_schreiben mit 403 ab und schreibt nichts', async () => {
      const { token } = await zugang(['agenten_schreiben', 'eingriff_verwalten']);

      const antwort = await melden({ token });

      expect(antwort.statusCode).toBe(403);
      expect(antwort.json()).toEqual({ fehler: 'nicht_erlaubt' });
      await nichtsGeschrieben();
    });

    it('liest den Rumpf erst nach der Prüfung: ein zu großer Rumpf ohne Token ist ein 401, kein 413', async () => {
      const antwort = await melden({ roh: JSON.stringify({ ...GUELTIG, text_intern: 'x'.repeat(100_000) }) });

      expect(antwort.statusCode).toBe(401);
    });
  });

  describe('ungültige Eingaben', () => {
    const ZU_LANG = 'x'.repeat(4001);

    it.each<[string, unknown, string[]]>([
      ['ohne Wache', { status: 'gruen', text_intern: 'x', takt_sekunden: 300 }, ['wache']],
      ['mit leerer Wache', { ...GUELTIG, wache: '' }, ['wache']],
      ['mit Großbuchstaben in der Wache', { ...GUELTIG, wache: 'Container' }, ['wache']],
      ['mit Leerzeichen in der Wache', { ...GUELTIG, wache: 'zwei worte' }, ['wache']],
      ['mit zu langer Wache', { ...GUELTIG, wache: 'a'.repeat(64) }, ['wache']],
      ['mit Wache, die mit einem Unterstrich beginnt', { ...GUELTIG, wache: '_x' }, ['wache']],
      ['mit Zahl als Wache', { ...GUELTIG, wache: 5 }, ['wache']],
      ['ohne Status', { wache: 'container', text_intern: 'x', takt_sekunden: 300 }, ['status']],
      ['mit unbekanntem Status', { ...GUELTIG, status: 'blau' }, ['status']],
      ['mit großgeschriebenem Status', { ...GUELTIG, status: 'GRUEN' }, ['status']],
      ['mit Umlaut im Status', { ...GUELTIG, status: 'grün' }, ['status']],
      ['mit Zahl als Status', { ...GUELTIG, status: 1 }, ['status']],
      ['ohne Text', { wache: 'container', status: 'gruen', takt_sekunden: 300 }, ['text_intern']],
      ['mit leerem Text', { ...GUELTIG, text_intern: '' }, ['text_intern']],
      ['mit Text aus Leerraum', { ...GUELTIG, text_intern: ' \n\t ' }, ['text_intern']],
      ['mit zu langem Text', { ...GUELTIG, text_intern: ZU_LANG }, ['text_intern']],
      ['mit Zahl als Text', { ...GUELTIG, text_intern: 5 }, ['text_intern']],
      ['mit leerem Klartext', { ...GUELTIG, text_kunde: '' }, ['text_kunde']],
      ['mit Klartext aus Leerraum', { ...GUELTIG, text_kunde: '   ' }, ['text_kunde']],
      ['mit zu langem Klartext', { ...GUELTIG, text_kunde: 'x'.repeat(501) }, ['text_kunde']],
      ['mit null als Klartext', { ...GUELTIG, text_kunde: null }, ['text_kunde']],
      ['mit leerem Anzeigenamen', { ...GUELTIG, anzeigename: '' }, ['anzeigename']],
      ['mit Anzeigenamen aus Leerraum', { ...GUELTIG, anzeigename: '   ' }, ['anzeigename']],
      ['mit zu langem Anzeigenamen', { ...GUELTIG, anzeigename: 'x'.repeat(61) }, ['anzeigename']],
      ['mit Zahl als Anzeigenamen', { ...GUELTIG, anzeigename: 5 }, ['anzeigename']],
      ['mit null als Anzeigenamen', { ...GUELTIG, anzeigename: null }, ['anzeigename']],
      ['mit Text statt Wahrheitswert bei kundensichtbar', { ...GUELTIG, text_kunde: 'x', kundensichtbar: 'ja' }, ['kundensichtbar']],
      ['mit Zahl statt Wahrheitswert bei kundensichtbar', { ...GUELTIG, text_kunde: 'x', kundensichtbar: 1 }, ['kundensichtbar']],
      ['kundensichtbar ohne Klartext', { ...GUELTIG, kundensichtbar: true }, ['text_kunde']],
      ['kundensichtbar mit leerem Klartext', { ...GUELTIG, kundensichtbar: true, text_kunde: '' }, ['text_kunde']],
      ['mit Takt null', { ...GUELTIG, takt_sekunden: 0 }, ['takt_sekunden']],
      ['mit negativem Takt', { ...GUELTIG, takt_sekunden: -5 }, ['takt_sekunden']],
      ['mit Dezimalzahl als Takt', { ...GUELTIG, takt_sekunden: 1.5 }, ['takt_sekunden']],
      ['mit Text als Takt', { ...GUELTIG, takt_sekunden: '300' }, ['takt_sekunden']],
      ['mit zu großem Takt', { ...GUELTIG, takt_sekunden: 31_622_401 }, ['takt_sekunden']],
      ['mit null als Takt', { ...GUELTIG, takt_sekunden: null }, ['takt_sekunden']],
      ['mit einem unbekannten Feld', { ...GUELTIG, nebenbei: 'x' }, ['nebenbei']],
      ['mit gefälschter Quelle', { ...GUELTIG, quelle: 'koordinator' }, ['quelle']],
      ['mit gefälschtem Zeitpunkt', { ...GUELTIG, gemeldet_am: '2020-01-01T00:00:00Z' }, ['gemeldet_am']],
      ['mit gefälschter Nummer', { ...GUELTIG, id: 1 }, ['id']],
      ['mit falsch geschriebenem Feld', { ...GUELTIG, kundensichtbar_: true }, ['kundensichtbar_']],
      ['mit einem Feld mit ungewöhnlichem Namen', { ...GUELTIG, '<script>alert(1)</script>': 1 }, ['(unbekanntes Feld)']],
      ['mit einem Feld mit zu langem Namen', { ...GUELTIG, ['x'.repeat(65)]: 1 }, ['(unbekanntes Feld)']],
      ['mit mehreren Fehlern', { wache: 'X', status: 'blau', text_intern: '' }, ['status', 'text_intern', 'wache']],
      ['als Liste', [GUELTIG], ['(rumpf)']],
      ['als Text', 'befund', ['(rumpf)']],
      ['als Zahl', 5, ['(rumpf)']],
      ['als null', null, ['(rumpf)']],
      ['als leeres Objekt', {}, ['status', 'text_intern', 'wache']],
    ])('lehnt einen Befund %s mit 400 ab, nennt nur das Feld und schreibt nichts', async (_name, koerper, felder) => {
      const { token } = await zugang();

      const antwort = await melden({ token, roh: JSON.stringify(koerper) });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder });
      await nichtsGeschrieben();
    });

    it('nennt bei einer unbekannten Wache ohne Takt das Feld takt_sekunden und legt nichts an', async () => {
      const { token } = await zugang();

      const antwort = await melden({ token, koerper: { wache: 'container', status: 'gruen', text_intern: 'x' } });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder: ['takt_sekunden'] });
      await nichtsGeschrieben();
    });

    it('wiederholt die Eingabe nie in der Antwort: kein Text, kein Wert, auch nicht in Teilen', async () => {
      const { token } = await zugang();
      const geheim = 'GEHEIMER-TEXT-DES-AGENTEN-4711';

      const antwort = await melden({ token, koerper: { ...GUELTIG, status: geheim, text_intern: geheim, wache: geheim, nebenbei: geheim } });

      expect(antwort.statusCode).toBe(400);
      // Erlaubt sind die Namen der falschen Felder, nie ihre Werte.
      expect(antwort.body).not.toContain(geheim);
    });

    it.each([
      ['kein JSON', '{kaputt'],
      ['abgeschnittenes JSON', '{"wache": "container", "status"'],
      ['ein leerer Rumpf', ''],
    ])('lehnt %s mit 400 ab und schreibt nichts', async (_name, roh) => {
      const { token } = await zugang();

      const antwort = await melden({ token, roh });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage' });
      expect(antwort.body).not.toContain('kaputt');
      await nichtsGeschrieben();
    });

    it.each([
      ['text/plain', 'text/plain'],
      ['ein Formular', 'application/x-www-form-urlencoded'],
      ['XML', 'application/xml'],
    ])('lehnt den Inhaltstyp %s mit 415 ab', async (_name, inhaltstyp) => {
      const { token } = await zugang();

      const antwort = await melden({ token, inhaltstyp, roh: 'wache=container&status=gruen&text_intern=x&takt_sekunden=300' });

      expect(antwort.statusCode).toBe(415);
      expect(antwort.json()).toEqual({ fehler: 'inhaltstyp_nicht_unterstuetzt' });
      await nichtsGeschrieben();
    });

    it('nimmt JSON mit Zeichensatz-Angabe an', async () => {
      const { token } = await zugang();

      const antwort = await melden({ token, inhaltstyp: 'application/json; charset=utf-8' });

      expect(antwort.statusCode).toBe(201);
    });
  });

  describe('zu große Eingaben', () => {
    it('lehnt einen Rumpf über 32 KiB mit 413 ab, ohne ihn auszuwerten, und schreibt nichts', async () => {
      const { token } = await zugang();

      const antwort = await melden({ token, roh: JSON.stringify({ ...GUELTIG, text_intern: 'x'.repeat(40 * 1024) }) });

      expect(antwort.statusCode).toBe(413);
      expect(antwort.json()).toEqual({ fehler: 'zu_gross' });
      await nichtsGeschrieben();
    });

    it('zählt bei den Texten Zeichen, nicht Byte: 2000 Emoji sind 4000 Zeichen und passen gerade', async () => {
      const { token } = await zugang();
      // Je Emoji vier Byte und zwei Zeichen (UTF-16): 8000 Byte, 4000 Zeichen — weit unter 32 KiB.
      const antwort = await melden({ token, koerper: { ...GUELTIG, text_intern: '🚀'.repeat(2000) } });

      expect(antwort.statusCode).toBe(201);
    });

    it('lehnt zu viele Zeichen auch dann ab, wenn der Rumpf klein genug ist', async () => {
      const { token } = await zugang();

      const antwort = await melden({ token, koerper: { ...GUELTIG, text_intern: 'x'.repeat(4001) } });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder: ['text_intern'] });
    });
  });

  describe('wenn etwas schiefgeht', () => {
    it('antwortet 500 ohne Text der Datenbank, legt die Wache nicht an und hält den Text nicht im Log', async () => {
      const { token } = await zugang();
      const entfernen = await einfuegenScheitern(pool, 'befund', 'test_befund_scheitert: GEHEIMER-DB-TEXT');
      let antwort;
      try {
        antwort = await melden({ token, koerper: { ...GUELTIG, text_intern: 'GEHEIMER-BEFUNDTEXT' } });
      } finally {
        await entfernen();
      }

      expect(antwort.statusCode).toBe(500);
      expect(antwort.json()).toEqual({ fehler: 'interner_fehler' });
      expect(antwort.body).not.toContain('GEHEIMER');
      expect(logZeilen.join('')).not.toContain('GEHEIMER');
      await nichtsGeschrieben();
    });

    it('hält den Text des Befunds aus dem Log, auch im Regelfall: Fastify loggt keine Rümpfe', async () => {
      const { token } = await zugang();

      await melden({ token, koerper: { ...GUELTIG, text_intern: 'GEHEIMER-BEFUNDTEXT' } });

      expect(logZeilen.join('')).not.toContain('GEHEIMER-BEFUNDTEXT');
      expect(logZeilen.join('')).not.toContain(token);
    });
  });

  describe('Update-Ziel einer Versions-Wache (COPI-140)', () => {
    const DIGEST = `sha256:${'ab'.repeat(32)}`;
    const COMMIT = 'bac99d0935870496c9c5cd867ed849d7e06ab91c';
    const SEIT = '2026-10-12T04:25:00+02:00';
    const COCKPIT = { wache: 'version-cockpit', status: 'gelb', text_intern: 'Neue Version 0.24.0', takt_sekunden: 21_600 };
    const MODUL = { ...COCKPIT, wache: 'version-modul-blog', text_intern: 'Commit bac99d0' };
    const COCKPIT_ZIEL = { art: 'cockpit', ziel: DIGEST, version: '0.24.0', hinweis: 'Updates mit einem Klick', seit: SEIT };
    const MODUL_ZIEL = { art: 'modul', ziel: COMMIT, version: null, hinweis: 'Block und View geändert', seit: SEIT };

    async function gespeichert(): Promise<unknown> {
      const zeile = await pool.query<{ update_ziel: unknown }>('SELECT update_ziel FROM cockpit.befund ORDER BY id DESC LIMIT 1');
      return zeile.rows[0]?.update_ziel;
    }

    it('speichert das Ziel des Cockpits am Befund', async () => {
      const { token } = await zugang();

      const antwort = await melden({ token, koerper: { ...COCKPIT, update: COCKPIT_ZIEL } });

      expect(antwort.statusCode).toBe(201);
      expect(await gespeichert()).toEqual(COCKPIT_ZIEL);
    });

    it('speichert das Ziel eines Moduls; ohne Version und ohne Hinweis genügt Art, Ziel und Seit', async () => {
      const { token } = await zugang();

      expect((await melden({ token, koerper: { ...MODUL, update: MODUL_ZIEL } })).statusCode).toBe(201);
      expect(await gespeichert()).toEqual({ art: 'modul', ziel: COMMIT, hinweis: 'Block und View geändert', seit: SEIT });
      expect((await melden({ token, koerper: { ...MODUL, update: { art: 'modul', ziel: COMMIT, seit: SEIT } } })).statusCode).toBe(201);
      expect(await gespeichert()).toEqual({ art: 'modul', ziel: COMMIT, seit: SEIT });
    });

    it('lässt einen Befund ohne Ziel, wie er war', async () => {
      const { token } = await zugang();

      expect((await melden({ token, koerper: COCKPIT })).statusCode).toBe(201);
      expect(await gespeichert()).toBeNull();
    });

    it.each<[string, unknown, string[]]>([
      ['bei grünem Befund', { ...COCKPIT, status: 'gruen', update: COCKPIT_ZIEL }, ['update']],
      ['an einer fremden Wache', { ...COCKPIT, wache: 'container', update: COCKPIT_ZIEL }, ['update.art']],
      ['mit Cockpit-Ziel an einer Modul-Wache', { ...MODUL, update: COCKPIT_ZIEL }, ['update.art']],
      ['mit Modul-Ziel an der Cockpit-Wache', { ...COCKPIT, update: MODUL_ZIEL }, ['update.art']],
      ['mit unbekannter Art', { ...COCKPIT, update: { ...COCKPIT_ZIEL, art: 'image' } }, ['update.art']],
      ['mit gekürztem Commit', { ...MODUL, update: { ...MODUL_ZIEL, ziel: COMMIT.slice(0, 7) } }, ['update.ziel']],
      ['mit Großbuchstaben im Commit', { ...MODUL, update: { ...MODUL_ZIEL, ziel: COMMIT.toUpperCase() } }, ['update.ziel']],
      ['mit Digest ohne sha256:', { ...COCKPIT, update: { ...COCKPIT_ZIEL, ziel: 'ab'.repeat(32) } }, ['update.ziel']],
      ['beim Cockpit ohne Version', { ...COCKPIT, update: { ...COCKPIT_ZIEL, version: null } }, ['update.version']],
      ['beim Cockpit mit ungültiger Version', { ...COCKPIT, update: { ...COCKPIT_ZIEL, version: 'v0.24' } }, ['update.version']],
      ['beim Modul mit Version', { ...MODUL, update: { ...MODUL_ZIEL, version: '1.0.0' } }, ['update.version']],
      ['mit zu langem Hinweis', { ...MODUL, update: { ...MODUL_ZIEL, hinweis: 'x'.repeat(201) } }, ['update.hinweis']],
      ['ohne Seit', { ...MODUL, update: { art: 'modul', ziel: COMMIT } }, ['update.seit']],
      ['mit Seit ohne Zeitzone', { ...MODUL, update: { ...MODUL_ZIEL, seit: '2026-10-12T04:25:00' } }, ['update.seit']],
      ['mit unbekanntem Feld im Ziel', { ...MODUL, update: { ...MODUL_ZIEL, digest: DIGEST } }, ['update.digest']],
    ])('weist ein Ziel %s ab und speichert nichts', async (_name, koerper, felder) => {
      const { token } = await zugang();

      const antwort = await melden({ token, koerper });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder });
      await nichtsGeschrieben();
    });

    it('lässt die Datenbank selbst kein ungültiges Ziel annehmen (Migration 0049)', async () => {
      await pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ('version-cockpit', 60)`);
      const einfuegen = (status: string, ziel: unknown) =>
        pool.query(
          `INSERT INTO cockpit.befund (wache, status, text_intern, kundensichtbar, quelle, gemeldet_am, update_ziel)
           VALUES ('version-cockpit', $1, 'x', false, 'test', now(), $2::jsonb)`,
          [status, JSON.stringify(ziel)],
        );

      await expect(einfuegen('gelb', COCKPIT_ZIEL)).resolves.toBeDefined();
      for (const [status, ziel] of [
        ['gruen', COCKPIT_ZIEL],
        ['gelb', { ...COCKPIT_ZIEL, version: null }],
        ['gelb', { ...MODUL_ZIEL, ziel: DIGEST }],
        ['gelb', { ...MODUL_ZIEL, version: '1.0.0' }],
        ['gelb', { ...MODUL_ZIEL, hinweis: 'x'.repeat(201) }],
        ['gelb', { ...MODUL_ZIEL, nebenbei: 1 }],
        ['gelb', { art: 'modul', ziel: COMMIT }],
        ['gelb', [COCKPIT_ZIEL]],
      ] as const) {
        await expect(einfuegen(status, ziel)).rejects.toThrow(/befund_update_ziel_form/);
      }
    });
  });

  describe('Gleichzeitig', () => {
    it('nimmt viele Befunde für dieselbe neue Wache gleichzeitig an: eine Wache, alle Befunde', async () => {
      const { token } = await zugang();

      const antworten = await Promise.all(
        Array.from({ length: 10 }, (_, i) => melden({ token, koerper: { ...GUELTIG, text_intern: `Befund ${String(i)}` } })),
      );

      expect(antworten.map((antwort) => antwort.statusCode)).toEqual(Array<number>(10).fill(201));
      expect(await anzahl('wache')).toBe(1);
      expect(await anzahl('befund')).toBe(10);
    });
  });

  describe('Die Uhr springt zurück', () => {
    it('lässt den Herzschlag der Wache nicht rückwärts laufen', async () => {
      const { token } = await zugang();
      await melden({ token });
      jetzt = new Date(T0.getTime() - 60 * 60_000);

      const antwort = await melden({ token, koerper: { ...GUELTIG, text_intern: 'nach dem Zurückspringen' } });

      expect(antwort.statusCode).toBe(201);
      const wache = await pool.query<{ letzter_lauf: Date }>('SELECT letzter_lauf FROM cockpit.wache');
      expect(wache.rows[0]?.letzter_lauf).toEqual(T0);
    });
  });
});
