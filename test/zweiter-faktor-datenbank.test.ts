/**
 * „Zweiter Faktor aktiv" aus einer Quelle (COPI-25): die SQL-Funktion
 * `cockpit.zweiter_faktor_aktiv`, die dünne Funktion der Anwendung und die Stellen,
 * die sie nutzen.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit."user"` und
 * `cockpit.einladung` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 *
 * Das Verhalten für Nutzer bleibt gleich; das belegen die bestehenden Tests von
 * Tor, Rechteprüfung, Einrichtung, Verfall und Übergabe, die unverändert grün
 * bleiben. Hier stehen die Fälle der Funktion selbst.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { zugangsZustandLesen } from '../src/auth/berechtigung.js';
import { zweiterFaktorAktiv } from '../src/auth/zweiter-faktor.js';
import { mailversandBauen } from '../src/mail/versand.js';
import { buildApp } from '../src/server/app.js';
import { kontenLoeschen, kontoEinrichten } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';

describe.skipIf(!datenbankUrl)('Zweiter Faktor aktiv (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;

  /** Eine Zeile direkt per SQL; `faktor: null` lässt die Spalte leer (sie ist nullable). */
  async function zeile(id: string, faktor: boolean | null): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled")
       VALUES ($1, $2, $1, true, now(), now(), $3)`,
      [id, `${id}@example.org`, faktor],
    );
  }

  async function funktion(id: string): Promise<boolean | null> {
    const ergebnis = await pool.query<{ aktiv: boolean | null }>(
      'SELECT cockpit.zweiter_faktor_aktiv(u) AS aktiv FROM cockpit."user" u WHERE u.id = $1',
      [id],
    );
    return ergebnis.rows[0]?.aktiv ?? null;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    const versand = mailversandBauen(nodemailer.createTransport({ jsonTransport: true }), 'cockpit@example.org');
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, versand, basisUrl: BASIS_URL });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
  });

  afterAll(async () => {
    await app.close();
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('SQL-Funktion cockpit.zweiter_faktor_aktiv', () => {
    it.each([
      ['true', true, true],
      ['false', false, false],
      ['leer (NULL)', null, false],
    ])('liefert für die Spalte %s das Ergebnis %s', async (_name, spalte, erwartet) => {
      await zeile('sql_konto', spalte);

      expect(await funktion('sql_konto')).toBe(erwartet);
    });

    it('liefert nie NULL, sondern immer wahr oder falsch', async () => {
      await zeile('sql_leer', null);

      expect(await funktion('sql_leer')).not.toBeNull();
    });
  });

  describe('zweiterFaktorAktiv(pool, id)', () => {
    it('liefert falsch für ein Konto ohne Faktor', async () => {
      const konto = await kontoEinrichten(app, auth, {
        email: 'ohne@example.org', passwort: PASSWORT, name: 'Ohne', mitZweitemFaktor: false,
      });

      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(false);
    });

    it('liefert wahr nach bestätigtem TOTP, über den echten Einrichtungsweg', async () => {
      const konto = await kontoEinrichten(app, auth, {
        email: 'mit@example.org', passwort: PASSWORT, name: 'Mit', mitZweitemFaktor: true,
      });

      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(true);
    });

    it('liefert falsch, sobald der Faktor direkt zurückgesetzt wird', async () => {
      const konto = await kontoEinrichten(app, auth, {
        email: 'zurueck@example.org', passwort: PASSWORT, name: 'Zurück', mitZweitemFaktor: true,
      });
      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(true);

      await pool.query('UPDATE cockpit."user" SET "twoFactorEnabled" = false WHERE id = $1', [konto.id]);

      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(false);
    });

    it.each([['gibt-es-nicht'], ['']])('liefert falsch für die unbekannte Konto-ID %j', async (id) => {
      expect(await zweiterFaktorAktiv(pool, id)).toBe(false);
    });
  });

  describe('zugangsZustandLesen', () => {
    it('liefert Rolle und Faktor aus einer Abfrage', async () => {
      await zeile('zustand_mit', true);
      await zeile('zustand_ohne', false);
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betriebs_admin' WHERE id = 'zustand_mit'`);

      expect(await zugangsZustandLesen(pool, 'zustand_mit')).toEqual({
        rolle: 'betriebs_admin',
        zweiterFaktorAktiv: true,
      });
      expect(await zugangsZustandLesen(pool, 'zustand_ohne')).toEqual({
        rolle: 'betrieb_mitarbeiter',
        zweiterFaktorAktiv: false,
      });
    });

    it('liefert für ein unbekanntes Konto keine Rolle und keinen Faktor', async () => {
      expect(await zugangsZustandLesen(pool, 'gibt-es-nicht')).toEqual({
        rolle: undefined,
        zweiterFaktorAktiv: false,
      });
    });
  });

  describe('Kosten: die Funktion wird je Prüfung genau einmal gefragt', () => {
    /** Zählt die Abfragen, in denen die Funktion vorkommt (Better Auth nutzt denselben Pool über Kysely). */
    async function funktionsabfragen(aufruf: () => Promise<unknown>): Promise<number> {
      const original = pg.Client.prototype.query as unknown as (...argumente: unknown[]) => unknown;
      const spion = vi
        .spyOn(pg.Client.prototype as unknown as { query: (...argumente: unknown[]) => unknown }, 'query')
        .mockImplementation(function (this: unknown, ...argumente: unknown[]) {
          return original.apply(this, argumente);
        });
      try {
        await aufruf();
        return spion.mock.calls.filter(
          (aufrufArgumente) => JSON.stringify(aufrufArgumente[0]).includes('zweiter_faktor_aktiv'),
        ).length;
      } finally {
        spion.mockRestore();
      }
    }

    // Die Übersicht (COPI-37) wählt ihre Sicht nach dem Recht `rohbefunde_sehen`: das Tor prüft, der Handler
    // prüft für sich noch einmal, wie bei der Einladung. Jede Prüfung fragt genau einmal.
    it('fragt für die Übersicht zweimal: das Tor und die Rechteprüfung des Handlers', async () => {
      const konto = await kontoEinrichten(app, auth, {
        email: 'kosten@example.org', passwort: PASSWORT, name: 'Kosten', mitZweitemFaktor: true,
      });

      const anzahl = await funktionsabfragen(() =>
        app.inject({ method: 'GET', url: '/', headers: { cookie: konto.cookie } }),
      );

      expect(anzahl).toBe(2);
    });

    it('fragt für das Einladungsformular dreimal: Tor, Haken und Handler prüfen je für sich', async () => {
      const konto = await kontoEinrichten(app, auth, {
        email: 'einladender@example.org', passwort: PASSWORT, name: 'Einladender', mitZweitemFaktor: true,
      });
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betriebs_admin' WHERE id = $1`, [konto.id]);

      const anzahl = await funktionsabfragen(() =>
        app.inject({ method: 'GET', url: '/einladung', headers: { cookie: konto.cookie } }),
      );

      expect(anzahl).toBe(3);
    });

    it('fragt ohne Sitzungs-Cookie gar nicht', async () => {
      const anzahl = await funktionsabfragen(() => app.inject({ method: 'GET', url: '/anmelden' }));

      expect(anzahl).toBe(0);
    });
  });
});
