/**
 * Anmeldung mit Passkey im zweiten Schritt (COPI-27) gegen eine echte PostgreSQL.
 * Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * ACHTUNG: Der Test räumt `cockpit."user"` (samt Passkeys, Vorgängen, Ersatzcodes),
 * `cockpit.anmeldeversuch` und `cockpit.anmeldevorgang` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 *
 * Der Software-Authenticator aus COPI-26 signiert mit eigenem Schlüsselpaar. Schwerpunkt
 * sind die Negativfälle: jeder scheiternde Versuch endet mit derselben neutralen Antwort,
 * ohne Sitzung — und zwischen Passwort und zweitem Schritt existiert nirgends eine Sitzung.
 *
 * Die Zeit der Vorgänge und Zähler ist über `jetzt` verschiebbar (kein `sleep`).
 */
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ANMELDEVORGANG_COOKIE_NAME, cookieLesen } from '../src/auth/anmeldevorgang.js';
import { erzeugeAuth, SITZUNGS_COOKIE_NAME, type CockpitAuth } from '../src/auth/konfiguration.js';
import { anmeldungPruefen } from '../src/auth/passkey-anmeldung.js';
import type * as PasskeyAnmeldung from '../src/auth/passkey-anmeldung.js';
import { sperrePruefen } from '../src/auth/ratenbegrenzung.js';
import { buildApp } from '../src/server/app.js';
import {
  cookieKopf,
  formular,
  FORMULAR_KOPF,
  kontenLoeschen,
  kontoEinrichten,
  passkeyEinrichten,
  protokollMarke,
  protokollSeit,
  totpCode,
  type Konto,
} from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';
import { SoftwareAuthenticator, type Abweichung } from './webauthn-authenticator.js';

// Die Prüfung des Passkeys läuft echt, wird aber gezählt: die Ratenbegrenzung soll sie
// begrenzen, nicht nur den Zählerstand. Gemessen wird, wie oft sie wirklich lief.
vi.mock('../src/auth/passkey-anmeldung.js', async (importOriginal) => {
  const echt = await importOriginal<typeof PasskeyAnmeldung>();
  return { ...echt, anmeldungPruefen: vi.fn(echt.anmeldungPruefen) };
});

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';
const EMAIL = 'passkey-anmeldung@example.org';
const ANDERE_EMAIL = 'anderes-konto@example.org';
const MINUTE = 60 * 1000;

/** Die eine neutrale Meldung jedes abgelehnten zweiten Schritts. */
const ABGELEHNT = 'Der Code stimmt nicht.';

describe.skipIf(!datenbankUrl)('Anmeldung mit Passkey (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let versatzMs = 0;
  let konto: Konto;
  let geraet: SoftwareAuthenticator;
  let ersatzcodes: string[];

  /** Konto ohne Faktor, dann Passkey über die echten Routen (COPI-26). */
  async function passkeyKonto(email: string) {
    const neu = await kontoEinrichten(app, auth, {
      email,
      passwort: PASSWORT,
      name: 'Passkey-Konto',
      mitZweitemFaktor: false,
    });
    const passkey = await passkeyEinrichten(app, neu, PASSWORT, BASIS_URL);
    return { konto: neu, ...passkey };
  }

  /** Erster Schritt. */
  async function passwortSchritt(email: string, passwort = PASSWORT, kopf: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/anmelden',
      headers: { ...FORMULAR_KOPF, ...kopf },
      payload: formular({ email, passwort }),
    });
  }

  /** Erster Schritt bis zum Codeschritt; liefert die Cookies zwischen den Schritten. */
  async function zwischenCookie(email = EMAIL): Promise<string> {
    const antwort = await passwortSchritt(email);
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden/code');
    return cookieKopf(antwort.headers['set-cookie']);
  }

  async function optionenHolen(cookie: string, kopf: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/anmelden/passkey/optionen',
      headers: { ...FORMULAR_KOPF, cookie, ...kopf },
      payload: '',
    });
  }

  async function pruefen(cookie: string, antwort: unknown, kopf: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/anmelden/passkey/pruefen',
      headers: { ...FORMULAR_KOPF, cookie, ...kopf },
      payload: formular({ antwort: typeof antwort === 'string' ? antwort : JSON.stringify(antwort) }),
    });
  }

  /** Optionen holen, das Gerät signieren lassen (mit gezielter Abweichung), einreichen. */
  async function anmeldung(cookie: string, gerat: SoftwareAuthenticator, abweichung: Abweichung = {}) {
    const optionen = await optionenHolen(cookie);
    expect(optionen.statusCode).toBe(200);
    const aufgabe = optionen.json<PublicKeyCredentialRequestOptionsJSON>();
    const antwort = await pruefen(cookie, gerat.signieren(aufgabe, BASIS_URL, abweichung));
    return { aufgabe, antwort };
  }

  async function codeSchritt(cookie: string, code: string) {
    return app.inject({
      method: 'POST',
      url: '/anmelden/code',
      headers: { ...FORMULAR_KOPF, cookie },
      payload: formular({ code }),
    });
  }

  function sitzungsCookie(antwort: { headers: Record<string, unknown> }): string | undefined {
    return cookieLesen(cookieKopf(antwort.headers['set-cookie'] as string | string[] | undefined), SITZUNGS_COOKIE_NAME);
  }

  async function sitzungenZaehlen(id: string): Promise<number> {
    const ergebnis = await pool.query<{ anzahl: string }>(
      'SELECT count(*)::text AS anzahl FROM cockpit.session WHERE "userId" = $1',
      [id],
    );
    return Number(ergebnis.rows[0]?.anzahl ?? '0');
  }

  async function wurzelseite(cookie: string) {
    return app.inject({ method: 'GET', url: '/', headers: { cookie } });
  }

  /** Was jeder abgelehnte zweite Schritt gemeinsam hat: neutral, ohne Sitzung. */
  async function istNeutralAbgelehnt(antwort: Awaited<ReturnType<typeof pruefen>>, cookie: string, id: string) {
    expect(antwort.statusCode).toBe(400);
    expect(antwort.body).toContain(ABGELEHNT);
    expect(sitzungsCookie(antwort)).toBeUndefined();
    expect(await sitzungenZaehlen(id)).toBe(0);
    const gesperrt = await wurzelseite(cookie);
    expect(gesperrt.statusCode).toBe(303);
    expect(gesperrt.headers.location).toBe('/anmelden');
  }

  async function gespeicherterZaehler(passkeyId: string): Promise<number> {
    const ergebnis = await pool.query<{ zaehler: string }>('SELECT zaehler::text FROM cockpit.passkey WHERE id = $1', [passkeyId]);
    return Number(ergebnis.rows[0]?.zaehler);
  }

  async function passkeyDirekt(id: string, gerat: SoftwareAuthenticator, zaehler = 0): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit.passkey (id, benutzer_id, oeffentlicher_schluessel, zaehler, transports, name)
       VALUES ($1, $2, $3, $4, '{internal}', 'Direkt')`,
      [gerat.kennung, id, gerat.oeffentlicherSchluesselCose, zaehler],
    );
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
  }, 60_000);

  beforeEach(async () => {
    versatzMs = 0;
    vi.mocked(anmeldungPruefen).mockClear();
    await pool.query('DELETE FROM cockpit.anmeldeversuch');
    await pool.query('DELETE FROM cockpit.anmeldevorgang');
    await kontenLoeschen(pool);
    const neu = await passkeyKonto(EMAIL);
    ({ konto, geraet, ersatzcodes } = neu);
    // Die Sitzung aus der Einrichtung gehört nicht zum Test.
    await pool.query('DELETE FROM cockpit.session');
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('Konto nur mit Passkey', () => {
    it('bekommt nach dem Passwort keine Sitzung, sondern den Codeschritt', async () => {
      const antwort = await passwortSchritt(EMAIL);
      const zwischen = cookieKopf(antwort.headers['set-cookie']);

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/anmelden/code');
      expect(cookieLesen(zwischen, ANMELDEVORGANG_COOKIE_NAME)).toBeTruthy();
      expect(sitzungsCookie(antwort)).toBeUndefined();
      expect(await sitzungenZaehlen(konto.id)).toBe(0);
      expect((await wurzelseite(zwischen)).headers.location).toBe('/anmelden');
    });

    it('bekommt auch nach dem Holen der Optionen keine Sitzung', async () => {
      const zwischen = await zwischenCookie();

      const optionen = await optionenHolen(zwischen);

      expect(optionen.statusCode).toBe(200);
      expect(sitzungsCookie(optionen)).toBeUndefined();
      expect(await sitzungenZaehlen(konto.id)).toBe(0);
    });

    it('meldet sich mit Passwort und Passkey an: Sitzung, das Tor lässt durch', async () => {
      const zwischen = await zwischenCookie();

      const { antwort } = await anmeldung(zwischen, geraet);

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/');
      const sitzung = sitzungsCookie(antwort);
      expect(sitzung).toBeTruthy();
      expect(await sitzungenZaehlen(konto.id)).toBe(1);
      const offen = await wurzelseite(`${SITZUNGS_COOKIE_NAME}=${sitzung ?? ''}`);
      expect(offen.statusCode).toBe(200);
      // Der Anmeldevorgang ist verbraucht, sein Cookie wird abgeräumt.
      expect(cookieKopf(antwort.headers['set-cookie'])).not.toContain(`${ANMELDEVORGANG_COOKIE_NAME}=${cookieLesen(zwischen, ANMELDEVORGANG_COOKIE_NAME) ?? 'x'}`);
      const vorgang = await pool.query('SELECT 1 FROM cockpit.anmeldevorgang WHERE verbraucht_am IS NULL');
      expect(vorgang.rowCount).toBe(0);
    });

    it('bietet dem Passkey-Konto den Passkey an, einem Konto ohne Passkey nicht', async () => {
      const mitPasskey = await app.inject({ method: 'GET', url: '/anmelden/code', headers: { cookie: await zwischenCookie() } });
      const totp = await kontoEinrichten(app, auth, { email: 'nur-totp@example.org', passwort: PASSWORT, name: 'Nur TOTP', mitZweitemFaktor: true });
      const ohnePasskey = await app.inject({
        method: 'GET',
        url: '/anmelden/code',
        headers: { cookie: await zwischenCookie('nur-totp@example.org') },
      });

      expect(mitPasskey.body).toContain('data-passkey-anmelden');
      expect(mitPasskey.body).toContain('/anmelden/passkey/skript.js');
      expect(ohnePasskey.body).not.toContain('data-passkey-anmelden');
      expect(ohnePasskey.body).toContain('name="code"'); // TOTP bleibt
      expect(totp.id).toBeTruthy();
    });

    it('liefert das Browser-Skript schon vor der Anmeldung aus, ohne Sitzung', async () => {
      const antwort = await app.inject({ method: 'GET', url: '/anmelden/passkey/skript.js' });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['content-type']).toMatch(/^text\/javascript/);
      expect(antwort.body).toContain('navigator.credentials.get');
    });

    it('verlangt die Optionen nach Passwort und mit Benutzerprüfung, nur mit dem Passkey des Kontos', async () => {
      const zwischen = await zwischenCookie();

      const antwort = await optionenHolen(zwischen);
      const aufgabe = antwort.json<PublicKeyCredentialRequestOptionsJSON>();

      expect(antwort.headers['cache-control']).toBe('no-store');
      expect(aufgabe.rpId).toBe('localhost');
      expect(aufgabe.userVerification).toBe('required');
      expect(aufgabe.allowCredentials?.map((eintrag) => eintrag.id)).toEqual([geraet.kennung]);
      expect(aufgabe.challenge.length).toBeGreaterThanOrEqual(32);
    });

    it('protokolliert die Anmeldung genau einmal, erst nach dem zweiten Schritt, ohne Kennung des Geräts', async () => {
      const marke = await protokollMarke(pool);
      const zwischen = await zwischenCookie();
      expect(await protokollSeit(pool, marke)).toEqual([]);

      await anmeldung(zwischen, geraet);

      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege).toEqual([
        {
          art: 'anmeldung_erfolgreich',
          akteur: konto.id,
          ziel: null,
          einzelheiten: { schritt: 'code', faktor: 'passkey' },
        },
      ]);
      expect(JSON.stringify(eintraege)).not.toContain(geraet.kennung);
    });
  });

  describe('Negativ: ohne Sitzung, dieselbe neutrale Antwort', () => {
    it.each([
      ['eine falsche Challenge', { challenge: 'ZmFsc2NoZS1jaGFsbGVuZ2U' }],
      ['eine falsche Herkunft', { origin: 'https://boese.example' }],
      ['eine falsche rpID', { rpId: 'boese.example' }],
      ['fehlende Benutzerprüfung (kein PIN, keine Biometrie)', { benutzerPruefung: false }],
    ])('bei %s', async (_beschreibung, abweichung) => {
      const marke = await protokollMarke(pool);
      const zwischen = await zwischenCookie();

      const { antwort } = await anmeldung(zwischen, geraet, abweichung);

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'anmeldung_fehlgeschlagen',
          akteur: 'system',
          ziel: konto.id,
          einzelheiten: { schritt: 'code', faktor: 'passkey' },
        },
      ]);
    });

    it('bei einer falschen Signatur: zur Kennung passend, aber mit einem anderen Schlüssel', async () => {
      const zwischen = await zwischenCookie();
      const nachgemacht = new SoftwareAuthenticator(geraet.kennungAlsBytes);

      const { antwort } = await anmeldung(zwischen, nachgemacht);

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
    });

    it('bei einem fremden Schlüssel: ein Gerät, das zu diesem Konto nicht gehört', async () => {
      const zwischen = await zwischenCookie();

      const { antwort } = await anmeldung(zwischen, new SoftwareAuthenticator());

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
    });

    it('bei einem Passkey, der einem anderen Konto gehört, auch wenn er gültig signiert', async () => {
      const anderes = await passkeyKonto(ANDERE_EMAIL);
      await pool.query('DELETE FROM cockpit.session');
      const zwischen = await zwischenCookie();

      const { antwort } = await anmeldung(zwischen, anderes.geraet);

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
      expect(await sitzungenZaehlen(anderes.konto.id)).toBe(0);
    });

    it('bei einer wiederverwendeten Challenge: nach einem Fehlversuch ist sie verbraucht', async () => {
      const zwischen = await zwischenCookie();
      const optionen = (await optionenHolen(zwischen)).json<PublicKeyCredentialRequestOptionsJSON>();
      const falsch = await pruefen(zwischen, geraet.signieren(optionen, BASIS_URL, { origin: 'https://boese.example' }));
      expect(falsch.statusCode).toBe(400);

      // Dieselbe Challenge, jetzt richtig signiert: sie gilt nicht mehr.
      const richtig = await pruefen(zwischen, geraet.signieren(optionen, BASIS_URL));

      await istNeutralAbgelehnt(richtig, zwischen, konto.id);
    });

    it('bei Wiederholung derselben Antwort nach Erfolg: der Vorgang ist verbraucht, keine zweite Sitzung', async () => {
      const zwischen = await zwischenCookie();
      const optionen = (await optionenHolen(zwischen)).json<PublicKeyCredentialRequestOptionsJSON>();
      const antwort = geraet.signieren(optionen, BASIS_URL);
      expect((await pruefen(zwischen, antwort)).statusCode).toBe(303);

      const wiederholt = await pruefen(zwischen, antwort);

      expect(wiederholt.statusCode).toBe(303);
      expect(wiederholt.headers.location).toBe('/anmelden');
      expect(sitzungsCookie(wiederholt)).toBeUndefined();
      expect(await sitzungenZaehlen(konto.id)).toBe(1);
    });

    it('bei abgelaufener Challenge (nach 5 Minuten), auch wenn der Anmeldevorgang noch gilt', async () => {
      const zwischen = await zwischenCookie();
      const optionen = (await optionenHolen(zwischen)).json<PublicKeyCredentialRequestOptionsJSON>();
      const antwort = geraet.signieren(optionen, BASIS_URL);

      versatzMs = 5 * MINUTE + 1000;
      const ergebnis = await pruefen(zwischen, antwort);

      await istNeutralAbgelehnt(ergebnis, zwischen, konto.id);
    });

    it('gilt noch knapp vor Ablauf der Challenge', async () => {
      const zwischen = await zwischenCookie();
      const optionen = (await optionenHolen(zwischen)).json<PublicKeyCredentialRequestOptionsJSON>();
      const antwort = geraet.signieren(optionen, BASIS_URL);

      versatzMs = 5 * MINUTE - 5000;
      const ergebnis = await pruefen(zwischen, antwort);

      expect(ergebnis.statusCode).toBe(303);
    });

    it('bei nicht abgeschlossener Zeremonie: keine Optionen geholt, eine Antwort auf eine erfundene Challenge', async () => {
      const zwischen = await zwischenCookie();
      const erfunden = { challenge: 'ZXJmdW5kZW5l', rpId: 'localhost', userVerification: 'required' as const };

      const antwort = await pruefen(zwischen, geraet.signieren(erfunden, BASIS_URL));

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
    });

    it('bei einem Anmeldevorgang eines anderen Kontos: die Challenge gehört zu einem Vorgang', async () => {
      const anderes = await passkeyKonto(ANDERE_EMAIL);
      await pool.query('DELETE FROM cockpit.session');
      const meinVorgang = await zwischenCookie();
      const seinVorgang = await zwischenCookie(ANDERE_EMAIL);
      const meineOptionen = (await optionenHolen(meinVorgang)).json<PublicKeyCredentialRequestOptionsJSON>();
      const seineOptionen = (await optionenHolen(seinVorgang)).json<PublicKeyCredentialRequestOptionsJSON>();

      // Mein Gerät, aber die Challenge des anderen Vorgangs.
      const vermischt = await pruefen(meinVorgang, geraet.signieren(seineOptionen, BASIS_URL));
      await istNeutralAbgelehnt(vermischt, meinVorgang, konto.id);

      // Sein Gerät auf meine Challenge, im Vorgang des anderen: die Challenge stimmt nicht.
      const umgekehrt = await pruefen(seinVorgang, anderes.geraet.signieren(meineOptionen, BASIS_URL));
      await istNeutralAbgelehnt(umgekehrt, seinVorgang, anderes.konto.id);
    });

    it('bei einer Challenge aus einem fremden Vorgang, auch wenn das eigene Gerät sie signiert und der eigene Vorgang keine hat', async () => {
      const anderes = await passkeyKonto(ANDERE_EMAIL);
      await pool.query('DELETE FROM cockpit.session');
      const meinVorgang = await zwischenCookie();
      const seinVorgang = await zwischenCookie(ANDERE_EMAIL);
      // Nur der andere Vorgang hat eine offene Challenge; meiner hat nie Optionen geholt.
      const seineOptionen = (await optionenHolen(seinVorgang)).json<PublicKeyCredentialRequestOptionsJSON>();

      const antwort = await pruefen(meinVorgang, geraet.signieren(seineOptionen, BASIS_URL));

      await istNeutralAbgelehnt(antwort, meinVorgang, konto.id);
      // Seine Challenge bleibt unberührt: er kann sich damit noch anmelden.
      const seine = await pruefen(seinVorgang, anderes.geraet.signieren(seineOptionen, BASIS_URL));
      expect(seine.statusCode).toBe(303);
    });

    it('bei kaputten Antworten: 400, ohne dass die Prüfung läuft oder ein Versuch verbraucht wird', async () => {
      const zwischen = await zwischenCookie();
      await optionenHolen(zwischen);

      for (const kaputt of ['das-ist-kein-json', '[]', '{}', '{"id":1,"rawId":2,"response":3,"type":4}', '']) {
        const antwort = await pruefen(zwischen, kaputt);
        expect(antwort.statusCode, kaputt).toBe(400);
        expect(sitzungsCookie(antwort)).toBeUndefined();
      }
      expect(vi.mocked(anmeldungPruefen)).not.toHaveBeenCalled();
      expect(await sitzungenZaehlen(konto.id)).toBe(0);
    });

    it('nennt in der Antwort keinen Grund der Bibliothek', async () => {
      const zwischen = await zwischenCookie();

      const { antwort } = await anmeldung(zwischen, geraet, { origin: 'https://boese.example' });

      expect(antwort.body).not.toMatch(/origin|challenge|rpID|boese|signature/i);
    });
  });

  describe('Signaturzähler', () => {
    async function anmeldenMitZaehler(zaehler: number | undefined) {
      const zwischen = await zwischenCookie();
      return {
        zwischen,
        ...(await anmeldung(zwischen, geraet, zaehler === undefined ? {} : { zaehler })),
      };
    }

    it('steigt mit jeder Anmeldung und wird gespeichert', async () => {
      expect(await gespeicherterZaehler(geraet.kennung)).toBe(0);

      for (const erwartet of [1, 2, 3]) {
        const { antwort } = await anmeldenMitZaehler(undefined);
        expect(antwort.statusCode).toBe(303);
        expect(await gespeicherterZaehler(geraet.kennung)).toBe(erwartet);
      }
    });

    it.each([
      ['zurückgegangen', 5],
      ['unverändert', 10],
    ])('lehnt einen Zähler ab, der %s ist, und lässt den gespeicherten Wert stehen', async (_beschreibung, zaehler) => {
      await pool.query('UPDATE cockpit.passkey SET zaehler = 10 WHERE id = $1', [geraet.kennung]);
      const marke = await protokollMarke(pool);

      const { antwort, zwischen } = await anmeldenMitZaehler(zaehler);

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
      expect(await gespeicherterZaehler(geraet.kennung)).toBe(10);
      // Ein Klon ist ein Sicherheitsereignis: der Eintrag unterscheidet sich vom Tippfehler.
      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'anmeldung_fehlgeschlagen',
          akteur: 'system',
          ziel: konto.id,
          einzelheiten: { schritt: 'passkey_zaehler', faktor: 'passkey' },
        },
      ]);
    });

    it('nimmt einen höheren Zähler an, auch mit Sprung', async () => {
      await pool.query('UPDATE cockpit.passkey SET zaehler = 10 WHERE id = $1', [geraet.kennung]);

      const { antwort } = await anmeldenMitZaehler(500);

      expect(antwort.statusCode).toBe(303);
      expect(await gespeicherterZaehler(geraet.kennung)).toBe(500);
    });

    it('lässt ein Gerät ohne Zähler zu: 0 gespeichert, 0 geliefert, jedes Mal', async () => {
      for (let mal = 0; mal < 2; mal += 1) {
        const { antwort } = await anmeldenMitZaehler(0);
        expect(antwort.statusCode).toBe(303);
      }
      expect(await gespeicherterZaehler(geraet.kennung)).toBe(0);
    });

    it('lehnt 0 ab, sobald ein Zähler gespeichert ist: ein zurückgesetztes Gerät ist kein derselbe Passkey', async () => {
      await pool.query('UPDATE cockpit.passkey SET zaehler = 3 WHERE id = $1', [geraet.kennung]);

      const { antwort, zwischen } = await anmeldenMitZaehler(0);

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
    });
  });

  describe('Ratenbegrenzung', () => {
    it('sperrt nach fünf Fehlversuchen: der sechste, richtige Versuch wird abgewiesen', async () => {
      const marke = await protokollMarke(pool);
      const zwischen = await zwischenCookie();
      for (let versuch = 1; versuch <= 5; versuch += 1) {
        await anmeldung(zwischen, geraet, { challenge: 'ZmFsc2NoZS1jaGFsbGVuZ2U' });
      }
      expect(await sperrePruefen(pool, 'code-konto', konto.id, new Date(Date.now() + versatzMs))).toBe(true);

      const richtig = await anmeldung(zwischen, geraet);

      await istNeutralAbgelehnt(richtig.antwort, zwischen, konto.id);
      const sperren = (await protokollSeit(pool, marke)).filter((eintrag) => eintrag.art === 'sperre_ausgeloest');
      expect(sperren).toEqual([
        { art: 'sperre_ausgeloest', akteur: 'system', ziel: konto.id, einzelheiten: { sperre: 'code-konto' } },
      ]);
    });

    it('sperrt auch mit einem frischen Anmeldevorgang und richtigem Passkey', async () => {
      const zwischen = await zwischenCookie();
      for (let versuch = 1; versuch <= 5; versuch += 1) {
        await anmeldung(zwischen, geraet, { challenge: 'ZmFsc2NoZS1jaGFsbGVuZ2U' });
      }

      const neu = await zwischenCookie();
      const { antwort } = await anmeldung(neu, geraet);

      await istNeutralAbgelehnt(antwort, neu, konto.id);
    });

    it('zählt Passkey, TOTP und Ersatzcode zusammen: ein Zähler je Konto', async () => {
      const zwischen = await zwischenCookie();
      for (let versuch = 1; versuch <= 3; versuch += 1) {
        await codeSchritt(zwischen, '000000');
      }
      for (let versuch = 1; versuch <= 2; versuch += 1) {
        await anmeldung(zwischen, geraet, { challenge: 'ZmFsc2NoZS1jaGFsbGVuZ2U' });
      }

      const { antwort } = await anmeldung(zwischen, geraet);

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
    });

    it('lässt die Sperre nach fünfzehn Minuten ablaufen', async () => {
      const zwischen = await zwischenCookie();
      for (let versuch = 1; versuch <= 5; versuch += 1) {
        await anmeldung(zwischen, geraet, { challenge: 'ZmFsc2NoZS1jaGFsbGVuZ2U' });
      }

      versatzMs = 16 * MINUTE;
      const neu = await zwischenCookie();
      const { antwort } = await anmeldung(neu, geraet);

      expect(antwort.statusCode).toBe(303);
    });

    it('setzt den Zähler nach erfolgreicher Anmeldung zurück', async () => {
      const zwischen = await zwischenCookie();
      for (let versuch = 1; versuch <= 4; versuch += 1) {
        await anmeldung(zwischen, geraet, { challenge: 'ZmFsc2NoZS1jaGFsbGVuZ2U' });
      }
      expect((await anmeldung(zwischen, geraet)).antwort.statusCode).toBe(303);

      // Vier weitere Fehlversuche wären ohne Zurücksetzen der neunte, und damit gesperrt.
      const neu = await zwischenCookie();
      for (let versuch = 1; versuch <= 4; versuch += 1) {
        await anmeldung(neu, geraet, { challenge: 'ZmFsc2NoZS1jaGFsbGVuZ2U' });
      }

      expect((await anmeldung(neu, geraet)).antwort.statusCode).toBe(303);
    });

    // Gemessen wird nicht der Zählerstand, sondern wie oft die eigentliche Prüfung wirklich
    // gelaufen ist. Ein Zähler, der erst nach der Prüfung hochgeht, sieht am Ende richtig
    // aus und hat trotzdem beliebig viele Prüfungen durchgelassen.
    it('lässt höchstens fünf Prüfungen je Konto gleichzeitig laufen', async () => {
      const zwischen = await zwischenCookie();
      const optionen = (await optionenHolen(zwischen)).json<PublicKeyCredentialRequestOptionsJSON>();
      const antwort = geraet.signieren(optionen, BASIS_URL, { origin: 'https://boese.example' });

      await Promise.all(Array.from({ length: 40 }, () => pruefen(zwischen, antwort)));

      expect(vi.mocked(anmeldungPruefen).mock.calls.length).toBeLessThanOrEqual(5);
      expect(await sperrePruefen(pool, 'code-konto', konto.id, new Date())).toBe(true);
    });

    it('weist ein Formular von fremder Herkunft ab, ohne zu zählen', async () => {
      const zwischen = await zwischenCookie();
      const optionen = (await optionenHolen(zwischen)).json<PublicKeyCredentialRequestOptionsJSON>();

      const fremd = await pruefen(zwischen, geraet.signieren(optionen, BASIS_URL), { origin: 'https://boese.example' });
      const fremdeOptionen = await optionenHolen(zwischen, { origin: 'https://boese.example' });

      expect(fremd.statusCode).toBe(403);
      expect(fremdeOptionen.statusCode).toBe(403);
      const zaehler = await pool.query('SELECT 1 FROM cockpit.anmeldeversuch WHERE art = $1', ['code-konto']);
      expect(zaehler.rowCount).toBe(0);
      expect(vi.mocked(anmeldungPruefen)).not.toHaveBeenCalled();
    });
  });

  describe('Ohne Anmeldevorgang', () => {
    it.each(['optionen', 'pruefen'])('leitet /anmelden/passkey/%s auf die Anmeldung um', async (schritt) => {
      const antwort = await app.inject({
        method: 'POST',
        url: `/anmelden/passkey/${schritt}`,
        headers: FORMULAR_KOPF,
        payload: formular({ antwort: '{}' }),
      });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/anmelden');
    });

    it('gibt einem Konto ohne Passkey keine Optionen', async () => {
      await kontoEinrichten(app, auth, { email: 'nur-totp@example.org', passwort: PASSWORT, name: 'Nur TOTP', mitZweitemFaktor: true });
      const zwischen = await zwischenCookie('nur-totp@example.org');

      const antwort = await optionenHolen(zwischen);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'Der Passkey konnte nicht verwendet werden.' });
    });
  });

  describe('Rückfall: Ersatzcode', () => {
    it('meldet ein Passkey-Konto mit einem Ersatzcode an, genau einmal', async () => {
      const marke = await protokollMarke(pool);
      const zwischen = await zwischenCookie();
      const code = ersatzcodes[0] ?? '';

      const erster = await codeSchritt(zwischen, code);

      expect(erster.statusCode).toBe(303);
      expect(sitzungsCookie(erster)).toBeTruthy();
      expect(await sitzungenZaehlen(konto.id)).toBe(1);
      expect((await protokollSeit(pool, marke)).map((eintrag) => [eintrag.art, eintrag.einzelheiten])).toEqual([
        ['ersatzcode_verwendet', {}],
        ['anmeldung_erfolgreich', { schritt: 'code', faktor: 'ersatzcode' }],
      ]);

      await pool.query('DELETE FROM cockpit.session');
      const zweiter = await codeSchritt(await zwischenCookie(), code);
      await istNeutralAbgelehnt(zweiter, '', konto.id);
    });

    it('lehnt einen falschen Ersatzcode ab und lässt die richtigen unverbraucht', async () => {
      const zwischen = await zwischenCookie();

      const antwort = await codeSchritt(zwischen, 'aaaaa-bbbbb');

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
      const offen = await pool.query('SELECT 1 FROM cockpit.ersatzcode WHERE benutzer_id = $1 AND verbraucht_am IS NULL', [konto.id]);
      expect(offen.rowCount).toBe(10);
    });

    it('löst einen Ersatzcode auch bei zwei gleichzeitigen Versuchen nur einmal ein', async () => {
      const code = ersatzcodes[1] ?? '';
      // Ein Vorgang, zwei gleichzeitige Anfragen (ein zweiter Vorgang würde den ersten entwerten).
      const zwischen = await zwischenCookie();

      const antworten = await Promise.all([codeSchritt(zwischen, code), codeSchritt(zwischen, code)]);

      const angemeldet = antworten.filter((antwort) => sitzungsCookie(antwort) !== undefined);
      expect(angemeldet).toHaveLength(1);
      expect(angemeldet[0]?.headers.location).toBe('/');
      expect(await sitzungenZaehlen(konto.id)).toBe(1);
      const verbraucht = await pool.query('SELECT 1 FROM cockpit.ersatzcode WHERE benutzer_id = $1 AND verbraucht_am IS NOT NULL', [konto.id]);
      expect(verbraucht.rowCount).toBe(1);
    });

    it('nimmt für ein Passkey-Konto keinen sechsstelligen Code: es gibt kein TOTP', async () => {
      const zwischen = await zwischenCookie();

      const antwort = await codeSchritt(zwischen, '123456');

      await istNeutralAbgelehnt(antwort, zwischen, konto.id);
    });
  });

  describe('Rückfall: TOTP bei einem Konto mit Passkey und TOTP', () => {
    let beide: Konto;
    let zweitesGeraet: SoftwareAuthenticator;

    beforeEach(async () => {
      beide = await kontoEinrichten(app, auth, {
        email: 'beide@example.org',
        passwort: PASSWORT,
        name: 'Beide',
        mitZweitemFaktor: true,
      });
      zweitesGeraet = new SoftwareAuthenticator();
      await passkeyDirekt(beide.id, zweitesGeraet);
      await pool.query('DELETE FROM cockpit.session');
    });

    it('bietet beides an und lässt TOTP unverändert zu', async () => {
      const zwischen = await zwischenCookie('beide@example.org');

      const seite = await app.inject({ method: 'GET', url: '/anmelden/code', headers: { cookie: zwischen } });
      const antwort = await codeSchritt(zwischen, await totpCode(auth, beide.geheimnis));

      expect(seite.body).toContain('data-passkey-anmelden');
      expect(seite.body).toContain('name="code"');
      expect(antwort.statusCode).toBe(303);
      expect(sitzungsCookie(antwort)).toBeTruthy();
    });

    it('meldet mit dem Passkey an und räumt den Cookie von Better Auth zwischen den Schritten ab', async () => {
      const zwischen = await zwischenCookie('beide@example.org');
      expect(zwischen).toContain('two_factor=');

      const { antwort } = await anmeldung(zwischen, zweitesGeraet);

      expect(antwort.statusCode).toBe(303);
      expect(sitzungsCookie(antwort)).toBeTruthy();
      const gesetzt = ([] as string[]).concat(antwort.headers['set-cookie'] ?? []);
      expect(gesetzt.some((eintrag) => /two_factor=;.*Max-Age=0/.test(eintrag))).toBe(true);
    });
  });

  describe('Der Sitzungs-Endpunkt ist nur im Prozess erreichbar', () => {
    it('gibt es über Better Auths eigenen HTTP-Router nicht: 404, keine Sitzung', async () => {
      const antwort = await auth.handler(
        new Request(`${BASIS_URL}/api/auth/cockpit/sitzung-nach-zweitem-faktor`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASIS_URL },
          body: JSON.stringify({ benutzerId: konto.id }),
        }),
      );

      expect(antwort.status).toBe(404);
      expect(await sitzungenZaehlen(konto.id)).toBe(0);
    });

    it('bleibt auch am zentralen Tor zu, mit und ohne Sitzung', async () => {
      const mitSitzung = await kontoEinrichten(app, auth, { email: 'mit-sitzung@example.org', passwort: PASSWORT, name: 'M', mitZweitemFaktor: true });

      for (const cookie of ['', mitSitzung.cookie]) {
        const antwort = await app.inject({
          method: 'POST',
          url: '/api/auth/cockpit/sitzung-nach-zweitem-faktor',
          headers: { 'content-type': 'application/json', cookie },
          payload: { benutzerId: konto.id },
        });
        expect(antwort.statusCode).toBe(404);
      }
      expect(await sitzungenZaehlen(konto.id)).toBe(0);
    });

    it('legt für ein unbekanntes Konto keine Sitzung an', async () => {
      await expect(auth.api.sitzungNachZweitemFaktor({ body: { benutzerId: 'gibt-es-nicht' } })).rejects.toThrow();
    });
  });
});
