/**
 * Die Server-Kommandos `modul-einspielen`, `module-auflisten` (COPI-77) und `modul-freigabe` (COPI-134) gegen eine
 * echte PostgreSQL.
 *
 * Wie bei `cli-api-token-datenbank.test.ts`: `cliAusfuehren` mit dem Pool des Tests und aufgefangenen
 * Ausgabekanälen. Die Standardeingabe kommt über `eingabeLesen` (`CliUmgebung`) statt über einen echten
 * Prozess-Stream — das lässt sich ohne Kindprozess und ohne echtes Piping prüfen.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cliAusfuehren } from '../src/cli/befehle.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BLOCK = [
  'kennung: server-zustand',
  'art: betrieb',
  'menuename: "Server & Dienste"',
  'ansicht: liste-detail',
  'view: v_modul_test_ok',
  'spalten:',
  '  - { name: titel, label: "Titel" }',
  '  - { name: status, label: "Status" }',
  '  - { name: text, label: "Text" }',
  '  - { name: aktualisiert_am, label: "Zuletzt", format: zeitpunkt }',
  'rollen: [betreuer]',
  'eingriffe: []',
  '',
].join('\n');

interface Lauf {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe.skipIf(!datenbankUrl)('Server-Kommando: Module (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function laufen(argumente: string[], eingabe = ''): Promise<Lauf> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await cliAusfuehren(argumente, {
      pool,
      basisUrl: 'http://localhost:3000',
      ausgabe: (zeile) => stdout.push(zeile),
      fehlerausgabe: (zeile) => stderr.push(zeile),
      eingabeLesen: () => Promise.resolve(eingabe),
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cockpit.modul_test_quelle (
        id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        titel           text        NOT NULL,
        status          text        NOT NULL,
        text_intern     text        NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO cockpit.modul_test_quelle (titel, status, text_intern) VALUES ('Postgres', 'gruen', 'roh');
      CREATE OR REPLACE VIEW cockpit.v_modul_test_ok AS
        SELECT id::text AS id, titel, status, aktualisiert_am, titel AS text
          FROM cockpit.modul_test_quelle;
    `);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query(`
      DROP VIEW IF EXISTS cockpit.v_modul_test_ok;
      DROP TABLE IF EXISTS cockpit.modul_test_quelle;
    `);
    await pool.end();
  });

  describe('modul-einspielen', () => {
    it('legt die erste Version an und nennt Kennung, Version und Prüfsumme', async () => {
      const lauf = await laufen(['modul-einspielen'], BLOCK);

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain('server-zustand');
      expect(lauf.stdout).toContain('Version:    1');
      expect(lauf.stdout).toMatch(/Prüfsumme:\s+[0-9a-f]{64}/);
      expect(lauf.stdout).toContain('EINGESPIELT');
      expect(lauf.stderr).toBe('');
    });

    it('speichert die Herkunft aus --herkunft', async () => {
      await laufen(['modul-einspielen', '--herkunft', 'agent-blueprints@abc123'], BLOCK);

      const zeile = await pool.query<{ herkunft: string | null }>(
        `SELECT herkunft FROM cockpit.modul WHERE kennung = 'server-zustand'`,
      );
      expect(zeile.rows[0]?.herkunft).toBe('agent-blueprints@abc123');
    });

    it('meldet beim zweiten, unveränderten Einspielen „unverändert" und legt keine neue Version an', async () => {
      await laufen(['modul-einspielen'], BLOCK);

      const lauf = await laufen(['modul-einspielen'], BLOCK);

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain('UNVERÄNDERT');
      const anzahl = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM cockpit.modul`);
      expect(anzahl.rows[0]?.n).toBe(1);
    });

    it('legt bei geändertem Block eine zweite Version an', async () => {
      await laufen(['modul-einspielen'], BLOCK);

      const lauf = await laufen(['modul-einspielen'], BLOCK.replace('Server & Dienste', 'Server & Dienste (neu)'));

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain('Version:    2');
    });

    it('lehnt einen leeren Modul-Block mit Exit-Code 1 ab, ohne Stacktrace', async () => {
      const lauf = await laufen(['modul-einspielen'], '   ');

      expect(lauf.code).toBe(1);
      expect(lauf.stdout).toBe('');
      expect(lauf.stderr).toContain('leer');
      expect(lauf.stderr).not.toContain('    at ');
    });

    it('lehnt eine unbekannte Option ab', async () => {
      const lauf = await laufen(['modul-einspielen', '--unbekannt', 'x'], BLOCK);

      expect(lauf.code).toBe(2);
    });

    it('lehnt einen Block ab, dessen View es nicht gibt, mit einer klaren Meldung', async () => {
      const lauf = await laufen(['modul-einspielen'], BLOCK.replace('v_modul_test_ok', 'v_modul_test_unbekannt'));

      expect(lauf.code).toBe(1);
      expect(lauf.stderr).toContain('v_modul_test_unbekannt');
    });
  });

  describe('module-auflisten', () => {
    it('meldet, dass kein Modul eingespielt ist', async () => {
      const lauf = await laufen(['module-auflisten']);

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toMatch(/Kein Modul/);
    });

    it('listet die aktiven Module mit Kennung und Version', async () => {
      await laufen(['modul-einspielen'], BLOCK);
      await laufen(['modul-einspielen'], BLOCK.replace('Server & Dienste', 'x'));

      const lauf = await laufen(['module-auflisten']);

      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain('server-zustand');
      expect(lauf.stdout).toContain('Version   2');
      expect(lauf.stdout).toContain('Betreuer: immer (technisch)');
    });
  });

  describe('modul-freigabe (COPI-134)', () => {
    const FACH = BLOCK.replace('kennung: server-zustand', 'kennung: fach-probe').replace('art: betrieb', 'rollen: [betriebs_admin]').replace('rollen: [betreuer]\n', '');

    it('setzt den Betreuer-Zugriff auf ein Fachmodul, protokolliert als Konsole und zeigt ihn in module-auflisten', async () => {
      expect((await laufen(['modul-einspielen'], FACH)).code).toBe(0);
      expect((await laufen(['module-auflisten'])).stdout).toMatch(/fach-probe .*Betreuer: (aus|lesen|entscheiden)/);

      const lauf = await laufen(['modul-freigabe', '--modul', 'fach-probe', '--stufe', 'lesen']);
      expect(lauf.code).toBe(0);
      expect(lauf.stdout).toContain('fach-probe: Lesen');

      const zeile = await pool.query<{ stufe: string; weg: string }>(
        `SELECT stufe, weg FROM cockpit.modul_betreuer_zugriff WHERE modul_kennung = 'fach-probe' ORDER BY id DESC LIMIT 1`,
      );
      expect(zeile.rows[0]).toEqual({ stufe: 'lesen', weg: 'konsole' });
      expect((await laufen(['module-auflisten'])).stdout).toMatch(/fach-probe .*Betreuer: lesen/);
      expect((await laufen(['modul-freigabe', '--modul', 'fach-probe', '--stufe', 'lesen'])).stdout).toContain('nichts geändert');
    });

    it('weist ein technisches und ein unbekanntes Modul ab und eine falsche Stufe als Bedienfehler', async () => {
      await laufen(['modul-einspielen'], BLOCK);
      expect((await laufen(['modul-freigabe', '--modul', 'server-zustand', '--stufe', 'lesen'])).code).toBe(1);
      expect((await laufen(['modul-freigabe', '--modul', 'gibt-es-nicht', '--stufe', 'lesen'])).code).toBe(1);
      expect((await laufen(['modul-freigabe', '--modul', 'server-zustand', '--stufe', 'alles'])).code).toBe(2);
      expect((await laufen(['modul-freigabe', '--stufe', 'lesen'])).code).toBe(2);
    });
  });
});
