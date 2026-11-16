/**
 * Die Anmeldung mit zweitem Faktor gegen eine echte PostgreSQL (COPI-13).
 * Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * ACHTUNG: Der Test räumt die Tabellen `cockpit."user"`,
 * `cockpit.anmeldeversuch` und `cockpit.anmeldevorgang` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 *
 * Schwerpunkt sind die negativen Fälle: keine Sitzung ohne Code, keine
 * unterscheidbare Antwort zwischen falschem Passwort und unbekannter Adresse,
 * und eine Sperre, die auch mit richtigem Passwort nicht nachgibt.
 *
 * Die Zeit der eigenen Zähler ist über `jetzt` verschiebbar (kein `sleep`);
 * TOTP und der `two_factor`-Cookie von Better Auth laufen weiter auf der
 * echten Uhr, deshalb verschieben nur die Sperr-Tests die Zeit.
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { buildApp } from '../src/server/app.js';
import { kennungHash, sperrePruefen } from '../src/auth/ratenbegrenzung.js';
import { ANMELDEVORGANG_COOKIE_NAME, cookieLesen } from '../src/auth/anmeldevorgang.js';
import { SITZUNGS_COOKIE_NAME } from '../src/auth/konfiguration.js';
import {
  cookieKopf,
  formular,
  FORMULAR_KOPF,
  kontenLoeschen,
  kontoEinrichten,
  protokollMarke,
  protokollSeit,
  totpCode,
  type Konto,
} from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';
const FALSCHES_PASSWORT = 'ein-ausreichend-langes-falsches';
const MIT_FAKTOR = 'mit-faktor@example.org';
const OHNE_FAKTOR = 'ohne-faktor@example.org';
const UNBEKANNT = 'gibt-es-nicht@example.org';

const MINUTE = 60 * 1000;

describe.skipIf(!datenbankUrl)('Anmeldung gegen echte Datenbank', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let mitFaktor: Konto;
  let ohneFaktor: Konto;
  let versatzMs = 0;

  /** Erster Schritt: Passwort. Liefert die Antwort unverändert zurück. */
  async function passwortSchritt(
    email: string,
    passwort: string,
    kopf: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/anmelden',
      headers: { ...FORMULAR_KOPF, ...kopf },
      payload: formular({ email, passwort }),
    });
  }

  /** Zweiter Schritt: Code, mit den Cookies aus dem ersten Schritt. */
  async function codeSchritt(cookie: string, code: string) {
    return app.inject({
      method: 'POST',
      url: '/anmelden/code',
      headers: { ...FORMULAR_KOPF, cookie },
      payload: formular({ code }),
    });
  }

  /** Vollständige Anmeldung; liefert den Cookie-Kopf der neuen Sitzung. */
  async function anmelden(): Promise<string> {
    const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
    expect(schritt1.statusCode).toBe(303);
    const zwischen = cookieKopf(schritt1.headers['set-cookie']);
    const schritt2 = await codeSchritt(zwischen, await totpCode(auth, mitFaktor.geheimnis));
    expect(schritt2.statusCode).toBe(303);
    return cookieKopf(schritt2.headers['set-cookie']);
  }

  async function wurzelseite(cookie: string) {
    return app.inject({ method: 'GET', url: '/', headers: { cookie } });
  }

  async function sitzungenZaehlen(): Promise<number> {
    const ergebnis = await pool.query<{ anzahl: string }>(
      'SELECT count(*)::text AS anzahl FROM cockpit.session WHERE "userId" = $1',
      [mitFaktor.id],
    );
    return Number(ergebnis.rows[0]?.anzahl ?? '0');
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await kontenLoeschen(pool);
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    app = buildApp(
      { nodeEnv: 'test' },
      { auth, pool, basisUrl: BASIS_URL, jetzt: () => new Date(Date.now() + versatzMs) },
    );

    mitFaktor = await kontoEinrichten(app, auth, {
      email: MIT_FAKTOR,
      passwort: PASSWORT,
      name: 'Mit Faktor',
      mitZweitemFaktor: true,
    });
    ohneFaktor = await kontoEinrichten(app, auth, {
      email: OHNE_FAKTOR,
      passwort: PASSWORT,
      name: 'Ohne Faktor',
      mitZweitemFaktor: false,
    });
  }, 60_000);

  beforeEach(async () => {
    versatzMs = 0;
    // Jeder Test beginnt mit leeren Zählern: sonst summieren sich die
    // Fehlversuche der vorherigen Tests im gemeinsamen IP-Zähler.
    await pool.query('DELETE FROM cockpit.anmeldeversuch');
    await pool.query('DELETE FROM cockpit.anmeldevorgang');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('Anmeldeseite', () => {
    it('zeigt das Formular und verrät nichts über andere Zugangswege', async () => {
      const antwort = await app.inject({ method: 'GET', url: '/anmelden' });
      const inhalt = antwort.body.toLowerCase();

      expect(antwort.statusCode).toBe(200);
      expect(antwort.body).toContain('Anmelden');
      expect(inhalt).not.toContain('erststart');
      expect(inhalt).not.toContain('einladung');
      expect(inhalt).not.toContain('ersatzcode');
    });

    it('schickt eine bestehende Sitzung zur Übersicht', async () => {
      const antwort = await app.inject({
        method: 'GET',
        url: '/anmelden',
        headers: { cookie: mitFaktor.cookie },
      });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/');
    });
  });

  describe('Zwei Schritte', () => {
    it('führt vom richtigen Passwort zum Codeschritt, ohne Sitzung', async () => {
      const antwort = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const zwischen = cookieKopf(antwort.headers['set-cookie']);

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/anmelden/code');
      expect(cookieLesen(zwischen, ANMELDEVORGANG_COOKIE_NAME)).toBeTruthy();

      // Kein Sitzungs-Cookie mit Inhalt — Better Auth entwertet den vorherigen.
      const sitzungswert = cookieLesen(zwischen, SITZUNGS_COOKIE_NAME);
      expect(sitzungswert).toBe(undefined);

      // Und mit diesen Cookies ist die Übersicht nicht erreichbar.
      const gesperrt = await wurzelseite(zwischen);
      expect(gesperrt.statusCode).toBe(303);
      expect(gesperrt.headers.location).toBe('/anmelden');
    });

    it('zeigt den Codeschritt nur mit laufendem Anmeldevorgang', async () => {
      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const zwischen = cookieKopf(schritt1.headers['set-cookie']);

      const mitVorgang = await app.inject({
        method: 'GET',
        url: '/anmelden/code',
        headers: { cookie: zwischen },
      });
      const ohneVorgang = await app.inject({ method: 'GET', url: '/anmelden/code' });

      expect(mitVorgang.statusCode).toBe(200);
      expect(mitVorgang.body).toContain('Ersatzcode');
      expect(ohneVorgang.statusCode).toBe(303);
      expect(ohneVorgang.headers.location).toBe('/anmelden');
    });

    it('gibt den Zugang nach richtigem Code frei', async () => {
      const sitzung = await anmelden();

      expect(cookieLesen(sitzung, SITZUNGS_COOKIE_NAME)).toBeTruthy();
      const offen = await wurzelseite(sitzung);
      expect(offen.statusCode).toBe(200);
    });

    it('legt bei richtigem Passwort und falschem Code keine Sitzung an', async () => {
      const vorher = await sitzungenZaehlen();
      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const zwischen = cookieKopf(schritt1.headers['set-cookie']);

      const schritt2 = await codeSchritt(zwischen, '000000');

      expect(schritt2.statusCode).toBe(400);
      expect(cookieLesen(cookieKopf(schritt2.headers['set-cookie']), SITZUNGS_COOKIE_NAME)).toBe(
        undefined,
      );
      const gesperrt = await wurzelseite(zwischen);
      expect(gesperrt.statusCode).toBe(303);
      expect(gesperrt.headers.location).toBe('/anmelden');
      // Der Passwortschritt hat die eben angelegte Sitzung wieder entwertet,
      // der Codeschritt keine neue angelegt: unverändert viele Sitzungen.
      expect(await sitzungenZaehlen()).toBe(vorher);
    });

    it('weist einen abgelaufenen Anmeldevorgang ab', async () => {
      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const zwischen = cookieKopf(schritt1.headers['set-cookie']);
      await pool.query(
        "UPDATE cockpit.anmeldevorgang SET ablauf_am = now() - interval '1 minute'",
      );

      const schritt2 = await codeSchritt(zwischen, await totpCode(auth, mitFaktor.geheimnis));

      expect(schritt2.statusCode).toBe(303);
      expect(schritt2.headers.location).toBe('/anmelden');
      expect(cookieLesen(cookieKopf(schritt2.headers['set-cookie']), SITZUNGS_COOKIE_NAME)).toBe(
        undefined,
      );
    });

    it('verlangt nach dem Abmelden wieder eine Anmeldung', async () => {
      const sitzung = await anmelden();

      const abmelden = await app.inject({
        method: 'POST',
        url: '/abmelden',
        headers: { cookie: sitzung },
      });

      expect(abmelden.statusCode).toBe(303);
      expect(abmelden.headers.location).toBe('/anmelden');
      const danach = await wurzelseite(sitzung);
      expect(danach.statusCode).toBe(303);
      expect(danach.headers.location).toBe('/anmelden');
    });

    it('läuft beim Abmelden ohne Sitzung nicht ins Leere', async () => {
      // `/abmelden` steht auf der Allowlist für Anonyme: ein Klick auf
      // „Abbrechen" oder eine abgelaufene Sitzung darf keinen Fehler erzeugen.
      const ohneSitzung = await app.inject({ method: 'POST', url: '/abmelden' });

      expect(ohneSitzung.statusCode).toBe(303);
      expect(ohneSitzung.headers.location).toBe('/anmelden');
    });

    it('schickt ein Konto ohne zweiten Faktor zur Einrichtung', async () => {
      const antwort = await passwortSchritt(OHNE_FAKTOR, PASSWORT);

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/zwei-faktor');
      const cookie = cookieKopf(antwort.headers['set-cookie']);
      const weiter = await wurzelseite(cookie);
      expect(weiter.statusCode).toBe(303);
      expect(weiter.headers.location).toBe('/zwei-faktor');
    });
  });

  describe('Ersatzcode', () => {
    it('lässt sich genau einmal einlösen', async () => {
      const code = mitFaktor.ersatzcodes[0] ?? '';
      expect(code).not.toBe('');

      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const erste = await codeSchritt(cookieKopf(schritt1.headers['set-cookie']), code);

      expect(erste.statusCode).toBe(303);
      expect(erste.headers.location).toBe('/');
      expect(cookieLesen(cookieKopf(erste.headers['set-cookie']), SITZUNGS_COOKIE_NAME)).toBeTruthy();

      // Derselbe Code ein zweites Mal: verbraucht.
      const schritt1b = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const zweite = await codeSchritt(cookieKopf(schritt1b.headers['set-cookie']), code);

      expect(zweite.statusCode).toBe(400);
      expect(cookieLesen(cookieKopf(zweite.headers['set-cookie']), SITZUNGS_COOKIE_NAME)).toBe(
        undefined,
      );
    });
  });

  describe('Keine Auskunft über Konten', () => {
    it('antwortet auf falsches Passwort und unbekannte Adresse gleich', async () => {
      const falsch = await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT);
      await pool.query('DELETE FROM cockpit.anmeldeversuch');
      const unbekannt = await passwortSchritt(UNBEKANNT, PASSWORT);

      expect(unbekannt.statusCode).toBe(falsch.statusCode);
      expect(unbekannt.body).toBe(falsch.body);
      // Auch die Kopfzeilen dürfen sich nicht unterscheiden (außer der Uhrzeit).
      const ohneDatum = (kopf: Record<string, unknown>): Record<string, unknown> =>
        Object.fromEntries(Object.entries(kopf).filter(([name]) => name !== 'date'));
      expect(ohneDatum(unbekannt.headers)).toEqual(ohneDatum(falsch.headers));
      expect(falsch.headers['set-cookie']).toBe(undefined);
      expect(unbekannt.headers['set-cookie']).toBe(undefined);
    });
  });

  describe('Eigene Ratenbegrenzung', () => {
    it('sperrt nach fünf Fehlversuchen — auch das richtige Passwort', async () => {
      let letzte = await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT);
      for (let versuch = 2; versuch <= 5; versuch += 1) {
        letzte = await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT);
      }
      expect(await sperrePruefen(pool, 'passwort-email', MIT_FAKTOR, new Date())).toBe(true);

      const mitRichtigem = await passwortSchritt(MIT_FAKTOR, PASSWORT);

      // Gleiche Antwort wie ein Fehlversuch: die Sperre ist nicht erkennbar.
      expect(mitRichtigem.statusCode).toBe(letzte.statusCode);
      expect(mitRichtigem.body).toBe(letzte.body);
      expect(mitRichtigem.headers['set-cookie']).toBe(undefined);
    });

    it('sperrt eine unbekannte Adresse genauso', async () => {
      let letzte = await passwortSchritt(UNBEKANNT, FALSCHES_PASSWORT);
      for (let versuch = 2; versuch <= 5; versuch += 1) {
        letzte = await passwortSchritt(UNBEKANNT, FALSCHES_PASSWORT);
      }

      expect(await sperrePruefen(pool, 'passwort-email', UNBEKANNT, new Date())).toBe(true);
      const nochmal = await passwortSchritt(UNBEKANNT, FALSCHES_PASSWORT);
      expect(nochmal.statusCode).toBe(letzte.statusCode);
      expect(nochmal.body).toBe(letzte.body);
    });

    it('lässt die Sperre nach fünfzehn Minuten ablaufen', async () => {
      for (let versuch = 1; versuch <= 5; versuch += 1) {
        await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT);
      }
      expect((await passwortSchritt(MIT_FAKTOR, PASSWORT)).statusCode).toBe(400);

      versatzMs = 16 * MINUTE;

      const danach = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      expect(danach.statusCode).toBe(303);
      expect(danach.headers.location).toBe('/anmelden/code');
    });

    it('zählt Fehlversuche auch je IP', async () => {
      const boese = { 'x-forwarded-for': '203.0.113.13' };
      // Zwanzig Fehlversuche von einer IP, jeweils auf eine andere Adresse:
      // der Zähler je Adresse greift dabei nie, nur der je IP.
      for (let versuch = 1; versuch <= 20; versuch += 1) {
        await passwortSchritt(`nutzer-${String(versuch)}@example.org`, FALSCHES_PASSWORT, boese);
      }
      expect(await sperrePruefen(pool, 'passwort-ip', '203.0.113.13', new Date())).toBe(true);

      const vonGesperrterIp = await passwortSchritt(MIT_FAKTOR, PASSWORT, boese);
      const vonAndererIp = await passwortSchritt(MIT_FAKTOR, PASSWORT, {
        'x-forwarded-for': '203.0.113.14',
      });

      expect(vonGesperrterIp.statusCode).toBe(400);
      expect(vonAndererIp.statusCode).toBe(303);
      expect(vonAndererIp.headers.location).toBe('/anmelden/code');
    });

    it('sperrt den Codeschritt je Konto', async () => {
      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const zwischen = cookieKopf(schritt1.headers['set-cookie']);
      for (let versuch = 1; versuch <= 5; versuch += 1) {
        await codeSchritt(zwischen, '000000');
      }
      expect(await sperrePruefen(pool, 'code-konto', mitFaktor.id, new Date())).toBe(true);

      // Frischer Anmeldevorgang, frischer Better-Auth-Nachweis, richtiger Code —
      // der eigene Zähler je Konto greift trotzdem.
      const neu = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const antwort = await codeSchritt(
        cookieKopf(neu.headers['set-cookie']),
        await totpCode(auth, mitFaktor.geheimnis),
      );

      expect(antwort.statusCode).toBe(400);
      expect(cookieLesen(cookieKopf(antwort.headers['set-cookie']), SITZUNGS_COOKIE_NAME)).toBe(
        undefined,
      );
    });

    it('räumt alte Zähler ab, sobald eine Sperre greift', async () => {
      // Ohne das könnte jemand mit Fehlversuchen auf immer neue Adressen
      // beliebig viele Zeilen anhäufen, wenn sich nie jemand erfolgreich
      // anmeldet.
      await pool.query(
        `INSERT INTO cockpit.anmeldeversuch (art, kennung_hash, fehlversuche, fenster_beginn)
              VALUES ('passwort-email', 'alter-eintrag', 1, now() - interval '2 hours')`,
      );

      for (let versuch = 1; versuch <= 5; versuch += 1) {
        await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT);
      }

      const alt = await pool.query(
        "SELECT 1 FROM cockpit.anmeldeversuch WHERE kennung_hash = 'alter-eintrag'",
      );
      expect(alt.rowCount).toBe(0);
      // Die frische Sperre bleibt natürlich stehen.
      expect(await sperrePruefen(pool, 'passwort-email', MIT_FAKTOR, new Date())).toBe(true);
    });

    it('setzt den Zähler nach erfolgreicher Anmeldung zurück', async () => {
      for (let versuch = 1; versuch <= 4; versuch += 1) {
        await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT);
      }

      await anmelden();

      expect(await sperrePruefen(pool, 'passwort-email', MIT_FAKTOR, new Date())).toBe(false);
      const wiederVier = await pool.query<{ anzahl: string }>(
        'SELECT count(*)::text AS anzahl FROM cockpit.anmeldeversuch',
      );
      // Der IP-Zähler bleibt bewusst stehen, der Adress-Zähler ist weg.
      expect(Number(wiederVier.rows[0]?.anzahl)).toBe(1);
    });
  });

  describe('Ratenbegrenzung unter Parallelität', () => {
    // Gemessen wird nicht der Zählerstand, sondern wie oft die eigentliche
    // Prüfung wirklich gelaufen ist. Ein Zähler, der erst nach der Prüfung
    // hochgeht, sieht am Ende richtig aus und hat trotzdem beliebig viele
    // Passwortprüfungen durchgelassen.
    const GLEICHZEITIG = 40;

    it('lässt an einer Adresse höchstens fünf Passwortprüfungen laufen', async () => {
      const spion = vi.spyOn(auth.api, 'signInEmail');

      await Promise.all(
        Array.from({ length: GLEICHZEITIG }, () =>
          passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT),
        ),
      );

      expect(spion.mock.calls.length).toBeLessThanOrEqual(5);
      spion.mockRestore();
    });

    it('weist auch ein richtiges Passwort ab, das nach der Grenze eintrifft', async () => {
      await Promise.all(
        Array.from({ length: GLEICHZEITIG }, () =>
          passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT),
        ),
      );

      const mitRichtigem = await passwortSchritt(MIT_FAKTOR, PASSWORT);

      expect(mitRichtigem.statusCode).toBe(400);
      expect(mitRichtigem.headers['set-cookie']).toBe(undefined);
    });

    it('lässt je IP höchstens zwanzig Passwortprüfungen laufen', async () => {
      const spion = vi.spyOn(auth.api, 'signInEmail');
      const boese = { 'x-forwarded-for': '203.0.113.40' };

      // Jede Anfrage auf eine andere Adresse: nur der Zähler je IP kann greifen.
      await Promise.all(
        Array.from({ length: GLEICHZEITIG }, (_wert, index) =>
          passwortSchritt(`parallel-${String(index)}@example.org`, FALSCHES_PASSWORT, boese),
        ),
      );

      expect(spion.mock.calls.length).toBeLessThanOrEqual(20);
      spion.mockRestore();
    });

    it('lässt am Codeschritt höchstens fünf Prüfungen je Konto laufen', async () => {
      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const zwischen = cookieKopf(schritt1.headers['set-cookie']);
      const totpSpion = vi.spyOn(auth.api, 'verifyTOTP');
      const ersatzSpion = vi.spyOn(auth.api, 'verifyBackupCode');

      await Promise.all(
        Array.from({ length: GLEICHZEITIG }, () => codeSchritt(zwischen, '000000')),
      );

      expect(totpSpion.mock.calls.length + ersatzSpion.mock.calls.length).toBeLessThanOrEqual(5);
      totpSpion.mockRestore();
      ersatzSpion.mockRestore();
    });
  });

  describe('IP-Budget rechtmäßiger Anmeldungen', () => {
    it('verbraucht sich durch erfolgreiche Anmeldungen nicht', async () => {
      const boese = { 'x-forwarded-for': '203.0.113.50' };

      for (let runde = 1; runde <= 3; runde += 1) {
        const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT, boese);
        expect(schritt1.statusCode).toBe(303);
        const schritt2 = await codeSchritt(
          cookieKopf(schritt1.headers['set-cookie']),
          await totpCode(auth, mitFaktor.geheimnis),
        );
        expect(schritt2.statusCode).toBe(303);
      }

      // Jede Anmeldung reserviert einen Versuch und schreibt ihn bei Erfolg
      // wieder gut: der Stand bleibt bei null.
      const stand = await pool.query<{ fehlversuche: number }>(
        'SELECT fehlversuche FROM cockpit.anmeldeversuch WHERE art = $1',
        ['passwort-ip'],
      );
      expect(stand.rows[0]?.fehlversuche ?? 0).toBe(0);
      // Der Zähler je Adresse ist nach Erfolg ganz weg.
      const jeAdresse = await pool.query(
        'SELECT 1 FROM cockpit.anmeldeversuch WHERE art = $1',
        ['passwort-email'],
      );
      expect(jeAdresse.rowCount).toBe(0);
    });

    it('schreibt die Reservierung gut, wenn erst der IP-Zähler abweist', async () => {
      // Genau die Lage, die unter Parallelität entsteht: der IP-Zähler steht
      // über der Grenze, seine Sperre ist aber (noch) nicht gesetzt. Dann darf
      // der Fehlversuch nicht der Adresse angerechnet werden — geprüft wurde ja
      // nichts.
      await pool.query(
        `INSERT INTO cockpit.anmeldeversuch (art, kennung_hash, fehlversuche, fenster_beginn)
              VALUES ('passwort-ip', $1, 25, now())`,
        [kennungHash('passwort-ip', '203.0.113.60')],
      );

      const antwort = await passwortSchritt(MIT_FAKTOR, PASSWORT, {
        'x-forwarded-for': '203.0.113.60',
      });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.headers['set-cookie']).toBe(undefined);
      const jeAdresse = await pool.query<{ fehlversuche: number }>(
        'SELECT fehlversuche FROM cockpit.anmeldeversuch WHERE art = $1',
        ['passwort-email'],
      );
      expect(jeAdresse.rows[0]?.fehlversuche ?? 0).toBe(0);
    });
  });

  describe('Herkunft der Anfrage', () => {
    it('weist ein Formular von fremder Herkunft ab, ohne zu zählen', async () => {
      const antwort = await app.inject({
        method: 'POST',
        url: '/anmelden',
        headers: {
          ...FORMULAR_KOPF,
          host: 'cockpit.example',
          origin: 'https://boese.example',
        },
        payload: formular({ email: MIT_FAKTOR, passwort: PASSWORT }),
      });

      expect(antwort.statusCode).toBe(403);
      expect(antwort.headers['set-cookie']).toBe(undefined);
      const zeilen = await pool.query<{ anzahl: string }>(
        'SELECT count(*)::text AS anzahl FROM cockpit.anmeldeversuch',
      );
      expect(zeilen.rows[0]?.anzahl).toBe('0');
    });

    it('lässt die eigene Herkunft durch', async () => {
      const antwort = await app.inject({
        method: 'POST',
        url: '/anmelden',
        headers: {
          ...FORMULAR_KOPF,
          host: 'cockpit.example',
          origin: 'https://cockpit.example',
        },
        payload: formular({ email: MIT_FAKTOR, passwort: PASSWORT }),
      });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/anmelden/code');
    });
  });

  describe('Client-IP in der Sitzung', () => {
    it('vermerkt die vom Proxy angehängte Adresse, nicht die behauptete', async () => {
      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT, {
        'x-forwarded-for': '1.2.3.4, 203.0.113.77',
      });
      const zwischen = cookieKopf(schritt1.headers['set-cookie']);
      await app.inject({
        method: 'POST',
        url: '/anmelden/code',
        headers: {
          ...FORMULAR_KOPF,
          cookie: zwischen,
          'x-forwarded-for': '1.2.3.4, 203.0.113.77',
        },
        payload: formular({ code: await totpCode(auth, mitFaktor.geheimnis) }),
      });

      const sitzungen = await pool.query<{ ipAddress: string | null }>(
        'SELECT "ipAddress" FROM cockpit.session ORDER BY "createdAt" DESC LIMIT 1',
      );
      expect(sitzungen.rows[0]?.ipAddress).toBe('203.0.113.77');
    });
  });

  describe('Protokoll (COPI-23)', () => {
    /** Die Arten der Einträge seit einer Marke, gezählt — für Abläufe, deren Reihenfolge nicht zählt. */
    async function artenSeit(marke: number): Promise<Record<string, number>> {
      const zaehler: Record<string, number> = {};
      for (const zeile of await protokollSeit(pool, marke)) {
        zaehler[zeile.art] = (zaehler[zeile.art] ?? 0) + 1;
      }
      return zaehler;
    }

    it('hält die Anmeldung mit Code genau einmal fest — erst nach dem zweiten Schritt', async () => {
      const marke = await protokollMarke(pool);

      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      // Nach dem Passwort allein ist niemand angemeldet: noch kein Eintrag.
      expect(await protokollSeit(pool, marke)).toEqual([]);

      const schritt2 = await codeSchritt(
        cookieKopf(schritt1.headers['set-cookie']),
        await totpCode(auth, mitFaktor.geheimnis),
      );
      expect(schritt2.statusCode).toBe(303);

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'anmeldung_erfolgreich',
          akteur: mitFaktor.id,
          ziel: null,
          einzelheiten: { schritt: 'code', faktor: 'totp' },
        },
      ]);
    });

    it('hält einen Ersatzcode fest: verwendet und angemeldet', async () => {
      const code = mitFaktor.ersatzcodes[1] ?? '';
      expect(code).not.toBe('');
      const marke = await protokollMarke(pool);

      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const schritt2 = await codeSchritt(cookieKopf(schritt1.headers['set-cookie']), code);
      expect(schritt2.statusCode).toBe(303);

      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'ersatzcode_verwendet', akteur: mitFaktor.id, ziel: null, einzelheiten: {} },
        {
          art: 'anmeldung_erfolgreich',
          akteur: mitFaktor.id,
          ziel: null,
          einzelheiten: { schritt: 'code', faktor: 'ersatzcode' },
        },
      ]);
    });

    it('hält bei einem Konto ohne zweiten Faktor die Anmeldung mit dem Passwort fest', async () => {
      const marke = await protokollMarke(pool);

      const antwort = await passwortSchritt(OHNE_FAKTOR, PASSWORT);
      expect(antwort.headers.location).toBe('/zwei-faktor');

      // Eine Sitzung entsteht (das Tor führt sie zur Einrichtung), also ein Eintrag.
      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'anmeldung_erfolgreich',
          akteur: ohneFaktor.id,
          ziel: null,
          einzelheiten: { schritt: 'passwort' },
        },
      ]);
    });

    it('hält ein falsches Passwort bei einem bekannten Konto genau einmal fest', async () => {
      const marke = await protokollMarke(pool);

      await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT);

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'anmeldung_fehlgeschlagen',
          akteur: 'system',
          ziel: mitFaktor.id,
          einzelheiten: { schritt: 'passwort' },
        },
      ]);
    });

    it('schreibt bei einer unbekannten Adresse nichts — sonst gäbe das Protokoll Auskunft über Adressen', async () => {
      const marke = await protokollMarke(pool);

      await passwortSchritt(UNBEKANNT, FALSCHES_PASSWORT);
      await passwortSchritt(UNBEKANNT, PASSWORT);

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('hält einen falschen Code fest, ohne dass eine Sitzung entsteht', async () => {
      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const marke = await protokollMarke(pool);

      await codeSchritt(cookieKopf(schritt1.headers['set-cookie']), '000000');

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'anmeldung_fehlgeschlagen',
          akteur: 'system',
          ziel: mitFaktor.id,
          einzelheiten: { schritt: 'code' },
        },
      ]);
    });

    it('hält die Sperre nach fünf Fehlversuchen genau einmal fest, weitere abgewiesene Versuche nicht', async () => {
      const marke = await protokollMarke(pool);
      for (let versuch = 1; versuch <= 5; versuch += 1) {
        await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT);
      }
      expect(await sperrePruefen(pool, 'passwort-email', MIT_FAKTOR, new Date())).toBe(true);

      const stand = await protokollSeit(pool, marke);
      expect(await artenSeit(marke)).toEqual({ anmeldung_fehlgeschlagen: 5, sperre_ausgeloest: 1 });
      expect(stand.find((zeile) => zeile.art === 'sperre_ausgeloest')).toEqual({
        art: 'sperre_ausgeloest',
        akteur: 'system',
        ziel: mitFaktor.id,
        einzelheiten: { sperre: 'passwort-email' },
      });

      // Danach weist die Sperre ab, auch mit richtigem Passwort — und schreibt nichts.
      await passwortSchritt(MIT_FAKTOR, PASSWORT);
      await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT);
      expect(await protokollSeit(pool, marke)).toHaveLength(stand.length);
    });

    it('schreibt bei der Sperre einer unbekannten Adresse nichts', async () => {
      const marke = await protokollMarke(pool);
      for (let versuch = 1; versuch <= 6; versuch += 1) {
        await passwortSchritt(UNBEKANNT, FALSCHES_PASSWORT);
      }
      expect(await sperrePruefen(pool, 'passwort-email', UNBEKANNT, new Date())).toBe(true);

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('hält die Sperre des Codeschritts je Konto fest', async () => {
      const schritt1 = await passwortSchritt(MIT_FAKTOR, PASSWORT);
      const zwischen = cookieKopf(schritt1.headers['set-cookie']);
      const marke = await protokollMarke(pool);
      for (let versuch = 1; versuch <= 5; versuch += 1) {
        await codeSchritt(zwischen, '000000');
      }
      expect(await sperrePruefen(pool, 'code-konto', mitFaktor.id, new Date())).toBe(true);

      expect(await artenSeit(marke)).toEqual({ anmeldung_fehlgeschlagen: 5, sperre_ausgeloest: 1 });
      const sperre = (await protokollSeit(pool, marke)).find((zeile) => zeile.art === 'sperre_ausgeloest');
      expect(sperre?.einzelheiten).toEqual({ sperre: 'code-konto' });
      expect(sperre?.ziel).toBe(mitFaktor.id);
    });

    it('schreibt bei der Sperre einer IP nichts: keine IP im Protokoll, kein Wachstum durch fremde Adressen', async () => {
      const marke = await protokollMarke(pool);
      const boese = { 'x-forwarded-for': '203.0.113.21' };
      for (let versuch = 1; versuch <= 20; versuch += 1) {
        await passwortSchritt(`fremd-${String(versuch)}@example.org`, FALSCHES_PASSWORT, boese);
      }
      expect(await sperrePruefen(pool, 'passwort-ip', '203.0.113.21', new Date())).toBe(true);

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('schreibt bei einem Formular von fremder Herkunft nichts', async () => {
      const marke = await protokollMarke(pool);

      const antwort = await passwortSchritt(MIT_FAKTOR, FALSCHES_PASSWORT, {
        origin: 'https://boese.example',
      });

      expect(antwort.statusCode).toBe(403);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('hält das Abmelden fest, mit der Kennung des Kontos', async () => {
      const sitzung = await anmelden();
      const marke = await protokollMarke(pool);

      const abmelden = await app.inject({
        method: 'POST',
        url: '/abmelden',
        headers: { cookie: sitzung },
      });
      expect(abmelden.statusCode).toBe(303);

      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'abmeldung', akteur: mitFaktor.id, ziel: null, einzelheiten: {} },
      ]);
    });

    it('schreibt beim Abmelden ohne Sitzung nichts', async () => {
      const marke = await protokollMarke(pool);

      const ohneSitzung = await app.inject({ method: 'POST', url: '/abmelden' });

      expect(ohneSitzung.statusCode).toBe(303);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });
  });

  describe('Konto-Verfallsfrist (COPI-17)', () => {
    // Als Literal, nicht als Konstante des Produktivcodes: sonst rechnete der
    // Test eine falsche Frist einfach mit.
    const FRIST_MS = 72 * MINUTE * 60;
    const HALBFERTIG = 'verfall-login@example.org';

    beforeAll(async () => {
      await kontoEinrichten(app, auth, {
        email: HALBFERTIG,
        passwort: PASSWORT,
        name: 'Verfall Login',
        mitZweitemFaktor: false,
      });
    });

    beforeEach(async () => {
      // Das Alter des Kontos gegen die Uhr des Tests festnageln.
      await pool.query('UPDATE cockpit."user" SET "createdAt" = $2 WHERE email = $1', [
        HALBFERTIG,
        new Date(),
      ]);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('weist ein Konto eine Minute nach Fristende neutral ab, ohne das Passwort zu prüfen', async () => {
      const spion = vi.spyOn(auth.api, 'signInEmail');
      versatzMs = FRIST_MS + MINUTE;

      const antwort = await passwortSchritt(HALBFERTIG, PASSWORT);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain('E-Mail-Adresse oder Passwort stimmen nicht.');
      expect(antwort.headers['set-cookie']).toBe(undefined);
      expect(spion).not.toHaveBeenCalled();
    });

    it('lässt ein Konto eine Minute vor Fristende noch zur Einrichtung', async () => {
      const spion = vi.spyOn(auth.api, 'signInEmail');
      versatzMs = FRIST_MS - MINUTE;

      const antwort = await passwortSchritt(HALBFERTIG, PASSWORT);

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/zwei-faktor');
      expect(spion).toHaveBeenCalledTimes(1);
    });

    it('lässt ein aktiviertes Konto auch weit nach Fristende zum Codeschritt', async () => {
      versatzMs = 100 * MINUTE * 60;

      const antwort = await passwortSchritt(MIT_FAKTOR, PASSWORT);

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/anmelden/code');
    });
  });
});
