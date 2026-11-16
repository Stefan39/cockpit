/**
 * Die Zugänge der Agenten-API in der Datenbank (COPI-35, Migration 0016): Tabelle `api_token`,
 * Speicher und Protokoll.
 *
 * Läuft nur mit `TEST_DATABASE_URL` (echte PostgreSQL) und räumt dort `cockpit.api_token` ab.
 * Niemals gegen eine Kundendatenbank laufen lassen. Das Protokoll lässt sich nicht abräumen
 * (COPI-23): geprüft werden die Einträge **seit einer Marke**.
 *
 * Die erwarteten Werte (Constraint- und Fehlernamen, Protokollarten) stehen als Literale: der
 * Test soll nicht mitrechnen, wenn die Migration oder der Speicher sie ändert.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenHashen } from '../src/auth/einmal-token.js';
import { protokollSchreiben } from '../src/auth/protokoll.js';
import {
  apiTokenAnlegen,
  apiTokenAuflisten,
  apiTokenSuchen,
  apiTokenWiderrufen,
} from '../src/intern/token-speicher.js';
import { protokollMarke, protokollSchreibenScheitern, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** Die Meldung, mit der die Datenbank eine Anweisung ablehnt; scheitert der Test, wenn sie angenommen wird. */
async function abgelehnt(anweisung: Promise<unknown>): Promise<string> {
  try {
    await anweisung;
  } catch (fehler) {
    return fehler instanceof Error ? fehler.message : String(fehler);
  }
  throw new Error('Die Datenbank hat die Anweisung angenommen, obwohl sie abgelehnt werden musste.');
}

describe.skipIf(!datenbankUrl)('Zugänge der Agenten-API (echte Datenbank)', () => {
  let pool: pg.Pool;

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

  async function zeileEinfuegen(name: string, hash: string, scopes: string): Promise<number> {
    const ergebnis = await pool.query<{ id: number }>(
      `INSERT INTO cockpit.api_token (name, token_hash, scopes)
       VALUES ($1, $2, $3::text[]) RETURNING id::int AS id`,
      [name, hash, scopes],
    );
    const id = ergebnis.rows[0]?.id;
    if (id === undefined) {
      throw new Error('Keine Zeile angelegt');
    }
    return id;
  }

  describe('Tabelle api_token', () => {
    it('nimmt einen Zugang mit Name, Hash und bekannten Scopes an, und die Datenbank setzt den Zeitpunkt', async () => {
      const id = await zeileEinfuegen('admin-agent', HASH_A, '{befund_schreiben,agenten_schreiben}');

      const zeile = await pool.query<{ erzeugt_am: Date; widerrufen_am: Date | null; scopes: string[] }>(
        'SELECT erzeugt_am, widerrufen_am, scopes FROM cockpit.api_token WHERE id = $1',
        [id],
      );

      expect(zeile.rows[0]?.erzeugt_am).toBeInstanceOf(Date);
      expect(zeile.rows[0]?.widerrufen_am).toBeNull();
      expect(zeile.rows[0]?.scopes).toEqual(['befund_schreiben', 'agenten_schreiben']);
    });

    it.each(['', 'Admin', '-zuerst', 'mit leerzeichen', 'mit.punkt', 'a'.repeat(41), 'x@y'])(
      'lehnt den Namen %j ab: er landet im Protokoll und muss dort als Kennung passen',
      async (name) => {
        expect(await abgelehnt(zeileEinfuegen(name, HASH_A, '{befund_schreiben}'))).toContain('api_token_name_form');
      },
    );

    it.each(['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])(
      'lehnt den Hash %j ab: gespeichert wird nur ein SHA-256 in Hex, nie ein Token',
      async (hash) => {
        expect(await abgelehnt(zeileEinfuegen('admin-agent', hash, '{befund_schreiben}'))).toContain(
          'api_token_hash_form',
        );
      },
    );

    it('kennt jeden Hash nur einmal', async () => {
      await zeileEinfuegen('erster', HASH_A, '{befund_schreiben}');

      expect(await abgelehnt(zeileEinfuegen('zweiter', HASH_A, '{befund_schreiben}'))).toContain(
        'api_token_hash_eindeutig',
      );
    });

    it.each([
      ['keine Scopes', '{}'],
      ['einen unbekannten Scope', '{alles}'],
      ['einen bekannten und einen unbekannten Scope', '{befund_schreiben,alles}'],
      ['einen Scope in anderer Schreibweise', '{Befund_Schreiben}'],
      ['einen Scope mit Doppelpunkt', '{befund:schreiben}'],
    ])('lehnt %s ab: ein Zugang ohne bekannte Berechtigung wäre wertlos oder zu mächtig', async (_name, scopes) => {
      expect(await abgelehnt(zeileEinfuegen('admin-agent', HASH_A, scopes))).toContain('api_token_scopes_bekannt');
    });

    it('lässt zwei Zugänge mit demselben Namen zu: beim Wechsel gilt der neue, bevor der alte widerrufen wird', async () => {
      await zeileEinfuegen('admin-agent', HASH_A, '{befund_schreiben}');

      await zeileEinfuegen('admin-agent', HASH_B, '{befund_schreiben}');
    });

    describe('was nach dem Anlegen feststeht', () => {
      it.each([
        ['der Hash', `SET token_hash = '${HASH_B}'`],
        ['die Scopes', `SET scopes = '{eingriff_verwalten}'`],
        ['der Name', `SET name = 'anderer-name'`],
        ['der Zeitpunkt der Erzeugung', `SET erzeugt_am = '2001-01-01T00:00:00Z'`],
      ])('lässt sich %s nicht mehr ändern: für andere Rechte gibt es einen neuen Zugang', async (_name, aenderung) => {
        const id = await zeileEinfuegen('admin-agent', HASH_A, '{befund_schreiben}');

        const meldung = await abgelehnt(pool.query(`UPDATE cockpit.api_token ${aenderung} WHERE id = $1`, [id]));

        expect(meldung).toContain('api_token_unveraenderlich');
      });

      it('lässt sich widerrufen, und der Widerruf bleibt: ein widerrufener Zugang wird nie wieder gültig', async () => {
        const id = await zeileEinfuegen('admin-agent', HASH_A, '{befund_schreiben}');
        await pool.query('UPDATE cockpit.api_token SET widerrufen_am = now() WHERE id = $1', [id]);

        const zurueck = await abgelehnt(pool.query('UPDATE cockpit.api_token SET widerrufen_am = NULL WHERE id = $1', [id]));
        const verschoben = await abgelehnt(
          pool.query(`UPDATE cockpit.api_token SET widerrufen_am = '2001-01-01T00:00:00Z' WHERE id = $1`, [id]),
        );

        // Ein durchgesickertes Token würde sonst mit einem einzigen SQL-Befehl wieder gültig.
        expect(zurueck).toContain('api_token_widerruf_bleibt');
        expect(verschoben).toContain('api_token_widerruf_bleibt');
      });
    });
  });

  describe('Protokoll', () => {
    it.each(['api_token_erzeugt', 'api_token_widerrufen', 'api_zugriff_abgelehnt'] as const)(
      'kennt die Art %s (Migration erweitert die Bedingung protokoll_art_bekannt)',
      async (art) => {
        await protokollSchreiben(pool, { art, akteur: 'konsole', ziel: 'api_token_1', einzelheiten: { token_id: 1 } });
      },
    );
  });

  describe('apiTokenAnlegen', () => {
    it('legt den Zugang an und gibt Nummer und Token zurück; gespeichert ist nur der Hash', async () => {
      const { id, token } = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] });

      const zeile = await pool.query<Record<string, unknown>>('SELECT * FROM cockpit.api_token WHERE id = $1', [id]);
      expect(zeile.rows[0]).toMatchObject({ name: 'admin-agent', token_hash: tokenHashen(token), scopes: ['befund_schreiben'] });
      // Keine Spalte trägt den Klartext, auch nicht in Teilen.
      expect(JSON.stringify(zeile.rows[0])).not.toContain(token);
      expect(JSON.stringify(zeile.rows[0])).not.toContain(token.slice(4, 24));
    });

    it('gibt ein Token zurück, das wie ein Token der Agenten-API aussieht', async () => {
      const { token } = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] });

      expect(token).toMatch(/^cpk_[A-Za-z0-9_-]{43}$/);
    });

    it('legt jeden Scope nur einmal an, auch wenn er mehrfach genannt wird', async () => {
      const { id } = await apiTokenAnlegen(pool, {
        name: 'admin-agent',
        scopes: ['befund_schreiben', 'agenten_schreiben', 'befund_schreiben'],
      });

      const zeile = await pool.query<{ scopes: string[] }>('SELECT scopes FROM cockpit.api_token WHERE id = $1', [id]);
      expect(zeile.rows[0]?.scopes).toEqual(['befund_schreiben', 'agenten_schreiben']);
    });

    it('protokolliert das Erzeugen mit Zugangsnummer und Name — ohne Token und ohne Hash', async () => {
      const marke = await protokollMarke(pool);

      const { id, token } = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] });

      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege).toEqual([
        {
          art: 'api_token_erzeugt',
          akteur: 'konsole',
          ziel: `api_token_${String(id)}`,
          einzelheiten: { token_id: id, name: 'admin-agent' },
        },
      ]);
      expect(JSON.stringify(eintraege)).not.toContain(token);
      expect(JSON.stringify(eintraege)).not.toContain(tokenHashen(token));
    });

    it('legt nichts an, wenn der Protokolleintrag scheitert: Zugang und Eintrag gelten gemeinsam oder gar nicht', async () => {
      const entfernen = await protokollSchreibenScheitern(pool, 'api_token_erzeugt');
      try {
        await expect(apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] })).rejects.toThrow();
      } finally {
        await entfernen();
      }

      const anzahl = await pool.query<{ anzahl: number }>('SELECT count(*)::int AS anzahl FROM cockpit.api_token');
      expect(anzahl.rows[0]?.anzahl).toBe(0);
    });
  });

  describe('apiTokenSuchen', () => {
    it('findet einen Zugang über den Hash des Tokens', async () => {
      const { id, token } = await apiTokenAnlegen(pool, {
        name: 'admin-agent',
        scopes: ['befund_schreiben', 'eingriff_verwalten'],
      });

      const gefunden = await apiTokenSuchen(pool, tokenHashen(token));

      expect(gefunden).toMatchObject({
        id,
        name: 'admin-agent',
        scopes: ['befund_schreiben', 'eingriff_verwalten'],
        widerrufenAm: undefined,
      });
    });

    it('findet keinen Zugang zu einem unbekannten Hash', async () => {
      expect(await apiTokenSuchen(pool, HASH_A)).toBeUndefined();
    });

    it('liefert einen widerrufenen Zugang mit dem Zeitpunkt des Widerrufs, damit die Prüfung ihn ablehnen kann', async () => {
      const { id, token } = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] });
      await apiTokenWiderrufen(pool, id);

      const gefunden = await apiTokenSuchen(pool, tokenHashen(token));

      expect(gefunden?.widerrufenAm).toBeInstanceOf(Date);
    });
  });

  describe('apiTokenWiderrufen', () => {
    it('widerruft einen Zugang und protokolliert das', async () => {
      const { id } = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] });
      const marke = await protokollMarke(pool);

      const ergebnis = await apiTokenWiderrufen(pool, id);

      expect(ergebnis).toBe('widerrufen');
      const zeile = await pool.query<{ widerrufen: boolean }>(
        'SELECT widerrufen_am IS NOT NULL AS widerrufen FROM cockpit.api_token WHERE id = $1',
        [id],
      );
      expect(zeile.rows[0]?.widerrufen).toBe(true);
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'api_token_widerrufen', akteur: 'konsole', ziel: `api_token_${String(id)}`, einzelheiten: { token_id: id } },
      ]);
    });

    it('widerruft nur einmal: der zweite Aufruf ändert den Zeitpunkt nicht und schreibt keinen zweiten Eintrag', async () => {
      const { id } = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] });
      await apiTokenWiderrufen(pool, id);
      const vorher = await pool.query('SELECT widerrufen_am FROM cockpit.api_token WHERE id = $1', [id]);
      const marke = await protokollMarke(pool);

      const ergebnis = await apiTokenWiderrufen(pool, id);

      expect(ergebnis).toBe('schon_widerrufen');
      const nachher = await pool.query('SELECT widerrufen_am FROM cockpit.api_token WHERE id = $1', [id]);
      expect(nachher.rows[0]).toEqual(vorher.rows[0]);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('meldet einen unbekannten Zugang, ohne etwas zu schreiben', async () => {
      const marke = await protokollMarke(pool);

      expect(await apiTokenWiderrufen(pool, 987_654)).toBe('unbekannt');

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('lässt den Zugang gültig, wenn der Protokolleintrag scheitert: Widerruf und Eintrag gelten gemeinsam oder gar nicht', async () => {
      const { id } = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] });
      const entfernen = await protokollSchreibenScheitern(pool, 'api_token_widerrufen');
      try {
        await expect(apiTokenWiderrufen(pool, id)).rejects.toThrow();
      } finally {
        await entfernen();
      }

      const zeile = await pool.query<{ widerrufen: boolean }>(
        'SELECT widerrufen_am IS NOT NULL AS widerrufen FROM cockpit.api_token WHERE id = $1',
        [id],
      );
      expect(zeile.rows[0]?.widerrufen).toBe(false);
    });
  });

  describe('apiTokenAuflisten', () => {
    it('listet alle Zugänge nach Nummer, mit Name, Scopes und Stand — ohne Hash und ohne Token', async () => {
      const erster = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['befund_schreiben'] });
      const zweiter = await apiTokenAnlegen(pool, { name: 'koordinator', scopes: ['eingriff_verwalten'] });
      await apiTokenWiderrufen(pool, erster.id);

      const liste = await apiTokenAuflisten(pool);

      expect(liste.map((zeile) => [zeile.id, zeile.name, zeile.scopes])).toEqual([
        [erster.id, 'admin-agent', ['befund_schreiben']],
        [zweiter.id, 'koordinator', ['eingriff_verwalten']],
      ]);
      expect(liste[0]?.widerrufenAm).toBeInstanceOf(Date);
      expect(liste[1]?.widerrufenAm).toBeUndefined();
      const text = JSON.stringify(liste);
      expect(text).not.toContain(tokenHashen(erster.token));
      expect(text).not.toContain(erster.token);
      expect(Object.keys(liste[0] ?? {}).sort()).toEqual(['erzeugtAm', 'id', 'name', 'scopes', 'widerrufenAm']);
    });

    it('liefert eine leere Liste, wenn es keinen Zugang gibt', async () => {
      expect(await apiTokenAuflisten(pool)).toEqual([]);
    });
  });
});
