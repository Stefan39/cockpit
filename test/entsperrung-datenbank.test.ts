/**
 * Entsperrung bei verlorenem zweitem Faktor (COPI-28) gegen eine echte PostgreSQL.
 * Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * ACHTUNG: Der Test räumt `cockpit."user"` (samt Sitzungen, Faktoren, Ersatzcodes),
 * `cockpit.anmeldeversuch`, `cockpit.anmeldevorgang` und `cockpit.einladung` ab.
 * Niemals gegen eine Kundendatenbank laufen lassen.
 *
 * Aufgerufen wird das echte Kommando (`cliAusfuehren`); den Link aus seiner Ausgabe
 * löst der Test über die echte Anwendung ein. Die Bedrohung, die das Design bestimmt:
 * würde das Kommando nur den Faktor entfernen, könnte danach jeder, der das Passwort
 * kennt, ein eigenes Gerät binden. Deshalb prüft der Test vor allem, was **nicht** mehr
 * geht — und dass nirgends Klartext steht.
 *
 * Die Zeit läuft über `jetzt` (Kommando und Anwendung), ohne `sleep`.
 */
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tokenHashen } from '../src/auth/einmal-token.js';
import { erzeugeAuth, SITZUNGS_COOKIE_NAME, type CockpitAuth } from '../src/auth/konfiguration.js';
import { wiederherstellungEinloesen } from '../src/auth/entsperrung.js';
import { passwortHashen, passwortPruefen } from '../src/auth/passwort.js';
import { zweiterFaktorAktiv } from '../src/auth/zweiter-faktor.js';
import { cliAusfuehren } from '../src/cli/befehle.js';
import { buildApp } from '../src/server/app.js';
import { geheimnisAusUri } from '../src/server/routes/zwei-faktor.js';
import {
  base32Dekodieren,
  cookieKopf,
  formular,
  FORMULAR_KOPF,
  kontenLoeschen,
  kontoEinrichten,
  passkeyEinrichten,
  protokollMarke,
  protokollSchreibenScheitern,
  protokollSeit,
  totpCode,
  type Konto,
} from './hilfen.js';
import { qrAusSeiteLesen } from './qr-lesen.js';
import { testDatenbankUrl } from './testdatenbank.js';
import { SoftwareAuthenticator } from './webauthn-authenticator.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const ALT = 'ein-ausreichend-langes-passwort';
const NEU = 'ein-ganz-neues-langes-passwort';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const EMAIL = 'verloren@example.org';
const ANDERE = 'nebenan@example.org';

/** Die eine neutrale Meldung jedes abgelehnten Passwortschritts. */
const PASSWORT_ABGELEHNT = 'E-Mail-Adresse oder Passwort stimmen nicht.';

interface Lauf {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly token: string;
}

describe.skipIf(!datenbankUrl)('Entsperrung (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let appJetzt = 0;
  let kommandoJetzt = 0;
  let konto: Konto;

  async function kommando(...argumente: string[]): Promise<Lauf> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await cliAusfuehren(argumente, {
      pool,
      basisUrl: BASIS_URL,
      ausgabe: (text) => stdout.push(text),
      fehlerausgabe: (text) => stderr.push(text),
      jetzt: () => new Date(Date.now() + kommandoJetzt),
    });
    const ausgabe = stdout.join('\n');
    const token = new RegExp(`${BASIS_URL}/zugang-wiederherstellen/([A-Za-z0-9_-]+)`).exec(ausgabe)?.[1] ?? '';
    return { code, stdout: ausgabe, stderr: stderr.join('\n'), token };
  }

  const entsperren = (email = EMAIL) => kommando('entsperren', '--konto', email);

  async function formularHolen(token: string) {
    return app.inject({ method: 'GET', url: `/zugang-wiederherstellen/${token}` });
  }

  async function einloesen(token: string, passwort = NEU, wiederholung = passwort) {
    return app.inject({
      method: 'POST',
      url: `/zugang-wiederherstellen/${token}`,
      headers: FORMULAR_KOPF,
      payload: formular({ passwort, passwortWiederholung: wiederholung }),
    });
  }

  async function passwortSchritt(email: string, passwort: string) {
    return app.inject({
      method: 'POST',
      url: '/anmelden',
      headers: FORMULAR_KOPF,
      payload: formular({ email, passwort }),
    });
  }

  async function zaehlen(sql: string, parameter: unknown[]): Promise<number> {
    const ergebnis = await pool.query<{ anzahl: string }>(`SELECT count(*)::text AS anzahl FROM (${sql}) t`, parameter);
    return Number(ergebnis.rows[0]?.anzahl ?? '0');
  }

  const sitzungen = (id: string) => zaehlen('SELECT 1 FROM cockpit.session WHERE "userId" = $1', [id]);
  const passkeys = (id: string) => zaehlen('SELECT 1 FROM cockpit.passkey WHERE benutzer_id = $1', [id]);
  const ersatzcodes = (id: string) => zaehlen('SELECT 1 FROM cockpit.ersatzcode WHERE benutzer_id = $1', [id]);
  const totpZeilen = (id: string) => zaehlen('SELECT 1 FROM cockpit."twoFactor" WHERE "userId" = $1', [id]);
  const offeneLinks = (id: string) =>
    zaehlen('SELECT 1 FROM cockpit.zugang_wiederherstellung WHERE benutzer_id = $1 AND verbraucht_am IS NULL', [id]);

  async function passwortHash(id: string): Promise<string> {
    const ergebnis = await pool.query<{ password: string }>(
      `SELECT password FROM cockpit.account WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [id],
    );
    return ergebnis.rows[0]?.password ?? '';
  }

  async function aktiviertAm(id: string): Promise<Date | null> {
    const ergebnis = await pool.query<{ aktiviert_am: Date | null }>(
      'SELECT aktiviert_am FROM cockpit."user" WHERE id = $1',
      [id],
    );
    return ergebnis.rows[0]?.aktiviert_am ?? null;
  }

  /** Ein Konto mit allem, was ein Konto an zweitem Faktor haben kann: TOTP, Passkey, Ersatzcodes, offene Vorgänge. */
  async function kontoMitAllemAusstatten(): Promise<SoftwareAuthenticator> {
    const geraet = new SoftwareAuthenticator();
    await pool.query(
      `INSERT INTO cockpit.passkey (id, benutzer_id, oeffentlicher_schluessel, zaehler, transports, name)
       VALUES ($1, $2, $3, 0, '{internal}', 'Direkt')`,
      [geraet.kennung, konto.id, geraet.oeffentlicherSchluesselCose],
    );
    await pool.query('INSERT INTO cockpit.ersatzcode (benutzer_id, code_hash) VALUES ($1, $2), ($1, $2)', [konto.id, 'hash']);
    await pool.query(
      `INSERT INTO cockpit.passkey_vorgang (benutzer_id, challenge, ablauf_am) VALUES ($1, 'x', now() + interval '5 minutes')`,
      [konto.id],
    );
    await pool.query(
      `INSERT INTO cockpit.anmeldevorgang (kennung_hash, benutzer_id, ablauf_am) VALUES ('hash-vorgang', $1, now() + interval '5 minutes')`,
      [konto.id],
    );
    return geraet;
  }

  async function totpEinrichten(cookie: string, passwort: string): Promise<{ geheimnis: string; cookie: string }> {
    const einrichten = await app.inject({
      method: 'POST',
      url: '/zwei-faktor/einrichten',
      headers: { ...FORMULAR_KOPF, cookie },
      payload: formular({ passwort }),
    });
    const geheimnis = geheimnisAusUri(qrAusSeiteLesen(einrichten.body));
    const { code } = await auth.api.generateTOTP({ body: { secret: base32Dekodieren(geheimnis) } });
    const pruefen = await app.inject({
      method: 'POST',
      url: '/zwei-faktor/pruefen',
      headers: { ...FORMULAR_KOPF, cookie },
      payload: formular({ code }),
    });
    return { geheimnis, cookie: cookieKopf(pruefen.headers['set-cookie']) || cookie };
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
      { auth, pool, basisUrl: BASIS_URL, jetzt: () => new Date(Date.now() + appJetzt) },
    );
  }, 60_000);

  beforeEach(async () => {
    appJetzt = 0;
    kommandoJetzt = 0;
    await pool.query('DELETE FROM cockpit.anmeldeversuch');
    await pool.query('DELETE FROM cockpit.anmeldevorgang');
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    // Das Konto der meisten Tests: mit echtem TOTP, wie ein Konto, das seinen Faktor verliert.
    konto = await kontoEinrichten(app, auth, { email: EMAIL, passwort: ALT, name: 'Verloren', mitZweitemFaktor: true });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('Das Kommando entfernt, was den Zugang öffnen könnte', () => {
    it('entfernt alle Faktoren: TOTP, Passkeys, Ersatzcodes und offene Vorgänge', async () => {
      await kontoMitAllemAusstatten();
      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(true);
      expect(await totpZeilen(konto.id)).toBe(1);

      const lauf = await entsperren();

      expect(lauf.code).toBe(0);
      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(false);
      expect(await totpZeilen(konto.id)).toBe(0);
      expect(await passkeys(konto.id)).toBe(0);
      expect(await ersatzcodes(konto.id)).toBe(0);
      expect(await zaehlen('SELECT 1 FROM cockpit.passkey_vorgang WHERE benutzer_id = $1', [konto.id])).toBe(0);
      expect(await zaehlen('SELECT 1 FROM cockpit.anmeldevorgang WHERE benutzer_id = $1', [konto.id])).toBe(0);
    });

    it('beendet alle Sitzungen, auch die laufende', async () => {
      // Eine zweite Sitzung, etwa vom Telefon.
      await pool.query(
        `INSERT INTO cockpit.session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
         VALUES ('zweite-sitzung', now() + interval '1 day', 'zweites-token', now(), now(), $1)`,
        [konto.id],
      );
      expect((await app.inject({ method: 'GET', url: '/', headers: { cookie: konto.cookie } })).statusCode).toBe(200);
      expect(await sitzungen(konto.id)).toBeGreaterThanOrEqual(2);

      await entsperren();

      expect(await sitzungen(konto.id)).toBe(0);
      const danach = await app.inject({ method: 'GET', url: '/', headers: { cookie: konto.cookie } });
      expect(danach.statusCode).toBe(303);
      expect(danach.headers.location).toBe('/anmelden');
    });

    it('entwertet das Passwort: mit dem alten meldet sich niemand mehr an, neutral abgewiesen', async () => {
      await kontoEinrichten(app, auth, { email: ANDERE, passwort: ALT, name: 'Nebenan', mitZweitemFaktor: true });
      const vorher = await passwortHash(konto.id);
      await entsperren();

      const altes = await passwortSchritt(EMAIL, ALT);
      const falsches = await passwortSchritt(ANDERE, 'ein-ganz-anderes-passwort');

      expect(await passwortHash(konto.id)).not.toBe(vorher);
      expect(await passwortPruefen({ hash: await passwortHash(konto.id), password: ALT })).toBe(false);
      expect(altes.statusCode).toBe(400);
      expect(altes.body).toContain(PASSWORT_ABGELEHNT);
      expect(altes.headers['set-cookie']).toBeUndefined();
      // Dieselbe Antwort wie bei falschem Passwort: nichts verrät, dass das Konto in Wiederherstellung ist.
      expect(altes.statusCode).toBe(falsches.statusCode);
      expect(altes.body).toBe(falsches.body);
      expect(await sitzungen(konto.id)).toBe(0);
    });

    it('ersetzt das Passwort durch einen gültigen Argon2id-Hash: die Prüfung kostet dieselbe Zeit wie sonst', async () => {
      await entsperren();

      // Ein Marker-String würde Argon2 sofort verwerfen und die Anmeldung messbar schneller
      // scheitern lassen als jeden anderen Fehlversuch (Zeitkanal).
      expect(await passwortHash(konto.id)).toMatch(/^\$argon2id\$/);
    });

    it('lässt die Rolle, die Adresse und aktiviert_am unverändert: das Konto verfällt nicht', async () => {
      const vorher = await aktiviertAm(konto.id);
      expect(vorher).toBeInstanceOf(Date);

      await entsperren();

      expect(await aktiviertAm(konto.id)).toEqual(vorher);
      const zeile = await pool.query<{ email: string; rolle: string }>('SELECT email, rolle FROM cockpit."user" WHERE id = $1', [konto.id]);
      expect(zeile.rows[0]).toEqual({ email: EMAIL, rolle: 'betrieb_mitarbeiter' });
    });

    it('rührt andere Konten nicht an', async () => {
      const anderes = await kontoEinrichten(app, auth, { email: ANDERE, passwort: ALT, name: 'Nebenan', mitZweitemFaktor: true });
      const hashVorher = await passwortHash(anderes.id);

      await entsperren();

      expect(await passwortHash(anderes.id)).toBe(hashVorher);
      expect(await zweiterFaktorAktiv(pool, anderes.id)).toBe(true);
      expect(await totpZeilen(anderes.id)).toBe(1);
      expect(await sitzungen(anderes.id)).toBeGreaterThanOrEqual(1);
    });

    it('macht alles oder nichts: scheitert das Protokoll, bleibt das Konto unverändert', async () => {
      await kontoMitAllemAusstatten();
      const hashVorher = await passwortHash(konto.id);
      const aufraeumen = await protokollSchreibenScheitern(pool, 'konto_entsperrt');
      try {
        const lauf = await entsperren();

        expect(lauf.code).toBe(1);
        expect(lauf.token).toBe('');
      } finally {
        await aufraeumen();
      }
      expect(await passwortHash(konto.id)).toBe(hashVorher);
      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(true);
      expect(await totpZeilen(konto.id)).toBe(1);
      expect(await passkeys(konto.id)).toBe(1);
      expect(await sitzungen(konto.id)).toBeGreaterThanOrEqual(1);
      expect(await offeneLinks(konto.id)).toBe(0);
    });

    it('protokolliert das Ereignis mit Akteur konsole, Konto-ID und Rolle, ohne Token und ohne Adresse', async () => {
      const marke = await protokollMarke(pool);

      const lauf = await entsperren();

      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege).toEqual([
        { art: 'konto_entsperrt', akteur: 'konsole', ziel: konto.id, einzelheiten: { rolle: 'betrieb_mitarbeiter' } },
      ]);
      expect(JSON.stringify(eintraege)).not.toContain(lauf.token);
      expect(JSON.stringify(eintraege)).not.toContain(EMAIL);
    });

    it('entsperrt auch den einzigen Betreuer, warnt aber auf stderr', async () => {
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betreuer' WHERE id = $1`, [konto.id]);
      const vorher = await aktiviertAm(konto.id);

      const lauf = await entsperren();

      expect(lauf.code).toBe(0);
      expect(lauf.token).not.toBe('');
      expect(lauf.stderr).toMatch(/Betreuer/);
      expect(lauf.stdout).not.toMatch(/Betreuer/);
      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(false);
      const zeile = await pool.query<{ rolle: string }>('SELECT rolle FROM cockpit."user" WHERE id = $1', [konto.id]);
      expect(zeile.rows[0]?.rolle).toBe('betreuer');
      expect(await aktiviertAm(konto.id)).toEqual(vorher);
    });

    it('meldet eine unbekannte Adresse mit Exit-Code 1 und klarer Meldung, ohne Token', async () => {
      const lauf = await entsperren('gibt-es-nicht@example.org');

      expect(lauf.code).toBe(1);
      expect(lauf.stderr).toContain('kein Konto');
      expect(lauf.stdout).toBe('');
    });

    it('gibt den Link genau einmal auf stdout aus und nichts davon auf stderr', async () => {
      const lauf = await entsperren();

      expect(lauf.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(lauf.stdout.split(lauf.token)).toHaveLength(2);
      expect(lauf.stderr).not.toContain(lauf.token);
    });
  });

  describe('Der Link', () => {
    it('speichert nur den Hash, 3 Stunden gültig, höchstens einer offen je Konto', async () => {
      const lauf = await entsperren();

      const zeile = await pool.query<{ token_hash: string; ablauf_am: Date; erstellt_am: Date }>(
        'SELECT token_hash, ablauf_am, erstellt_am FROM cockpit.zugang_wiederherstellung WHERE benutzer_id = $1',
        [konto.id],
      );
      expect(zeile.rows).toHaveLength(1);
      expect(zeile.rows[0]?.token_hash).toBe(tokenHashen(lauf.token));
      const dauer = (zeile.rows[0]?.ablauf_am.getTime() ?? 0) - Date.now();
      expect(dauer).toBeGreaterThan(3 * HOUR - MINUTE);
      expect(dauer).toBeLessThanOrEqual(3 * HOUR);
    });

    it('wird von einem zweiten Aufruf für dasselbe Konto entwertet', async () => {
      const erster = await entsperren();
      const zweiter = await entsperren();

      expect(zweiter.token).not.toBe(erster.token);
      expect(await offeneLinks(konto.id)).toBe(1);
      expect((await formularHolen(erster.token)).statusCode).toBe(404);
      expect((await formularHolen(zweiter.token)).statusCode).toBe(200);
    });

    it('zeigt das Formular mit der Adresse des Kontos, und nur mit gültigem Token', async () => {
      const lauf = await entsperren();

      const seite = await formularHolen(lauf.token);

      expect(seite.statusCode).toBe(200);
      expect(seite.body).toContain(EMAIL);
      expect(seite.body).toContain('name="passwort"');
      expect(seite.body).toContain('name="passwortWiederholung"');
      expect(seite.headers['cache-control']).toBe('no-store');
    });

    it('antwortet auf einen unbekannten Token wie auf eine unbekannte Einladung: neutral 404', async () => {
      const unbekannt = await formularHolen('ein-token-das-es-nicht-gibt');
      const einladung = await app.inject({ method: 'GET', url: '/einladung/ein-token-das-es-nicht-gibt' });
      const leer = await app.inject({ method: 'GET', url: '/zugang-wiederherstellen' });

      expect(unbekannt.statusCode).toBe(404);
      expect(unbekannt.body).toBe(einladung.body);
      expect(leer.statusCode).toBe(404);
      expect(leer.body).toBe(einladung.body);
    });

    it('gilt bis knapp vor Ablauf der drei Stunden und danach nicht mehr', async () => {
      const lauf = await entsperren();

      appJetzt = 3 * HOUR - MINUTE;
      expect((await formularHolen(lauf.token)).statusCode).toBe(200);

      appJetzt = 3 * HOUR + MINUTE;
      expect((await formularHolen(lauf.token)).statusCode).toBe(404);
      const nach = await einloesen(lauf.token);
      expect(nach.statusCode).toBe(404);
      expect(await passwortPruefen({ hash: await passwortHash(konto.id), password: NEU })).toBe(false);
    });

    it('bleibt nach Ablauf gesperrt: das Passwort ist entwertet, ein neuer Link hilft', async () => {
      const lauf = await entsperren();
      appJetzt = 4 * HOUR;
      kommandoJetzt = 4 * HOUR;
      expect((await formularHolen(lauf.token)).statusCode).toBe(404);
      expect((await passwortSchritt(EMAIL, ALT)).statusCode).toBe(400);

      const neu = await entsperren();

      expect(neu.code).toBe(0);
      expect((await einloesen(neu.token)).statusCode).toBe(303);
    });
  });

  describe('Einlösen prüft selbst, nicht nur die Route davor', () => {
    it('lehnt einen abgelaufenen Link ab, auch wenn er der Vorprüfung entgangen wäre (Fenster beim Ablauf)', async () => {
      await entsperren();
      const link = await pool.query<{ id: string }>('SELECT id::text AS id FROM cockpit.zugang_wiederherstellung WHERE benutzer_id = $1', [konto.id]);
      const hashVorher = await passwortHash(konto.id);

      const abgelaufen = new Date(Date.now() + 3 * HOUR + MINUTE);
      const ergebnis = await wiederherstellungEinloesen(pool, link.rows[0]?.id ?? '', await passwortHashen(NEU), abgelaufen);

      expect(ergebnis).toBeUndefined();
      expect(await passwortHash(konto.id)).toBe(hashVorher);
      expect(await offeneLinks(konto.id)).toBe(1);
    });

    it('nimmt den Link und das Passwort gemeinsam zurück, wenn das Protokoll scheitert', async () => {
      const lauf = await entsperren();
      const link = await pool.query<{ id: string }>('SELECT id::text AS id FROM cockpit.zugang_wiederherstellung WHERE benutzer_id = $1', [konto.id]);
      const hashVorher = await passwortHash(konto.id);
      const aufraeumen = await protokollSchreibenScheitern(pool, 'zugang_wiederhergestellt');
      try {
        await expect(
          wiederherstellungEinloesen(pool, link.rows[0]?.id ?? '', await passwortHashen(NEU), new Date()),
        ).rejects.toThrow();
      } finally {
        await aufraeumen();
      }

      expect(await passwortHash(konto.id)).toBe(hashVorher);
      expect(await offeneLinks(konto.id)).toBe(1);
      // Der Link gilt weiter: der Versuch hat ihn nicht verbrannt.
      expect((await einloesen(lauf.token)).statusCode).toBe(303);
    });
  });

  describe('Einlösen', () => {
    it('setzt das neue Passwort, meldet an und führt in die Einrichtung des zweiten Faktors', async () => {
      const marke = await protokollMarke(pool);
      const lauf = await entsperren();

      const antwort = await einloesen(lauf.token);

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/zwei-faktor');
      const cookie = cookieKopf(antwort.headers['set-cookie']);
      expect(cookie).toContain(SITZUNGS_COOKIE_NAME);
      expect(await sitzungen(konto.id)).toBe(1);
      expect(await passwortPruefen({ hash: await passwortHash(konto.id), password: NEU })).toBe(true);
      expect(await offeneLinks(konto.id)).toBe(0);
      // Ohne zweiten Faktor führt das Tor jede Seite außer der Einrichtung dorthin.
      const gesperrt = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
      expect(gesperrt.statusCode).toBe(303);
      expect(gesperrt.headers.location).toBe('/zwei-faktor');
      expect((await app.inject({ method: 'GET', url: '/zwei-faktor', headers: { cookie } })).statusCode).toBe(200);
      expect((await protokollSeit(pool, marke)).map((eintrag) => [eintrag.art, eintrag.akteur, eintrag.ziel])).toEqual([
        ['konto_entsperrt', 'konsole', konto.id],
        ['zugang_wiederhergestellt', 'wiederherstellung', konto.id],
      ]);
    });

    it('lässt sich genau einmal einlösen, auch bei zwei gleichzeitigen Versuchen', async () => {
      const lauf = await entsperren();

      const antworten = await Promise.all([einloesen(lauf.token, NEU), einloesen(lauf.token, 'ein-anderes-langes-passwort')]);

      expect(antworten.map((antwort) => antwort.statusCode).sort()).toEqual([303, 404]);
      expect(await sitzungen(konto.id)).toBe(1);
      expect((await einloesen(lauf.token)).statusCode).toBe(404);
    });

    it.each([
      ['ein zu kurzes Passwort', 'kurz', 'kurz'],
      ['zwei verschiedene Passwörter', NEU, 'ein-anderes-langes-passwort'],
    ])('lehnt %s ab, ohne den Link zu verbrennen', async (_beschreibung, passwort, wiederholung) => {
      const lauf = await entsperren();

      const antwort = await einloesen(lauf.token, passwort, wiederholung);

      expect(antwort.statusCode).toBe(400);
      expect(await offeneLinks(konto.id)).toBe(1);
      expect(await sitzungen(konto.id)).toBe(0);
      expect((await einloesen(lauf.token)).statusCode).toBe(303);
    });

    it('gilt nur für das Konto, für das der Link ausgestellt wurde', async () => {
      const anderes = await kontoEinrichten(app, auth, { email: ANDERE, passwort: ALT, name: 'Nebenan', mitZweitemFaktor: true });
      const meiner = await entsperren(EMAIL);
      const seiner = await entsperren(ANDERE);
      const hashAnderes = await passwortHash(anderes.id);

      const antwort = await einloesen(meiner.token);

      expect(antwort.statusCode).toBe(303);
      expect(await passwortHash(anderes.id)).toBe(hashAnderes);
      expect(await passwortPruefen({ hash: hashAnderes, password: NEU })).toBe(false);
      expect(await sitzungen(anderes.id)).toBe(0);
      // Sein Link bleibt seiner und gilt weiter.
      expect(await offeneLinks(anderes.id)).toBe(1);
      expect((await formularHolen(seiner.token)).body).toContain(ANDERE);
      // Mein neues Passwort öffnet sein Konto nicht.
      expect((await passwortSchritt(ANDERE, NEU)).statusCode).toBe(400);
    });

    it('führt mit TOTP zu einem aktiven Konto, aktiviert_am bleibt, anmelden geht mit dem neuen Passwort', async () => {
      const vorher = await aktiviertAm(konto.id);
      const lauf = await entsperren();
      const antwort = await einloesen(lauf.token);

      const eingerichtet = await totpEinrichten(cookieKopf(antwort.headers['set-cookie']), NEU);

      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(true);
      expect(await aktiviertAm(konto.id)).toEqual(vorher);
      const abgemeldet = await pool.query('DELETE FROM cockpit.session WHERE "userId" = $1', [konto.id]);
      expect(abgemeldet.rowCount).toBeGreaterThanOrEqual(1);
      const schritt1 = await passwortSchritt(EMAIL, NEU);
      expect(schritt1.headers.location).toBe('/anmelden/code');
      const schritt2 = await app.inject({
        method: 'POST',
        url: '/anmelden/code',
        headers: { ...FORMULAR_KOPF, cookie: cookieKopf(schritt1.headers['set-cookie']) },
        payload: formular({ code: await totpCode(auth, eingerichtet.geheimnis) }),
      });
      expect(schritt2.statusCode).toBe(303);
      expect(schritt2.headers.location).toBe('/');
    });

    it('führt mit einem neuen Passkey zu einem aktiven Konto; der alte ist weg', async () => {
      const alt = await kontoEinrichten(app, auth, { email: 'passkey-weg@example.org', passwort: ALT, name: 'PK', mitZweitemFaktor: false });
      const altesGeraet = await passkeyEinrichten(app, alt, ALT, BASIS_URL);
      expect(await passkeys(alt.id)).toBe(1);
      const lauf = await entsperren('passkey-weg@example.org');
      expect(await passkeys(alt.id)).toBe(0);
      const antwort = await einloesen(lauf.token);

      const neu = await passkeyEinrichten(app, { ...alt, cookie: cookieKopf(antwort.headers['set-cookie']) }, NEU, BASIS_URL);

      expect(await zweiterFaktorAktiv(pool, alt.id)).toBe(true);
      expect(await passkeys(alt.id)).toBe(1);
      expect(neu.geraet.kennung).not.toBe(altesGeraet.geraet.kennung);
      expect(neu.ersatzcodes).toHaveLength(10);
    });
  });

  describe('Negativ: was nach dem Entsperren nicht mehr geht', () => {
    it('mit dem alten Passwort lässt sich kein Faktor binden: weder mit der alten Sitzung noch ohne', async () => {
      await entsperren();

      // Die alte Sitzung ist weg: das Tor führt zur Anmeldung, die Einrichtung ist nicht erreichbar.
      const mitAlterSitzung = await app.inject({
        method: 'POST',
        url: '/zwei-faktor/einrichten',
        headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
        payload: formular({ passwort: ALT }),
      });
      const ohneSitzung = await app.inject({
        method: 'POST',
        url: '/zwei-faktor/einrichten',
        headers: FORMULAR_KOPF,
        payload: formular({ passwort: ALT }),
      });
      const passkey = await app.inject({
        method: 'POST',
        url: '/zwei-faktor/passkey/optionen',
        headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
        payload: formular({ passwort: ALT }),
      });

      for (const antwort of [mitAlterSitzung, ohneSitzung, passkey]) {
        expect(antwort.statusCode).toBe(303);
        expect(antwort.headers.location).toBe('/anmelden');
      }
      // Auch direkt an Better Auth vorbei: das Passwort stimmt nicht mehr.
      await expect(auth.api.signInEmail({ body: { email: EMAIL, password: ALT } })).rejects.toThrow();
      expect(await totpZeilen(konto.id)).toBe(0);
      expect(await passkeys(konto.id)).toBe(0);
    });

    it('bekommt mit dem alten Passwort nach dem Einlösen des Links keinen Zugang mehr', async () => {
      const lauf = await entsperren();
      await einloesen(lauf.token);

      const antwort = await passwortSchritt(EMAIL, ALT);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain(PASSWORT_ABGELEHNT);
    });

    it('schreibt weder Token noch Passwörter im Klartext irgendwohin in die Datenbank', async () => {
      const lauf = await entsperren();
      await einloesen(lauf.token);

      const tabellen = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'cockpit' AND table_type = 'BASE TABLE'`,
      );
      expect(tabellen.rows.length).toBeGreaterThan(5);
      for (const { table_name: tabelle } of tabellen.rows) {
        const zeilen = await pool.query<{ text: string }>(`SELECT row_to_json(t)::text AS text FROM cockpit."${tabelle}" t`);
        const inhalt = zeilen.rows.map((zeile) => zeile.text).join('\n');
        expect(inhalt, `${tabelle} enthält den Link`).not.toContain(lauf.token);
        expect(inhalt, `${tabelle} enthält das neue Passwort`).not.toContain(NEU);
        expect(inhalt, `${tabelle} enthält das alte Passwort`).not.toContain(ALT);
      }
    });
  });

  describe('Log', () => {
    it('enthält weder Token noch Passwort: die Token-Pfade sind maskiert, auch die alten', async () => {
      const zeilen: string[] = [];
      const strom = new Writable({
        write(stueck: Buffer, _kodierung, weiter) {
          zeilen.push(stueck.toString());
          weiter();
        },
      });
      const mitLog = buildApp(
        { nodeEnv: 'test' },
        { auth, pool, basisUrl: BASIS_URL, logStrom: strom },
      );
      const lauf = await entsperren();

      await mitLog.inject({ method: 'GET', url: `/zugang-wiederherstellen/${lauf.token}` });
      await mitLog.inject({
        method: 'POST',
        url: `/zugang-wiederherstellen/${lauf.token}`,
        headers: FORMULAR_KOPF,
        payload: formular({ passwort: NEU, passwortWiederholung: NEU }),
      });
      await mitLog.inject({ method: 'GET', url: '/erststart/ein-erststart-token-im-pfad' });
      await mitLog.inject({ method: 'GET', url: '/einladung/ein-einladungs-token-im-pfad' });
      await mitLog.close();

      const log = zeilen.join('');
      expect(log).toContain('/zugang-wiederherstellen/<token>'); // der Log läuft, und maskiert
      expect(log).toContain('/erststart/<token>');
      expect(log).toContain('/einladung/<token>');
      expect(log).not.toContain(lauf.token);
      expect(log).not.toContain(NEU);
      expect(log).not.toContain('ein-erststart-token-im-pfad');
      expect(log).not.toContain('ein-einladungs-token-im-pfad');
    });
  });
});
