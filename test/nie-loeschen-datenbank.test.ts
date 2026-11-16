/**
 * Nie physisch löschen, nur als gelöscht markieren (COPI-62, Migration 0025) — die Garantien im Ganzen.
 *
 * Ein als gelöscht markiertes Konto bleibt im Bestand, kommt aber nie wieder hinein: kein Passwort, kein Faktor, keine
 * Sitzung, keine Rolle. Seine Adresse ist wieder frei. Zugangsmittel landen im Archiv, ohne Geheimnis. Agenten werden
 * als entfernt markiert. Und die Datenbank weist DELETE an jeder Nachweistabelle ab.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { zugangsZustandLesen } from '../src/auth/berechtigung.js';
import { kontoEntfernen } from '../src/auth/benutzer-bearbeiten-speicher.js';
import { kontoVorhanden } from '../src/auth/einladung-speicher.js';
import { EntsperrenKontoUnbekannt, kontoEntsperren } from '../src/auth/entsperrung.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { buildApp } from '../src/server/app.js';
import { agentenLesen, inventarErsetzen, type AgentInventar } from '../src/status/agenten-speicher.js';
import { kontenLoeschen, kontoEinrichten, passkeyEinrichten, wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';
const JEDER = { id: 'handelnder-1', erlaubt: () => true };

/** Jede Tabelle, die nie gelöscht wird — Chat (0024), Bestand (0025) und spätere, etwa die Pipeline-Queue (0051). */
const NACHWEISTABELLEN = [
  'agent',
  'agent_ereignis',
  'anhang_download',
  'api_token',
  'app_symbol',
  'befund',
  'chat_mail',
  'chat_verbrauch',
  'eingriff',
  'einladung',
  'email_aenderung',
  'entscheidung',
  'erststart_token',
  'freigabe',
  'instanz',
  'kanal',
  'modul',
  'modul_betreuer_zugriff',
  'modul_gelesen',
  'nachricht',
  'nachricht_lesestand',
  'pipeline_job',
  'pipeline_job_event',
  'pipeline_provider_state',
  'pipeline_repo_config',
  'pipeline_usage',
  'posteingang_push',
  'posteingang_stand',
  'preis',
  'push_abo',
  'update_freigabemodus',
  'user',
  'verbrauch',
  'vorgang_sperre',
  'wache',
  'wechselkurs',
  'zugang_wiederherstellung',
  'zugangsmittel_archiv',
];

describe.skipIf(!datenbankUrl)('Nie löschen, nur markieren (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();
  });

  beforeEach(async () => {
    await kontenLoeschen(pool);
  });

  afterAll(async () => {
    await app.close();
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('die Datenbank', () => {
    it('hat an jeder Nachweistabelle die Sperre gegen DELETE — und an keiner Kurzzeittabelle', async () => {
      const ergebnis = await pool.query<{ tabelle: string }>(
        `SELECT c.relname AS tabelle
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'nie_loeschen' AND NOT t.tgisinternal
          ORDER BY c.relname`,
      );
      expect(ergebnis.rows.map((zeile) => zeile.tabelle)).toEqual(NACHWEISTABELLEN);
    });

    it('weist DELETE ab, wie in einer Kundeninstanz, mit dem Namen der Tabelle', async () => {
      await pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ('container', 300)`);
      await expect(wieImBetrieb(pool, `DELETE FROM cockpit.wache`)).rejects.toThrow(
        'nie_loeschen: In wache wird nie geloescht, nur als geloescht markiert',
      );
      await pool.query(`DELETE FROM cockpit.wache`);
    });

    it('hält im Archiv der Zugangsmittel kein Geheimnis: nur Art, Konto, Kennung und Zeitpunkte', async () => {
      const spalten = await pool.query<{ spalte: string }>(
        `SELECT column_name AS spalte FROM information_schema.columns
          WHERE table_schema = 'cockpit' AND table_name = 'zugangsmittel_archiv' ORDER BY ordinal_position`,
      );
      expect(spalten.rows.map((zeile) => zeile.spalte)).toEqual(['id', 'art', 'benutzer_id', 'ursprung_id', 'angelegt_am', 'widerrufen_am']);
    });
  });

  describe('ein als gelöscht markiertes Konto', () => {
    it('kommt nie wieder hinein: weder mit alter Adresse noch mit dem Platzhalter, und bekommt auch sonst keine Sitzung', async () => {
      const konto = await kontoEinrichten(app, auth, { email: 'anna@example.org', passwort: PASSWORT, name: 'Anna', mitZweitemFaktor: true });
      expect(await kontoEntfernen(pool, konto.id, JEDER)).toEqual({ ok: true, wert: undefined });

      await expect(auth.api.signInEmail({ body: { email: 'anna@example.org', password: PASSWORT } })).rejects.toThrow();
      await expect(
        auth.api.signInEmail({ body: { email: `geloescht-${konto.id}@geloescht.invalid`, password: PASSWORT } }),
      ).rejects.toThrow();

      // Der Riegel dahinter (Sitzungs-Hook): der Weg, der eine Sitzung ohne Adresse und Passwort anlegt — nach einem
      // Passkey oder Ersatzcode (`sitzung-anlegen.ts`) —, gibt einem markierten Konto keine. Better Auth findet den
      // Platzhalter über die Adresse ohnehin nie: es schreibt die Eingabe klein, die Konto-ID enthält Großbuchstaben.
      const lebend = await kontoEinrichten(app, auth, { email: 'kontrolle@example.org', passwort: PASSWORT, name: 'K', mitZweitemFaktor: false });
      await expect(auth.api.sitzungNachZweitemFaktor({ body: { benutzerId: lebend.id } })).resolves.toEqual({ ok: true });
      await expect(auth.api.sitzungNachZweitemFaktor({ body: { benutzerId: konto.id } })).rejects.toThrow();
      const sitzungen = await pool.query('SELECT 1 FROM cockpit.session WHERE "userId" = $1', [konto.id]);
      expect(sitzungen.rowCount).toBe(0);

      // Die alte Sitzung öffnet nichts mehr.
      expect((await app.inject({ method: 'GET', url: '/', headers: { cookie: konto.cookie } })).statusCode).not.toBe(200);
    }, 30_000);

    it('hat keine Rolle, lässt sich nicht entsperren, und seine Adresse ist wieder einladbar', async () => {
      const konto = await kontoEinrichten(app, auth, { email: 'bert@example.org', passwort: PASSWORT, name: 'Bert', mitZweitemFaktor: true });
      await kontoEntfernen(pool, konto.id, JEDER);

      expect(await zugangsZustandLesen(pool, konto.id)).toMatchObject({ rolle: undefined, zweiterFaktorAktiv: false });
      await expect(kontoEntsperren(pool, konto.id)).rejects.toBeInstanceOf(EntsperrenKontoUnbekannt);
      expect(await kontoVorhanden(pool, 'bert@example.org')).toBe(false);
    }, 30_000);

    it('legt seine Zugangsmittel ins Archiv — Passkey und Ersatzcodes —, die Anmeldetabellen sind leer', async () => {
      const konto = await kontoEinrichten(app, auth, { email: 'cora@example.org', passwort: PASSWORT, name: 'Cora', mitZweitemFaktor: false });
      const { ersatzcodes } = await passkeyEinrichten(app, konto, PASSWORT, BASIS_URL);
      const passkey = await pool.query<{ id: string }>('SELECT id FROM cockpit.passkey WHERE benutzer_id = $1', [konto.id]);
      expect(passkey.rowCount).toBe(1);

      await kontoEntfernen(pool, konto.id, JEDER);

      const archiv = await pool.query<{ art: string; ursprung_id: string }>(
        'SELECT art, ursprung_id FROM cockpit.zugangsmittel_archiv WHERE benutzer_id = $1 ORDER BY art, id',
        [konto.id],
      );
      expect(archiv.rows.filter((zeile) => zeile.art === 'passkey')).toEqual([{ art: 'passkey', ursprung_id: passkey.rows[0]?.id }]);
      expect(archiv.rows.filter((zeile) => zeile.art === 'ersatzcode')).toHaveLength(ersatzcodes.length);
      for (const tabelle of ['passkey', 'ersatzcode']) {
        const reste = await pool.query(`SELECT 1 FROM cockpit.${tabelle} WHERE benutzer_id = $1`, [konto.id]);
        expect({ tabelle, reste: reste.rowCount }).toEqual({ tabelle, reste: 0 });
      }
    }, 30_000);
  });

  describe('Agenten', () => {
    const agent = (kennung: string): AgentInventar => ({ kennung, rolle: 'admin', version: '1.0.0', grenzen: {}, zeitplan: [] });
    const T0 = new Date('2026-09-23T08:00:00.000Z');

    beforeEach(async () => {
      await pool.query('DELETE FROM cockpit.agent');
    });

    it('markiert, wer nicht mehr gemeldet wird, als entfernt — und nimmt ihn wieder auf, wenn er zurückkommt', async () => {
      await inventarErsetzen(pool, [agent('admin'), agent('koordinator')], T0);

      expect(await inventarErsetzen(pool, [agent('admin')], T0)).toEqual({ agenten: 1, entfernt: 1 });
      expect((await agentenLesen(pool)).map((a) => a.kennung)).toEqual(['admin']);
      const bestand = await pool.query<{ kennung: string; entfernt_am: Date | null }>(
        'SELECT kennung, entfernt_am FROM cockpit.agent ORDER BY kennung',
      );
      expect(bestand.rows).toEqual([
        { kennung: 'admin', entfernt_am: null },
        { kennung: 'koordinator', entfernt_am: T0 },
      ]);

      // Noch einmal ohne ihn: er zählt nicht zweimal als entfernt.
      expect(await inventarErsetzen(pool, [agent('admin')], T0)).toEqual({ agenten: 1, entfernt: 0 });

      expect(await inventarErsetzen(pool, [agent('admin'), agent('koordinator')], T0)).toEqual({ agenten: 2, entfernt: 0 });
      expect((await agentenLesen(pool)).map((a) => a.kennung)).toEqual(['admin', 'koordinator']);
    });
  });
});
