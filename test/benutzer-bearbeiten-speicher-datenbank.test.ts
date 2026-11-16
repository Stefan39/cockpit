/**
 * Konten bearbeiten in der Datenbank (COPI-46): jede Änderung mit Protokolleintrag in derselben Transaktion, und die
 * Prüfung an der gesperrten Zeile — was dann nicht mehr erlaubt ist, ändert nichts. Dazu, was die Datenbank selbst
 * schützt: den Betreuer.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit."user"` und `cockpit.einladung` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { faktorZuruecksetzen, kontoEntfernen, nameAendern, rolleAendern, type Handelnder } from '../src/auth/benutzer-bearbeiten-speicher.js';
import { wiederherstellungPruefen } from '../src/auth/entsperrung.js';
import { kontenLoeschen, protokollMarke, protokollSchreibenScheitern, protokollSeit, wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

/** Darf alles: so zeigt sich, was die Datenbank selbst noch schützt. */
const ALLES: Handelnder = { id: 'handelnder-1', erlaubt: () => true };
const NICHTS: Handelnder = { id: 'handelnder-1', erlaubt: () => false };

describe.skipIf(!datenbankUrl)('Konten bearbeiten in der Datenbank (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function konto(id: string, rolle: string, aktiviert = true): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", rolle, aktiviert_am)
       VALUES ($1, $1, $1 || '@example.org', true, now(), now(), $2, ${aktiviert ? 'now()' : 'NULL'})`,
      [id, rolle],
    );
    await pool.query(
      `INSERT INTO cockpit.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       VALUES ($1 || '-konto', $1, 'credential', $1, 'altes-passwort', now(), now())`,
      [id],
    );
  }

  async function zeile(id: string): Promise<{ name: string; rolle: string } | undefined> {
    const ergebnis = await pool.query<{ name: string; rolle: string }>('SELECT name, rolle FROM cockpit."user" WHERE id = $1', [id]);
    return ergebnis.rows[0];
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await konto('betreuer-1', 'betreuer');
    await konto('admin-1', 'betriebs_admin');
    await konto('mitarbeiter-1', 'betrieb_mitarbeiter');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('Name ändern', () => {
    it('setzt den Namen und protokolliert, wer an wem — ohne den Namen', async () => {
      const marke = await protokollMarke(pool);

      const ergebnis = await nameAendern(pool, 'mitarbeiter-1', 'Anna Neu', ALLES);

      expect(ergebnis).toEqual({ ok: true, wert: undefined });
      expect((await zeile('mitarbeiter-1'))?.name).toBe('Anna Neu');
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'name_geaendert', akteur: 'handelnder-1', ziel: 'mitarbeiter-1', einzelheiten: {} },
      ]);
    });

    it('ändert nichts, wenn es nicht erlaubt ist, und nichts an einem unbekannten Konto', async () => {
      const marke = await protokollMarke(pool);

      expect(await nameAendern(pool, 'mitarbeiter-1', 'Anna Neu', NICHTS)).toEqual({ ok: false, grund: 'verboten' });
      expect(await nameAendern(pool, 'gibt-es-nicht', 'Anna Neu', ALLES)).toEqual({ ok: false, grund: 'unbekannt' });
      expect((await zeile('mitarbeiter-1'))?.name).toBe('mitarbeiter-1');
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('lässt den Namen stehen, wenn der Protokolleintrag scheitert: beides oder keins', async () => {
      const entfernen = await protokollSchreibenScheitern(pool, 'name_geaendert');
      try {
        await expect(nameAendern(pool, 'mitarbeiter-1', 'Anna Neu', ALLES)).rejects.toThrow();
      } finally {
        await entfernen();
      }
      expect((await zeile('mitarbeiter-1'))?.name).toBe('mitarbeiter-1');
    });
  });

  describe('Rolle ändern', () => {
    it('wechselt die Rolle und protokolliert von welcher zu welcher', async () => {
      const marke = await protokollMarke(pool);

      await rolleAendern(pool, 'mitarbeiter-1', 'betriebs_admin', ALLES);

      expect((await zeile('mitarbeiter-1'))?.rolle).toBe('betriebs_admin');
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'rolle_geaendert', akteur: 'handelnder-1', ziel: 'mitarbeiter-1', einzelheiten: { von: 'betrieb_mitarbeiter', an: 'betriebs_admin' } },
      ]);
    });

    it('prüft an der Rolle, die jetzt in der Datenbank steht, nicht an der von vorhin', async () => {
      // Die Seite zeigte einen Mitarbeiter; inzwischen ist er Admin geworden, und das darf dieser Handelnde nicht.
      const nurMitarbeiter: Handelnder = { id: 'admin-1', erlaubt: (ziel) => ziel.rolle === 'betrieb_mitarbeiter' };
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betriebs_admin' WHERE id = 'mitarbeiter-1'`);

      const ergebnis = await nameAendern(pool, 'mitarbeiter-1', 'Anna Neu', nurMitarbeiter);

      expect(ergebnis).toEqual({ ok: false, grund: 'verboten' });
    });

    it('lässt den aktivierten Betreuer nicht herabstufen, selbst wenn die Anwendung es erlaubte: die Datenbank hält', async () => {
      await expect(rolleAendern(pool, 'betreuer-1', 'betrieb_mitarbeiter', ALLES)).rejects.toThrow(/betreuer_bleibt_bestehen/);
      expect((await zeile('betreuer-1'))?.rolle).toBe('betreuer');
    });
  });

  describe('Konto entfernen', () => {
    it('markiert das Konto als gelöscht, statt es zu löschen: Zugang entwertet, Adresse frei, alles bleibt im Bestand', async () => {
      await pool.query(
        `INSERT INTO cockpit.session (id, "expiresAt", token, "updatedAt", "userId") VALUES ('s1', now() + interval '1 day', 't1', now(), 'mitarbeiter-1')`,
      );
      await pool.query(
        `INSERT INTO cockpit.einladung (email, token_hash, eingeladen_von, ablauf_am) VALUES ('neu@example.org', $1, 'mitarbeiter-1', now() + interval '1 hour')`,
        ['ab'.repeat(32)],
      );
      const marke = await protokollMarke(pool);

      const ergebnis = await kontoEntfernen(pool, 'mitarbeiter-1', ALLES);

      expect(ergebnis).toEqual({ ok: true, wert: undefined });
      const konto = await pool.query(
        `SELECT name, rolle, email, geloescht_email, geloescht_von, geloescht_am IS NOT NULL AS geloescht FROM cockpit."user" WHERE id = 'mitarbeiter-1'`,
      );
      expect(konto.rows).toEqual([
        {
          name: 'mitarbeiter-1',
          rolle: 'betrieb_mitarbeiter',
          email: 'geloescht-mitarbeiter-1@geloescht.invalid',
          geloescht_email: 'mitarbeiter-1@example.org',
          geloescht_von: 'handelnder-1',
          geloescht: true,
        },
      ]);
      const passwort = await pool.query<{ password: string }>(`SELECT password FROM cockpit.account WHERE "userId" = 'mitarbeiter-1'`);
      expect(passwort.rows[0]?.password).toMatch(/^\$argon2id\$/);
      const sitzungen = await pool.query(`SELECT 1 FROM cockpit.session WHERE "userId" = 'mitarbeiter-1'`);
      expect(sitzungen.rowCount).toBe(0);
      // Einladungen, die das Konto verschickt hat, bleiben gültig und nennen es weiter.
      const einladung = await pool.query<{ eingeladen_von: string | null; verbraucht_am: Date | null }>(
        `SELECT eingeladen_von, verbraucht_am FROM cockpit.einladung WHERE email = 'neu@example.org'`,
      );
      expect(einladung.rows[0]).toEqual({ eingeladen_von: 'mitarbeiter-1', verbraucht_am: null });
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'konto_entfernt', akteur: 'handelnder-1', ziel: 'mitarbeiter-1', einzelheiten: { rolle: 'betrieb_mitarbeiter' } },
      ]);
    });

    it('kennt ein als gelöscht markiertes Konto danach nicht mehr — kein zweites Entfernen, kein Bearbeiten', async () => {
      await kontoEntfernen(pool, 'mitarbeiter-1', ALLES);
      const marke = await protokollMarke(pool);

      expect(await kontoEntfernen(pool, 'mitarbeiter-1', ALLES)).toEqual({ ok: false, grund: 'unbekannt' });
      expect(await nameAendern(pool, 'mitarbeiter-1', 'Wieder da', ALLES)).toEqual({ ok: false, grund: 'unbekannt' });
      expect(await faktorZuruecksetzen(pool, 'mitarbeiter-1', ALLES, new Date())).toEqual({ ok: false, grund: 'unbekannt' });
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('lässt die Markierung nicht zurücknehmen und das Konto nicht physisch löschen (Datenbank)', async () => {
      await kontoEntfernen(pool, 'mitarbeiter-1', ALLES);

      await expect(
        pool.query(`UPDATE cockpit."user" SET geloescht_am = NULL, geloescht_von = NULL, geloescht_email = NULL WHERE id = 'mitarbeiter-1'`),
      ).rejects.toThrow('konto_geloescht_endgueltig');
      await expect(wieImBetrieb(pool, `DELETE FROM cockpit."user" WHERE id = 'admin-1'`)).rejects.toThrow('nie_loeschen: In user');
    });

    it('lässt den aktivierten Betreuer nicht löschen, selbst wenn die Anwendung es erlaubte', async () => {
      const marke = await protokollMarke(pool);

      await expect(kontoEntfernen(pool, 'betreuer-1', ALLES)).rejects.toThrow(/konto_betreuer_nicht_loeschen/);

      expect(await zeile('betreuer-1')).toBeDefined();
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('ändert nichts, wenn es nicht erlaubt ist', async () => {
      expect(await kontoEntfernen(pool, 'mitarbeiter-1', NICHTS)).toEqual({ ok: false, grund: 'verboten' });
      expect(await zeile('mitarbeiter-1')).toBeDefined();
    });
  });

  describe('zweiten Faktor zurücksetzen', () => {
    it('entsperrt wie COPI-28, protokolliert Handelnden und Weg, und der Link öffnet die Wiederherstellung', async () => {
      await pool.query(
        `INSERT INTO cockpit.session (id, "expiresAt", token, "updatedAt", "userId") VALUES ('s2', now() + interval '1 day', 't2', now(), 'mitarbeiter-1')`,
      );
      const marke = await protokollMarke(pool);

      const ergebnis = await faktorZuruecksetzen(pool, 'mitarbeiter-1', ALLES, new Date());

      expect(ergebnis.ok).toBe(true);
      const token = ergebnis.ok ? ergebnis.wert.token : '';
      expect(await wiederherstellungPruefen(pool, token)).toMatchObject({ gueltig: true, email: 'mitarbeiter-1@example.org' });
      const passwort = await pool.query<{ password: string }>(`SELECT password FROM cockpit.account WHERE "userId" = 'mitarbeiter-1'`);
      expect(passwort.rows[0]?.password).not.toBe('altes-passwort');
      const sitzungen = await pool.query(`SELECT 1 FROM cockpit.session WHERE "userId" = 'mitarbeiter-1'`);
      expect(sitzungen.rowCount).toBe(0);
      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'konto_entsperrt',
          akteur: 'handelnder-1',
          ziel: 'mitarbeiter-1',
          einzelheiten: { rolle: 'betrieb_mitarbeiter', weg: 'oberflaeche' },
        },
      ]);
    });

    it('ändert nichts, wenn es nicht erlaubt ist, und kennt kein unbekanntes Konto', async () => {
      const marke = await protokollMarke(pool);

      expect(await faktorZuruecksetzen(pool, 'mitarbeiter-1', NICHTS, new Date())).toEqual({ ok: false, grund: 'verboten' });
      expect(await faktorZuruecksetzen(pool, 'gibt-es-nicht', ALLES, new Date())).toEqual({ ok: false, grund: 'unbekannt' });
      const passwort = await pool.query<{ password: string }>(`SELECT password FROM cockpit.account WHERE "userId" = 'mitarbeiter-1'`);
      expect(passwort.rows[0]?.password).toBe('altes-passwort');
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });
  });
});
