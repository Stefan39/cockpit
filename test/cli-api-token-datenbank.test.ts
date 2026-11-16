/**
 * Die Server-Kommandos für die Zugänge der Agenten-API gegen eine echte PostgreSQL (COPI-35).
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.api_token` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen. Das Protokoll lässt sich nicht abräumen (COPI-23): geprüft
 * werden die Einträge seit einer Marke.
 *
 * Aufgerufen wird `cliAusfuehren` mit dem Pool des Tests und aufgefangenen Ausgabekanälen. Ob das
 * ausgegebene Token die Agenten-API wirklich öffnet, zeigt eine Anfrage an die echte Anwendung:
 * erst das belegt, dass das Token stimmt (wie bei Erststart und Einladung).
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenHashen } from '../src/auth/einmal-token.js';
import { cliAusfuehren } from '../src/cli/befehle.js';
import { apiTokenSuchen } from '../src/intern/token-speicher.js';
import { buildApp } from '../src/server/app.js';
import { protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

interface Lauf {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Wie oft der Text in `heuhaufen` vorkommt. */
function vorkommen(heuhaufen: string, text: string): number {
  return heuhaufen.split(text).length - 1;
}

describe.skipIf(!datenbankUrl)('Server-Kommando: Zugänge der Agenten-API (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function laufen(...argumente: string[]): Promise<Lauf> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await cliAusfuehren(argumente, {
      pool,
      basisUrl: 'http://localhost:3000',
      ausgabe: (text) => stdout.push(text),
      fehlerausgabe: (text) => stderr.push(text),
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  /** Das Token aus der Ausgabe: `cpk_` und 43 Zeichen. */
  function tokenAus(ausgabe: string): string {
    return /cpk_[A-Za-z0-9_-]{43}/.exec(ausgabe)?.[0] ?? '';
  }

  async function pingen(token: string): Promise<number> {
    const app = buildApp({ nodeEnv: 'test' }, { pool });
    try {
      const antwort = await app.inject({
        method: 'GET',
        url: '/intern/ping',
        headers: { authorization: `Bearer ${token}` },
      });
      return antwort.statusCode;
    } finally {
      await app.close();
    }
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.api_token');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.end();
  });

  describe('api-token-erzeugen', () => {
    it('legt den Zugang an und gibt das Token genau einmal auf stdout aus, nie auf stderr', async () => {
      const lauf = await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben');

      expect(lauf.code).toBe(0);
      const token = tokenAus(lauf.stdout);
      expect(token).not.toBe('');
      expect(vorkommen(lauf.stdout, token)).toBe(1);
      expect(lauf.stderr).toBe('');
    });

    it('nennt Nummer, Name und Rechte und sagt, dass das Token nirgends sonst steht', async () => {
      const lauf = await laufen(
        'api-token-erzeugen',
        '--name',
        'admin-agent',
        '--scope',
        'befund_schreiben',
        '--scope',
        'agenten_schreiben',
      );

      const zeile = await pool.query<{ id: number }>('SELECT id::int AS id FROM cockpit.api_token');
      expect(lauf.stdout).toContain('admin-agent');
      expect(lauf.stdout).toContain('befund_schreiben');
      expect(lauf.stdout).toContain('agenten_schreiben');
      expect(lauf.stdout).toContain(String(zeile.rows[0]?.id));
      expect(lauf.stdout).toMatch(/nirgends sonst/);
    });

    it('speichert nur den Hash: weder Token noch Hash stehen in der Ausgabe außer dem Token selbst', async () => {
      const lauf = await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben');
      const token = tokenAus(lauf.stdout);

      const zeile = await pool.query<{ token_hash: string }>('SELECT token_hash FROM cockpit.api_token');
      expect(zeile.rows[0]?.token_hash).toBe(tokenHashen(token));
      expect(lauf.stdout).not.toContain(tokenHashen(token));
      expect(JSON.stringify(zeile.rows)).not.toContain(token);
    });

    it('gibt ein Token aus, das die Agenten-API wirklich öffnet', async () => {
      const lauf = await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben');

      expect(await pingen(tokenAus(lauf.stdout))).toBe(200);
    });

    it('hält das Erzeugen im Protokoll fest: Akteur konsole, ohne Token und ohne Hash', async () => {
      const marke = await protokollMarke(pool);

      const lauf = await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben');

      const token = tokenAus(lauf.stdout);
      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege).toHaveLength(1);
      expect(eintraege[0]).toMatchObject({ art: 'api_token_erzeugt', akteur: 'konsole', einzelheiten: { name: 'admin-agent' } });
      expect(JSON.stringify(eintraege)).not.toContain(token);
      expect(JSON.stringify(eintraege)).not.toContain(tokenHashen(token));
    });

    it('erzeugt bei jedem Aufruf ein anderes Token, auch für denselben Namen (Wechsel ohne Ausfall)', async () => {
      const erstes = tokenAus((await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben')).stdout);
      const zweites = tokenAus((await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben')).stdout);

      expect(erstes).not.toBe(zweites);
      expect(await pingen(erstes)).toBe(200);
      expect(await pingen(zweites)).toBe(200);
    });
  });

  describe('api-token-auflisten', () => {
    it('meldet, dass es keinen Zugang gibt', async () => {
      const lauf = await laufen('api-token-auflisten');

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toMatch(/Kein Zugang/);
    });

    it('listet Nummer, Name, Rechte und Stand — nie ein Token und nie einen Hash', async () => {
      const erster = await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben');
      const zweiter = await laufen('api-token-erzeugen', '--name', 'koordinator', '--scope', 'eingriff_verwalten');
      const ids = (await pool.query<{ id: number; name: string }>('SELECT id::int AS id, name FROM cockpit.api_token ORDER BY id')).rows;
      await laufen('api-token-widerrufen', '--id', String(ids[0]?.id));

      const lauf = await laufen('api-token-auflisten');

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain('admin-agent');
      expect(lauf.stdout).toContain('koordinator');
      expect(lauf.stdout).toContain('widerrufen');
      expect(lauf.stdout).toContain('gültig');
      for (const token of [tokenAus(erster.stdout), tokenAus(zweiter.stdout)]) {
        expect(lauf.stdout).not.toContain(token);
        expect(lauf.stdout).not.toContain(tokenHashen(token));
      }
      expect(lauf.stderr).toBe('');
    });
  });

  describe('api-token-widerrufen', () => {
    it('widerruft den Zugang: das Token gilt danach nicht mehr', async () => {
      const erzeugt = await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben');
      const token = tokenAus(erzeugt.stdout);
      const id = (await apiTokenSuchen(pool, tokenHashen(token)))?.id;
      expect(await pingen(token)).toBe(200);

      const lauf = await laufen('api-token-widerrufen', '--id', String(id));

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain(String(id));
      expect(await pingen(token)).toBe(401);
    });

    it('hält den Widerruf im Protokoll fest: Akteur konsole', async () => {
      const erzeugt = await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben');
      const id = (await apiTokenSuchen(pool, tokenHashen(tokenAus(erzeugt.stdout))))?.id ?? 0;
      const marke = await protokollMarke(pool);

      await laufen('api-token-widerrufen', '--id', String(id));

      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'api_token_widerrufen', akteur: 'konsole', ziel: `api_token_${String(id)}`, einzelheiten: { token_id: id } },
      ]);
    });

    it('sagt bei einem schon widerrufenen Zugang, dass nichts zu tun war, und schreibt keinen zweiten Eintrag', async () => {
      const erzeugt = await laufen('api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben');
      const id = (await apiTokenSuchen(pool, tokenHashen(tokenAus(erzeugt.stdout))))?.id ?? 0;
      await laufen('api-token-widerrufen', '--id', String(id));
      const marke = await protokollMarke(pool);

      const lauf = await laufen('api-token-widerrufen', '--id', String(id));

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toMatch(/schon widerrufen/);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('lehnt einen unbekannten Zugang mit Exit-Code 1 ab und schreibt nichts', async () => {
      const marke = await protokollMarke(pool);

      const lauf = await laufen('api-token-widerrufen', '--id', '987654');

      expect(lauf.code).toBe(1);
      expect(lauf.stdout).toBe('');
      expect(lauf.stderr).toMatch(/gibt es nicht/);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('widerruft nur den genannten Zugang: die übrigen gelten weiter', async () => {
      const a = tokenAus((await laufen('api-token-erzeugen', '--name', 'a', '--scope', 'befund_schreiben')).stdout);
      const b = tokenAus((await laufen('api-token-erzeugen', '--name', 'b', '--scope', 'befund_schreiben')).stdout);
      const idA = (await apiTokenSuchen(pool, tokenHashen(a)))?.id;

      await laufen('api-token-widerrufen', '--id', String(idA));

      expect(await pingen(a)).toBe(401);
      expect(await pingen(b)).toBe(200);
    });
  });
});
