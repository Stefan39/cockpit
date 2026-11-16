/**
 * Die Adressänderung in der Datenbank (COPI-47): beantragen ändert am Konto nichts; erst der eingelöste Link macht die
 * neue Adresse gültig, genau einmal. Belegte Adressen, abgelaufene und entwertete Links ändern nichts.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit."user"` und `cockpit.einladung` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Handelnder } from '../src/auth/benutzer-bearbeiten-speicher.js';
import {
  EMAIL_AENDERUNG_GUELTIGKEIT_MS,
  emailAenderungBeantragen,
  emailLinkEinloesen,
  emailLinkPruefen,
  offeneAenderungLesen,
} from '../src/auth/email-aenderung.js';
import { kontenLoeschen, protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const ALLES: Handelnder = { id: 'handelnder-1', erlaubt: () => true };

describe.skipIf(!datenbankUrl)('Adressänderung in der Datenbank (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function konto(id: string): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", rolle)
       VALUES ($1, $1, $1 || '@example.org', true, now(), now(), 'betrieb_mitarbeiter')`,
      [id],
    );
  }

  async function email(id: string): Promise<string | undefined> {
    const ergebnis = await pool.query<{ email: string }>('SELECT email FROM cockpit."user" WHERE id = $1', [id]);
    return ergebnis.rows[0]?.email;
  }

  /** Beantragt und gibt das Token zurück; scheitert der Antrag, scheitert der Test. */
  async function beantragen(id: string, adresse: string, jetzt = new Date()): Promise<string> {
    const ergebnis = await emailAenderungBeantragen(pool, id, adresse, ALLES, jetzt);
    if (!ergebnis.ok || ergebnis.wert.art !== 'beantragt') {
      throw new Error(`Antrag gescheitert: ${JSON.stringify(ergebnis)}`);
    }
    return ergebnis.wert.token;
  }

  async function einloesen(token: string, jetzt = new Date()) {
    const pruefung = await emailLinkPruefen(pool, token, jetzt);
    return pruefung.gueltig && pruefung.id !== undefined ? emailLinkEinloesen(pool, pruefung.id, jetzt) : { art: 'ungueltig' as const };
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await konto('anna');
    await konto('bernd');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('beantragen', () => {
    it('legt einen Antrag an, protokolliert ohne Adresse und ändert am Konto nichts', async () => {
      const marke = await protokollMarke(pool);

      const ergebnis = await emailAenderungBeantragen(pool, 'anna', '  Anna.Neu@Example.org ', ALLES, new Date());

      expect(ergebnis).toMatchObject({ ok: true, wert: { art: 'beantragt', bisherige: 'anna@example.org' } });
      expect(await email('anna')).toBe('anna@example.org');
      expect(await offeneAenderungLesen(pool, 'anna', new Date())).toMatchObject({ neueEmail: 'anna.neu@example.org' });
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'email_aenderung_beantragt', akteur: 'handelnder-1', ziel: 'anna', einzelheiten: {} },
      ]);
    });

    it('entwertet einen älteren offenen Antrag desselben Kontos', async () => {
      const alt = await beantragen('anna', 'anna.eins@example.org');
      await beantragen('anna', 'anna.zwei@example.org');

      expect(await emailLinkPruefen(pool, alt, new Date())).toEqual({ gueltig: false });
      expect((await offeneAenderungLesen(pool, 'anna', new Date()))?.neueEmail).toBe('anna.zwei@example.org');
    });

    it.each([
      ['die bisherige Adresse', 'anna@example.org', 'gleich'],
      ['die Adresse eines anderen Kontos', 'BERND@example.org', 'konto'],
    ])('weist %s ab, ohne etwas zu schreiben', async (_name, adresse, grund) => {
      const marke = await protokollMarke(pool);

      const ergebnis = await emailAenderungBeantragen(pool, 'anna', adresse, ALLES, new Date());

      expect(ergebnis).toEqual({ ok: true, wert: { art: 'belegt', grund } });
      expect(await offeneAenderungLesen(pool, 'anna', new Date())).toBeUndefined();
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('weist eine Adresse mit offener Einladung ab', async () => {
      await pool.query(
        `INSERT INTO cockpit.einladung (email, token_hash, ablauf_am) VALUES ('neu@example.org', $1, now() + interval '1 hour')`,
        ['ab'.repeat(32)],
      );

      expect(await emailAenderungBeantragen(pool, 'anna', 'neu@example.org', ALLES, new Date())).toEqual({
        ok: true,
        wert: { art: 'belegt', grund: 'einladung' },
      });
    });

    it('weist eine Adresse ab, die ein anderes Konto schon beantragt hat — bis dessen Antrag abgelaufen ist', async () => {
      await beantragen('bernd', 'neu@example.org');

      expect(await emailAenderungBeantragen(pool, 'anna', 'neu@example.org', ALLES, new Date())).toEqual({
        ok: true,
        wert: { art: 'belegt', grund: 'aenderung' },
      });
      const spaeter = new Date(Date.now() + EMAIL_AENDERUNG_GUELTIGKEIT_MS + 60_000);
      expect(await emailAenderungBeantragen(pool, 'anna', 'neu@example.org', ALLES, spaeter)).toMatchObject({ ok: true, wert: { art: 'beantragt' } });
    });

    it('ändert nichts, wenn es nicht erlaubt ist', async () => {
      const ergebnis = await emailAenderungBeantragen(pool, 'anna', 'anna.neu@example.org', { id: 'x', erlaubt: () => false }, new Date());

      expect(ergebnis).toEqual({ ok: false, grund: 'verboten' });
      expect(await offeneAenderungLesen(pool, 'anna', new Date())).toBeUndefined();
    });
  });

  describe('einlösen', () => {
    it('macht die neue Adresse gültig, genau einmal, und protokolliert es', async () => {
      const token = await beantragen('anna', 'anna.neu@example.org');
      const marke = await protokollMarke(pool);

      expect(await einloesen(token)).toEqual({ art: 'geaendert', neueEmail: 'anna.neu@example.org' });
      expect(await einloesen(token)).toEqual({ art: 'ungueltig' });

      expect(await email('anna')).toBe('anna.neu@example.org');
      expect(await offeneAenderungLesen(pool, 'anna', new Date())).toBeUndefined();
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'email_geaendert', akteur: 'email_bestaetigung', ziel: 'anna', einzelheiten: {} },
      ]);
    });

    it('lässt von zwei gleichzeitigen Einlösungen genau eine wirken', async () => {
      const token = await beantragen('anna', 'anna.neu@example.org');
      const pruefung = await emailLinkPruefen(pool, token, new Date());
      const id = pruefung.id ?? '';

      const ergebnisse = await Promise.all([emailLinkEinloesen(pool, id, new Date()), emailLinkEinloesen(pool, id, new Date())]);

      expect(ergebnisse.map((ergebnis) => ergebnis.art).sort()).toEqual(['geaendert', 'ungueltig']);
    });

    it('löst einen abgelaufenen Link nicht ein', async () => {
      const token = await beantragen('anna', 'anna.neu@example.org');
      const spaeter = new Date(Date.now() + EMAIL_AENDERUNG_GUELTIGKEIT_MS + 60_000);

      expect(await emailLinkPruefen(pool, token, spaeter)).toEqual({ gueltig: false });
      expect(await einloesen(token, spaeter)).toEqual({ art: 'ungueltig' });
      expect(await email('anna')).toBe('anna@example.org');
    });

    it('kennt ein fremdes Token nicht', async () => {
      await beantragen('anna', 'anna.neu@example.org');

      expect(await emailLinkPruefen(pool, 'A'.repeat(43), new Date())).toEqual({ gueltig: false });
    });

    it('ändert nichts, wenn die Adresse inzwischen ein anderes Konto hat — und der Link bleibt offen', async () => {
      const token = await beantragen('anna', 'anna.neu@example.org');
      await pool.query(`UPDATE cockpit."user" SET email = 'anna.neu@example.org' WHERE id = 'bernd'`);

      expect(await einloesen(token)).toEqual({ art: 'belegt' });
      expect(await email('anna')).toBe('anna@example.org');
      expect((await emailLinkPruefen(pool, token, new Date())).gueltig).toBe(true);
    });

    it('lässt eine Einladung an die neue Adresse verfallen: eine Adresse gehört zu genau einem Konto', async () => {
      const token = await beantragen('anna', 'anna.neu@example.org');
      await pool.query(
        `INSERT INTO cockpit.einladung (email, token_hash, ablauf_am) VALUES ('anna.neu@example.org', $1, now() + interval '1 hour')`,
        ['cd'.repeat(32)],
      );

      await einloesen(token);

      const einladung = await pool.query<{ verbraucht: boolean }>(
        `SELECT verbraucht_am IS NOT NULL AS verbraucht FROM cockpit.einladung WHERE email = 'anna.neu@example.org'`,
      );
      expect(einladung.rows[0]?.verbraucht).toBe(true);
    });

    it('nimmt den Antrag mit, wenn das Konto entfernt wird', async () => {
      const token = await beantragen('anna', 'anna.neu@example.org');
      await pool.query(`DELETE FROM cockpit."user" WHERE id = 'anna'`);

      expect(await emailLinkPruefen(pool, token, new Date())).toEqual({ gueltig: false });
    });
  });
});
