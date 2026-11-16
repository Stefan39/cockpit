/**
 * Anmeldung & Sicherheit (COPI-94, `routes/sicherheit.ts`) über die echten Routen gegen eine echte PostgreSQL. Läuft
 * nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * Der Fall aus dem Ticket zuerst: ein Konto mit Passkey vom iMac legt am iPhone einen zweiten an — bestätigt mit einem
 * Ersatzcode — und meldet sich danach mit beiden an. Dann die Grenzen: ohne frische Bestätigung nichts, mit dem
 * Passwort allein nichts, nie der letzte Faktor, die Herkunft ist Pflicht, Fehlversuche sperren wie bei der Anmeldung.
 *
 * ACHTUNG: räumt `cockpit."user"` und `cockpit.anmeldeversuch` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { FAKTOR_BESTAETIGT_COOKIE } from '../src/auth/faktor-bestaetigung.js';
import type { Mailversand } from '../src/mail/versand.js';
import { buildApp } from '../src/server/app.js';
import { geheimnisAusUri } from '../src/server/routes/zwei-faktor.js';
import {
  cookieKopf,
  ersatzcodesAusSeite,
  formular,
  FORMULAR_KOPF,
  kontenLoeschen,
  kontoEinrichten,
  passkeyEinrichten,
  protokollMarke,
  protokollSeit,
  sperrenLeeren,
  totpCode,
  type Konto,
} from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';
import { SoftwareAuthenticator } from './webauthn-authenticator.js';

const datenbankUrl = testDatenbankUrl;
const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';
/** Die eigene Herkunft: jedes Formular auf `/sicherheit` verlangt sie (`herkunftBelegt`). */
const HERKUNFT = { origin: BASIS_URL, host: 'localhost:3000' };

interface GesendeteMail {
  readonly an: string;
  readonly betreff: string;
}

describe.skipIf(!datenbankUrl)('Anmeldung & Sicherheit (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let mails: GesendeteMail[];
  let nummer = 0;

  const versand: Mailversand = {
    senden: (nachricht) => {
      mails.push({ an: nachricht.an, betreff: nachricht.betreff });
      return Promise.resolve();
    },
  };

  function email(): string {
    nummer += 1;
    return `sicherheit-${String(nummer)}@example.org`;
  }

  /** Ein Konto, dessen erster Faktor ein Passkey ist („iMac"), mit seinen zehn Ersatzcodes. */
  async function imacKonto(): Promise<{ konto: Konto; adresse: string; imac: SoftwareAuthenticator; ersatzcodes: string[] }> {
    const adresse = email();
    const konto = await kontoEinrichten(app, auth, { email: adresse, passwort: PASSWORT, name: 'Stefan', mitZweitemFaktor: false });
    const { geraet, ersatzcodes } = await passkeyEinrichten(app, konto, PASSWORT, BASIS_URL);
    return { konto, adresse, imac: geraet, ersatzcodes };
  }

  function holen(cookie: string, url: string) {
    return app.inject({ method: 'GET', url, headers: { cookie } });
  }

  function senden(cookie: string, url: string, felder: Record<string, string> = {}, kopf: Record<string, string> = HERKUNFT) {
    return app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...kopf, cookie }, payload: formular(felder) });
  }

  /** Mit einem Code bestätigen; liefert den Cookie-Kopf samt Bestätigung. */
  async function mitCodeBestaetigen(cookie: string, code: string, weiter = '/sicherheit'): Promise<string> {
    const antwort = await senden(cookie, '/sicherheit/bestaetigen/code', { code, weiter });
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe(weiter);
    return `${cookie}; ${cookieKopf(antwort.headers['set-cookie'])}`;
  }

  /** Anmelden mit Passwort und Passkey, wie ein Browser; liefert das Sitzungs-Cookie oder `undefined`. */
  async function mitPasskeyAnmelden(adresse: string, geraet: SoftwareAuthenticator): Promise<number> {
    const passwort = await app.inject({ method: 'POST', url: '/anmelden', headers: FORMULAR_KOPF, payload: formular({ email: adresse, passwort: PASSWORT }) });
    const zwischen = cookieKopf(passwort.headers['set-cookie']);
    const optionen = await app.inject({ method: 'POST', url: '/anmelden/passkey/optionen', headers: { ...FORMULAR_KOPF, cookie: zwischen }, payload: '' });
    const antwort = await app.inject({
      method: 'POST',
      url: '/anmelden/passkey/pruefen',
      headers: { ...FORMULAR_KOPF, cookie: zwischen },
      payload: formular({ antwort: JSON.stringify(geraet.signieren(optionen.json<PublicKeyCredentialRequestOptionsJSON>(), BASIS_URL)) }),
    });
    return antwort.statusCode === 303 && antwort.headers.location === '/' ? 1 : 0;
  }

  async function passkeyNamen(benutzerId: string): Promise<string[]> {
    const ergebnis = await pool.query<{ name: string }>('SELECT name FROM cockpit.passkey WHERE benutzer_id = $1 ORDER BY angelegt_am, id', [benutzerId]);
    return ergebnis.rows.map((zeile) => zeile.name);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, versand, jetzt: () => new Date() });
  }, 60_000);

  beforeEach(async () => {
    mails = [];
    await kontenLoeschen(pool);
    await sperrenLeeren(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('DoD: das iMac-Konto legt am iPhone einen zweiten Passkey an (bestätigt mit Ersatzcode) und meldet sich mit beiden an', async () => {
    const { konto, adresse, imac, ersatzcodes } = await imacKonto();
    const marke = await protokollMarke(pool);

    const ohne = await holen(konto.cookie, '/sicherheit/passkey');
    expect(ohne.statusCode).toBe(303);
    expect(ohne.headers.location).toBe('/sicherheit/bestaetigen?weiter=%2Fsicherheit%2Fpasskey');

    const cookie = await mitCodeBestaetigen(konto.cookie, ersatzcodes[0] ?? '', '/sicherheit/passkey');
    expect((await holen(cookie, '/sicherheit/passkey')).statusCode).toBe(200);
    const optionen = await senden(cookie, '/sicherheit/passkey/optionen');
    expect(optionen.statusCode).toBe(200);
    const iphone = new SoftwareAuthenticator();
    const angelegt = await senden(cookie, '/sicherheit/passkey/pruefen', {
      antwort: JSON.stringify(iphone.registrieren(optionen.json<PublicKeyCredentialCreationOptionsJSON>(), BASIS_URL)),
      name: 'iPhone',
    });

    expect(angelegt.statusCode).toBe(303);
    expect(angelegt.headers.location).toBe('/sicherheit?hinweis=passkey-hinzugefuegt');
    expect(await passkeyNamen(konto.id)).toEqual(['Testgerät', 'iPhone']);
    expect(mails).toEqual([{ an: adresse, betreff: 'Neuer Passkey für Ihren Cockpit-Zugang' }]);
    expect((await protokollSeit(pool, marke)).map((zeile) => [zeile.art, zeile.einzelheiten])).toEqual([
      ['ersatzcode_verwendet', {}],
      ['faktor_bestaetigt', { faktor: 'ersatzcode' }],
      ['zweiter_faktor_hinzugefuegt', { faktor: 'passkey' }],
    ]);
    expect(await mitPasskeyAnmelden(adresse, imac)).toBe(1);
    expect(await mitPasskeyAnmelden(adresse, iphone)).toBe(1);
  });

  it('bestätigt auch mit einem vorhandenen Passkey', async () => {
    const { konto, imac } = await imacKonto();

    const optionen = await senden(konto.cookie, '/sicherheit/bestaetigen/passkey/optionen');
    expect(optionen.statusCode).toBe(200);
    const antwort = await senden(konto.cookie, '/sicherheit/bestaetigen/passkey', {
      antwort: JSON.stringify(imac.signieren(optionen.json<PublicKeyCredentialRequestOptionsJSON>(), BASIS_URL)),
      weiter: '/sicherheit/ersatzcodes',
    });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/sicherheit/ersatzcodes');
    expect(String(antwort.headers['set-cookie'])).toContain(`${FAKTOR_BESTAETIGT_COOKIE}=passkey.`);
  });

  describe('ohne frische Bestätigung ändert sich nichts', () => {
    it('leitet jede Seite, die ändert, zur Bestätigung um und weist jedes Formular ab', async () => {
      const { konto } = await imacKonto();
      const id = (await pool.query<{ id: string }>('SELECT id FROM cockpit.passkey WHERE benutzer_id = $1', [konto.id])).rows[0]?.id ?? '';

      // Je Seite das Formular, das von ihr abgeschickt wird.
      const seiten: [string, string][] = [
        ['/sicherheit/passkey', '/sicherheit/passkey/pruefen'],
        ['/sicherheit/totp', '/sicherheit/totp'],
        ['/sicherheit/totp', '/sicherheit/totp/pruefen'],
        ['/sicherheit/totp/entfernen', '/sicherheit/totp/entfernen'],
        ['/sicherheit/ersatzcodes', '/sicherheit/ersatzcodes'],
        [`/sicherheit/passkey/${id}/entfernen`, `/sicherheit/passkey/${id}/entfernen`],
      ];
      for (const [url, ziel] of seiten) {
        const umleitung = `/sicherheit/bestaetigen?weiter=${encodeURIComponent(url)}`;
        expect((await holen(konto.cookie, url)).headers.location, url).toBe(umleitung);
        expect((await senden(konto.cookie, ziel, { passwort: PASSWORT, code: '123456' })).headers.location, ziel).toBe(umleitung);
      }
      const optionen = await senden(konto.cookie, '/sicherheit/passkey/optionen');
      expect(optionen.statusCode).toBe(403);
      expect(await passkeyNamen(konto.id)).toEqual(['Testgerät']);
    });

    it('nimmt das Passwort nicht als Bestätigung', async () => {
      const { konto } = await imacKonto();

      const antwort = await senden(konto.cookie, '/sicherheit/bestaetigen/code', { code: PASSWORT, weiter: '/sicherheit/passkey' });

      expect(antwort.statusCode).toBe(400);
      expect(String(antwort.headers['set-cookie'] ?? '')).not.toContain(FAKTOR_BESTAETIGT_COOKIE);
    });

    it('lässt die Bestätigung einer Sitzung nicht für eine andere gelten', async () => {
      const { konto, adresse, ersatzcodes } = await imacKonto();
      const bestaetigt = await mitCodeBestaetigen(konto.cookie, ersatzcodes[0] ?? '');
      const bestaetigung = bestaetigt.split('; ').find((teil) => teil.startsWith(FAKTOR_BESTAETIGT_COOKIE)) ?? '';
      // Eine zweite Sitzung desselben Kontos, über die Anmeldung mit einem Ersatzcode.
      const passwort = await app.inject({ method: 'POST', url: '/anmelden', headers: FORMULAR_KOPF, payload: formular({ email: adresse, passwort: PASSWORT }) });
      const zwischen = cookieKopf(passwort.headers['set-cookie']);
      const code = await app.inject({ method: 'POST', url: '/anmelden/code', headers: { ...FORMULAR_KOPF, cookie: zwischen }, payload: formular({ code: ersatzcodes[1] ?? '' }) });
      const zweite = cookieKopf(code.headers['set-cookie']);

      const antwort = await holen(`${zweite}; ${bestaetigung}`, '/sicherheit/ersatzcodes');

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/sicherheit/bestaetigen?weiter=%2Fsicherheit%2Fersatzcodes');
    });

    it('verlangt die eigene Herkunft für jedes Formular', async () => {
      const { konto, ersatzcodes } = await imacKonto();
      const cookie = await mitCodeBestaetigen(konto.cookie, ersatzcodes[0] ?? '');

      for (const kopf of [{}, { origin: 'https://boese.example', host: 'localhost:3000' }]) {
        expect((await senden(cookie, '/sicherheit/ersatzcodes', {}, kopf)).statusCode).toBe(403);
        expect((await senden(konto.cookie, '/sicherheit/bestaetigen/code', { code: ersatzcodes[1] ?? '' }, kopf)).statusCode).toBe(403);
      }
    });

    it('sperrt nach fünf Fehlversuchen, auch für einen richtigen Code', async () => {
      const { konto, ersatzcodes } = await imacKonto();

      for (let versuch = 0; versuch < 5; versuch += 1) {
        expect((await senden(konto.cookie, '/sicherheit/bestaetigen/code', { code: 'aaaaa-aaaaa' })).statusCode).toBe(400);
      }
      const richtig = await senden(konto.cookie, '/sicherheit/bestaetigen/code', { code: ersatzcodes[0] ?? '' });

      expect(richtig.statusCode).toBe(400);
      expect(String(richtig.headers['set-cookie'] ?? '')).not.toContain(FAKTOR_BESTAETIGT_COOKIE);
    });

    it('führt nach der Bestätigung nur auf Seiten von /sicherheit zurück', async () => {
      const { konto, ersatzcodes } = await imacKonto();

      const antwort = await senden(konto.cookie, '/sicherheit/bestaetigen/code', { code: ersatzcodes[0] ?? '', weiter: 'https://boese.example/' });

      expect(antwort.headers.location).toBe('/sicherheit');
    });
  });

  describe('entfernen', () => {
    it('entfernt nie den letzten Faktor', async () => {
      const { konto, ersatzcodes } = await imacKonto();
      const cookie = await mitCodeBestaetigen(konto.cookie, ersatzcodes[0] ?? '');
      const id = (await pool.query<{ id: string }>('SELECT id FROM cockpit.passkey WHERE benutzer_id = $1', [konto.id])).rows[0]?.id ?? '';

      expect((await holen(cookie, `/sicherheit/passkey/${id}/entfernen`)).headers.location).toBe('/sicherheit?fehler=letzter');
      expect((await senden(cookie, `/sicherheit/passkey/${id}/entfernen`)).headers.location).toBe('/sicherheit?fehler=letzter');
      expect(await passkeyNamen(konto.id)).toEqual(['Testgerät']);
      expect((await holen(cookie, '/sicherheit')).body).not.toContain('/entfernen');
    });

    it('entfernt einen von zwei Passkeys nach Rückfrage, mit Hinweis-Mail', async () => {
      const { konto, adresse, ersatzcodes } = await imacKonto();
      const cookie = await mitCodeBestaetigen(konto.cookie, ersatzcodes[0] ?? '');
      const optionen = await senden(cookie, '/sicherheit/passkey/optionen');
      await senden(cookie, '/sicherheit/passkey/pruefen', {
        antwort: JSON.stringify(new SoftwareAuthenticator().registrieren(optionen.json<PublicKeyCredentialCreationOptionsJSON>(), BASIS_URL)),
        name: 'iPhone',
      });
      const id = (await pool.query<{ id: string }>("SELECT id FROM cockpit.passkey WHERE benutzer_id = $1 AND name = 'Testgerät'", [konto.id])).rows[0]?.id ?? '';

      const frage = await holen(cookie, `/sicherheit/passkey/${id}/entfernen`);
      expect(frage.statusCode).toBe(200);
      expect(frage.body).toContain('Passkey „Testgerät“ entfernen?');
      const entfernt = await senden(cookie, `/sicherheit/passkey/${id}/entfernen`);

      expect(entfernt.headers.location).toBe('/sicherheit?hinweis=passkey-entfernt');
      expect(await passkeyNamen(konto.id)).toEqual(['iPhone']);
      expect(mails.at(-1)).toEqual({ an: adresse, betreff: 'Passkey aus Ihrem Cockpit-Zugang entfernt' });
    });
  });

  it('richtet die Authenticator-App neben dem Passkey ein und entfernt sie wieder', async () => {
    const { konto, ersatzcodes } = await imacKonto();
    let cookie = await mitCodeBestaetigen(konto.cookie, ersatzcodes[0] ?? '');

    expect((await holen(cookie, '/sicherheit/totp')).statusCode).toBe(200);
    const qr = await senden(cookie, '/sicherheit/totp', { passwort: PASSWORT });
    expect(qr.statusCode).toBe(200);
    expect(qr.body).toContain('action="/sicherheit/totp/pruefen"');
    expect(qr.body).not.toContain('class="codes"');
    const geheimnis = geheimnisAusUri(qr.body.match(/value="(otpauth:[^"]+)"/)?.[1]?.replaceAll('&amp;', '&') ?? '');
    const scharf = await senden(cookie, '/sicherheit/totp/pruefen', { code: await totpCode(auth, geheimnis) });
    expect(scharf.headers.location).toBe('/sicherheit?hinweis=totp-hinzugefuegt');
    // Better Auth hat die Sitzung ersetzt; die Bestätigung hing an der alten.
    cookie = cookieKopf(scharf.headers['set-cookie']);
    const seite = await holen(cookie, '/sicherheit');
    expect(seite.body).toContain('Eingerichtet');
    // Die Codes der App, die dabei entstanden, sieht niemand: die bisherigen Ersatzcodes zählen allein.
    expect(seite.body).toContain('9 von 10 übrig');

    cookie = await mitCodeBestaetigen(cookie, await totpCode(auth, geheimnis), '/sicherheit/totp/entfernen');
    const entfernt = await senden(cookie, '/sicherheit/totp/entfernen');
    expect(entfernt.headers.location).toBe('/sicherheit?hinweis=totp-entfernt');
    expect((await holen(cookie, '/sicherheit')).body).toContain('Nicht eingerichtet');
  });

  it('zeigt nach dem Entfernen der App neue Ersatzcodes, wenn sonst keine blieben (Konto, das mit der App begann)', async () => {
    const adresse = email();
    const konto = await kontoEinrichten(app, auth, { email: adresse, passwort: PASSWORT, name: 'App zuerst', mitZweitemFaktor: true });
    await pool.query(
      `INSERT INTO cockpit.passkey (id, benutzer_id, oeffentlicher_schluessel, zaehler, transports, name) VALUES ('daneben', $1, '\\x00', 0, '{}', 'iMac')`,
      [konto.id],
    );
    const cookie = await mitCodeBestaetigen(konto.cookie, await totpCode(auth, konto.geheimnis), '/sicherheit/totp/entfernen');

    const frage = await holen(cookie, '/sicherheit/totp/entfernen');
    expect(frage.body).toContain('Mit ihr fallen ihre Ersatzcodes weg');
    const antwort = await senden(cookie, '/sicherheit/totp/entfernen');

    expect(antwort.statusCode).toBe(200);
    expect(antwort.headers['cache-control']).toBe('no-store');
    expect(ersatzcodesAusSeite(antwort.body)).toHaveLength(10);
    expect(mails.map((mail) => mail.betreff)).toEqual([
      'Authenticator-App aus Ihrem Cockpit-Zugang entfernt',
      'Neue Ersatzcodes für Ihren Cockpit-Zugang',
    ]);
  });

  it('erzeugt neue Ersatzcodes genau einmal sichtbar; die alten gelten nicht mehr', async () => {
    const { konto, ersatzcodes } = await imacKonto();
    const cookie = await mitCodeBestaetigen(konto.cookie, ersatzcodes[0] ?? '', '/sicherheit/ersatzcodes');

    const seite = await senden(cookie, '/sicherheit/ersatzcodes');

    expect(seite.statusCode).toBe(200);
    expect(seite.headers['cache-control']).toBe('no-store');
    const neue = ersatzcodesAusSeite(seite.body);
    expect(neue).toHaveLength(10);
    const alt = await senden(konto.cookie, '/sicherheit/bestaetigen/code', { code: ersatzcodes[1] ?? '' });
    expect(alt.statusCode).toBe(400);
    expect((await senden(konto.cookie, '/sicherheit/bestaetigen/code', { code: neue[0] ?? '' })).statusCode).toBe(303);
  });

  it('zeigt die Übersicht mit Faktoren und letzten Änderungen, und die Einstellungen führen dorthin', async () => {
    const { konto, ersatzcodes } = await imacKonto();
    await mitCodeBestaetigen(konto.cookie, ersatzcodes[0] ?? '');

    const seite = await holen(konto.cookie, '/sicherheit');
    expect(seite.statusCode).toBe(200);
    expect(seite.body).toContain('Testgerät');
    expect(seite.body).toContain('9 von 10 übrig');
    expect(seite.body).toContain('Ersatzcode verwendet');
    expect(seite.body).toContain('Zweiter Faktor eingerichtet (Passkey)');
    expect(seite.body).toContain('<a href="/einstellungen" class="hauptnav-eintrag" aria-current="page">');

    const einstellungen = await holen(konto.cookie, '/einstellungen');
    expect(einstellungen.body).toContain('href="/sicherheit"');
    expect(einstellungen.body).toContain('Passkeys: Testgerät');
  });
});
