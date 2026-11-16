/**
 * `PUT /intern/agenten` (COPI-38), mit echten Anfragen gegen die echte Datenbank: der Admin-Agent liefert das
 * Inventar der Agenten (Kennung, Rolle, Version, Grenzen, Zeitplan), das Cockpit ersetzt seinen Stand damit.
 *
 * Der Endpunkt liegt auf dem einzigen öffentlich erreichbaren Dienst. Hier steht, was er aushalten muss:
 * nur mit dem Recht `agenten_schreiben`, nur gültige Eingaben, eine Obergrenze für die Größe, keine Eingabe im
 * Echo einer Fehlermeldung — und **eine abgewiesene Meldung lässt das Inventar unangetastet**: PUT ersetzt
 * alles, ein Fehler dürfte also besonders viel zerstören.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.agent` und `cockpit.api_token` ab. Erwartete Werte
 * (Statuscodes, Fehlernamen, Grenzen) stehen als Literale.
 */
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen, apiTokenWiderrufen } from '../src/intern/token-speicher.js';
import type { ApiScope } from '../src/intern/token.js';
import { buildApp } from '../src/server/app.js';
import { agentenLesen, inventarErsetzen, type AgentInventar } from '../src/status/agenten-speicher.js';
import { einfuegenScheitern } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const T0 = new Date('2026-09-21T12:00:00.000Z');

/** Ein gültiger Agent; die Tests verändern ihn Feld für Feld. */
const AGENT = {
  kennung: 'rechnung',
  rolle: 'Rechnungs-Agent',
  version: '2.3.1',
  grenzen: { 'Betrag je Rechnung': 5000, 'darf löschen': false, Währung: 'EUR' },
  zeitplan: [
    { name: 'Rechnungslauf', wann: 'täglich 07:00' },
    { name: 'Mahnungen', wann: 'montags 09:00' },
  ],
};

const GUELTIG = { agenten: [AGENT] };

/** Ein Bestand, den eine abgewiesene Meldung nicht anrühren darf. */
const BESTAND: readonly AgentInventar[] = [
  { kennung: 'alt-1', rolle: 'Alt 1', version: '1', grenzen: { a: 1 }, zeitplan: [{ name: 'n', wann: 'w' }] },
  { kennung: 'alt-2', rolle: 'Alt 2', version: '1', grenzen: {}, zeitplan: [] },
];

interface Anfrage {
  readonly token?: string;
  readonly koerper?: unknown;
  /** Der Rumpf, wie er über die Leitung geht, statt JSON zu erzeugen. */
  readonly roh?: string;
  readonly inhaltstyp?: string;
  readonly methode?: 'PUT' | 'POST' | 'GET';
}

describe.skipIf(!datenbankUrl)('PUT /intern/agenten (echte Datenbank)', () => {
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

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    jetzt = new Date(T0);
    logZeilen = [];
    await pool.query('DELETE FROM cockpit.agent');
    await pool.query('DELETE FROM cockpit.api_token');
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => jetzt, logStrom });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.agent');
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.end();
  });

  async function zugang(scopes: readonly ApiScope[] = ['agenten_schreiben'], name = 'admin-agent') {
    return apiTokenAnlegen(pool, { name, scopes });
  }

  function melden(a: Anfrage) {
    return app.inject({
      method: a.methode ?? 'PUT',
      url: '/intern/agenten',
      headers: {
        ...(a.token === undefined ? {} : { authorization: `Bearer ${a.token}` }),
        'content-type': a.inhaltstyp ?? 'application/json',
      },
      payload: a.roh ?? JSON.stringify(a.koerper ?? GUELTIG),
    });
  }

  /** Der Stand des Inventars als Kennung → Rolle, zum Vergleichen. */
  async function bestand(): Promise<Record<string, string>> {
    return Object.fromEntries((await agentenLesen(pool)).map((zeile) => [zeile.kennung, zeile.rolle]));
  }

  async function bestandAnlegen(): Promise<void> {
    await inventarErsetzen(pool, BESTAND, T0);
  }

  async function bestandUnveraendert(): Promise<void> {
    expect(await bestand()).toEqual({ 'alt-1': 'Alt 1', 'alt-2': 'Alt 2' });
    expect((await agentenLesen(pool)).every((zeile) => zeile.aktualisiertAm.getTime() === T0.getTime())).toBe(true);
  }

  describe('ein gültiges Inventar', () => {
    it('antwortet 200 mit der Zahl der Agenten und der entfernten, ohne Zwischenspeicher', async () => {
      const { token } = await zugang();

      const antwort = await melden({ token });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['cache-control']).toBe('no-store');
      expect(antwort.json()).toEqual({ agenten: 1, entfernt: 0 });
    });

    it('speichert Rolle, Version, Grenzen und Zeitplan, und den Zeitpunkt setzt der Server', async () => {
      const { token } = await zugang();

      await melden({ token });

      expect(await agentenLesen(pool)).toEqual([
        {
          kennung: 'rechnung',
          rolle: 'Rechnungs-Agent',
          version: '2.3.1',
          grenzen: { 'Betrag je Rechnung': 5000, 'darf löschen': false, Währung: 'EUR' },
          zeitplan: [
            { name: 'Rechnungslauf', wann: 'täglich 07:00' },
            { name: 'Mahnungen', wann: 'montags 09:00' },
          ],
          aktualisiertAm: T0,
        },
      ]);
    });

    it('ersetzt das Inventar als Ganzes: wer in der Liste fehlt, fällt heraus', async () => {
      await bestandAnlegen();
      const { token } = await zugang();

      const antwort = await melden({ token });

      expect(antwort.json()).toEqual({ agenten: 1, entfernt: 2 });
      expect(await bestand()).toEqual({ rechnung: 'Rechnungs-Agent' });
    });

    it('nimmt eine leere Liste an und leert das Inventar: eine Instanz ohne Agenten ist ein gültiger Stand', async () => {
      await bestandAnlegen();
      const { token } = await zugang();

      const antwort = await melden({ token, koerper: { agenten: [] } });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.json()).toEqual({ agenten: 0, entfernt: 2 });
      expect(await bestand()).toEqual({});
    });

    it('nimmt Grenzen und Zeitplan als leer an, wenn der Agent sie weglässt', async () => {
      const { token } = await zugang();

      await melden({ token, koerper: { agenten: [{ kennung: 'buchung', rolle: 'Buchungs-Agent', version: '1' }] } });

      const [zeile] = await agentenLesen(pool);
      expect(zeile).toMatchObject({ kennung: 'buchung', grenzen: {}, zeitplan: [] });
    });

    it('ist wiederholbar: dieselbe Meldung noch einmal ergibt denselben Stand', async () => {
      const { token } = await zugang();
      await melden({ token });
      jetzt = new Date(T0.getTime() + 60_000);

      const zweite = await melden({ token });

      expect(zweite.json()).toEqual({ agenten: 1, entfernt: 0 });
      const [zeile] = await agentenLesen(pool);
      expect(zeile?.kennung).toBe('rechnung');
      expect(zeile?.aktualisiertAm).toEqual(jetzt);
    });

    it('schneidet Texte an den Rändern ab und lässt das Innere unverändert', async () => {
      const { token } = await zugang();

      await melden({
        token,
        koerper: { agenten: [{ ...AGENT, rolle: '  Rechnungs-Agent  ', grenzen: { Text: '  a  b  ' }, zeitplan: [{ name: ' n ', wann: ' täglich  07:00 ' }] }] },
      });

      const [zeile] = await agentenLesen(pool);
      expect(zeile?.rolle).toBe('Rechnungs-Agent');
      expect(zeile?.grenzen).toEqual({ Text: 'a  b' });
      expect(zeile?.zeitplan).toEqual([{ name: 'n', wann: 'täglich  07:00' }]);
    });

    it('speichert Fremdtext, wie er kommt: Maskieren ist Sache der Ausgabe, nicht des Speicherns', async () => {
      const { token } = await zugang();
      const fremd = '<img src=x onerror=alert(1)> https://boese.example';

      await melden({ token, koerper: { agenten: [{ ...AGENT, rolle: fremd, grenzen: { [fremd]: fremd }, zeitplan: [{ name: fremd, wann: fremd }] }] } });

      const [zeile] = await agentenLesen(pool);
      expect(zeile?.rolle).toBe(fremd);
      expect(zeile?.zeitplan).toEqual([{ name: fremd, wann: fremd }]);
    });

    it('nimmt die größten erlaubten Werte an', async () => {
      const { token } = await zugang();
      const grenzen = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i).padStart(2, '0')}${'g'.repeat(58)}`, 'w'.repeat(200)]));
      const zeitplan = Array.from({ length: 20 }, () => ({ name: 'n'.repeat(80), wann: 'w'.repeat(120) }));
      const agenten = Array.from({ length: 30 }, (_, i) => ({
        kennung: `a${String(i).padStart(2, '0')}${'k'.repeat(60)}`,
        rolle: 'r'.repeat(100),
        version: 'v'.repeat(64),
        grenzen,
        zeitplan,
      }));

      const antwort = await melden({ token, koerper: { agenten } });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.json()).toEqual({ agenten: 30, entfernt: 0 });
    });
  });

  describe('ohne Berechtigung', () => {
    it('lehnt ohne Token mit 401 ab und lässt das Inventar unangetastet', async () => {
      await bestandAnlegen();

      const antwort = await melden({});

      expect(antwort.statusCode).toBe(401);
      await bestandUnveraendert();
    });

    it('lehnt ein widerrufenes Token mit 401 ab und lässt das Inventar unangetastet', async () => {
      await bestandAnlegen();
      const { id, token } = await zugang();
      await apiTokenWiderrufen(pool, id);

      const antwort = await melden({ token });

      expect(antwort.statusCode).toBe(401);
      await bestandUnveraendert();
    });

    it('lehnt ein Token ohne das Recht agenten_schreiben mit 403 ab: mit befund_schreiben darf man kein Inventar ersetzen', async () => {
      await bestandAnlegen();
      const { token } = await zugang(['befund_schreiben', 'eingriff_verwalten']);

      const antwort = await melden({ token, koerper: { agenten: [] } });

      expect(antwort.statusCode).toBe(403);
      expect(antwort.json()).toEqual({ fehler: 'nicht_erlaubt' });
      await bestandUnveraendert();
    });

    it('liest den Rumpf erst nach der Prüfung: ein zu großer Rumpf ohne Token ist ein 401, kein 413', async () => {
      const antwort = await melden({ roh: JSON.stringify({ agenten: [{ ...AGENT, rolle: 'x'.repeat(700_000) }] }) });

      expect(antwort.statusCode).toBe(401);
    });

    it.each(['POST', 'GET'] as const)('kennt die Adresse nur mit PUT: %s ist keine Route', async (methode) => {
      const { token } = await zugang();

      const antwort = await melden({ token, methode });

      expect(antwort.statusCode).toBe(404);
    });
  });

  describe('ungültige Eingaben', () => {
    const langerName = 'x'.repeat(61);
    const grenzen = (anzahl: number): Record<string, number> => Object.fromEntries(Array.from({ length: anzahl }, (_, i) => [`g${String(i)}`, i]));

    it.each<[string, unknown, string[]]>([
      ['ohne die Liste', {}, ['agenten']],
      ['mit einer Liste, die keine ist', { agenten: 'rechnung' }, ['agenten']],
      ['mit einem Objekt statt einer Liste', { agenten: { kennung: 'a' } }, ['agenten']],
      ['als Liste statt als Objekt', [AGENT], ['(rumpf)']],
      ['mit einem unbekannten Feld', { ...GUELTIG, nebenbei: 1 }, ['nebenbei']],
      ['mit mehr als 30 Agenten', { agenten: Array.from({ length: 31 }, (_, i) => ({ ...AGENT, kennung: `a${String(i)}` })) }, ['agenten']],
      ['mit doppelter Kennung', { agenten: [AGENT, { ...AGENT, rolle: 'zweite' }] }, ['agenten']],
      ['ohne Kennung', { agenten: [{ rolle: 'r', version: '1' }] }, ['agenten.0.kennung']],
      ['mit Großbuchstaben in der Kennung', { agenten: [{ ...AGENT, kennung: 'Rechnung' }] }, ['agenten.0.kennung']],
      ['mit Leerzeichen in der Kennung', { agenten: [{ ...AGENT, kennung: 'zwei worte' }] }, ['agenten.0.kennung']],
      ['mit zu langer Kennung', { agenten: [{ ...AGENT, kennung: 'a'.repeat(64) }] }, ['agenten.0.kennung']],
      ['mit einer Zahl als Kennung', { agenten: [{ ...AGENT, kennung: 5 }] }, ['agenten.0.kennung']],
      ['ohne Rolle', { agenten: [{ kennung: 'a', version: '1' }] }, ['agenten.0.rolle']],
      ['mit leerer Rolle', { agenten: [{ ...AGENT, rolle: '' }] }, ['agenten.0.rolle']],
      ['mit Rolle aus Leerzeichen', { agenten: [{ ...AGENT, rolle: '   ' }] }, ['agenten.0.rolle']],
      ['mit zu langer Rolle', { agenten: [{ ...AGENT, rolle: 'r'.repeat(101) }] }, ['agenten.0.rolle']],
      ['ohne Version', { agenten: [{ kennung: 'a', rolle: 'r' }] }, ['agenten.0.version']],
      ['mit zu langer Version', { agenten: [{ ...AGENT, version: 'v'.repeat(65) }] }, ['agenten.0.version']],
      ['mit einer Zahl als Version', { agenten: [{ ...AGENT, version: 2 }] }, ['agenten.0.version']],
      ['mit einem unbekannten Feld beim Agenten', { agenten: [{ ...AGENT, hinweis: 'x' }] }, ['agenten.0.hinweis']],
      ['mit Grenzen als Liste', { agenten: [{ ...AGENT, grenzen: [1] }] }, ['agenten.0.grenzen']],
      ['mit einem Objekt als Wert einer Grenze', { agenten: [{ ...AGENT, grenzen: { a: { b: 1 } } }] }, ['agenten.0.grenzen']],
      ['mit null als Wert einer Grenze', { agenten: [{ ...AGENT, grenzen: { a: null } }] }, ['agenten.0.grenzen']],
      ['mit einem leeren Text als Wert einer Grenze', { agenten: [{ ...AGENT, grenzen: { a: '  ' } }] }, ['agenten.0.grenzen']],
      ['mit einem zu langen Text als Wert einer Grenze', { agenten: [{ ...AGENT, grenzen: { a: 'w'.repeat(201) } }] }, ['agenten.0.grenzen']],
      ['mit einem zu langen Namen einer Grenze', { agenten: [{ ...AGENT, grenzen: { [langerName]: 1 } }] }, ['agenten.0.grenzen']],
      ['mit einem leeren Namen einer Grenze', { agenten: [{ ...AGENT, grenzen: { '': 1 } }] }, ['agenten.0.grenzen']],
      ['mit mehr als 20 Grenzen', { agenten: [{ ...AGENT, grenzen: grenzen(21) }] }, ['agenten.0.grenzen']],
      ['mit einem Zeitplan, der keine Liste ist', { agenten: [{ ...AGENT, zeitplan: 'täglich' }] }, ['agenten.0.zeitplan']],
      ['mit einem Takt ohne Namen', { agenten: [{ ...AGENT, zeitplan: [{ wann: 'täglich' }] }] }, ['agenten.0.zeitplan.0.name']],
      ['mit einem Takt ohne Angabe, wann', { agenten: [{ ...AGENT, zeitplan: [{ name: 'n' }] }] }, ['agenten.0.zeitplan.0.wann']],
      ['mit einem Takt mit leerem Namen', { agenten: [{ ...AGENT, zeitplan: [{ name: '', wann: 'w' }] }] }, ['agenten.0.zeitplan.0.name']],
      ['mit einem zu langen Namen eines Takts', { agenten: [{ ...AGENT, zeitplan: [{ name: 'n'.repeat(81), wann: 'w' }] }] }, ['agenten.0.zeitplan.0.name']],
      ['mit einer zu langen Angabe, wann', { agenten: [{ ...AGENT, zeitplan: [{ name: 'n', wann: 'w'.repeat(121) }] }] }, ['agenten.0.zeitplan.0.wann']],
      ['mit einem unbekannten Feld im Takt', { agenten: [{ ...AGENT, zeitplan: [{ name: 'n', wann: 'w', cron: '* * * * *' }] }] }, ['agenten.0.zeitplan.0.cron']],
      ['mit mehr als 20 Takten', { agenten: [{ ...AGENT, zeitplan: Array.from({ length: 21 }, () => ({ name: 'n', wann: 'w' })) }] }, ['agenten.0.zeitplan']],
      ['mit Fehlern bei mehreren Agenten', { agenten: [{ ...AGENT, rolle: '' }, { ...AGENT, kennung: 'b', version: '' }] }, ['agenten.0.rolle', 'agenten.1.version']],
    ])('lehnt ein Inventar %s mit 400 ab und lässt den Bestand unangetastet', async (_name, koerper, felder) => {
      await bestandAnlegen();
      const { token } = await zugang();

      const antwort = await melden({ token, roh: JSON.stringify(koerper) });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder });
      await bestandUnveraendert();
    });

    it('nennt bei einem Fehler in den Grenzen nie den Namen, den der Agent gewählt hat: das wäre Inhalt, kein Feldname', async () => {
      const { token } = await zugang();
      const geheim = 'GEHEIME-GRENZE-4711';

      const antwort = await melden({ token, koerper: { agenten: [{ ...AGENT, grenzen: { [geheim]: { verschachtelt: true } } }] } });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder: ['agenten.0.grenzen'] });
      expect(antwort.body).not.toContain(geheim);
    });

    it('wiederholt die Eingabe nie in der Antwort: kein Text, kein Wert, auch nicht in Teilen', async () => {
      const { token } = await zugang();
      const geheim = 'GEHEIMER-TEXT-DES-AGENTEN-4711';

      const antwort = await melden({
        token,
        koerper: { agenten: [{ kennung: geheim, rolle: 5, version: geheim, grenzen: { a: geheim.repeat(20) }, zeitplan: [{ name: 1, wann: geheim }] }], nebenbei: geheim },
      });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).not.toContain(geheim);
    });

    it('nennt ein unbekanntes Feld mit seinem Namen, wenn der harmlos aussieht, und maskiert einen auffälligen', async () => {
      const { token } = await zugang();

      const antwort = await melden({
        token,
        koerper: { agenten: [{ ...AGENT, zeitplan: [{ name: 'n', wann: 'w', cron: 1, '<b>fett</b> mit Leerzeichen': 2 }] }] },
      });

      expect(antwort.json()).toEqual({
        fehler: 'ungueltige_anfrage',
        felder: ['agenten.0.zeitplan.0.(unbekanntes Feld)', 'agenten.0.zeitplan.0.cron'],
      });
      expect(antwort.body).not.toContain('fett');
    });

    it.each([
      ['kein JSON', '{kaputt'],
      ['abgeschnittenes JSON', '{"agenten": [{"kennung"'],
      ['ein leerer Rumpf', ''],
    ])('lehnt %s mit 400 ab und lässt den Bestand unangetastet', async (_name, roh) => {
      await bestandAnlegen();
      const { token } = await zugang();

      const antwort = await melden({ token, roh });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage' });
      expect(antwort.body).not.toContain('kaputt');
      await bestandUnveraendert();
    });

    it.each([
      ['text/plain', 'text/plain'],
      ['ein Formular', 'application/x-www-form-urlencoded'],
      ['XML', 'application/xml'],
    ])('lehnt den Inhaltstyp %s mit 415 ab und lässt den Bestand unangetastet', async (_name, inhaltstyp) => {
      await bestandAnlegen();
      const { token } = await zugang();

      const antwort = await melden({ token, inhaltstyp, roh: 'agenten=leer' });

      expect(antwort.statusCode).toBe(415);
      expect(antwort.json()).toEqual({ fehler: 'inhaltstyp_nicht_unterstuetzt' });
      await bestandUnveraendert();
    });

    it('nimmt JSON mit Zeichensatz-Angabe an', async () => {
      const { token } = await zugang();

      const antwort = await melden({ token, inhaltstyp: 'application/json; charset=utf-8' });

      expect(antwort.statusCode).toBe(200);
    });
  });

  describe('zu große Eingaben', () => {
    it('lehnt einen Rumpf über 512 KiB mit 413 ab, ohne ihn auszuwerten, und lässt den Bestand unangetastet', async () => {
      await bestandAnlegen();
      const { token } = await zugang();

      const antwort = await melden({ token, roh: JSON.stringify({ agenten: [{ ...AGENT, rolle: 'x'.repeat(600 * 1024) }] }) });

      expect(antwort.statusCode).toBe(413);
      expect(antwort.json()).toEqual({ fehler: 'zu_gross' });
      await bestandUnveraendert();
    });

    it('zählt bei den Texten Zeichen, nicht Byte: 50 Emoji sind 100 Zeichen und passen gerade', async () => {
      const { token } = await zugang();

      const antwort = await melden({ token, koerper: { agenten: [{ ...AGENT, rolle: '🚀'.repeat(50) }] } });

      expect(antwort.statusCode).toBe(200);
    });
  });

  describe('wenn etwas schiefgeht', () => {
    it('antwortet 500 ohne Text der Datenbank, lässt den Bestand unangetastet und hält den Text nicht im Log', async () => {
      await bestandAnlegen();
      const { token } = await zugang();
      const entfernen = await einfuegenScheitern(pool, 'agent', 'test_agent_scheitert: GEHEIMER-DB-TEXT');
      let antwort;
      try {
        // „neu" ist ein INSERT und scheitert; das Entfernen von alt-1/alt-2 darf dann nicht gelten.
        antwort = await melden({ token, koerper: { agenten: [{ ...AGENT, kennung: 'neu', rolle: 'GEHEIMER-AGENTENTEXT' }] } });
      } finally {
        await entfernen();
      }

      expect(antwort.statusCode).toBe(500);
      expect(antwort.json()).toEqual({ fehler: 'interner_fehler' });
      expect(antwort.body).not.toContain('GEHEIMER');
      expect(logZeilen.join('')).not.toContain('GEHEIMER');
      await bestandUnveraendert();
    });

    it('hält den Text des Inventars aus dem Log, auch im Regelfall: Fastify loggt keine Rümpfe', async () => {
      const { token } = await zugang();

      await melden({ token, koerper: { agenten: [{ ...AGENT, rolle: 'GEHEIMER-AGENTENTEXT' }] } });

      expect(logZeilen.join('')).not.toContain('GEHEIMER-AGENTENTEXT');
      expect(logZeilen.join('')).not.toContain(token);
    });
  });

  describe('Gleichzeitig', () => {
    it('ergibt bei zwei gleichzeitigen Meldungen genau eine der beiden Listen, nie eine Mischung', async () => {
      const { token } = await zugang();
      const eins = { agenten: [1, 2, 3].map((i) => ({ ...AGENT, kennung: `eins-${String(i)}`, rolle: 'Liste 1' })) };
      const zwei = { agenten: [1, 2].map((i) => ({ ...AGENT, kennung: `zwei-${String(i)}`, rolle: 'Liste 2' })) };

      for (let lauf = 0; lauf < 5; lauf += 1) {
        await Promise.all([melden({ token, koerper: eins }), melden({ token, koerper: zwei })]);

        const stand = Object.keys(await bestand()).sort();
        expect([['eins-1', 'eins-2', 'eins-3'], ['zwei-1', 'zwei-2']], `Lauf ${String(lauf)}: ${stand.join(', ')}`).toContainEqual(stand);
      }
    });
  });
});
