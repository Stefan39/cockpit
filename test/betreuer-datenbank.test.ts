/**
 * Die Rolle `betreuer` in der Datenbank (COPI-22): höchstens einer, dauerhaft,
 * nur durch eine Übergabe wechselnd.
 *
 * Läuft nur mit `TEST_DATABASE_URL` (echte PostgreSQL) und räumt dort
 * `cockpit."user"` und `cockpit.einladung` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 *
 * Konten entstehen hier direkt per SQL: geprüft werden Regeln der Datenbank,
 * nicht der Anmeldeweg. Die erwarteten Werte (Rollennamen, Fehlernamen der
 * Sperren) stehen als Literale — der Test soll nicht mitrechnen, wenn der
 * Produktivcode sie ändert.
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { betreuerUebergeben } from '../src/auth/betreuer.js';
import { verfalleneKontenMarkieren } from '../src/auth/konto-verfall.js';
import { kontenLoeschen, protokollMarke, protokollSchreibenScheitern, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-06-01T12:00:00.000Z');
const STUNDE = 60 * 60 * 1000;

interface KontoWunsch {
  readonly rolle?: string;
  /** Aktiviert: zweiter Faktor an und `aktiviert_am` gesetzt. Steuert beides, wenn nicht einzeln angegeben. */
  readonly aktiviert?: boolean;
  /** Der zweite Faktor ist an (`twoFactorEnabled`). */
  readonly faktor?: boolean;
  /** `aktiviert_am` ist gesetzt. */
  readonly markiert?: boolean;
  readonly erstelltAm?: Date;
}

describe.skipIf(!datenbankUrl)('Rolle betreuer (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function konto(id: string, wunsch: KontoWunsch = {}): Promise<void> {
    const aktiviert = wunsch.aktiviert === true;
    const faktor = wunsch.faktor ?? aktiviert;
    const markiert = wunsch.markiert ?? aktiviert;
    const erstellt = wunsch.erstelltAm ?? JETZT;
    await pool.query(
      `INSERT INTO cockpit."user"
              (id, email, name, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled", aktiviert_am, rolle)
       VALUES ($1, $2, $1, true, $3, $3, $4, $5, $6)`,
      [
        id,
        `${id}@example.org`,
        erstellt,
        faktor,
        markiert ? JETZT : null,
        wunsch.rolle ?? 'betrieb_mitarbeiter',
      ],
    );
  }

  async function rolleVon(id: string): Promise<string | undefined> {
    const ergebnis = await pool.query<{ rolle: string }>(
      'SELECT rolle FROM cockpit."user" WHERE id = $1',
      [id],
    );
    return ergebnis.rows[0]?.rolle;
  }

  async function anzahlBetreuer(): Promise<number> {
    const ergebnis = await pool.query<{ anzahl: number }>(
      `SELECT count(*)::int AS anzahl FROM cockpit."user" WHERE rolle = 'betreuer'`,
    );
    return ergebnis.rows[0]?.anzahl ?? 0;
  }

  /** Ein Konto, das gilt — ein als gelöscht markiertes (COPI-62) zählt nicht. */
  async function kontoVorhanden(id: string): Promise<boolean> {
    const ergebnis = await pool.query('SELECT 1 FROM cockpit."user" WHERE id = $1 AND geloescht_am IS NULL', [id]);
    return (ergebnis.rowCount ?? 0) === 1;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
  });

  afterAll(async () => {
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('höchstens ein Betreuer', () => {
    it('lässt ein Konto mit der Rolle betreuer zu', async () => {
      await konto('erster', { rolle: 'betreuer' });

      expect(await anzahlBetreuer()).toBe(1);
    });

    it('lässt kein zweites Konto mit der Rolle betreuer anlegen', async () => {
      await konto('erster', { rolle: 'betreuer' });

      await expect(konto('zweiter', { rolle: 'betreuer' })).rejects.toThrow(
        /user_hoechstens_ein_betreuer/,
      );
      expect(await anzahlBetreuer()).toBe(1);
    });

    it('lässt kein vorhandenes Konto zum zweiten Betreuer machen', async () => {
      await konto('erster', { rolle: 'betreuer' });
      await konto('zweiter');

      await expect(
        pool.query(`UPDATE cockpit."user" SET rolle = 'betreuer' WHERE id = 'zweiter'`),
      ).rejects.toThrow(/user_hoechstens_ein_betreuer/);
      expect(await rolleVon('zweiter')).toBe('betrieb_mitarbeiter');
    });

    it('lässt kein zweites Konto zum Betreuer werden, auch nicht in einer Transaktion mit dem ersten', async () => {
      await konto('erster', { rolle: 'betreuer' });
      await konto('zweiter');

      // Erst befördern, dann herabstufen wäre in einer Transaktion „kurz zwei" —
      // der Index prüft sofort und lässt es nicht zu.
      await expect(
        pool.query(
          `UPDATE cockpit."user" SET rolle = 'betreuer' WHERE id = 'zweiter';
           UPDATE cockpit."user" SET rolle = 'betrieb_mitarbeiter' WHERE id = 'erster'`,
        ),
      ).rejects.toThrow(/user_hoechstens_ein_betreuer/);
      expect(await rolleVon('erster')).toBe('betreuer');
      expect(await rolleVon('zweiter')).toBe('betrieb_mitarbeiter');
    });

    it('kennt keine unbekannte Rolle', async () => {
      await expect(konto('unbekannt', { rolle: 'superadmin' })).rejects.toThrow(
        /user_rolle_bekannt/,
      );
    });

    it('lässt einen anderen Betreuer werden, sobald der bisherige nie aktiviert war und ging', async () => {
      await konto('erster', { rolle: 'betreuer' });
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betrieb_mitarbeiter' WHERE id = 'erster'`);
      await konto('zweiter', { rolle: 'betreuer' });

      expect(await anzahlBetreuer()).toBe(1);
      expect(await rolleVon('zweiter')).toBe('betreuer');
    });
  });

  describe('ein aktivierter Betreuer bleibt bestehen', () => {
    it('lässt sich nicht löschen', async () => {
      await konto('betreuer', { rolle: 'betreuer', aktiviert: true });

      await expect(pool.query(`DELETE FROM cockpit."user" WHERE id = 'betreuer'`)).rejects.toThrow(
        /betreuer_bleibt_bestehen/,
      );
      expect(await kontoVorhanden('betreuer')).toBe(true);
    });

    it('lässt sich nicht herabstufen', async () => {
      await konto('betreuer', { rolle: 'betreuer', aktiviert: true });

      await expect(
        pool.query(`UPDATE cockpit."user" SET rolle = 'betriebs_admin' WHERE id = 'betreuer'`),
      ).rejects.toThrow(/betreuer_bleibt_bestehen/);
      expect(await rolleVon('betreuer')).toBe('betreuer');
    });

    it('verliert den Schutz nicht, wenn der Aktivierungsmarker geleert wird', async () => {
      // Faktor abgeschaltet, Marker noch gesetzt (Marker und Faktor sind entkoppelt, siehe 0006).
      await konto('betreuer', { rolle: 'betreuer', markiert: true, faktor: false });

      await expect(
        pool.query(`UPDATE cockpit."user" SET aktiviert_am = NULL WHERE id = 'betreuer'`),
      ).rejects.toThrow(/betreuer_bleibt_bestehen/);
    });

    it('behält den Marker auch bei eingeschaltetem Faktor: der Trigger aus 0007 setzt ihn sofort neu', async () => {
      await konto('betreuer', { rolle: 'betreuer', aktiviert: true });

      await pool.query(`UPDATE cockpit."user" SET aktiviert_am = NULL WHERE id = 'betreuer'`);

      const ergebnis = await pool.query<{ markiert: boolean }>(
        `SELECT aktiviert_am IS NOT NULL AS markiert FROM cockpit."user" WHERE id = 'betreuer'`,
      );
      expect(ergebnis.rows[0]?.markiert).toBe(true);
    });

    it('schützt nur den Betreuer: andere aktivierte Konten lassen sich herabstufen und löschen', async () => {
      await konto('betreuer', { rolle: 'betreuer', aktiviert: true });
      await konto('anderer', { rolle: 'betriebs_admin', aktiviert: true });

      await pool.query(`UPDATE cockpit."user" SET rolle = 'betrieb_mitarbeiter' WHERE id = 'anderer'`);
      await pool.query(`DELETE FROM cockpit."user" WHERE id = 'anderer'`);

      expect(await rolleVon('betreuer')).toBe('betreuer');
    });

    it('lässt sich nur bewusst entfernen: mit der Übergabe-Markierung in einer Transaktion', async () => {
      await konto('betreuer', { rolle: 'betreuer', aktiviert: true });

      await kontenLoeschen(pool);

      expect(await kontoVorhanden('betreuer')).toBe(false);
    });

    it('ist ein nie aktivierter Betreuer, verfällt aber nach 72 Stunden wie jedes halbfertige Konto', async () => {
      await konto('abgebrochen', {
        rolle: 'betreuer',
        erstelltAm: new Date(JETZT.getTime() - 100 * STUNDE),
      });

      const geloescht = await verfalleneKontenMarkieren(pool, JETZT);

      expect(geloescht).toBe(1);
      expect(await kontoVorhanden('abgebrochen')).toBe(false);
    });

    it('lässt einen aktivierten Betreuer beim Aufräumen der verfallenen Konten stehen', async () => {
      await konto('betreuer', {
        rolle: 'betreuer',
        aktiviert: true,
        erstelltAm: new Date(JETZT.getTime() - 500 * STUNDE),
      });

      const geloescht = await verfalleneKontenMarkieren(pool, JETZT);

      expect(geloescht).toBe(0);
      expect(await kontoVorhanden('betreuer')).toBe(true);
    });
  });

  describe('betreuerUebergeben', () => {
    it('macht das Zielkonto zum Betreuer und stuft den bisherigen herab', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });
      await konto('neu', { aktiviert: true });

      const ergebnis = await betreuerUebergeben(pool, { an: 'neu' });

      expect(ergebnis).toEqual({ von: 'alt', an: 'neu' });
      expect(await rolleVon('neu')).toBe('betreuer');
      expect(await rolleVon('alt')).toBe('betrieb_mitarbeiter');
      expect(await anzahlBetreuer()).toBe(1);
    });

    it('stuft den bisherigen auf Wunsch zum Betriebs-Admin herab', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });
      await konto('neu', { aktiviert: true });

      await betreuerUebergeben(pool, { an: 'neu', bisherigerWirdRolle: 'betriebs_admin' });

      expect(await rolleVon('alt')).toBe('betriebs_admin');
      expect(await rolleVon('neu')).toBe('betreuer');
    });

    it('lässt die Rolle des Zielkontos beliebig sein, auch einen Betriebs-Admin', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });
      await konto('neu', { rolle: 'betriebs_admin', aktiviert: true });

      await betreuerUebergeben(pool, { an: 'neu' });

      expect(await rolleVon('neu')).toBe('betreuer');
    });

    it('ernennt das Zielkonto, wenn es keinen Betreuer gibt', async () => {
      await konto('neu', { aktiviert: true });

      const ergebnis = await betreuerUebergeben(pool, { an: 'neu' });

      expect(ergebnis).toEqual({ von: undefined, an: 'neu' });
      expect(await rolleVon('neu')).toBe('betreuer');
    });

    it.each([
      ['ein Konto, das nie einen zweiten Faktor hatte', {}],
      ['ein Konto, dessen zweiter Faktor abgeschaltet wurde', { markiert: true, faktor: false }],
      ['ein Konto mit Faktor, aber ohne Aktivierungsmarker', { faktor: true, markiert: false }],
    ] as const)('lehnt %s ab und ändert nichts', async (_beschreibung, wunsch) => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });
      await konto('ziel', wunsch);

      await expect(betreuerUebergeben(pool, { an: 'ziel' })).rejects.toMatchObject({
        grund: 'ziel-nicht-aktiv',
      });

      expect(await rolleVon('alt')).toBe('betreuer');
      expect(await rolleVon('ziel')).toBe('betrieb_mitarbeiter');
      expect(await anzahlBetreuer()).toBe(1);
    });

    it('lehnt ein unbekanntes Zielkonto ab und ändert nichts', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });

      await expect(betreuerUebergeben(pool, { an: 'gibt-es-nicht' })).rejects.toMatchObject({
        grund: 'ziel-unbekannt',
      });

      expect(await rolleVon('alt')).toBe('betreuer');
    });

    it('lehnt die Übergabe an den Betreuer selbst ab und ändert nichts', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });

      await expect(betreuerUebergeben(pool, { an: 'alt' })).rejects.toMatchObject({
        grund: 'ziel-ist-betreuer',
      });

      expect(await rolleVon('alt')).toBe('betreuer');
    });

    it.each(['betreuer', 'superadmin', ''])(
      'lehnt die Rolle %j für den bisherigen Betreuer ab, ohne etwas zu ändern',
      async (rolle) => {
        await konto('alt', { rolle: 'betreuer', aktiviert: true });
        await konto('neu', { aktiviert: true });

        await expect(
          betreuerUebergeben(pool, { an: 'neu', bisherigerWirdRolle: rolle as 'betriebs_admin' }),
        ).rejects.toMatchObject({ grund: 'rolle-ungueltig' });

        expect(await rolleVon('alt')).toBe('betreuer');
        expect(await rolleVon('neu')).toBe('betrieb_mitarbeiter');
      },
    );

    it('hält die Übergabe genau einmal fest, mit bisherigem und neuem Betreuer', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });
      await konto('neu', { aktiviert: true });
      const marke = await protokollMarke(pool);

      await betreuerUebergeben(pool, { an: 'neu', bisherigerWirdRolle: 'betriebs_admin' });

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'betreuer_uebergeben',
          akteur: 'konsole',
          ziel: 'neu',
          einzelheiten: { von: 'alt', an: 'neu', bisherige_rolle: 'betriebs_admin' },
        },
      ]);
    });

    it('hält fest, wer die Übergabe ausgelöst hat, wenn ein Akteur angegeben ist', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });
      await konto('neu', { aktiviert: true });
      const marke = await protokollMarke(pool);

      await betreuerUebergeben(pool, { an: 'neu', akteur: 'system' });

      expect((await protokollSeit(pool, marke))[0]?.akteur).toBe('system');
    });

    it('lässt bei einer Ernennung ohne bisherigen Betreuer den Vorgänger weg', async () => {
      await konto('neu', { aktiviert: true });
      const marke = await protokollMarke(pool);

      await betreuerUebergeben(pool, { an: 'neu' });

      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'betreuer_uebergeben', akteur: 'konsole', ziel: 'neu', einzelheiten: { an: 'neu' } },
      ]);
    });

    it('schreibt bei einer abgelehnten Übergabe nichts', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });
      await konto('ziel');
      const marke = await protokollMarke(pool);

      await expect(betreuerUebergeben(pool, { an: 'ziel' })).rejects.toMatchObject({
        grund: 'ziel-nicht-aktiv',
      });
      await expect(betreuerUebergeben(pool, { an: 'alt' })).rejects.toMatchObject({
        grund: 'ziel-ist-betreuer',
      });
      await expect(betreuerUebergeben(pool, { an: 'gibt-es-nicht' })).rejects.toMatchObject({
        grund: 'ziel-unbekannt',
      });

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('nimmt die Übergabe zurück, wenn der Eintrag scheitert: es bleibt beim bisherigen Betreuer', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });
      await konto('neu', { aktiviert: true });
      const marke = await protokollMarke(pool);
      const aufraeumen = await protokollSchreibenScheitern(pool, 'betreuer_uebergeben');
      try {
        await expect(betreuerUebergeben(pool, { an: 'neu' })).rejects.toThrow(
          /test_protokoll_scheitert_betreuer_uebergeben/,
        );
      } finally {
        await aufraeumen();
      }

      expect(await rolleVon('alt')).toBe('betreuer');
      expect(await rolleVon('neu')).toBe('betrieb_mitarbeiter');
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('lässt bei gleichzeitigen Übergaben nie zwei Betreuer entstehen', async () => {
      await konto('alt', { rolle: 'betreuer', aktiviert: true });
      await konto('eins', { aktiviert: true });
      await konto('zwei', { aktiviert: true });

      const ergebnisse = await Promise.allSettled([
        betreuerUebergeben(pool, { an: 'eins' }),
        betreuerUebergeben(pool, { an: 'zwei' }),
      ]);

      expect(ergebnisse.some((e) => e.status === 'fulfilled')).toBe(true);
      expect(await anzahlBetreuer()).toBe(1);
    });
  });

  describe('Migration 0008 — Bestandskonto', () => {
    /** Die UPDATE-Anweisung aus der ausgelieferten Migration, nicht eine Kopie. */
    async function reparatur(): Promise<string> {
      const sql = await readFile('db/migrations/0008_betreuer.up.sql', 'utf8');
      const start = sql.indexOf('UPDATE "cockpit"."user"');
      return sql.slice(start, sql.indexOf(';', start) + 1);
    }

    it('macht genau ein vorhandenes Konto zum Betreuer', async () => {
      await konto('einziges');

      await pool.query(await reparatur());

      expect(await rolleVon('einziges')).toBe('betreuer');
    });

    it('macht auch ein einziges Konto zum Betreuer, das die Migration 0003 zum Betriebs-Admin machte', async () => {
      await konto('einziges', { rolle: 'betriebs_admin' });

      await pool.query(await reparatur());

      expect(await rolleVon('einziges')).toBe('betreuer');
    });

    it('rät bei mehreren Konten nichts zusammen', async () => {
      await konto('eins');
      await konto('zwei');

      await pool.query(await reparatur());

      expect(await rolleVon('eins')).toBe('betrieb_mitarbeiter');
      expect(await rolleVon('zwei')).toBe('betrieb_mitarbeiter');
    });

    it('lässt einen vorhandenen Betreuer stehen', async () => {
      await konto('betreuer', { rolle: 'betreuer' });

      await pool.query(await reparatur());

      expect(await rolleVon('betreuer')).toBe('betreuer');
      expect(await anzahlBetreuer()).toBe(1);
    });
  });
});
