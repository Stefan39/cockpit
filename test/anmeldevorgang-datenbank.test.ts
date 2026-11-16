/**
 * Der kurzlebige Anmeldevorgang zwischen Passwort- und Codeschritt (COPI-13),
 * gegen eine echte PostgreSQL. Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * ACHTUNG: Der Test räumt die Tabellen `cockpit.anmeldevorgang` und
 * `cockpit."user"` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ANMELDEVORGANG_COOKIE_NAME,
  ANMELDEVORGANG_GUELTIGKEIT_MS,
  anmeldevorgaengeAufraeumen,
  anmeldevorgangAnlegen,
  anmeldevorgangCookie,
  anmeldevorgangCookieLoeschen,
  anmeldevorgangLesen,
  anmeldevorgangVerbrauchen,
  cookieLesen,
} from '../src/auth/anmeldevorgang.js';
import { kontenLoeschen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const T0 = new Date('2026-09-19T12:00:00.000Z');

function spaeter(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

describe('cookieLesen', () => {
  it('findet den Wert zwischen anderen Cookies', () => {
    expect(cookieLesen('a=1; __Host-cockpit.anmeldevorgang=xyz; b=2', ANMELDEVORGANG_COOKIE_NAME)).toBe('xyz');
  });

  it('verwechselt keinen Namen, der nur endet wie der gesuchte', () => {
    expect(cookieLesen('fremd-__Host-cockpit.anmeldevorgang=xyz', ANMELDEVORGANG_COOKIE_NAME)).toBe(
      undefined,
    );
  });

  it('kommt ohne Kopfzeile und mit leerem Wert zurecht', () => {
    expect(cookieLesen(undefined, ANMELDEVORGANG_COOKIE_NAME)).toBe(undefined);
    expect(cookieLesen('__Host-cockpit.anmeldevorgang=', ANMELDEVORGANG_COOKIE_NAME)).toBe(undefined);
  });
});

describe('Cookie des Anmeldevorgangs', () => {
  it('trägt alle Attribute, die das __Host--Präfix verlangt', () => {
    const cookie = anmeldevorgangCookie('ein-token');

    expect(cookie.startsWith(`${ANMELDEVORGANG_COOKIE_NAME}=ein-token`)).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie.toLowerCase()).not.toContain('domain=');
    expect(cookie).toContain(`Max-Age=${String(ANMELDEVORGANG_GUELTIGKEIT_MS / 1000)}`);
  });

  it('löscht sich mit denselben Attributen und ohne Wert', () => {
    const cookie = anmeldevorgangCookieLoeschen();

    expect(cookie.startsWith(`${ANMELDEVORGANG_COOKIE_NAME}=;`)).toBe(true);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
  });
});

describe.skipIf(!datenbankUrl)('Anmeldevorgang gegen echte Datenbank', () => {
  let pool: pg.Pool;
  let benutzerId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await kontenLoeschen(pool);
    const ergebnis = await pool.query<{ id: string }>(
      `INSERT INTO cockpit."user" (id, name, email, "emailVerified", "updatedAt")
            VALUES ('benutzer-fuer-vorgang', 'Vorgang', 'vorgang@example.org', false, now())
         RETURNING id`,
    );
    benutzerId = ergebnis.rows[0]?.id ?? '';
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.anmeldevorgang');
  });

  afterAll(async () => {
    await kontenLoeschen(pool);
    await pool.end();
  });

  it('legt einen Vorgang an und liefert das Konto zurück', async () => {
    const token = await anmeldevorgangAnlegen(pool, benutzerId, T0);

    expect(await anmeldevorgangLesen(pool, token, T0)).toBe(benutzerId);
  });

  it('speichert den Klartext des Tokens nirgends', async () => {
    const token = await anmeldevorgangAnlegen(pool, benutzerId, T0);

    const zeilen = await pool.query<{ zeile: string }>(
      'SELECT anmeldevorgang::text AS zeile FROM cockpit.anmeldevorgang',
    );
    expect(zeilen.rows[0]?.zeile).not.toContain(token);
  });

  it('kennt ein erfundenes Token nicht', async () => {
    await anmeldevorgangAnlegen(pool, benutzerId, T0);

    expect(await anmeldevorgangLesen(pool, 'frei-erfunden', T0)).toBe(undefined);
  });

  it('läuft nach zehn Minuten ab', async () => {
    const token = await anmeldevorgangAnlegen(pool, benutzerId, T0);

    expect(await anmeldevorgangLesen(pool, token, spaeter(ANMELDEVORGANG_GUELTIGKEIT_MS - 1000))).toBe(
      benutzerId,
    );
    expect(await anmeldevorgangLesen(pool, token, spaeter(ANMELDEVORGANG_GUELTIGKEIT_MS + 1000))).toBe(
      undefined,
    );
  });

  it('gilt nach dem Verbrauchen nicht mehr', async () => {
    const token = await anmeldevorgangAnlegen(pool, benutzerId, T0);

    expect(await anmeldevorgangVerbrauchen(pool, token)).toBe(true);

    expect(await anmeldevorgangLesen(pool, token, T0)).toBe(undefined);
    expect(await anmeldevorgangVerbrauchen(pool, token)).toBe(false);
  });

  it('entwertet einen vorherigen Vorgang desselben Kontos', async () => {
    const alt = await anmeldevorgangAnlegen(pool, benutzerId, T0);
    const neu = await anmeldevorgangAnlegen(pool, benutzerId, T0);

    expect(await anmeldevorgangLesen(pool, alt, T0)).toBe(undefined);
    expect(await anmeldevorgangLesen(pool, neu, T0)).toBe(benutzerId);
  });

  it('räumt abgelaufene und verbrauchte Vorgänge ab', async () => {
    const abgelaufen = await anmeldevorgangAnlegen(pool, benutzerId, T0);
    await anmeldevorgangVerbrauchen(pool, abgelaufen);

    const entfernt = await anmeldevorgaengeAufraeumen(
      pool,
      spaeter(ANMELDEVORGANG_GUELTIGKEIT_MS + 1000),
    );

    expect(entfernt).toBe(1);
  });
});
