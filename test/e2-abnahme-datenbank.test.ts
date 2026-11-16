/**
 * E2-Abnahme (COPI-29): der durchgehende Ablauf gegen eine echte PostgreSQL.
 * Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * ACHTUNG: Der Test räumt `cockpit."user"`, `cockpit.einladung` und `cockpit.erststart_token`
 * ab. Niemals gegen eine Kundendatenbank laufen lassen.
 *
 * Die Definition of Done der ADR (Abschnitt 11) für E2: „Konto aus Setup-Mail bis aktiv+2FA;
 * kein Zugriff ohne 2. Faktor (negativ geprüft); Betreuer-Zugang per Konsolen-Token
 * nachgewiesen." Die Teile sind einzeln getestet. Was fehlte, ist der Beleg, dass sie **zusammen**
 * halten — ein Ablauf auf einer frischen Instanz, an der kein Test etwas vorbereitet. Genau so
 * blieb unbemerkt, dass „Erststart-Konto lädt Betriebs-Admin ein" auf einer frischen Instanz
 * unmöglich war (COPI-22): die Tests legten ihre Konten und Rollen von Hand an.
 *
 * Hier legt **nichts** von Hand an. Alles läuft über die echten Wege: das Server-Kommando, die
 * Formulare, die Mail (ein Ersatz-Transport fängt sie ab und liefert den Link), Passkey und TOTP
 * als echte Zeremonien, die zweistufige Anmeldung. Die Schritte bauen aufeinander auf und laufen
 * in dieser Reihenfolge; schlägt einer fehl, folgen die übrigen nicht mehr aussagekräftig.
 *
 *   1. Server-Kommando `erststart` → Token → Betreuer-Konto (Rolle aus dem Erststart, COPI-22)
 *   2. ohne zweiten Faktor: kein Zugriff (negativ), dann Passkey → aktiv
 *   3. Abmelden, zweistufige Anmeldung mit dem Passkey
 *   4. Betreuer lädt einen Betriebs-Admin ein (Mail) → Konto → ohne Faktor kein Zugriff → TOTP → aktiv
 *   5. Der Betriebs-Admin lädt einen Mitarbeiter ein → Konto → Passkey → aktiv; Rollenregeln
 *   6. Verlorener Faktor: `entsperren` → altes Passwort und alte Sitzung tot → Wiederherstellung
 *   7. Endzustand und Protokoll: drei Konten, ein Betreuer, alle aktiv, die Geschichte im Protokoll
 */
import nodemailer from 'nodemailer';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ANMELDEVORGANG_COOKIE_NAME, cookieLesen } from '../src/auth/anmeldevorgang.js';
import { erzeugeAuth, SITZUNGS_COOKIE_NAME, type CockpitAuth } from '../src/auth/konfiguration.js';
import { zweiterFaktorAktiv } from '../src/auth/zweiter-faktor.js';
import { cliAusfuehren } from '../src/cli/befehle.js';
import { mailversandBauen } from '../src/mail/versand.js';
import { buildApp } from '../src/server/app.js';
import { geheimnisAusUri } from '../src/server/routes/zwei-faktor.js';
import {
  base32Dekodieren,
  cookieKopf,
  formular,
  FORMULAR_KOPF,
  kontenLoeschen,
  passkeyEinrichten,
  protokollMarke,
  protokollSeit,
  totpCode,
  type Konto,
} from './hilfen.js';
import { qrAusSeiteLesen } from './qr-lesen.js';
import { testDatenbankUrl } from './testdatenbank.js';
import type { SoftwareAuthenticator } from './webauthn-authenticator.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const NEUES_PASSWORT = 'ein-ganz-neues-langes-passwort';

const BETREUER = { email: 'betreuer@example.org', passwort: 'betreuer-passwort-lang-genug', name: 'betreuer' };
const ADMIN = { email: 'admin@example.org', passwort: 'admin-passwort-lang-genug-1', name: 'Betriebs-Admin' };
const MITARBEITER = { email: 'mitarbeiter@example.org', passwort: 'mitarbeiter-passwort-lang-1', name: 'Mitarbeiter' };

interface Nachricht {
  readonly to: readonly { address: string }[];
  readonly text: string;
}

/** Ein Konto im Ablauf: was der Test über es weiß. */
interface Person {
  readonly email: string;
  passwort: string;
  id: string;
  cookie: string;
}

describe.skipIf(!datenbankUrl)('E2-Abnahme: vom Konsolen-Token bis zum aktiven Konto (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let marke = 0;
  const gesendet: Nachricht[] = [];

  const betreuer: Person = { email: BETREUER.email, passwort: BETREUER.passwort, id: '', cookie: '' };
  const admin: Person = { email: ADMIN.email, passwort: ADMIN.passwort, id: '', cookie: '' };
  const mitarbeiter: Person = { email: MITARBEITER.email, passwort: MITARBEITER.passwort, id: '', cookie: '' };
  let betreuerGeraet: SoftwareAuthenticator;
  let adminGeheimnis = '';
  let erststartToken = '';

  // --- Werkzeuge ---------------------------------------------------------------------------

  async function kommando(...argumente: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await cliAusfuehren(argumente, {
      pool,
      basisUrl: BASIS_URL,
      ausgabe: (text) => stdout.push(text),
      fehlerausgabe: (text) => stderr.push(text),
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  function get(url: string, cookie = '') {
    return app.inject({ method: 'GET', url, ...(cookie === '' ? {} : { headers: { cookie } }) });
  }

  function post(url: string, daten: Record<string, string>, cookie = '') {
    return app.inject({
      method: 'POST',
      url,
      headers: { ...FORMULAR_KOPF, ...(cookie === '' ? {} : { cookie }) },
      payload: formular(daten),
    });
  }

  const sitzung = (antwort: { headers: Record<string, unknown> }): string | undefined =>
    cookieLesen(cookieKopf(antwort.headers['set-cookie'] as string | string[] | undefined), SITZUNGS_COOKIE_NAME);

  async function zaehlen(sql: string, parameter: unknown[] = []): Promise<number> {
    const ergebnis = await pool.query<{ anzahl: string }>(`SELECT count(*)::text AS anzahl FROM (${sql}) t`, parameter);
    return Number(ergebnis.rows[0]?.anzahl ?? '0');
  }

  const offeneEinladungen = () => zaehlen('SELECT 1 FROM cockpit.einladung WHERE verbraucht_am IS NULL');

  async function rolleVon(id: string): Promise<string | undefined> {
    const ergebnis = await pool.query<{ rolle: string }>('SELECT rolle FROM cockpit."user" WHERE id = $1', [id]);
    return ergebnis.rows[0]?.rolle;
  }

  async function aktiviertAm(id: string): Promise<Date | null> {
    const ergebnis = await pool.query<{ aktiviert_am: Date | null }>('SELECT aktiviert_am FROM cockpit."user" WHERE id = $1', [id]);
    return ergebnis.rows[0]?.aktiviert_am ?? null;
  }

  /** Die Person als `Konto` für die Testhelfer (sie brauchen nur Kennung und Cookie). */
  const alsKonto = (person: Person): Konto => ({ id: person.id, cookie: person.cookie, geheimnis: '', ersatzcodes: [] });

  /** Das Konto hat keinen zweiten Faktor: außer der Einrichtung führt nichts irgendwohin. */
  async function ohneFaktorIstAlleszu(person: Person): Promise<void> {
    expect(await zweiterFaktorAktiv(pool, person.id)).toBe(false);
    for (const pfad of ['/', '/einladung', '/anmelden/code']) {
      const antwort = await get(pfad, person.cookie);
      expect(antwort.statusCode, pfad).toBe(303);
      expect(antwort.headers.location, pfad).toBe('/zwei-faktor');
    }
    const vorher = await offeneEinladungen();
    const einladen = await post('/einladung', { email: 'wer-auch-immer@example.org' }, person.cookie);
    expect(einladen.statusCode).toBe(303);
    expect(einladen.headers.location).toBe('/zwei-faktor');
    expect(await offeneEinladungen()).toBe(vorher);
    // Die Einrichtung selbst bleibt offen.
    expect((await get('/zwei-faktor', person.cookie)).statusCode).toBe(200);
  }

  /** Das Konto ist vollständig angemeldet: das Cockpit ist erreichbar, die Einrichtung führt weiter. */
  async function istAktiv(person: Person): Promise<void> {
    expect(await zweiterFaktorAktiv(pool, person.id)).toBe(true);
    expect((await get('/', person.cookie)).statusCode).toBe(200);
    expect((await get('/zwei-faktor', person.cookie)).headers.location).toBe('/');
  }

  async function abmelden(person: Person): Promise<void> {
    const antwort = await post('/abmelden', {}, person.cookie);
    expect(antwort.headers.location).toBe('/anmelden');
    const danach = await get('/', person.cookie);
    expect(danach.statusCode).toBe(303);
    expect(danach.headers.location).toBe('/anmelden');
    person.cookie = '';
  }

  /** Erster Schritt: das Passwort. Es entsteht keine Sitzung; das Cockpit bleibt zu. */
  async function passwortSchritt(person: Person): Promise<string> {
    const antwort = await post('/anmelden', { email: person.email, passwort: person.passwort });
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden/code');
    const zwischen = cookieKopf(antwort.headers['set-cookie']);
    expect(cookieLesen(zwischen, ANMELDEVORGANG_COOKIE_NAME)).toBeTruthy();
    expect(sitzung(antwort)).toBeUndefined();
    // Ohne Sitzung: das Cockpit führt zur Anmeldung, das Einladungsformular ist für Anonyme neutral 404.
    const cockpit = await get('/', zwischen);
    expect(cockpit.statusCode).toBe(303);
    expect(cockpit.headers.location).toBe('/anmelden');
    expect((await get('/einladung', zwischen)).statusCode).toBe(404);
    return zwischen;
  }

  async function mitPasskeyAnmelden(person: Person, geraet: SoftwareAuthenticator): Promise<void> {
    const zwischen = await passwortSchritt(person);
    const optionen = await app.inject({
      method: 'POST',
      url: '/anmelden/passkey/optionen',
      headers: { ...FORMULAR_KOPF, cookie: zwischen },
      payload: '',
    });
    expect(optionen.statusCode).toBe(200);
    const antwort = await post(
      '/anmelden/passkey/pruefen',
      { antwort: JSON.stringify(geraet.signieren(optionen.json(), BASIS_URL)) },
      zwischen,
    );
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/');
    person.cookie = cookieKopf(antwort.headers['set-cookie']);
    expect(sitzung(antwort)).toBeTruthy();
    await istAktiv(person);
  }

  async function mitTotpAnmelden(person: Person, geheimnis: string): Promise<void> {
    const zwischen = await passwortSchritt(person);
    const antwort = await post('/anmelden/code', { code: await totpCode(auth, geheimnis) }, zwischen);
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/');
    person.cookie = cookieKopf(antwort.headers['set-cookie']);
    expect(sitzung(antwort)).toBeTruthy();
    await istAktiv(person);
  }

  /** TOTP einrichten wie eine Person mit Authenticator-App: QR-Code lesen, Code bilden, bestätigen. */
  async function totpEinrichten(person: Person): Promise<string> {
    const einrichten = await post('/zwei-faktor/einrichten', { passwort: person.passwort }, person.cookie);
    expect(einrichten.statusCode).toBe(200);
    const geheimnis = geheimnisAusUri(qrAusSeiteLesen(einrichten.body));
    const { code } = await auth.api.generateTOTP({ body: { secret: base32Dekodieren(geheimnis) } });
    const pruefen = await post('/zwei-faktor/pruefen', { code }, person.cookie);
    expect(pruefen.headers.location).toBe('/');
    person.cookie = cookieKopf(pruefen.headers['set-cookie']) || person.cookie;
    return geheimnis;
  }

  /** Lädt ein und liefert das Token aus der Mail, die dabei verschickt wurde. */
  async function einladen(von: Person, email: string, rolle: string): Promise<string> {
    gesendet.length = 0;
    const antwort = await post('/einladung', { email, rolle }, von.cookie);
    expect(antwort.statusCode).toBe(200);
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0]?.to.map((empfaenger) => empfaenger.address)).toEqual([email]);
    const token = /\/einladung\/([A-Za-z0-9_-]+)/.exec(gesendet[0]?.text ?? '')?.[1] ?? '';
    expect(token).not.toBe('');
    return token;
  }

  /** Löst die Einladung ein: ohne Anmeldung, wie der Empfänger es tut. Liefert den Cookie der neuen Sitzung. */
  async function einloesen(token: string, person: Person, name: string): Promise<void> {
    const formularSeite = await get(`/einladung/${token}`);
    expect(formularSeite.statusCode).toBe(200);
    expect(formularSeite.body).toContain(person.email);
    const antwort = await post(`/einladung/${token}`, {
      name,
      passwort: person.passwort,
      passwortWiederholung: person.passwort,
    });
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/zwei-faktor');
    person.cookie = cookieKopf(antwort.headers['set-cookie']);
    expect(sitzung(antwort)).toBeTruthy();
    const konto = await pool.query<{ id: string }>('SELECT id FROM cockpit."user" WHERE lower(email) = $1', [person.email]);
    person.id = konto.rows[0]?.id ?? '';
    // Ein zweiter Versuch mit demselben Link: verbraucht, neutrale 404.
    expect((await get(`/einladung/${token}`)).statusCode).toBe(404);
  }

  // --- Aufbau ------------------------------------------------------------------------------

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await pool.query('DELETE FROM cockpit.erststart_token');
    await kontenLoeschen(pool);
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    // Mail: der echte Versandweg, nur der Transport fängt die Nachricht ab.
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const echteSendMail = transporter.sendMail.bind(transporter);
    transporter.sendMail = (async (optionen: Parameters<typeof echteSendMail>[0]) => {
      const info = await echteSendMail(optionen);
      gesendet.push(JSON.parse(String(info.message)) as Nachricht);
      return info;
    }) as typeof transporter.sendMail;
    app = buildApp(
      { nodeEnv: 'test' },
      { auth, pool, versand: mailversandBauen(transporter, 'cockpit@example.org'), basisUrl: BASIS_URL },
    );
    marke = await protokollMarke(pool);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await kontenLoeschen(pool);
    await pool.end();
  });

  // --- Der Ablauf --------------------------------------------------------------------------

  describe('1. Betreuer-Zugang per Konsolen-Token', () => {
    it('beginnt auf einer frischen Instanz ohne Konto und ohne dass ein Test etwas vorbereitet', async () => {
      expect(await zaehlen('SELECT 1 FROM cockpit."user"')).toBe(0);
      expect(await zaehlen('SELECT 1 FROM cockpit.einladung')).toBe(0);
    });

    it('gibt das Token über das Server-Kommando aus: Link auf stdout, genau einmal, nichts auf stderr', async () => {
      const lauf = await kommando('erststart');

      expect(lauf.code).toBe(0);
      const token = /\/erststart\/([A-Za-z0-9_-]+)/.exec(lauf.stdout)?.[1] ?? '';
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(lauf.stdout.split(token)).toHaveLength(2);
      expect(lauf.stderr).toBe('');
      erststartToken = token;
    });

    it('legt mit dem Token das Konto an; es ist der Betreuer, eingerichtet über das Formular', async () => {
      expect((await get(`/erststart/${erststartToken}`)).statusCode).toBe(200);

      const antwort = await post(`/erststart/${erststartToken}`, {
        email: betreuer.email,
        passwort: betreuer.passwort,
        passwortWiederholung: betreuer.passwort,
      });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/zwei-faktor');
      betreuer.cookie = cookieKopf(antwort.headers['set-cookie']);
      const konto = await pool.query<{ id: string }>('SELECT id FROM cockpit."user"');
      expect(konto.rows).toHaveLength(1);
      betreuer.id = konto.rows[0]?.id ?? '';
      // Die Rolle kommt aus dem Erststart selbst (COPI-22): nichts wurde von Hand gesetzt.
      expect(await rolleVon(betreuer.id)).toBe('betreuer');
      expect(await aktiviertAm(betreuer.id)).toBeNull();
    });

    it('lässt das Token nur einmal gelten: verbraucht, und das Kommando lehnt ab, sobald ein Konto besteht', async () => {
      expect((await get(`/erststart/${erststartToken}`)).statusCode).toBe(404);
      const nochmal = await kommando('erststart');
      expect(nochmal.code).toBe(1);
      expect(nochmal.stdout).toBe('');
    });
  });

  describe('2. Ohne zweiten Faktor führt nichts irgendwohin; mit Passkey ist das Konto aktiv', () => {
    it('sperrt den Betreuer bis zur Einrichtung aus: kein Cockpit, kein Einladen (negativ)', async () => {
      await ohneFaktorIstAlleszu(betreuer);
    });

    it('richtet den Passkey ein: aktiv, Ersatzcodes, aktiviert_am gesetzt, das Cockpit ist offen', async () => {
      const einrichtung = await passkeyEinrichten(app, alsKonto(betreuer), betreuer.passwort, BASIS_URL);

      betreuerGeraet = einrichtung.geraet;
      expect(einrichtung.ersatzcodes).toHaveLength(10);
      expect(await aktiviertAm(betreuer.id)).toBeInstanceOf(Date);
      await istAktiv(betreuer);
    });
  });

  describe('3. Zweistufige Anmeldung', () => {
    it('meldet ab, und dann ist nichts mehr offen', async () => {
      await abmelden(betreuer);
      expect((await get('/einladung')).statusCode).toBe(404);
    });

    it('verlangt nach dem Passwort den Passkey: erst danach entsteht die Sitzung', async () => {
      await mitPasskeyAnmelden(betreuer, betreuerGeraet);
    });
  });

  describe('4. Der Betreuer lädt einen Betriebs-Admin ein', () => {
    let token = '';

    it('verschickt die Einladung per Mail an die eine Adresse; die Rolle gehört zur Einladung', async () => {
      token = await einladen(betreuer, admin.email, 'betriebs_admin');

      expect(await offeneEinladungen()).toBe(1);
    });

    it('legt beim Einlösen das Konto an; die Rolle kommt aus der Einladung, nicht aus dem Formular', async () => {
      await einloesen(token, admin, ADMIN.name);

      expect(await rolleVon(admin.id)).toBe('betriebs_admin');
      expect(await offeneEinladungen()).toBe(0);
      expect(await aktiviertAm(admin.id)).toBeNull();
    });

    it('sperrt das neue Konto bis zur Einrichtung aus: kein Cockpit, kein Einladen (negativ)', async () => {
      await ohneFaktorIstAlleszu(admin);
    });

    it('richtet TOTP ein: aktiv, aktiviert_am gesetzt; nach Abmelden und Anmelden mit Passwort und Code offen', async () => {
      adminGeheimnis = await totpEinrichten(admin);
      expect(await aktiviertAm(admin.id)).toBeInstanceOf(Date);
      await istAktiv(admin);

      await abmelden(admin);
      await mitTotpAnmelden(admin, adminGeheimnis);
    });
  });

  describe('5. Der Betriebs-Admin lädt einen Mitarbeiter ein', () => {
    let token = '';

    it('darf nur Mitarbeiter einladen: einen Betriebs-Admin nicht (neutrale 404, nichts verschickt)', async () => {
      gesendet.length = 0;
      const abgelehnt = await post('/einladung', { email: 'noch-ein-admin@example.org', rolle: 'betriebs_admin' }, admin.cookie);

      expect(abgelehnt.statusCode).toBe(404);
      expect(gesendet).toHaveLength(0);
      expect(await offeneEinladungen()).toBe(0);
    });

    it('lädt den Mitarbeiter ein und legt beim Einlösen sein Konto an', async () => {
      token = await einladen(admin, mitarbeiter.email, 'betrieb_mitarbeiter');
      await einloesen(token, mitarbeiter, MITARBEITER.name);

      expect(await rolleVon(mitarbeiter.id)).toBe('betrieb_mitarbeiter');
      await ohneFaktorIstAlleszu(mitarbeiter);
    });

    it('richtet einen Passkey ein und ist aktiv — darf aber nicht einladen, auch mit zweitem Faktor', async () => {
      await passkeyEinrichten(app, alsKonto(mitarbeiter), mitarbeiter.passwort, BASIS_URL);
      await istAktiv(mitarbeiter);

      const vorher = await offeneEinladungen();
      expect((await get('/einladung', mitarbeiter.cookie)).statusCode).toBe(404);
      expect((await post('/einladung', { email: 'nein@example.org' }, mitarbeiter.cookie)).statusCode).toBe(404);
      expect(await offeneEinladungen()).toBe(vorher);
    });
  });

  describe('6. Verlorener zweiter Faktor', () => {
    it('stellt der Betreuer per Server-Kommando wieder her: alte Sitzung und altes Passwort öffnen nichts mehr', async () => {
      const alteSitzung = mitarbeiter.cookie;
      const altesPasswort = mitarbeiter.passwort;

      const lauf = await kommando('entsperren', '--konto', mitarbeiter.email);

      expect(lauf.code).toBe(0);
      const token = /\/zugang-wiederherstellen\/([A-Za-z0-9_-]+)/.exec(lauf.stdout)?.[1] ?? '';
      expect(token).not.toBe('');
      expect(await zweiterFaktorAktiv(pool, mitarbeiter.id)).toBe(false);
      expect(await zaehlen('SELECT 1 FROM cockpit.passkey WHERE benutzer_id = $1', [mitarbeiter.id])).toBe(0);
      const gesperrt = await get('/', alteSitzung);
      expect(gesperrt.statusCode).toBe(303);
      expect(gesperrt.headers.location).toBe('/anmelden');
      const altesPasswortAntwort = await post('/anmelden', { email: mitarbeiter.email, passwort: altesPasswort });
      expect(altesPasswortAntwort.statusCode).toBe(400);
      expect(sitzung(altesPasswortAntwort)).toBeUndefined();

      // Der Link führt zu einem neuen Passwort und in die normale Einrichtung.
      mitarbeiter.passwort = NEUES_PASSWORT;
      const einloesenAntwort = await post(`/zugang-wiederherstellen/${token}`, {
        passwort: NEUES_PASSWORT,
        passwortWiederholung: NEUES_PASSWORT,
      });
      expect(einloesenAntwort.headers.location).toBe('/zwei-faktor');
      mitarbeiter.cookie = cookieKopf(einloesenAntwort.headers['set-cookie']);
      await ohneFaktorIstAlleszu(mitarbeiter);
      expect((await get(`/zugang-wiederherstellen/${token}`)).statusCode).toBe(404);
    });

    it('endet mit einem neuen Faktor: aktiviert_am unverändert, Anmeldung mit dem neuen Passwort', async () => {
      const vorher = await aktiviertAm(mitarbeiter.id);
      const geheimnis = await totpEinrichten(mitarbeiter);

      expect(await aktiviertAm(mitarbeiter.id)).toEqual(vorher);
      await istAktiv(mitarbeiter);
      await abmelden(mitarbeiter);
      await mitTotpAnmelden(mitarbeiter, geheimnis);
    });
  });

  describe('7. Endzustand und Protokoll', () => {
    it('hat genau drei Konten mit den drei Rollen, genau einen Betreuer, alle aktiv', async () => {
      const konten = await pool.query<{ email: string; rolle: string }>('SELECT email, rolle FROM cockpit."user" ORDER BY "createdAt"');
      expect(konten.rows).toEqual([
        { email: betreuer.email, rolle: 'betreuer' },
        { email: admin.email, rolle: 'betriebs_admin' },
        { email: mitarbeiter.email, rolle: 'betrieb_mitarbeiter' },
      ]);
      expect(await zaehlen(`SELECT 1 FROM cockpit."user" WHERE rolle = 'betreuer'`)).toBe(1);
      for (const person of [betreuer, admin, mitarbeiter]) {
        expect(await zweiterFaktorAktiv(pool, person.id)).toBe(true);
        expect(await aktiviertAm(person.id)).toBeInstanceOf(Date);
      }
      expect(await offeneEinladungen()).toBe(0);
      expect(await zaehlen('SELECT 1 FROM cockpit.erststart_token WHERE verbraucht_am IS NULL')).toBe(0);
    });

    it('erzählt die ganze Geschichte im Protokoll, in dieser Reihenfolge, ohne Adresse und ohne Token', async () => {
      const namen: Record<string, string> = {
        [betreuer.id]: 'betreuer',
        [admin.id]: 'admin',
        [mitarbeiter.id]: 'mitarbeiter',
      };
      const name = (kennung: string | null): string => (kennung === null ? '-' : (namen[kennung] ?? kennung));

      const eintraege = await protokollSeit(pool, marke);
      const geschichte = eintraege.map((eintrag) => {
        const einzelheiten = eintrag.einzelheiten as Record<string, unknown>;
        const teile = [eintrag.art, name(eintrag.akteur), name(eintrag.ziel)];
        for (const schluessel of ['weg', 'rolle', 'faktor', 'schritt']) {
          if (schluessel in einzelheiten) {
            teile.push(`${schluessel}=${String(einzelheiten[schluessel])}`);
          }
        }
        return teile.join(' | ');
      });

      expect(geschichte).toEqual([
        // 1. Konsole und Erststart
        'erststart_token_erzeugt | konsole | -',
        'konto_angelegt | erststart | betreuer | weg=erststart | rolle=betreuer',
        // 2. Passkey
        'zweiter_faktor_eingerichtet | betreuer | - | faktor=passkey',
        // 3. Abmelden, zweistufig anmelden (das Passwort allein hinterlässt nichts)
        'abmeldung | betreuer | -',
        'anmeldung_erfolgreich | betreuer | - | faktor=passkey | schritt=code',
        // 4. Einladung des Betriebs-Admins
        'einladung_erzeugt | betreuer | - | rolle=betriebs_admin',
        'einladung_eingeloest | einladung | - | rolle=betriebs_admin',
        'konto_angelegt | einladung | admin | weg=einladung | rolle=betriebs_admin',
        'zweiter_faktor_eingerichtet | admin | - | faktor=totp',
        'abmeldung | admin | -',
        'anmeldung_erfolgreich | admin | - | faktor=totp | schritt=code',
        // 5. Einladung des Mitarbeiters
        'einladung_erzeugt | admin | - | rolle=betrieb_mitarbeiter',
        'einladung_eingeloest | einladung | - | rolle=betrieb_mitarbeiter',
        'konto_angelegt | einladung | mitarbeiter | weg=einladung | rolle=betrieb_mitarbeiter',
        'zweiter_faktor_eingerichtet | mitarbeiter | - | faktor=passkey',
        // 6. Verlust und Wiederherstellung
        'konto_entsperrt | konsole | mitarbeiter | rolle=betrieb_mitarbeiter',
        'anmeldung_fehlgeschlagen | system | mitarbeiter | schritt=passwort',
        'zugang_wiederhergestellt | wiederherstellung | mitarbeiter',
        'zweiter_faktor_eingerichtet | mitarbeiter | - | faktor=totp',
        'abmeldung | mitarbeiter | -',
        'anmeldung_erfolgreich | mitarbeiter | - | faktor=totp | schritt=code',
      ]);

      const klartext = JSON.stringify(eintraege);
      for (const geheim of [betreuer.email, admin.email, mitarbeiter.email, erststartToken, BETREUER.passwort, ADMIN.passwort, NEUES_PASSWORT]) {
        expect(klartext).not.toContain(geheim);
      }
    });
  });

});
