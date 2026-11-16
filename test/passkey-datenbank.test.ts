/**
 * Passkey als zweiter Faktor einrichten (COPI-26) gegen eine echte PostgreSQL.
 * Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * ACHTUNG: Der Test räumt `cockpit."user"` (samt Passkeys, Vorgängen und
 * Ersatzcodes), `cockpit.anmeldeversuch` und `cockpit.anmeldevorgang` ab.
 * Niemals gegen eine Kundendatenbank laufen lassen.
 *
 * Ein Software-Authenticator (`webauthn-authenticator.ts`) signiert mit eigenem
 * Schlüsselpaar, ohne Browser. Der Schwerpunkt liegt auf den Negativfällen: jede
 * fehlerhafte Zeremonie lässt das Konto **ohne** aktiven Faktor zurück — kein
 * Passkey, keine Ersatzcodes, kein `aktiviert_am`.
 *
 * Die Zeit der Vorgänge ist über `jetzt` verschiebbar (kein `sleep`).
 */
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { kontoVerfallen } from '../src/auth/konto-verfall.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import {
  passkeyKonfiguration,
  registrierungAbschliessen,
  registrierungBeginnen,
} from '../src/auth/passkey.js';
import { zweiterFaktorAktiv } from '../src/auth/zweiter-faktor.js';
import { buildApp } from '../src/server/app.js';
import {
  ersatzcodesAusSeite,
  formular,
  FORMULAR_KOPF,
  kontenLoeschen,
  kontoEinrichten,
  protokollMarke,
  protokollSchreibenScheitern,
  protokollSeit,
  type Konto,
} from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';
import { SoftwareAuthenticator, type Abweichung } from './webauthn-authenticator.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';
const MINUTE = 60 * 1000;

const EMAIL = 'passkey@example.org';

describe.skipIf(!datenbankUrl)('Passkey einrichten (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let versatzMs = 0;
  let konto: Konto;

  async function neuesKonto(email: string, mitTotp = false): Promise<Konto> {
    return kontoEinrichten(app, auth, {
      email,
      passwort: PASSWORT,
      name: 'Passkey-Konto',
      mitZweitemFaktor: mitTotp,
    });
  }

  /** Schritt 1: Passwort bestätigen, Optionen für das Gerät holen. */
  async function optionenHolen(cookie: string, passwort = PASSWORT) {
    return app.inject({
      method: 'POST',
      url: '/zwei-faktor/passkey/optionen',
      headers: { ...FORMULAR_KOPF, cookie },
      payload: formular({ passwort }),
    });
  }

  /** Schritt 3: die Antwort des Geräts einreichen. */
  async function pruefen(cookie: string, antwort: unknown, name = 'Mein Laptop') {
    return app.inject({
      method: 'POST',
      url: '/zwei-faktor/passkey/pruefen',
      headers: { ...FORMULAR_KOPF, cookie },
      payload: formular({ antwort: typeof antwort === 'string' ? antwort : JSON.stringify(antwort), name }),
    });
  }

  /** Die ganze Zeremonie: Optionen, Gerät, Prüfung. Optional mit einer gezielten Abweichung. */
  async function zeremonie(
    einKonto: Konto,
    abweichung: Abweichung = {},
    geraet: SoftwareAuthenticator = new SoftwareAuthenticator(),
  ) {
    const optionen = await optionenHolen(einKonto.cookie);
    expect(optionen.statusCode).toBe(200);
    const aufgabe = optionen.json<PublicKeyCredentialCreationOptionsJSON>();
    const antwort = await pruefen(einKonto.cookie, geraet.registrieren(aufgabe, BASIS_URL, abweichung));
    return { aufgabe, geraet, antwort };
  }

  async function zaehlen(tabelle: string, id: string): Promise<number> {
    const ergebnis = await pool.query<{ anzahl: string }>(
      `SELECT count(*)::text AS anzahl FROM cockpit.${tabelle} WHERE benutzer_id = $1`,
      [id],
    );
    return Number(ergebnis.rows[0]?.anzahl ?? '0');
  }

  async function aktiviertAm(id: string): Promise<Date | null> {
    const ergebnis = await pool.query<{ aktiviert_am: Date | null }>(
      'SELECT aktiviert_am FROM cockpit."user" WHERE id = $1',
      [id],
    );
    return ergebnis.rows[0]?.aktiviert_am ?? null;
  }

  /** Nach einer gescheiterten Zeremonie: kein Faktor, kein Passkey, keine Codes, kein Marker. */
  async function bleibtOhneFaktor(id: string): Promise<void> {
    expect(await zweiterFaktorAktiv(pool, id)).toBe(false);
    expect(await zaehlen('passkey', id)).toBe(0);
    expect(await zaehlen('ersatzcode', id)).toBe(0);
    expect(await aktiviertAm(id)).toBeNull();
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
    await pool.query('DELETE FROM cockpit.anmeldeversuch');
    await pool.query('DELETE FROM cockpit.anmeldevorgang');
    await kontenLoeschen(pool);
    konto = await neuesKonto(EMAIL);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('Einrichtungsseite', () => {
    it('bietet neben TOTP den Passkey an und liefert das Skript vom eigenen Ursprung', async () => {
      const seite = await app.inject({ method: 'GET', url: '/zwei-faktor', headers: { cookie: konto.cookie } });

      expect(seite.statusCode).toBe(200);
      expect(seite.body).toContain('action="/zwei-faktor/einrichten"'); // TOTP bleibt erreichbar
      expect(seite.body).toContain('data-passkey');
      expect(seite.body).toContain('/zwei-faktor/passkey/skript.js');
      expect(seite.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // kein Inline-Skript
    });

    it('liefert das Skript als JavaScript aus, nur mit Sitzung', async () => {
      const mitSitzung = await app.inject({
        method: 'GET',
        url: '/zwei-faktor/passkey/skript.js',
        headers: { cookie: konto.cookie },
      });
      const ohneSitzung = await app.inject({ method: 'GET', url: '/zwei-faktor/passkey/skript.js' });

      expect(mitSitzung.statusCode).toBe(200);
      expect(mitSitzung.headers['content-type']).toMatch(/^text\/javascript/);
      expect(mitSitzung.body).toContain('navigator.credentials.create');
      expect(ohneSitzung.statusCode).toBe(303);
      expect(ohneSitzung.headers.location).toBe('/anmelden');
    });
  });

  describe('Optionen', () => {
    it('liefert Optionen aus der festen Basis-URL: rpID, Benutzerprüfung verlangt, Attestation none', async () => {
      const antwort = await optionenHolen(konto.cookie);
      const optionen = antwort.json<PublicKeyCredentialCreationOptionsJSON>();

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['content-type']).toMatch(/^application\/json/);
      expect(antwort.headers['cache-control']).toBe('no-store');
      expect(optionen.rp).toEqual({ id: 'localhost', name: 'Cockpit' });
      expect(optionen.authenticatorSelection?.userVerification).toBe('required');
      expect(optionen.attestation).toBe('none');
      expect(optionen.challenge.length).toBeGreaterThanOrEqual(32);
      expect(optionen.user.name).toBe(EMAIL);
      // Die Kennung des Kontos am Gerät ist die Konto-ID, keine Adresse.
      expect(Buffer.from(optionen.user.id, 'base64url').toString('utf8')).toBe(konto.id);
    });

    it('lehnt ein falsches Passwort ab und legt keine Challenge an', async () => {
      const antwort = await optionenHolen(konto.cookie, 'ein-ganz-anderes-passwort');

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'Das Passwort ist nicht korrekt.' });
      expect(await zaehlen('passkey_vorgang', konto.id)).toBe(0);
    });

    it('lehnt ein leeres Passwort ab', async () => {
      const antwort = await optionenHolen(konto.cookie, '');

      expect(antwort.statusCode).toBe(400);
      expect(await zaehlen('passkey_vorgang', konto.id)).toBe(0);
    });

    it('hält je Konto höchstens eine offene Challenge: die zweite ersetzt die erste', async () => {
      const erste = (await optionenHolen(konto.cookie)).json<PublicKeyCredentialCreationOptionsJSON>();
      const zweite = (await optionenHolen(konto.cookie)).json<PublicKeyCredentialCreationOptionsJSON>();

      expect(zweite.challenge).not.toBe(erste.challenge);
      expect(await zaehlen('passkey_vorgang', konto.id)).toBe(1);
    });
  });

  describe('Registrierung gelingt', () => {
    it('macht den zweiten Faktor aktiv, setzt aktiviert_am und lässt die Sitzung durchs Tor', async () => {
      expect((await app.inject({ method: 'GET', url: '/', headers: { cookie: konto.cookie } })).statusCode).toBe(303);
      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(false);
      expect(await aktiviertAm(konto.id)).toBeNull();

      const { antwort, geraet } = await zeremonie(konto);

      expect(antwort.statusCode).toBe(200);
      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(true);
      expect(await aktiviertAm(konto.id)).toBeInstanceOf(Date);
      const tor = await app.inject({ method: 'GET', url: '/', headers: { cookie: konto.cookie } });
      expect(tor.statusCode).toBe(200);
      const zeile = await pool.query<{
        id: string;
        zaehler: string;
        name: string;
        transports: string[];
      }>('SELECT id, zaehler::text, name, transports FROM cockpit.passkey WHERE benutzer_id = $1', [konto.id]);
      expect(zeile.rows).toEqual([
        { id: geraet.kennung, zaehler: '0', name: 'Mein Laptop', transports: ['internal'] },
      ]);
    });

    it('zeigt zehn Ersatzcodes einmal an und speichert nur deren Argon2id-Hash', async () => {
      const { antwort } = await zeremonie(konto);

      const codes = ersatzcodesAusSeite(antwort.body);
      expect(antwort.headers['cache-control']).toBe('no-store');
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      const gespeichert = await pool.query<{ code_hash: string; verbraucht_am: Date | null }>(
        'SELECT code_hash, verbraucht_am FROM cockpit.ersatzcode WHERE benutzer_id = $1',
        [konto.id],
      );
      expect(gespeichert.rows).toHaveLength(10);
      for (const zeile of gespeichert.rows) {
        expect(zeile.code_hash).toMatch(/^\$argon2id\$/);
        expect(zeile.verbraucht_am).toBeNull();
        for (const code of codes) {
          expect(zeile.code_hash).not.toContain(code);
        }
      }
    });

    it('zeigt die Codes danach nie wieder an: die Einrichtungsseite trägt keinen', async () => {
      await zeremonie(konto);

      const seite = await app.inject({ method: 'GET', url: '/zwei-faktor', headers: { cookie: konto.cookie } });

      expect(ersatzcodesAusSeite(seite.body)).toEqual([]);
    });

    it('protokolliert die Einrichtung mit Faktor passkey und ohne Adresse, Name oder Kennung des Geräts', async () => {
      const marke = await protokollMarke(pool);

      const { geraet } = await zeremonie(konto);

      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege).toEqual([
        {
          art: 'zweiter_faktor_eingerichtet',
          akteur: konto.id,
          ziel: null,
          einzelheiten: { faktor: 'passkey' },
        },
      ]);
      expect(JSON.stringify(eintraege)).not.toContain(EMAIL);
      expect(JSON.stringify(eintraege)).not.toContain(geraet.kennung);
    });

    it('nimmt ohne Namen "Passkey" und kürzt einen überlangen Namen', async () => {
      const optionen = (await optionenHolen(konto.cookie)).json<PublicKeyCredentialCreationOptionsJSON>();
      const geraet = new SoftwareAuthenticator();

      await pruefen(konto.cookie, geraet.registrieren(optionen, BASIS_URL), ' ');

      const name = await pool.query<{ name: string }>('SELECT name FROM cockpit.passkey WHERE benutzer_id = $1', [konto.id]);
      expect(name.rows[0]?.name).toBe('Passkey');

      const anderes = await neuesKonto('lang@example.org');
      const andere = (await optionenHolen(anderes.cookie)).json<PublicKeyCredentialCreationOptionsJSON>();
      await pruefen(anderes.cookie, new SoftwareAuthenticator().registrieren(andere, BASIS_URL), 'x'.repeat(200));
      const lang = await pool.query<{ name: string }>('SELECT name FROM cockpit.passkey WHERE benutzer_id = $1', [anderes.id]);
      expect(lang.rows[0]?.name).toHaveLength(60);
    });

    it('zählt für den Konto-Verfall als Aktivierung: ein Passkey-Konto verfällt nicht nach 72 Stunden', async () => {
      const alt = new Date(Date.now() - 100 * 60 * MINUTE);
      await pool.query('UPDATE cockpit."user" SET "createdAt" = $2 WHERE id = $1', [konto.id, alt]);
      expect(await kontoVerfallen(pool, EMAIL, new Date())).toBe(true);

      await zeremonie(konto);

      expect(await kontoVerfallen(pool, EMAIL, new Date())).toBe(false);
    });
  });

  describe('Registrierung scheitert: das Konto bleibt ohne aktiven Faktor', () => {
    it.each([
      ['eine falsche Challenge', { challenge: 'ZmFsc2NoZS1jaGFsbGVuZ2U' }],
      ['eine falsche Herkunft', { origin: 'https://boese.example' }],
      ['eine falsche rpID', { rpId: 'boese.example' }],
      ['fehlende Benutzerprüfung (kein PIN, keine Biometrie)', { benutzerPruefung: false }],
    ])('bei %s', async (_beschreibung, abweichung) => {
      const { antwort } = await zeremonie(konto, abweichung);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain('Der Passkey konnte nicht eingerichtet werden');
      await bleibtOhneFaktor(konto.id);
    });

    it('bei einer wiederverwendeten Challenge: nach einem Fehlversuch ist sie verbraucht', async () => {
      const optionen = (await optionenHolen(konto.cookie)).json<PublicKeyCredentialCreationOptionsJSON>();
      const geraet = new SoftwareAuthenticator();
      const falsch = await pruefen(konto.cookie, geraet.registrieren(optionen, BASIS_URL, { origin: 'https://boese.example' }));
      expect(falsch.statusCode).toBe(400);

      // Dieselbe Challenge, jetzt mit richtiger Herkunft: sie gilt nicht mehr.
      const richtig = await pruefen(konto.cookie, geraet.registrieren(optionen, BASIS_URL));

      expect(richtig.statusCode).toBe(400);
      await bleibtOhneFaktor(konto.id);
    });

    it('bei Wiederholung derselben Antwort nach Erfolg: es bleibt bei einem Passkey und einem Satz Codes', async () => {
      const optionen = (await optionenHolen(konto.cookie)).json<PublicKeyCredentialCreationOptionsJSON>();
      const antwort = new SoftwareAuthenticator().registrieren(optionen, BASIS_URL);
      expect((await pruefen(konto.cookie, antwort)).statusCode).toBe(200);

      const wiederholt = await pruefen(konto.cookie, antwort);

      expect(wiederholt.statusCode).toBe(303);
      expect(await zaehlen('passkey', konto.id)).toBe(1);
      expect(await zaehlen('ersatzcode', konto.id)).toBe(10);
    });

    it('bei nicht abgeschlossener Zeremonie: keine Optionen geholt, nur eine Antwort geschickt', async () => {
      // Die Optionen eines anderen Kontos, mit denen ein Angreifer selbst eine Antwort baut.
      const fremd = await neuesKonto('fremd@example.org');
      const fremdeOptionen = (await optionenHolen(fremd.cookie)).json<PublicKeyCredentialCreationOptionsJSON>();
      const antwort = new SoftwareAuthenticator().registrieren(fremdeOptionen, BASIS_URL);

      const ergebnis = await pruefen(konto.cookie, antwort);

      expect(ergebnis.statusCode).toBe(400);
      await bleibtOhneFaktor(konto.id);
      // Die Challenge des anderen Kontos bleibt unberührt.
      expect(await zaehlen('passkey_vorgang', fremd.id)).toBe(1);
      await bleibtOhneFaktor(fremd.id);
    });

    it('bei nicht abgeschlossener Zeremonie: nie Optionen geholt, eine Antwort auf eine erfundene Challenge', async () => {
      const erfunden = { ...(await zeremonie(await neuesKonto('erfunden@example.org'))).aufgabe, challenge: 'ZXJmdW5kZW5l' };
      const antwort = new SoftwareAuthenticator().registrieren(erfunden, BASIS_URL);

      const ergebnis = await pruefen(konto.cookie, antwort);

      expect(ergebnis.statusCode).toBe(400);
      await bleibtOhneFaktor(konto.id);
    });

    it('bei einer Kennung, die schon zu einem anderen Konto gehört', async () => {
      const geraet = new SoftwareAuthenticator();
      const erstes = await neuesKonto('erstes@example.org');
      expect((await zeremonie(erstes, {}, geraet)).antwort.statusCode).toBe(200);

      // Dasselbe Gerät mit demselben Schlüssel noch einmal, für ein anderes Konto.
      const zweites = await zeremonie(konto, {}, geraet);

      expect(zweites.antwort.statusCode).toBe(400);
      await bleibtOhneFaktor(konto.id);
      expect(await zaehlen('passkey', erstes.id)).toBe(1);
    });

    it('bei abgelaufener Challenge (nach 5 Minuten)', async () => {
      const optionen = (await optionenHolen(konto.cookie)).json<PublicKeyCredentialCreationOptionsJSON>();
      const antwort = new SoftwareAuthenticator().registrieren(optionen, BASIS_URL);

      versatzMs = 5 * MINUTE + 1000;
      const ergebnis = await pruefen(konto.cookie, antwort);

      expect(ergebnis.statusCode).toBe(400);
      await bleibtOhneFaktor(konto.id);
    });

    it('gilt noch knapp vor Ablauf der Challenge', async () => {
      const optionen = (await optionenHolen(konto.cookie)).json<PublicKeyCredentialCreationOptionsJSON>();
      const antwort = new SoftwareAuthenticator().registrieren(optionen, BASIS_URL);

      versatzMs = 5 * MINUTE - 5000;
      const ergebnis = await pruefen(konto.cookie, antwort);

      expect(ergebnis.statusCode).toBe(200);
    });

    it.each([
      ['kein JSON', 'das-ist-kein-json'],
      ['ein JSON-Array', '[]'],
      ['ein leeres Objekt', '{}'],
      ['ein Objekt mit falschen Typen', '{"id":1,"rawId":2,"response":3,"type":4}'],
      ['nichts', ''],
    ])('bei einer Antwort, die %s ist: 400 und kein Passkey', async (_beschreibung, antwort) => {
      await optionenHolen(konto.cookie);

      const ergebnis = await pruefen(konto.cookie, antwort);

      expect(ergebnis.statusCode).toBe(400);
      await bleibtOhneFaktor(konto.id);
    });

    it('nennt in der Fehlermeldung keinen Grund der Bibliothek', async () => {
      const { antwort } = await zeremonie(konto, { origin: 'https://boese.example' });

      expect(antwort.body).not.toMatch(/origin|challenge|rpID|boese/i);
    });
  });

  describe('Abschluss als Transaktion', () => {
    it('legt weder Passkey noch Ersatzcodes an, wenn das Protokoll nicht geschrieben werden kann', async () => {
      const aufraeumen = await protokollSchreibenScheitern(pool, 'zweiter_faktor_eingerichtet');
      try {
        const { antwort } = await zeremonie(konto);

        // Ein Datenbankfehler ist keine Fehlbedienung: 500, und nichts ist halb geschehen.
        expect(antwort.statusCode).toBe(500);
        await bleibtOhneFaktor(konto.id);
      } finally {
        await aufraeumen();
      }
    });

    it('prüft den Zustand in der Transaktion noch einmal: ein Faktor, der dazwischen entstand, gewinnt', async () => {
      const konfiguration = passkeyKonfiguration(BASIS_URL);
      const optionen = await registrierungBeginnen(pool, konfiguration, { id: konto.id, email: EMAIL }, new Date());
      const antwort = new SoftwareAuthenticator().registrieren(optionen, BASIS_URL);
      // TOTP wird zwischen Optionen und Abschluss bestätigt (etwa in einem zweiten Tab).
      await pool.query('UPDATE cockpit."user" SET "twoFactorEnabled" = true WHERE id = $1', [konto.id]);

      const ergebnis = await registrierungAbschliessen(pool, konfiguration, konto.id, antwort, 'Spät', new Date());

      expect(ergebnis).toEqual({ ok: false, grund: 'schon_aktiv' });
      expect(await zaehlen('passkey', konto.id)).toBe(0);
      expect(await zaehlen('ersatzcode', konto.id)).toBe(0);
    });
  });

  describe('ohne feste Basis-URL', () => {
    it('gibt es keine Passkey-Routen und die Einrichtungsseite zeigt keinen Passkey', async () => {
      const ohneBasis = buildApp({ nodeEnv: 'test' }, { auth, pool });

      const seite = await ohneBasis.inject({ method: 'GET', url: '/zwei-faktor', headers: { cookie: konto.cookie } });
      const optionen = await ohneBasis.inject({
        method: 'POST',
        url: '/zwei-faktor/passkey/optionen',
        headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
        payload: formular({ passwort: PASSWORT }),
      });

      expect(seite.statusCode).toBe(200);
      expect(seite.body).toContain('action="/zwei-faktor/einrichten"');
      expect(seite.body).not.toContain('data-passkey');
      expect(optionen.statusCode).toBe(404);
      await ohneBasis.close();
    });
  });

  describe('Zugriff', () => {
    it.each([
      ['POST', '/zwei-faktor/passkey/optionen'],
      ['POST', '/zwei-faktor/passkey/pruefen'],
      ['GET', '/zwei-faktor/passkey/skript.js'],
    ])('leitet %s %s ohne Sitzung auf die Anmeldung um, wie das Tor es vorsieht', async (methode, url) => {
      const antwort = await app.inject({
        method: methode as 'GET' | 'POST',
        url,
        headers: FORMULAR_KOPF,
        ...(methode === 'POST' ? { payload: formular({ passwort: PASSWORT }) } : {}),
      });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/anmelden');
    });

    it('lässt einen Passkey nicht neben einen aktiven Faktor: Konto mit TOTP bekommt keine Optionen', async () => {
      const mitTotp = await neuesKonto('mit-totp@example.org', true);

      const antwort = await optionenHolen(mitTotp.cookie);

      expect(antwort.statusCode).toBe(403);
      expect(antwort.json()).toEqual({ fehler: 'Der zweite Faktor ist bereits eingerichtet.' });
      expect(await zaehlen('passkey_vorgang', mitTotp.id)).toBe(0);
    });

    it('lässt auch keinen zweiten Passkey nach einem ersten zu (das geht nur über /sicherheit, COPI-94)', async () => {
      const { aufgabe } = await zeremonie(konto);

      expect((await optionenHolen(konto.cookie)).statusCode).toBe(403);
      // Auch eine gültig signierte Antwort auf die alten Optionen ändert nichts.
      const spaet = await pruefen(konto.cookie, new SoftwareAuthenticator().registrieren(aufgabe, BASIS_URL));
      expect(spaet.statusCode).toBe(303);
      expect(await zaehlen('passkey', konto.id)).toBe(1);
    });

    it('lässt mit Passkey und Passwort allein keine Authenticator-App daneben einrichten (COPI-94)', async () => {
      await zeremonie(konto);

      const einrichten = await app.inject({
        method: 'POST',
        url: '/zwei-faktor/einrichten',
        headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
        payload: formular({ passwort: PASSWORT }),
      });
      expect(einrichten.statusCode).toBe(303);
      expect(einrichten.headers.location).toBe('/');
      const pruefen = await app.inject({
        method: 'POST',
        url: '/zwei-faktor/pruefen',
        headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
        payload: formular({ code: '123456' }),
      });
      expect(pruefen.statusCode).toBe(303);
      expect(pruefen.headers.location).toBe('/');
      const totp = await pool.query('SELECT 1 FROM cockpit."twoFactor" WHERE "userId" = $1', [konto.id]);
      expect(totp.rowCount).toBe(0);
    });

    it('macht keinen rohen Better-Auth-Pfad für Passkeys erreichbar', async () => {
      for (const pfad of ['/api/auth/passkey/generate-register-options', '/api/auth/passkey/verify-registration']) {
        const antwort = await app.inject({ method: 'GET', url: pfad, headers: { cookie: konto.cookie } });
        expect(antwort.statusCode).toBe(404);
      }
    });
  });

  describe('Anmeldung eines Kontos ohne Faktor', () => {
    it('lässt es weiter zur Einrichtung (das Verhalten aus COPI-13 bleibt)', async () => {
      const antwort = await app.inject({
        method: 'POST',
        url: '/anmelden',
        headers: FORMULAR_KOPF,
        payload: formular({ email: EMAIL, passwort: PASSWORT }),
      });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/zwei-faktor');
    });
    // Die Anmeldung eines Kontos mit Passkey steht in `passkey-anmeldung-datenbank.test.ts` (COPI-27).
  });

  describe('Datenbank: der Faktor folgt dem Zustand, nicht dem Weg', () => {
    async function passkeyEinfuegen(id: string): Promise<void> {
      await pool.query(
        `INSERT INTO cockpit.passkey (id, benutzer_id, oeffentlicher_schluessel, zaehler, transports, name)
         VALUES ($1, $2, $3, 0, '{}', 'Direkt')`,
        [`direkt-${id}`, id, Buffer.from([1, 2, 3])],
      );
    }

    it('ein Passkey macht die SQL-Funktion wahr und setzt aktiviert_am, auch am Formular vorbei', async () => {
      await passkeyEinfuegen(konto.id);

      const ergebnis = await pool.query<{ aktiv: boolean }>(
        'SELECT cockpit.zweiter_faktor_aktiv(u) AS aktiv FROM cockpit."user" u WHERE u.id = $1',
        [konto.id],
      );
      expect(ergebnis.rows[0]?.aktiv).toBe(true);
      expect(await aktiviertAm(konto.id)).toBeInstanceOf(Date);
    });

    it('überschreibt ein vorhandenes aktiviert_am nicht', async () => {
      const vorher = new Date('2026-01-01T00:00:00.000Z');
      await pool.query('UPDATE cockpit."user" SET aktiviert_am = $2 WHERE id = $1', [konto.id, vorher]);

      await passkeyEinfuegen(konto.id);

      expect(await aktiviertAm(konto.id)).toEqual(vorher);
    });

    it('behandelt einen noch nicht aktivierten Betreuer wie jedes Konto', async () => {
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betreuer' WHERE id = $1`, [konto.id]);

      await passkeyEinfuegen(konto.id);

      expect(await zweiterFaktorAktiv(pool, konto.id)).toBe(true);
      expect(await aktiviertAm(konto.id)).toBeInstanceOf(Date);
    });

    it('entfernt Passkeys, Vorgänge und Ersatzcodes mit dem Konto', async () => {
      await optionenHolen(konto.cookie);
      await passkeyEinfuegen(konto.id);
      await pool.query(
        'INSERT INTO cockpit.ersatzcode (benutzer_id, code_hash) VALUES ($1, $2)',
        [konto.id, 'hash'],
      );
      expect(await zaehlen('passkey_vorgang', konto.id)).toBe(1);

      await kontenLoeschen(pool);

      for (const tabelle of ['passkey', 'passkey_vorgang', 'ersatzcode']) {
        const rest = await pool.query(`SELECT 1 FROM cockpit.${tabelle}`);
        expect(rest.rowCount, tabelle).toBe(0);
      }
    });

    it('lässt keine zwei Passkeys mit derselben Kennung zu', async () => {
      await passkeyEinfuegen(konto.id);

      await expect(passkeyEinfuegen(konto.id)).rejects.toThrow(/passkey_pkey|duplicate/);
    });
  });
});
