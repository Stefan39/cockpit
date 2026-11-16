/**
 * Das Server-Kommando gegen eine echte PostgreSQL (COPI-24).
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit."user"`,
 * `cockpit.einladung` und `cockpit.erststart_token` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 *
 * Aufgerufen wird `cliAusfuehren` mit dem Pool des Tests und aufgefangenen
 * Ausgabekanälen; dass auch der echte Prozess sich so verhält, zeigt
 * `cli-prozess-datenbank.test.ts`. Die Links aus der Ausgabe werden über die
 * echte Anwendung eingelöst: erst das belegt, dass der Token stimmt.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cliAusfuehren } from '../src/cli/befehle.js';
import { tokenHashen } from '../src/auth/einmal-token.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { neuesErststartTokenAnlegen, tokenPruefen } from '../src/auth/erststart-speicher.js';
import { buildApp } from '../src/server/app.js';
import {
  FORMULAR_KOPF,
  formular,
  kontenLoeschen,
  kontoEinrichten,
  protokollMarke,
  protokollSeit,
} from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';
const NEU = 'cli-neu@example.org';

interface Lauf {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Wie oft der Text in `heuhaufen` vorkommt. */
function vorkommen(heuhaufen: string, text: string): number {
  return heuhaufen.split(text).length - 1;
}

describe.skipIf(!datenbankUrl)('Server-Kommando gegen echte Datenbank', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;

  async function laufen(...argumente: string[]): Promise<Lauf> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await cliAusfuehren(argumente, {
      pool,
      basisUrl: BASIS_URL,
      ausgabe: (text) => stdout.push(text),
      fehlerausgabe: (text) => stderr.push(text),
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  /** Das Token aus dem Link in der Ausgabe. */
  function tokenAus(ausgabe: string, pfad: 'erststart' | 'einladung'): string {
    return new RegExp(`${BASIS_URL}/${pfad}/([A-Za-z0-9_-]+)`).exec(ausgabe)?.[1] ?? '';
  }

  async function offeneErststartToken(): Promise<number> {
    const ergebnis = await pool.query<{ anzahl: string }>(
      `SELECT count(*)::text AS anzahl FROM cockpit.erststart_token
        WHERE verbraucht_am IS NULL AND ablauf_am > now()`,
    );
    return Number(ergebnis.rows[0]?.anzahl ?? '0');
  }

  async function rolleVon(email: string): Promise<string | undefined> {
    const ergebnis = await pool.query<{ rolle: string }>(
      'SELECT rolle FROM cockpit."user" WHERE lower(email) = $1',
      [email],
    );
    return ergebnis.rows[0]?.rolle;
  }

  /** Ein Konto direkt per SQL: geprüft wird hier das Kommando, nicht der Anmeldeweg. */
  async function konto(id: string, rolle: string, aktiviert: boolean): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit."user"
              (id, email, name, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled", aktiviert_am, rolle)
       VALUES ($1, $2, $1, true, now(), now(), $3, $4, $5)`,
      [id, `${id}@example.org`, aktiviert, aktiviert ? new Date() : null, rolle],
    );
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    // Ohne Mailversand: das Kommando kennt keine Mail, und die Einlöse-Route braucht keine.
    app = buildApp({ nodeEnv: 'test' }, { auth, pool });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.einladung');
    await pool.query('DELETE FROM cockpit.erststart_token');
    await kontenLoeschen(pool);
  });

  afterAll(async () => {
    await app.close();
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('erststart', () => {
    it('lehnt ab, solange ein Benutzer existiert, und erzeugt kein Token', async () => {
      await kontoEinrichten(app, auth, {
        email: 'vorhanden@example.org',
        passwort: PASSWORT,
        name: 'Vorhanden',
        mitZweitemFaktor: false,
      });
      const marke = await protokollMarke(pool);

      const lauf = await laufen('erststart');

      expect(lauf.code).toBe(1);
      expect(lauf.stdout).toBe('');
      expect(lauf.stderr).toContain('bereits ein Benutzer');
      expect(await offeneErststartToken()).toBe(0);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('erzeugt ohne Benutzer genau ein offenes Token und entwertet das vorherige', async () => {
      const frueheres = await neuesErststartTokenAnlegen(pool);
      expect(await offeneErststartToken()).toBe(1);

      const lauf = await laufen('erststart');

      expect(lauf.code).toBe(0);
      expect(lauf.stderr).toBe('');
      const token = tokenAus(lauf.stdout, 'erststart');
      expect(token).not.toBe('');
      expect(await offeneErststartToken()).toBe(1);
      expect((await tokenPruefen(pool, token)).gueltig).toBe(true);
      expect((await tokenPruefen(pool, frueheres.token)).gueltig).toBe(false);
    });

    it('liefert einen Link, der über die echte Anwendung einlösbar ist', async () => {
      const lauf = await laufen('erststart');
      const token = tokenAus(lauf.stdout, 'erststart');

      const seite = await app.inject({ method: 'GET', url: `/erststart/${token}` });
      const eingeloest = await app.inject({
        method: 'POST',
        url: `/erststart/${token}`,
        headers: FORMULAR_KOPF,
        payload: formular({
          email: 'erst@example.org',
          passwort: PASSWORT,
          passwortWiederholung: PASSWORT,
        }),
      });

      expect(seite.statusCode).toBe(200);
      expect(eingeloest.statusCode).toBe(303);
      expect(await rolleVon('erst@example.org')).toBe('betreuer');
    });

    it('gibt das Token genau einmal auf stdout aus, nie auf stderr, und speichert nur den Hash', async () => {
      const lauf = await laufen('erststart');
      const token = tokenAus(lauf.stdout, 'erststart');

      expect(vorkommen(lauf.stdout, token)).toBe(1);
      expect(lauf.stderr).not.toContain(token);
      const zeilen = await pool.query<{ zeile: string }>('SELECT t::text AS zeile FROM cockpit.erststart_token t');
      expect(zeilen.rows.some((zeile) => zeile.zeile.includes(token))).toBe(false);
      expect(zeilen.rows.some((zeile) => zeile.zeile.includes(tokenHashen(token)))).toBe(true);
    });

    it('hält das Erzeugen im Protokoll fest, ohne das Token', async () => {
      const marke = await protokollMarke(pool);

      const lauf = await laufen('erststart');
      const token = tokenAus(lauf.stdout, 'erststart');

      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege).toEqual([
        { art: 'erststart_token_erzeugt', akteur: 'konsole', ziel: null, einzelheiten: {} },
      ]);
      expect(JSON.stringify(eintraege)).not.toContain(token);
    });
  });

  describe('einladung', () => {
    async function einladen(rolle = 'betriebs_admin', email = NEU): Promise<Lauf> {
      return laufen('einladung', '--email', email, '--rolle', rolle);
    }

    async function einloesen(token: string, name = 'Neue Person'): Promise<number> {
      const antwort = await app.inject({
        method: 'POST',
        url: `/einladung/${token}`,
        headers: FORMULAR_KOPF,
        payload: formular({ name, passwort: PASSWORT, passwortWiederholung: PASSWORT }),
      });
      return antwort.statusCode;
    }

    beforeEach(async () => {
      await pool.query('DELETE FROM cockpit."user" WHERE lower(email) = $1', [NEU]);
    });

    it.each([
      ['betriebs_admin', 'Betriebs-Admin'],
      ['betrieb_mitarbeiter', 'Mitarbeiter'],
    ])('legt eine Einladung für %s an; der Link löst ein Konto mit dieser Rolle ein', async (rolle, name) => {
      const lauf = await einladen(rolle);

      expect(lauf.code).toBe(0);
      expect(lauf.stderr).toBe('');
      expect(lauf.stdout).toContain(name);
      const token = tokenAus(lauf.stdout, 'einladung');
      expect(token).not.toBe('');
      expect(await einloesen(token)).toBe(303);
      expect(await rolleVon(NEU)).toBe(rolle);
    });

    it('lässt sich nur einmal einlösen', async () => {
      const token = tokenAus((await einladen()).stdout, 'einladung');

      expect(await einloesen(token)).toBe(303);
      expect(await einloesen(token)).toBe(404);
    });

    it('gibt das Token genau einmal auf stdout aus, nie auf stderr, und speichert nur den Hash', async () => {
      const lauf = await einladen();
      const token = tokenAus(lauf.stdout, 'einladung');

      expect(vorkommen(lauf.stdout, token)).toBe(1);
      expect(lauf.stderr).not.toContain(token);
      const zeilen = await pool.query<{ zeile: string; token_hash: string }>(
        'SELECT e::text AS zeile, token_hash FROM cockpit.einladung e',
      );
      expect(zeilen.rows).toHaveLength(1);
      expect(zeilen.rows[0]?.zeile).not.toContain(token);
      expect(zeilen.rows[0]?.token_hash).toBe(tokenHashen(token));
    });

    it('gilt drei Stunden', async () => {
      await einladen();

      const ergebnis = await pool.query<{ stunden: string }>(
        'SELECT (EXTRACT(EPOCH FROM (ablauf_am - erstellt_am)) / 3600)::text AS stunden FROM cockpit.einladung',
      );
      expect(Number(ergebnis.rows[0]?.stunden)).toBeCloseTo(3, 2);
    });

    it('ersetzt eine frühere offene Einladung an dieselbe Adresse', async () => {
      const alt = tokenAus((await einladen()).stdout, 'einladung');
      const neu = tokenAus((await einladen()).stdout, 'einladung');

      expect(await einloesen(alt)).toBe(404);
      expect(await einloesen(neu)).toBe(303);
    });

    it('lädt niemanden ein, für den es schon einen Zugang gibt, und legt nichts an', async () => {
      await konto('cli_vorhanden', 'betrieb_mitarbeiter', false);

      const lauf = await laufen('einladung', '--email', 'cli_vorhanden@example.org', '--rolle', 'betrieb_mitarbeiter');

      expect(lauf.code).toBe(1);
      expect(lauf.stdout).toBe('');
      expect(lauf.stderr).toContain('bereits einen Zugang');
      const anzahl = await pool.query<{ anzahl: string }>('SELECT count(*)::text AS anzahl FROM cockpit.einladung');
      expect(anzahl.rows[0]?.anzahl).toBe('0');
    });

    it('legt für die Rolle betreuer nichts an', async () => {
      const lauf = await einladen('betreuer');

      expect(lauf.code).toBe(2);
      const anzahl = await pool.query<{ anzahl: string }>('SELECT count(*)::text AS anzahl FROM cockpit.einladung');
      expect(anzahl.rows[0]?.anzahl).toBe('0');
    });

    it('hält die Einladung im Protokoll fest: Akteur konsole, ohne Adresse und Token', async () => {
      const marke = await protokollMarke(pool);

      const lauf = await einladen('betriebs_admin');
      const token = tokenAus(lauf.stdout, 'einladung');

      const id = await pool.query<{ id: string }>('SELECT id::text AS id FROM cockpit.einladung');
      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege).toEqual([
        {
          art: 'einladung_erzeugt',
          akteur: 'konsole',
          ziel: null,
          einzelheiten: { rolle: 'betriebs_admin', einladung_id: Number(id.rows[0]?.id) },
        },
      ]);
      expect(JSON.stringify(eintraege)).not.toContain(token);
      expect(JSON.stringify(eintraege)).not.toContain(NEU);
    });
  });

  describe('betreuer-uebergeben', () => {
    beforeEach(async () => {
      await konto('cli_alt', 'betreuer', true);
      await konto('cli_neu', 'betrieb_mitarbeiter', true);
    });

    it('macht das Zielkonto zum Betreuer und stuft den bisherigen zum Mitarbeiter herab', async () => {
      const lauf = await laufen('betreuer-uebergeben', '--an', 'cli_neu@example.org');

      expect(lauf.code).toBe(0);
      expect(lauf.stderr).toBe('');
      expect(lauf.stdout).toContain('cli_neu@example.org');
      expect(lauf.stdout).toContain('Mitarbeiter');
      expect(await rolleVon('cli_neu@example.org')).toBe('betreuer');
      expect(await rolleVon('cli_alt@example.org')).toBe('betrieb_mitarbeiter');
    });

    it('stuft den bisherigen auf Wunsch zum Betriebs-Admin herab', async () => {
      const lauf = await laufen(
        'betreuer-uebergeben', '--an', 'cli_neu@example.org', '--bisheriger-wird', 'betriebs_admin',
      );

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain('Betriebs-Admin');
      expect(await rolleVon('cli_alt@example.org')).toBe('betriebs_admin');
    });

    it('hält die Übergabe im Protokoll fest: Akteur konsole', async () => {
      const marke = await protokollMarke(pool);

      await laufen('betreuer-uebergeben', '--an', 'cli_neu@example.org');

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'betreuer_uebergeben',
          akteur: 'konsole',
          ziel: 'cli_neu',
          einzelheiten: { von: 'cli_alt', an: 'cli_neu', bisherige_rolle: 'betrieb_mitarbeiter' },
        },
      ]);
    });

    it.each([
      ['ein unbekanntes Konto', 'gibt-es-nicht@example.org', 'kein Konto'],
      ['das Konto des Betreuers selbst', 'cli_alt@example.org', 'schon der Betreuer'],
    ])('lehnt %s ab und ändert nichts', async (_beschreibung, adresse, meldung) => {
      const marke = await protokollMarke(pool);

      const lauf = await laufen('betreuer-uebergeben', '--an', adresse);

      expect(lauf.code).toBe(1);
      expect(lauf.stdout).toBe('');
      expect(lauf.stderr).toContain(meldung);
      expect(await rolleVon('cli_alt@example.org')).toBe('betreuer');
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('lehnt ein Konto ohne aktiven zweiten Faktor ab und ändert nichts', async () => {
      await konto('cli_ohne', 'betrieb_mitarbeiter', false);

      const lauf = await laufen('betreuer-uebergeben', '--an', 'cli_ohne@example.org');

      expect(lauf.code).toBe(1);
      expect(lauf.stderr).toContain('zweiten Faktor');
      expect(await rolleVon('cli_alt@example.org')).toBe('betreuer');
      expect(await rolleVon('cli_ohne@example.org')).toBe('betrieb_mitarbeiter');
    });
  });
});
