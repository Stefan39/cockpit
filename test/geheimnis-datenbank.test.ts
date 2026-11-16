/**
 * Das Auth-Geheimnis gegen eine echte PostgreSQL (COPI-32). Läuft nur mit `TEST_DATABASE_URL`.
 *
 * ACHTUNG: Der Test räumt `cockpit."user"` (samt Faktoren, Vorgängen, Ersatzcodes),
 * `cockpit.anmeldeversuch` und `cockpit.anmeldevorgang` ab. Niemals gegen eine Kundendatenbank
 * laufen lassen.
 *
 * Ein „Prozess" ist hier eine eigene Auth- und App-Instanz mit eigenem Geheimnis auf derselben
 * Datenbank — genau das, was ein Neustart des Dev-Servers ist. Drei Fragen:
 *
 *   1. Übersteht ein Konto mit TOTP einen Neustart, wenn das Geheimnis dasselbe bleibt?
 *   2. Was passiert mit einem anderen Geheimnis: neutrale Antwort, aber ein Log, das den
 *      Grund nennt (ohne Geheimnis, Code oder Schlüssel)?
 *   3. Was hängt am Geheimnis und was nicht? Sitzungen und alles, was Better Auth verschlüsselt
 *      (TOTP-Schlüssel, dessen Ersatzcodes) ja; Passkeys und die eigenen Ersatzcodes nein.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SITZUNGS_COOKIE_NAME, erzeugeAuth, geheimnisBesorgen, type CockpitAuth } from '../src/auth/konfiguration.js';
import { cookieLesen } from '../src/auth/anmeldevorgang.js';
import { buildApp } from '../src/server/app.js';
import type { CockpitEnv } from '../src/server/env.js';
import { cookieKopf, formular, FORMULAR_KOPF, kontenLoeschen, kontoEinrichten, passkeyEinrichten, totpCode, type Konto } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';
import type { SoftwareAuthenticator } from './webauthn-authenticator.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';
const GEHEIMNIS_A = 'geheimnis-a-mit-deutlich-mehr-als-32-zeichen-laenge';
const GEHEIMNIS_B = 'geheimnis-b-mit-deutlich-mehr-als-32-zeichen-laenge';
const ABGELEHNT = 'Der Code stimmt nicht.';
const MELDUNG = 'Anmeldung: Codeschritt abgelehnt';

function umgebung(nodeEnv: CockpitEnv['nodeEnv']): CockpitEnv {
  return {
    nodeEnv,
    port: 3000,
    host: '127.0.0.1',
    databaseUrl: undefined,
    cockpitDomain: undefined,
    authSecret: undefined,
    smtpHost: undefined,
    smtpPort: undefined,
    smtpUser: undefined,
    smtpPass: undefined,
    smtpFrom: undefined,
    imageVersion: undefined,
    imageCommit: undefined,
    imageDigest: undefined,
    instanzName: undefined,
    koordinatorUrl: undefined,
    koordinatorGeheimnis: undefined,
    koordinatorFristSekunden: undefined,
    chatTageslimit: undefined,
    chatMailNachMinuten: undefined,
    vapidOeffentlich: undefined,
    vapidPrivat: undefined,
    vapidKontakt: undefined,
    wartungsfenster: 'di 07-09',
    pipelineGeheimnis: undefined,
  };
}

interface Prozess {
  readonly auth: CockpitAuth;
  readonly app: FastifyInstance;
  /** Alles, was dieser Prozess ins Log geschrieben hat, Zeile für Zeile. */
  readonly log: string[];
}

describe.skipIf(!datenbankUrl)('Auth-Geheimnis (echte Datenbank)', () => {
  let pool: pg.Pool;
  let prozesse: Prozess[];

  /** Ein „Prozess" mit eigenem Geheimnis auf der Testdatenbank. */
  function prozessStarten(geheimnis: string): Prozess {
    const log: string[] = [];
    const strom = new Writable({
      write(stueck: Buffer, _kodierung, weiter) {
        log.push(...stueck.toString().split('\n').filter((zeile) => zeile.length > 0));
        weiter();
      },
    });
    const auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: geheimnis, pool });
    const app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, logStrom: strom });
    const prozess = { auth, app, log };
    prozesse.push(prozess);
    return prozess;
  }

  /** Erster Schritt bis zum Codeschritt; die Cookies zwischen den Schritten. */
  async function passwortSchritt(prozess: Prozess, email: string): Promise<string> {
    const antwort = await prozess.app.inject({
      method: 'POST',
      url: '/anmelden',
      headers: FORMULAR_KOPF,
      payload: formular({ email, passwort: PASSWORT }),
    });
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden/code');
    return cookieKopf(antwort.headers['set-cookie']);
  }

  function codeSchritt(prozess: Prozess, cookie: string, code: string) {
    return prozess.app.inject({
      method: 'POST',
      url: '/anmelden/code',
      headers: { ...FORMULAR_KOPF, cookie },
      payload: formular({ code }),
    });
  }

  /** Die Warnungen „Codeschritt abgelehnt" aus dem Log, als Objekte. */
  function ablehnungen(prozess: Prozess): { grund?: string; hinweis?: string; msg: string }[] {
    return prozess.log
      .map((zeile) => JSON.parse(zeile) as { msg: string; level: number; grund?: string; hinweis?: string })
      .filter((eintrag) => eintrag.msg === MELDUNG);
  }

  function sitzungsCookie(antwort: { headers: Record<string, unknown> }): string | undefined {
    return cookieLesen(cookieKopf(antwort.headers['set-cookie'] as string | string[] | undefined), SITZUNGS_COOKIE_NAME);
  }

  async function wurzelseite(prozess: Prozess, cookie: string) {
    return prozess.app.inject({ method: 'GET', url: '/', headers: { cookie } });
  }

  /** Der TOTP-Schlüssel, so wie er in der Datenbank steht (verschlüsselt). */
  async function gespeicherterSchluessel(benutzerId: string): Promise<string> {
    const ergebnis = await pool.query<{ secret: string }>('SELECT secret FROM cockpit."twoFactor" WHERE "userId" = $1', [benutzerId]);
    return ergebnis.rows[0]?.secret ?? '';
  }

  async function totpKonto(prozess: Prozess, email: string): Promise<Konto> {
    return kontoEinrichten(prozess.app, prozess.auth, { email, passwort: PASSWORT, name: 'Konto', mitZweitemFaktor: true });
  }

  async function passkeyKonto(prozess: Prozess, email: string): Promise<{ konto: Konto; geraet: SoftwareAuthenticator; ersatzcodes: string[] }> {
    const konto = await kontoEinrichten(prozess.app, prozess.auth, { email, passwort: PASSWORT, name: 'Konto', mitZweitemFaktor: false });
    return { konto, ...(await passkeyEinrichten(prozess.app, konto, PASSWORT, BASIS_URL)) };
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    prozesse = [];
    await pool.query('DELETE FROM cockpit.anmeldeversuch');
    await pool.query('DELETE FROM cockpit.anmeldevorgang');
    await kontenLoeschen(pool);
  }, 30_000);

  afterEach(async () => {
    await Promise.all(prozesse.map((prozess) => prozess.app.close()));
  });

  afterAll(async () => {
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('Neustart mit demselben Geheimnis (das Geheimnis kommt aus der Datei der Entwicklung)', () => {
    let ordner: string;
    beforeEach(() => {
      ordner = mkdtempSync(path.join(tmpdir(), 'cockpit-geheimnis-db-'));
    });
    afterEach(() => {
      rmSync(ordner, { recursive: true, force: true });
    });

    it('lässt ein Konto mit TOTP nach dem Neustart anmelden', async () => {
      const datei = path.join(ordner, '.cockpit-dev-secret');
      const vorher = prozessStarten(geheimnisBesorgen(umgebung('development'), { datei }));
      const konto = await totpKonto(vorher, 'totp-neustart@example.org');
      await vorher.app.close();

      // Neustart: neue Instanz, das Geheimnis wird wieder besorgt — es kommt aus der Datei.
      const nachher = prozessStarten(geheimnisBesorgen(umgebung('development'), { datei }));
      const cookie = await passwortSchritt(nachher, 'totp-neustart@example.org');
      const antwort = await codeSchritt(nachher, cookie, await totpCode(nachher.auth, konto.geheimnis));

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/');
      const sitzung = sitzungsCookie(antwort);
      expect(sitzung).toBeDefined();
      expect((await wurzelseite(nachher, `${SITZUNGS_COOKIE_NAME}=${String(sitzung)}`)).statusCode).toBe(200);
      expect(ablehnungen(nachher)).toEqual([]);
    });

    it('lässt auch die Sitzung von vor dem Neustart weiter gelten', async () => {
      const datei = path.join(ordner, '.cockpit-dev-secret');
      const vorher = prozessStarten(geheimnisBesorgen(umgebung('development'), { datei }));
      const konto = await totpKonto(vorher, 'sitzung-neustart@example.org');
      expect((await wurzelseite(vorher, konto.cookie)).statusCode).toBe(200);
      await vorher.app.close();

      const nachher = prozessStarten(geheimnisBesorgen(umgebung('development'), { datei }));

      expect((await wurzelseite(nachher, konto.cookie)).statusCode).toBe(200);
    });
  });

  describe('Neustart mit einem anderen Geheimnis (so war es bisher in jeder Entwicklungs-Sitzung)', () => {
    it('lehnt einen richtigen TOTP-Code neutral ab und sagt im Log, woran es liegen kann', async () => {
      const a = prozessStarten(GEHEIMNIS_A);
      const konto = await totpKonto(a, 'totp-anders@example.org');
      const b = prozessStarten(GEHEIMNIS_B);

      const cookie = await passwortSchritt(b, 'totp-anders@example.org');
      const code = await totpCode(b.auth, konto.geheimnis);
      const antwort = await codeSchritt(b, cookie, code);

      // Nach außen: dieselbe neutrale Antwort wie bei einem falschen Code, keine Sitzung.
      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain(ABGELEHNT);
      expect(sitzungsCookie(antwort)).toBeUndefined();

      // Im Log: genau eine Warnung, mit einem Hinweis auf das Geheimnis.
      const eintraege = ablehnungen(b);
      expect(eintraege).toHaveLength(1);
      expect(eintraege[0]?.hinweis).toMatch(/BETTER_AUTH_SECRET/);
      expect(eintraege[0]?.hinweis).toMatch(/gespeicherten/);
      expect(eintraege[0]?.hinweis).toMatch(/Handbuch/);

      // Und nichts Geheimes: weder Code noch Schlüssel noch eines der Geheimnisse.
      const gesamt = b.log.join('\n');
      for (const geheim of [code, konto.geheimnis, GEHEIMNIS_A, GEHEIMNIS_B, await gespeicherterSchluessel(konto.id)]) {
        expect(geheim.length).toBeGreaterThan(5);
        expect(gesamt).not.toContain(geheim);
      }
    });

    it('nennt den Hinweis nicht bei einem schlicht falschen Code (dann stimmt das Geheimnis)', async () => {
      const a = prozessStarten(GEHEIMNIS_A);
      const konto = await totpKonto(a, 'totp-falsch@example.org');
      const richtig = await totpCode(a.auth, konto.geheimnis);
      const falsch = richtig === '000000' ? '111111' : '000000';

      const cookie = await passwortSchritt(a, 'totp-falsch@example.org');
      const antwort = await codeSchritt(a, cookie, falsch);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain(ABGELEHNT);
      const eintraege = ablehnungen(a);
      expect(eintraege).toHaveLength(1);
      expect(eintraege[0]?.hinweis).toBeUndefined();
    });

    it('nennt den Hinweis auch beim Ersatzcode eines TOTP-Kontos: Better Auth verschlüsselt ihn mit demselben Geheimnis', async () => {
      const a = prozessStarten(GEHEIMNIS_A);
      const konto = await totpKonto(a, 'totp-ersatz@example.org');
      const b = prozessStarten(GEHEIMNIS_B);

      const cookie = await passwortSchritt(b, 'totp-ersatz@example.org');
      const antwort = await codeSchritt(b, cookie, konto.ersatzcodes[0] ?? '');

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain(ABGELEHNT);
      expect(ablehnungen(b)[0]?.hinweis).toMatch(/BETTER_AUTH_SECRET/);
    });

    it('macht Sitzungen ungültig: das Cookie ist mit dem alten Geheimnis signiert', async () => {
      const a = prozessStarten(GEHEIMNIS_A);
      const konto = await totpKonto(a, 'sitzung-anders@example.org');
      const b = prozessStarten(GEHEIMNIS_B);

      expect((await wurzelseite(a, konto.cookie)).statusCode).toBe(200);
      const abgemeldet = await wurzelseite(b, konto.cookie);

      expect(abgemeldet.statusCode).toBe(303);
      expect(abgemeldet.headers.location).toBe('/anmelden');
    });
  });

  describe('Was nicht am Geheimnis hängt: Passkeys und die eigenen Ersatzcodes', () => {
    it('lässt ein Konto mit Passkey auch mit einem anderen Geheimnis anmelden', async () => {
      const a = prozessStarten(GEHEIMNIS_A);
      const { geraet } = await passkeyKonto(a, 'passkey-anders@example.org');
      const b = prozessStarten(GEHEIMNIS_B);

      const cookie = await passwortSchritt(b, 'passkey-anders@example.org');
      const optionen = await b.app.inject({
        method: 'POST',
        url: '/anmelden/passkey/optionen',
        headers: { ...FORMULAR_KOPF, cookie },
        payload: '',
      });
      expect(optionen.statusCode).toBe(200);
      const antwort = await b.app.inject({
        method: 'POST',
        url: '/anmelden/passkey/pruefen',
        headers: { ...FORMULAR_KOPF, cookie },
        payload: formular({ antwort: JSON.stringify(geraet.signieren(optionen.json<PublicKeyCredentialRequestOptionsJSON>(), BASIS_URL)) }),
      });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/');
      expect(sitzungsCookie(antwort)).toBeDefined();
      expect(ablehnungen(b)).toEqual([]);
    });

    it('lässt einen Ersatzcode eines Passkey-Kontos auch mit einem anderen Geheimnis gelten', async () => {
      const a = prozessStarten(GEHEIMNIS_A);
      const { ersatzcodes } = await passkeyKonto(a, 'passkey-ersatz@example.org');
      const b = prozessStarten(GEHEIMNIS_B);

      const cookie = await passwortSchritt(b, 'passkey-ersatz@example.org');
      const antwort = await codeSchritt(b, cookie, ersatzcodes[0] ?? '');

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/');
      expect(ablehnungen(b)).toEqual([]);
    });
  });
});
