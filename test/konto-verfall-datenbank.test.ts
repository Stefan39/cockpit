/**
 * Verfallsfrist für halbfertige Konten (COPI-17, belastbar gemacht in COPI-18).
 *
 * Läuft nur mit `TEST_DATABASE_URL` (echte PostgreSQL) und räumt dort
 * `cockpit."user"`, `cockpit.einladung` und `cockpit.erststart_token` ab.
 * Niemals gegen eine Kundendatenbank laufen lassen.
 *
 * Jeder Test legt seinen Zustand selbst an (`beforeEach` leert die Tabellen).
 * Grenzfälle laufen gegen einen festen Zeitpunkt statt gegen die Uhr, und die
 * Frist steht hier als Literal: würde der Test die Konstante des Produktiv-
 * codes benutzen, rechnete er eine falsche Frist einfach mit und fiele nie auf.
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  benutzerVorhanden,
  neuesErststartTokenAnlegen,
  tokenPruefen,
} from '../src/auth/erststart-speicher.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import {
  kontoVerfallen,
  verfalleneKontenMarkieren,
} from '../src/auth/konto-verfall.js';
import { buildApp } from '../src/server/app.js';
import { geheimnisAusUri } from '../src/server/routes/zwei-faktor.js';
import {
  formular,
  FORMULAR_KOPF,
  kontenLoeschen,
  kontoEinrichten,
  protokollMarke,
  protokollSchreibenScheitern,
  protokollSeit,
  totpCode,
  type Konto,
} from './hilfen.js';
import { qrAusSeiteLesen } from './qr-lesen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';

const MINUTE = 60 * 1000;
const FRIST_MS = 72 * 60 * MINUTE;
const JETZT = new Date('2026-06-01T12:00:00.000Z');

function erstelltVor(ms: number): Date {
  return new Date(JETZT.getTime() - ms);
}

/** Eine Minute jünger als die Frist: darf noch nicht verfallen. */
const KNAPP_INNERHALB = erstelltVor(FRIST_MS - MINUTE);
/** Eine Minute älter als die Frist: muss verfallen. */
const KNAPP_ABGELAUFEN = erstelltVor(FRIST_MS + MINUTE);

interface NutzerWunsch {
  readonly erstelltAm: Date;
  readonly aktiviertAm?: Date | null;
  readonly zweiterFaktor?: boolean | null;
}

describe.skipIf(!datenbankUrl)('Konto-Verfall nach 72h (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;

  /** Direkt angelegtes Konto — für Fälle, in denen die Zeit genau stimmen muss. */
  async function nutzerAnlegen(id: string, wunsch: NutzerWunsch): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit."user"
              (id, email, name, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled", "aktiviert_am")
       VALUES ($1, $2, $3, true, $4, $4, $5, $6)`,
      [
        id,
        `${id}@example.org`,
        id,
        wunsch.erstelltAm,
        wunsch.zweiterFaktor ?? false,
        wunsch.aktiviertAm ?? null,
      ],
    );
  }

  /** Ein Konto, das gilt — nicht als gelöscht markiert. */
  async function nutzerVorhanden(id: string): Promise<boolean> {
    const ergebnis = await pool.query('SELECT 1 FROM cockpit."user" WHERE id = $1 AND geloescht_am IS NULL', [id]);
    return (ergebnis.rowCount ?? 0) === 1;
  }

  /** Als gelöscht markiert, aber im Bestand (COPI-62): nie physisch gelöscht. */
  async function nutzerMarkiert(id: string): Promise<{ von: string; email: string } | undefined> {
    const ergebnis = await pool.query<{ von: string; email: string }>(
      'SELECT geloescht_von AS von, email FROM cockpit."user" WHERE id = $1 AND geloescht_am IS NOT NULL',
      [id],
    );
    return ergebnis.rows[0];
  }

  async function aktiviertAm(id: string): Promise<Date | null> {
    const ergebnis = await pool.query<{ aktiviert_am: Date | null }>(
      'SELECT "aktiviert_am" FROM cockpit."user" WHERE id = $1',
      [id],
    );
    return ergebnis.rows[0]?.aktiviert_am ?? null;
  }

  async function zeilenJeKonto(
    tabelle: 'session' | 'account' | '"twoFactor"',
    benutzerId: string,
  ): Promise<number> {
    const ergebnis = await pool.query<{ anzahl: number }>(
      `SELECT count(*)::int AS anzahl FROM cockpit.${tabelle} WHERE "userId" = $1`,
      [benutzerId],
    );
    return ergebnis.rows[0]?.anzahl ?? 0;
  }

  async function zweitenFaktorBeginnen(konto: Konto) {
    return app.inject({
      method: 'POST',
      url: '/zwei-faktor/einrichten',
      headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
      payload: formular({ passwort: PASSWORT }),
    });
  }

  async function codePruefen(konto: Konto, code: string) {
    return app.inject({
      method: 'POST',
      url: '/zwei-faktor/pruefen',
      headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
      payload: formular({ code }),
    });
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool });
  }, 60_000);

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.einladung');
    await pool.query('DELETE FROM cockpit.erststart_token');
    await kontenLoeschen(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('kontoVerfallen', () => {
    it('lässt ein nie aktiviertes Konto eine Minute vor Fristende stehen', async () => {
      await nutzerAnlegen('knapp-innen', { erstelltAm: KNAPP_INNERHALB });

      expect(await kontoVerfallen(pool, 'knapp-innen@example.org', JETZT)).toBe(false);
    });

    it('erkennt ein nie aktiviertes Konto eine Minute nach Fristende', async () => {
      await nutzerAnlegen('knapp-abgelaufen', { erstelltAm: KNAPP_ABGELAUFEN });

      expect(await kontoVerfallen(pool, 'knapp-abgelaufen@example.org', JETZT)).toBe(true);
    });

    it('lässt ein aktiviertes Konto stehen, auch wenn der Faktor abgeschaltet ist', async () => {
      await nutzerAnlegen('aktiviert', {
        erstelltAm: erstelltVor(100 * 60 * MINUTE),
        aktiviertAm: erstelltVor(99 * 60 * MINUTE),
        zweiterFaktor: false,
      });

      expect(await kontoVerfallen(pool, 'aktiviert@example.org', JETZT)).toBe(false);
    });

    it('kennt keine Adresse ohne Konto', async () => {
      expect(await kontoVerfallen(pool, 'gibt-es-nicht@example.org', JETZT)).toBe(false);
    });
  });

  describe('Aktivierung über die Einrichtungsseiten', () => {
    it('setzt aktiviert_am erst mit dem bestätigten Code', async () => {
      const konto = await kontoEinrichten(app, auth, {
        email: 'einrichtung@example.org',
        passwort: PASSWORT,
        name: 'Einrichtung',
        mitZweitemFaktor: false,
      });
      expect(await aktiviertAm(konto.id)).toBeNull();

      const einrichten = await zweitenFaktorBeginnen(konto);
      expect(einrichten.statusCode).toBe(200);
      expect(await aktiviertAm(konto.id)).toBeNull();

      const falsch = await codePruefen(konto, '000000');
      expect(falsch.statusCode).toBe(400);
      expect(await aktiviertAm(konto.id)).toBeNull();

      const geheimnis = geheimnisAusUri(qrAusSeiteLesen(einrichten.body));
      const richtig = await codePruefen(konto, await totpCode(auth, geheimnis));
      expect(richtig.statusCode).toBe(303);
      const gesetzt = await aktiviertAm(konto.id);
      expect(gesetzt).not.toBeNull();
      expect(Math.abs((gesetzt?.getTime() ?? 0) - Date.now())).toBeLessThan(5 * MINUTE);
    });
  });

  describe('Aktivierung über jeden Weg (COPI-19)', () => {
    /**
     * Der Better-Auth-Handler direkt: dieselbe Antwort wie der rohe Endpunkt
     * `/api/auth/two-factor/verify-totp`, aber am Tor vorbei. So bleibt der Test
     * gültig, auch wenn das Tor den HTTP-Pfad später schließt.
     */
    async function rohVerifizieren(konto: Konto, code: string): Promise<Response> {
      return auth.handler(
        new Request(`${BASIS_URL}/api/auth/two-factor/verify-totp`, {
          method: 'POST',
          headers: {
            cookie: konto.cookie,
            origin: BASIS_URL,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ code }),
        }),
      );
    }

    it('setzt aktiviert_am auch, wenn der Faktor am Formular vorbei bestätigt wird', async () => {
      const konto = await kontoEinrichten(app, auth, {
        email: 'roh@example.org',
        passwort: PASSWORT,
        name: 'Roh',
        mitZweitemFaktor: false,
      });
      const einrichten = await zweitenFaktorBeginnen(konto);
      const geheimnis = geheimnisAusUri(qrAusSeiteLesen(einrichten.body));

      const antwort = await rohVerifizieren(konto, await totpCode(auth, geheimnis));

      expect(antwort.status).toBe(200);
      const zeile = await pool.query<{ aktiv: boolean | null }>(
        'SELECT "twoFactorEnabled" AS aktiv FROM cockpit."user" WHERE id = $1',
        [konto.id],
      );
      expect(zeile.rows[0]?.aktiv).toBe(true);
      expect(await aktiviertAm(konto.id)).not.toBeNull();

      // Folge: Das voll eingerichtete Konto verfällt auch mit alter Anlage nicht.
      await pool.query('UPDATE cockpit."user" SET "createdAt" = $2 WHERE id = $1', [
        konto.id,
        KNAPP_ABGELAUFEN,
      ]);
      expect(await verfalleneKontenMarkieren(pool, JETZT)).toBe(0);
      expect(await nutzerVorhanden(konto.id)).toBe(true);
    });

    it('setzt aktiviert_am, sobald ein Update den Faktor einschaltet', async () => {
      await nutzerAnlegen('direkt', { erstelltAm: KNAPP_INNERHALB, zweiterFaktor: false });
      expect(await aktiviertAm('direkt')).toBeNull();

      await pool.query('UPDATE cockpit."user" SET "twoFactorEnabled" = true WHERE id = $1', [
        'direkt',
      ]);

      const gesetzt = await aktiviertAm('direkt');
      expect(gesetzt).not.toBeNull();
      expect(Math.abs((gesetzt?.getTime() ?? 0) - Date.now())).toBeLessThan(5 * MINUTE);
    });

    it('lässt aktiviert_am leer, solange der Faktor nicht eingeschaltet ist', async () => {
      await nutzerAnlegen('aus', { erstelltAm: KNAPP_INNERHALB, zweiterFaktor: false });
      await nutzerAnlegen('unbekannt', { erstelltAm: KNAPP_INNERHALB, zweiterFaktor: null });

      await pool.query(`UPDATE cockpit."user" SET name = 'geaendert'`);
      await pool.query('UPDATE cockpit."user" SET "twoFactorEnabled" = false WHERE id = $1', ['aus']);

      expect(await aktiviertAm('aus')).toBeNull();
      expect(await aktiviertAm('unbekannt')).toBeNull();
    });

    it('überschreibt ein vorhandenes aktiviert_am nie', async () => {
      const fest = erstelltVor(10 * 60 * MINUTE);
      await nutzerAnlegen('fest', {
        erstelltAm: erstelltVor(20 * 60 * MINUTE),
        aktiviertAm: fest,
        zweiterFaktor: false,
      });

      for (const wert of [true, false, true]) {
        await pool.query('UPDATE cockpit."user" SET "twoFactorEnabled" = $2 WHERE id = $1', [
          'fest',
          wert,
        ]);
      }

      expect((await aktiviertAm('fest'))?.getTime()).toBe(fest.getTime());
    });

    it('leert aktiviert_am nicht, wenn der Faktor abgeschaltet wird', async () => {
      const fest = erstelltVor(10 * 60 * MINUTE);
      await nutzerAnlegen('abgeschaltet', {
        erstelltAm: erstelltVor(20 * 60 * MINUTE),
        aktiviertAm: fest,
        zweiterFaktor: true,
      });

      await pool.query('UPDATE cockpit."user" SET "twoFactorEnabled" = false WHERE id = $1', [
        'abgeschaltet',
      ]);

      expect((await aktiviertAm('abgeschaltet'))?.getTime()).toBe(fest.getTime());
    });
  });

  describe('Migration 0007 — Reparatur', () => {
    /** Die Reparatur-Anweisung aus der ausgelieferten Migration, nicht eine Kopie. */
    async function reparatur(): Promise<string> {
      const sql = await readFile('db/migrations/0007_konto_aktivierung.up.sql', 'utf8');
      const start = sql.indexOf('UPDATE "cockpit"."user"');
      expect(start).toBeGreaterThan(-1);
      return sql.slice(start, sql.indexOf(';', start) + 1);
    }

    it('markiert Konten mit aktivem Faktor ohne Aktivierung und sonst keines', async () => {
      // Direkt angelegt: der Trigger greift nur bei UPDATE, so entsteht der
      // Zustand, den `0006` bei einer Aktivierung am Formular vorbei hinterlassen hat.
      const fest = erstelltVor(10 * 60 * MINUTE);
      const alt = erstelltVor(200 * 60 * MINUTE);
      await nutzerAnlegen('betroffen', { erstelltAm: alt, zweiterFaktor: true });
      await nutzerAnlegen('ohne-faktor', { erstelltAm: alt, zweiterFaktor: false });
      await nutzerAnlegen('faktor-unbekannt', { erstelltAm: alt, zweiterFaktor: null });
      await nutzerAnlegen('schon-markiert', { erstelltAm: alt, zweiterFaktor: true, aktiviertAm: fest });

      await pool.query(await reparatur());

      expect(await aktiviertAm('betroffen')).not.toBeNull();
      expect(await aktiviertAm('ohne-faktor')).toBeNull();
      expect(await aktiviertAm('faktor-unbekannt')).toBeNull();
      expect((await aktiviertAm('schon-markiert'))?.getTime()).toBe(fest.getTime());
    });
  });

  describe('verfalleneKontenMarkieren', () => {
    it('markiert genau die Konten jenseits der Frist als gelöscht — sie bleiben im Bestand', async () => {
      await nutzerAnlegen('bleibt', { erstelltAm: KNAPP_INNERHALB });
      await nutzerAnlegen('geht', { erstelltAm: KNAPP_ABGELAUFEN });

      expect(await verfalleneKontenMarkieren(pool, JETZT)).toBe(1);

      expect(await nutzerVorhanden('bleibt')).toBe(true);
      expect(await nutzerVorhanden('geht')).toBe(false);
      expect(await nutzerMarkiert('geht')).toEqual({ von: 'system', email: 'geloescht-geht@geloescht.invalid' });
      // Kein zweites Mal: ein markiertes Konto verfällt nicht noch einmal.
      expect(await verfalleneKontenMarkieren(pool, JETZT)).toBe(0);
    });

    it('meldet null bei leerem Bestand', async () => {
      expect(await verfalleneKontenMarkieren(pool, JETZT)).toBe(0);
    });

    it('löscht ein aktiviertes Konto nie — auch nicht nach abgeschaltetem Faktor', async () => {
      // Der echte Weg: TOTP einrichten und bestätigen, danach den Faktor
      // abschalten, wie es `/api/auth/two-factor/disable` täte.
      const konto = await kontoEinrichten(app, auth, {
        email: 'regression@example.org',
        passwort: PASSWORT,
        name: 'Regression',
        mitZweitemFaktor: true,
      });
      expect(await aktiviertAm(konto.id)).not.toBeNull();
      await pool.query(
        'UPDATE cockpit."user" SET "twoFactorEnabled" = false, "createdAt" = $2 WHERE id = $1',
        [konto.id, erstelltVor(2 * FRIST_MS)],
      );

      expect(await verfalleneKontenMarkieren(pool, JETZT)).toBe(0);

      expect(await nutzerVorhanden(konto.id)).toBe(true);
      expect(await kontoVerfallen(pool, 'regression@example.org', JETZT)).toBe(false);
    });

    it('entwertet jeden Zugang: Sitzungen und Vorgänge weg, Faktor archiviert, Passwort ohne Urbild', async () => {
      // Halbfertiges Konto: Passwort gesetzt, Einrichtung begonnen, nie bestätigt.
      const konto = await kontoEinrichten(app, auth, {
        email: 'kaskade@example.org',
        passwort: PASSWORT,
        name: 'Kaskade',
        mitZweitemFaktor: false,
      });
      await zweitenFaktorBeginnen(konto);
      await pool.query(
        `INSERT INTO cockpit.anmeldevorgang (kennung_hash, benutzer_id, ablauf_am)
              VALUES ('kaskade-hash', $1, $2)`,
        [konto.id, new Date(JETZT.getTime() + 10 * MINUTE)],
      );
      await pool.query('UPDATE cockpit."user" SET "createdAt" = $2 WHERE id = $1', [
        konto.id,
        KNAPP_ABGELAUFEN,
      ]);
      expect(await zeilenJeKonto('session', konto.id)).toBeGreaterThan(0);
      expect(await zeilenJeKonto('account', konto.id)).toBeGreaterThan(0);
      expect(await zeilenJeKonto('"twoFactor"', konto.id)).toBeGreaterThan(0);

      expect(await verfalleneKontenMarkieren(pool, JETZT)).toBe(1);

      expect(await nutzerVorhanden(konto.id)).toBe(false);
      expect(await nutzerMarkiert(konto.id)).toBeDefined();
      expect(await zeilenJeKonto('session', konto.id)).toBe(0);
      expect(await zeilenJeKonto('"twoFactor"', konto.id)).toBe(0);
      const archiv = await pool.query('SELECT art FROM cockpit.zugangsmittel_archiv WHERE benutzer_id = $1', [konto.id]);
      expect(archiv.rows).toEqual([{ art: 'totp' }]);
      // Die Zeile bleibt, das Passwort öffnet nichts mehr.
      await expect(auth.api.signInEmail({ body: { email: 'kaskade@example.org', password: PASSWORT } })).rejects.toThrow();
      const vorgaenge = await pool.query(
        'SELECT 1 FROM cockpit.anmeldevorgang WHERE benutzer_id = $1',
        [konto.id],
      );
      expect(vorgaenge.rowCount).toBe(0);
    });

    it('lässt die Einladungshistorie stehen, samt `eingeladen_von`', async () => {
      await nutzerAnlegen('einlader', { erstelltAm: KNAPP_ABGELAUFEN });
      await pool.query(
        `INSERT INTO cockpit.einladung (email, token_hash, eingeladen_von, ablauf_am)
              VALUES ('gast@example.org', 'einladung-hash', 'einlader', $1)`,
        [new Date(JETZT.getTime() + 60 * MINUTE)],
      );

      await verfalleneKontenMarkieren(pool, JETZT);

      const zeile = await pool.query<{ eingeladen_von: string | null }>(
        `SELECT eingeladen_von FROM cockpit.einladung WHERE email = 'gast@example.org'`,
      );
      expect(zeile.rowCount).toBe(1);
      expect(zeile.rows[0]?.eingeladen_von).toBe('einlader');
    });

    it('hält jedes verfallene Konto genau einmal fest', async () => {
      await nutzerAnlegen('bleibt', { erstelltAm: KNAPP_INNERHALB });
      await nutzerAnlegen('geht-1', { erstelltAm: KNAPP_ABGELAUFEN });
      await nutzerAnlegen('geht-2', { erstelltAm: KNAPP_ABGELAUFEN });
      const marke = await protokollMarke(pool);

      expect(await verfalleneKontenMarkieren(pool, JETZT)).toBe(2);

      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege.map((zeile) => zeile.ziel).sort()).toEqual(['geht-1', 'geht-2']);
      for (const eintrag of eintraege) {
        expect(eintrag).toMatchObject({ art: 'konto_verfallen', akteur: 'system', einzelheiten: {} });
      }
      expect(await nutzerVorhanden('geht-1')).toBe(false);
    });

    it('schreibt nichts, wenn kein Konto verfällt', async () => {
      await nutzerAnlegen('bleibt', { erstelltAm: KNAPP_INNERHALB });
      await nutzerAnlegen('aktiviert', {
        erstelltAm: erstelltVor(500 * 60 * MINUTE),
        aktiviertAm: erstelltVor(499 * 60 * MINUTE),
        zweiterFaktor: true,
      });
      const marke = await protokollMarke(pool);

      expect(await verfalleneKontenMarkieren(pool, JETZT)).toBe(0);

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('hält bei zwei gleichzeitigen Läufen jedes Konto genau einmal fest', async () => {
      for (let i = 0; i < 5; i += 1) {
        await nutzerAnlegen(`protokoll-parallel-${i}`, { erstelltAm: KNAPP_ABGELAUFEN });
      }
      const marke = await protokollMarke(pool);

      await Promise.all([
        verfalleneKontenMarkieren(pool, JETZT),
        verfalleneKontenMarkieren(pool, JETZT),
      ]);

      const ziele = (await protokollSeit(pool, marke)).map((zeile) => zeile.ziel).sort();
      expect(ziele).toEqual([0, 1, 2, 3, 4].map((i) => `protokoll-parallel-${String(i)}`));
    });

    it('nimmt das Markieren zurück, wenn der Eintrag scheitert: beides gilt oder keins', async () => {
      await nutzerAnlegen('haelt', { erstelltAm: KNAPP_ABGELAUFEN });
      const marke = await protokollMarke(pool);
      const aufraeumen = await protokollSchreibenScheitern(pool, 'konto_verfallen');
      try {
        await expect(verfalleneKontenMarkieren(pool, JETZT)).rejects.toThrow(
          /test_protokoll_scheitert_konto_verfallen/,
        );
      } finally {
        await aufraeumen();
      }

      expect(await nutzerVorhanden('haelt')).toBe(true);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('richtet bei zwei gleichzeitigen Läufen keinen Schaden an', async () => {
      for (let i = 0; i < 5; i += 1) {
        await nutzerAnlegen(`parallel-${i}`, { erstelltAm: KNAPP_ABGELAUFEN });
      }
      await nutzerAnlegen('unbeteiligt', { erstelltAm: KNAPP_INNERHALB });

      const [erster, zweiter] = await Promise.all([
        verfalleneKontenMarkieren(pool, JETZT),
        verfalleneKontenMarkieren(pool, JETZT),
      ]);

      expect(erster + zweiter).toBe(5);
      expect(await nutzerVorhanden('unbeteiligt')).toBe(true);
      for (let i = 0; i < 5; i += 1) {
        expect(await nutzerVorhanden(`parallel-${i}`)).toBe(false);
      }
    });
  });

  describe('Migration 0006 — Bestandskonten', () => {
    /** Die UPDATE-Anweisung aus der ausgelieferten Migration, nicht eine Kopie. */
    async function bestandsUpdate(): Promise<string> {
      const sql = await readFile('db/migrations/0006_konto_verfall.up.sql', 'utf8');
      const start = sql.lastIndexOf('UPDATE "cockpit"."user"');
      expect(start).toBeGreaterThan(-1);
      return sql.slice(start);
    }

    it('markiert Konten mit aktivem zweitem Faktor als aktiviert und sonst keines', async () => {
      // Zustand vor der Migration: die Spalte gibt es (die Test-Datenbank ist
      // migriert), sie ist aber überall leer.
      await nutzerAnlegen('mit-faktor', { erstelltAm: erstelltVor(200 * 60 * MINUTE), zweiterFaktor: true });
      await nutzerAnlegen('ohne-faktor', { erstelltAm: erstelltVor(200 * 60 * MINUTE), zweiterFaktor: false });
      await nutzerAnlegen('faktor-unbekannt', { erstelltAm: erstelltVor(200 * 60 * MINUTE), zweiterFaktor: null });

      await pool.query(await bestandsUpdate());

      expect(await aktiviertAm('mit-faktor')).not.toBeNull();
      expect(await aktiviertAm('ohne-faktor')).toBeNull();
      expect(await aktiviertAm('faktor-unbekannt')).toBeNull();
    });
  });

  describe('Letztes Konto verfällt', () => {
    it('lässt danach ein neues, gültiges Erststart-Token zu', async () => {
      // Lage nach einem abgebrochenen Erststart: das Token ist verbraucht, das
      // einzige Konto hat den zweiten Faktor nie eingerichtet.
      await nutzerAnlegen('einziges', { erstelltAm: KNAPP_ABGELAUFEN });
      const frueheres = await neuesErststartTokenAnlegen(pool, JETZT);
      await pool.query('UPDATE cockpit.erststart_token SET verbraucht_am = now()');

      expect(await verfalleneKontenMarkieren(pool, JETZT)).toBe(1);
      expect(await benutzerVorhanden(pool)).toBe(false);

      const neues = await neuesErststartTokenAnlegen(pool, JETZT);
      expect(await tokenPruefen(pool, neues.token, JETZT)).toEqual({
        gueltig: true,
        id: expect.any(String) as unknown,
      });
      expect(await tokenPruefen(pool, frueheres.token, JETZT)).toEqual({ gueltig: false });
      const offene = await pool.query<{ anzahl: number }>(
        'SELECT count(*)::int AS anzahl FROM cockpit.erststart_token WHERE verbraucht_am IS NULL',
      );
      expect(offene.rows[0]?.anzahl).toBe(1);
    });
  });
});
