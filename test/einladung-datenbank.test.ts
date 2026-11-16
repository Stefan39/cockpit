/**
 * Einladungs-Flow gegen eine echte PostgreSQL. Läuft nur, wenn `TEST_DATABASE_URL`
 * gesetzt ist — in der CI über den Postgres-Service-Container, lokal nur mit
 * einer eigens dafür bereitgestellten Datenbank.
 *
 * ACHTUNG: Der Test räumt die Tabellen `cockpit."user"` und
 * `cockpit.einladung` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 *
 * Schwerpunkt ist die **Autorisierung**: wer das Einladungsformular erreicht
 * und wer nicht. Der wichtigste Fall ist ein `betrieb_mitarbeiter` mit
 * aktivem zweitem Faktor — ein vollwertig angemeldetes Konto, dem allein die
 * Rolle fehlt.
 */
import { readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { betreuerUebergeben } from '../src/auth/betreuer.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { tokenHashen } from '../src/auth/einmal-token.js';
import { buildApp } from '../src/server/app.js';
import { einladungsMailBauen } from '../src/mail/einladung-mail.js';
import { mailversandBauen, type Mailversand } from '../src/mail/versand.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import {
  cookieKopf,
  FORMULAR_KOPF,
  formular,
  kontenLoeschen,
  kontoEinrichten,
  protokollMarke,
  protokollSchreibenScheitern,
  protokollSeit,
  type Konto,
} from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';
const ADMIN = 'admin@example.org';
const BETREUER = 'betreuer@example.org';
const MITARBEITER = 'mitarbeiter@example.org';
const ADMIN_OHNE_FAKTOR = 'admin-ohne-faktor@example.org';
const EINGELADEN = 'neue.kollegin@example.org';

interface JsonNachricht {
  readonly from: { address: string; name: string };
  readonly to: { address: string }[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Tor weit offen: so zeigt sich, dass die Route für sich selbst prüft. */
const TOR_OFFEN: SitzungLesen = () =>
  Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

describe.skipIf(!datenbankUrl)('Einladung gegen echte Datenbank', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let appOhneTor: FastifyInstance;
  let admin: Konto;
  let betreuer: Konto;
  let mitarbeiter: Konto;
  let adminOhneFaktor: Konto;
  const gesendet: JsonNachricht[] = [];

  function versandMitErfassung(): Mailversand {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const echteSendMail = transporter.sendMail.bind(transporter);
    transporter.sendMail = (async (optionen: Parameters<typeof echteSendMail>[0]) => {
      const info = await echteSendMail(optionen);
      gesendet.push(JSON.parse(String(info.message)) as JsonNachricht);
      return info;
    }) as typeof transporter.sendMail;
    return mailversandBauen(transporter, 'cockpit@example.org');
  }

  async function rolleSetzenDirekt(benutzerId: string, rolle: string): Promise<void> {
    await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [benutzerId, rolle]);
  }

  async function rolleLesenDirekt(email: string): Promise<string | undefined> {
    const ergebnis = await pool.query<{ rolle: string }>(
      'SELECT rolle FROM cockpit."user" WHERE lower(email) = $1',
      [email],
    );
    return ergebnis.rows[0]?.rolle;
  }

  async function offeneEinladungen(): Promise<number> {
    const ergebnis = await pool.query<{ anzahl: string }>(
      'SELECT count(*)::text AS anzahl FROM cockpit.einladung WHERE verbraucht_am IS NULL',
    );
    return Number(ergebnis.rows[0]?.anzahl ?? '0');
  }

  /**
   * Verschickt eine Einladung (standardmäßig als Betriebs-Admin, ohne Rollenangabe)
   * und liefert das Token aus der Mail.
   */
  async function einladen(
    email: string,
    optionen: { rolle?: string; cookie?: string } = {},
  ): Promise<string> {
    gesendet.length = 0;
    const antwort = await app.inject({
      method: 'POST',
      url: '/einladung',
      headers: { ...FORMULAR_KOPF, cookie: optionen.cookie ?? admin.cookie },
      payload: formular(optionen.rolle === undefined ? { email } : { email, rolle: optionen.rolle }),
    });
    expect(antwort.statusCode).toBe(200);
    const text = gesendet[0]?.text ?? '';
    return /\/einladung\/([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    const versand = versandMitErfassung();
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, versand, basisUrl: BASIS_URL });
    appOhneTor = buildApp(
      { nodeEnv: 'test' },
      { auth, pool, versand, basisUrl: BASIS_URL, sitzungLesen: TOR_OFFEN },
    );

    admin = await kontoEinrichten(app, auth, {
      email: ADMIN,
      passwort: PASSWORT,
      name: 'Admin',
      mitZweitemFaktor: true,
    });
    betreuer = await kontoEinrichten(app, auth, {
      email: BETREUER,
      passwort: PASSWORT,
      name: 'Betreuer',
      mitZweitemFaktor: true,
    });
    mitarbeiter = await kontoEinrichten(app, auth, {
      email: MITARBEITER,
      passwort: PASSWORT,
      name: 'Mitarbeiter',
      mitZweitemFaktor: true,
    });
    adminOhneFaktor = await kontoEinrichten(app, auth, {
      email: ADMIN_OHNE_FAKTOR,
      passwort: PASSWORT,
      name: 'Admin ohne Faktor',
      mitZweitemFaktor: false,
    });
    await rolleSetzenDirekt(betreuer.id, 'betreuer');
    await rolleSetzenDirekt(admin.id, 'betriebs_admin');
    await rolleSetzenDirekt(adminOhneFaktor.id, 'betriebs_admin');
    // mitarbeiter behält den Spalten-Default `betrieb_mitarbeiter`.
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await appOhneTor.close();
    await pool.end();
  });

  describe('Autorisierung des Einladungsformulars', () => {
    it('lässt betriebs_admin mit aktivem zweitem Faktor an das Formular', async () => {
      const antwort = await app.inject({
        method: 'GET',
        url: '/einladung',
        headers: { cookie: admin.cookie },
      });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.body).toContain('Nutzer einladen');
    });

    it('zeigt das Formular im App-Rahmen: „Mehr" ist markiert, die Übersicht ein Weg zurück, Abmelden da (COPI-38, COPI-43)', async () => {
      const antwort = await app.inject({ method: 'GET', url: '/einladung', headers: { cookie: admin.cookie } });

      expect(antwort.body).toContain('<a href="/mehr" class="hauptnav-eintrag" aria-current="page">');
      expect(antwort.body).toContain('<a href="/" class="hauptnav-eintrag">');
      expect(antwort.body).toContain('<form method="post" action="/abmelden"');
    });

    it('verwehrt einem betrieb_mitarbeiter den Zugriff — auch mit aktivem zweitem Faktor', async () => {
      // Der wichtigste Fall dieses Tickets: ein vollwertig angemeldetes Konto
      // mit zweitem Faktor, dem allein die Rolle fehlt.
      const vorher = await offeneEinladungen();

      const anzeigen = await app.inject({
        method: 'GET',
        url: '/einladung',
        headers: { cookie: mitarbeiter.cookie },
      });
      const abschicken = await app.inject({
        method: 'POST',
        url: '/einladung',
        headers: { ...FORMULAR_KOPF, cookie: mitarbeiter.cookie },
        payload: formular({ email: 'heimlich@example.org' }),
      });

      expect(anzeigen.statusCode).toBe(404);
      expect(anzeigen.body).not.toContain('Nutzer einladen');
      expect(abschicken.statusCode).toBe(404);
      // Belegt zugleich, dass der preHandler die Anfrage wirklich abbricht und
      // der Handler nicht doch noch läuft.
      expect(await offeneEinladungen()).toBe(vorher);
    });

    it('verwehrt einem betriebs_admin ohne zweiten Faktor den Zugriff', async () => {
      const antwort = await app.inject({
        method: 'GET',
        url: '/einladung',
        headers: { cookie: adminOhneFaktor.cookie },
      });

      // Hier greift bereits die zentrale 2FA-Weiche aus COPI-10.
      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/zwei-faktor');
      expect(antwort.body).not.toContain('Nutzer einladen');
    });

    it('verwehrt den Zugriff ohne Anmeldung', async () => {
      const anzeigen = await app.inject({ method: 'GET', url: '/einladung' });
      const abschicken = await app.inject({
        method: 'POST',
        url: '/einladung',
        headers: FORMULAR_KOPF,
        payload: formular({ email: 'heimlich@example.org' }),
      });

      expect(anzeigen.statusCode).toBe(404);
      expect(abschicken.statusCode).toBe(404);
      expect(await offeneEinladungen()).toBe(0);
    });

    it('prüft selbst, auch wenn die 2FA-Weiche alles durchließe', async () => {
      // Dieselben Fälle noch einmal gegen eine Anwendung, deren zentrale
      // Weiche nichts blockiert: die Route verlässt sich also nicht auf sie.
      const alsAdmin = await appOhneTor.inject({
        method: 'GET',
        url: '/einladung',
        headers: { cookie: admin.cookie },
      });
      const alsMitarbeiter = await appOhneTor.inject({
        method: 'GET',
        url: '/einladung',
        headers: { cookie: mitarbeiter.cookie },
      });
      const ohneZweitenFaktor = await appOhneTor.inject({
        method: 'GET',
        url: '/einladung',
        headers: { cookie: adminOhneFaktor.cookie },
      });
      const abschickenOhneZweitenFaktor = await appOhneTor.inject({
        method: 'POST',
        url: '/einladung',
        headers: { ...FORMULAR_KOPF, cookie: adminOhneFaktor.cookie },
        payload: formular({ email: 'heimlich@example.org' }),
      });

      expect(alsAdmin.statusCode).toBe(200);
      expect(alsMitarbeiter.statusCode).toBe(404);
      expect(ohneZweitenFaktor.statusCode).toBe(404);
      expect(abschickenOhneZweitenFaktor.statusCode).toBe(404);
      expect(await offeneEinladungen()).toBe(0);
    });
  });

  describe('Einladung verschicken', () => {
    it('legt genau eine Einladung an und speichert nur den Hash', async () => {
      await pool.query('DELETE FROM cockpit.einladung');

      const token = await einladen(EINGELADEN);

      expect(token).not.toBe('');
      const zeilen = await pool.query<{ zeile: string; token_hash: string; email: string }>(
        'SELECT einladung::text AS zeile, token_hash, email FROM cockpit.einladung',
      );
      expect(zeilen.rows).toHaveLength(1);
      expect(zeilen.rows[0]?.email).toBe(EINGELADEN);
      expect(zeilen.rows[0]?.token_hash).toBe(tokenHashen(token));
      // Der Klartext taucht in der gesamten Zeile nirgends auf.
      expect(zeilen.rows[0]?.zeile).not.toContain(token);
    });

    it('setzt die Gültigkeit auf 3 Stunden', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      await einladen(EINGELADEN);

      const ergebnis = await pool.query<{ stunden: string }>(
        'SELECT (EXTRACT(EPOCH FROM (ablauf_am - erstellt_am)) / 3600)::text AS stunden FROM cockpit.einladung',
      );

      expect(Number(ergebnis.rows[0]?.stunden)).toBeCloseTo(3, 2);
    });

    it('verschickt eine Mail nach den Konventionen aus Abschnitt 7', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      const token = await einladen(EINGELADEN);
      const nachricht = gesendet[0];

      expect(nachricht?.to[0]?.address).toBe(EINGELADEN);
      expect(nachricht?.from.address).toBe('cockpit@example.org');
      expect(nachricht?.from.name).toBe('');
      expect(nachricht?.text).toContain('Guten Tag');
      expect(nachricht?.html).toContain('<p>');
      // Kein Empfängerwert im Text, aber die Einlöse-Adresse.
      expect(nachricht?.text).not.toContain(EINGELADEN);
      expect(nachricht?.html).not.toContain(EINGELADEN);
      expect(nachricht?.text).toContain(`${BASIS_URL}/einladung/${token}`);
    });

    it('weist eine unplausible Adresse ab, ohne eine Einladung anzulegen', async () => {
      await pool.query('DELETE FROM cockpit.einladung');

      const antwort = await app.inject({
        method: 'POST',
        url: '/einladung',
        headers: { ...FORMULAR_KOPF, cookie: admin.cookie },
        payload: formular({ email: 'keine-adresse' }),
      });

      expect(antwort.statusCode).toBe(400);
      expect(await offeneEinladungen()).toBe(0);
    });

    it('lädt niemanden ein, für den es bereits einen Zugang gibt', async () => {
      await pool.query('DELETE FROM cockpit.einladung');

      const antwort = await app.inject({
        method: 'POST',
        url: '/einladung',
        headers: { ...FORMULAR_KOPF, cookie: admin.cookie },
        payload: formular({ email: MITARBEITER }),
      });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain('bereits einen Zugang');
      expect(await offeneEinladungen()).toBe(0);
    });

    it('entwertet eine vorherige offene Einladung an dieselbe Adresse', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      const alt = await einladen(EINGELADEN);
      const neu = await einladen(EINGELADEN);

      expect(await offeneEinladungen()).toBe(1);
      const veraltet = await app.inject({ method: 'GET', url: `/einladung/${alt}` });
      const aktuell = await app.inject({ method: 'GET', url: `/einladung/${neu}` });

      expect(veraltet.statusCode).toBe(404);
      expect(aktuell.statusCode).toBe(200);
    });
  });

  describe('Einladung einlösen', () => {
    it('zeigt das Formular ohne Anmeldung, aber nur mit gültigem Token', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      const token = await einladen(EINGELADEN);

      const gueltig = await app.inject({ method: 'GET', url: `/einladung/${token}` });
      const erfunden = await app.inject({ method: 'GET', url: '/einladung/frei-erfunden' });

      expect(gueltig.statusCode).toBe(200);
      expect(gueltig.body).toContain('Zugang einrichten');
      expect(erfunden.statusCode).toBe(404);
      expect(erfunden.body).not.toContain('Zugang einrichten');
    });

    it('weist eine abgelaufene Einladung ab', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      const token = await einladen(EINGELADEN);
      await pool.query(
        "UPDATE cockpit.einladung SET ablauf_am = now() - interval '1 minute' WHERE verbraucht_am IS NULL",
      );

      const antwort = await app.inject({ method: 'GET', url: `/einladung/${token}` });

      expect(antwort.statusCode).toBe(404);
    });

    it('verbrennt die Einladung bei einem Eingabefehler nicht', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      const token = await einladen(EINGELADEN);

      const antwort = await app.inject({
        method: 'POST',
        url: `/einladung/${token}`,
        headers: FORMULAR_KOPF,
        payload: formular({
          name: 'Neue Kollegin',
          passwort: 'zu-kurz',
          passwortWiederholung: 'zu-kurz',
        }),
      });

      expect(antwort.statusCode).toBe(400);
      expect(await offeneEinladungen()).toBe(1);
      const nochmal = await app.inject({ method: 'GET', url: `/einladung/${token}` });
      expect(nochmal.statusCode).toBe(200);
    });

    it('legt das Konto mit Rolle betrieb_mitarbeiter an und entwertet die Einladung', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      await pool.query('DELETE FROM cockpit."user" WHERE lower(email) = $1', [EINGELADEN]);
      const token = await einladen(EINGELADEN);

      const antwort = await app.inject({
        method: 'POST',
        url: `/einladung/${token}`,
        headers: FORMULAR_KOPF,
        payload: formular({
          name: 'Neue Kollegin',
          passwort: PASSWORT,
          passwortWiederholung: PASSWORT,
        }),
      });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/zwei-faktor');
      expect(await rolleLesenDirekt(EINGELADEN)).toBe('betrieb_mitarbeiter');
      expect(await offeneEinladungen()).toBe(0);

      // Das neue Konto hat eine Sitzung, aber noch keinen zweiten Faktor —
      // die zentrale Weiche aus COPI-10 greift ohne Zutun dieser Routen.
      const cookie = cookieKopf(antwort.headers['set-cookie']);
      expect(cookie).toContain('__Host-cockpit.session_token');
      const geschuetzt = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
      expect(geschuetzt.statusCode).toBe(303);
      expect(geschuetzt.headers.location).toBe('/zwei-faktor');

      // Und es darf selbst nicht einladen.
      const einladungsversuch = await app.inject({
        method: 'GET',
        url: '/einladung',
        headers: { cookie },
      });
      expect(einladungsversuch.statusCode).toBe(303);

      // Passwort als Argon2id-Hash, Einladung nicht wiederverwendbar.
      const konten = await pool.query<{ password: string | null }>(
        `SELECT a.password FROM cockpit."account" a
           JOIN cockpit."user" u ON u.id = a."userId"
          WHERE lower(u.email) = $1`,
        [EINGELADEN],
      );
      expect(konten.rows[0]?.password ?? '').toMatch(/^\$argon2id\$/);

      const nochmal = await app.inject({ method: 'GET', url: `/einladung/${token}` });
      expect(nochmal.statusCode).toBe(404);
    });

    it('legt kein zweites Konto zur selben Adresse an', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      // Einladung von Hand anlegen: über die Route ginge es nicht, weil der
      // Zugang inzwischen existiert — genau das ist hier der Ausgangspunkt.
      const { einladungAnlegen } = await import('../src/auth/einladung-speicher.js');
      const token = await einladungAnlegen(pool, EINGELADEN, admin.id);

      const antwort = await app.inject({
        method: 'POST',
        url: `/einladung/${token.token}`,
        headers: FORMULAR_KOPF,
        payload: formular({
          name: 'Doppelt',
          passwort: PASSWORT,
          passwortWiederholung: PASSWORT,
        }),
      });

      expect(antwort.statusCode).toBe(400);
      const anzahl = await pool.query<{ anzahl: string }>(
        'SELECT count(*)::text AS anzahl FROM cockpit."user" WHERE lower(email) = $1',
        [EINGELADEN],
      );
      expect(anzahl.rows[0]?.anzahl).toBe('1');
    });
  });

  describe('Rolle der Einladung (COPI-22)', () => {
    /** Räumt Einladungen und das Konto der Eingeladenen ab, damit jeder Test bei null beginnt. */
    async function zuruecksetzen(): Promise<void> {
      await pool.query('DELETE FROM cockpit.einladung');
      await pool.query('DELETE FROM cockpit."user" WHERE lower(email) = $1', [EINGELADEN]);
      gesendet.length = 0;
    }

    async function einlösen(token: string, zusatz: Record<string, string> = {}): Promise<number> {
      const antwort = await app.inject({
        method: 'POST',
        url: `/einladung/${token}`,
        headers: FORMULAR_KOPF,
        payload: formular({
          name: 'Neue Kollegin',
          passwort: PASSWORT,
          passwortWiederholung: PASSWORT,
          ...zusatz,
        }),
      });
      return antwort.statusCode;
    }

    async function gespeicherteRolle(): Promise<string | undefined> {
      const ergebnis = await pool.query<{ rolle: string }>(
        'SELECT rolle FROM cockpit.einladung WHERE verbraucht_am IS NULL OR email = $1 ORDER BY id DESC LIMIT 1',
        [EINGELADEN],
      );
      return ergebnis.rows[0]?.rolle;
    }

    it('bietet dem Betreuer Betriebs-Admin und Mitarbeiter an', async () => {
      const antwort = await app.inject({
        method: 'GET',
        url: '/einladung',
        headers: { cookie: betreuer.cookie },
      });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.body).toContain('value="betriebs_admin"');
      expect(antwort.body).toContain('value="betrieb_mitarbeiter"');
      expect(antwort.body).not.toContain('value="betreuer"');
    });

    it('bietet dem Betriebs-Admin nur Mitarbeiter an', async () => {
      const antwort = await app.inject({
        method: 'GET',
        url: '/einladung',
        headers: { cookie: admin.cookie },
      });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.body).toContain('value="betrieb_mitarbeiter"');
      expect(antwort.body).not.toContain('value="betriebs_admin"');
      expect(antwort.body).not.toContain('value="betreuer"');
    });

    it('lässt den Betreuer einen Betriebs-Admin einladen; das eingelöste Konto hat diese Rolle', async () => {
      await zuruecksetzen();

      const token = await einladen(EINGELADEN, { rolle: 'betriebs_admin', cookie: betreuer.cookie });

      expect(await gespeicherteRolle()).toBe('betriebs_admin');
      expect(await einlösen(token)).toBe(303);
      expect(await rolleLesenDirekt(EINGELADEN)).toBe('betriebs_admin');
    });

    it('macht ohne Rollenangabe einen Mitarbeiter daraus, auch beim Betreuer', async () => {
      await zuruecksetzen();

      const token = await einladen(EINGELADEN, { cookie: betreuer.cookie });

      expect(await gespeicherteRolle()).toBe('betrieb_mitarbeiter');
      expect(await einlösen(token)).toBe(303);
      expect(await rolleLesenDirekt(EINGELADEN)).toBe('betrieb_mitarbeiter');
    });

    it('lässt den Betriebs-Admin einen Mitarbeiter einladen', async () => {
      await zuruecksetzen();

      const token = await einladen(EINGELADEN, { rolle: 'betrieb_mitarbeiter' });

      expect(await einlösen(token)).toBe(303);
      expect(await rolleLesenDirekt(EINGELADEN)).toBe('betrieb_mitarbeiter');
    });

    it.each([
      // Der Betriebs-Admin darf weder seinesgleichen noch den Betreuer einladen —
      // auch nicht, wenn er das Formular von Hand manipuliert.
      ['admin', 'betriebs_admin'],
      ['admin', 'betreuer'],
      // Der Betreuer entsteht nie durch eine Einladung, auch nicht durch den Betreuer.
      ['betreuer', 'betreuer'],
      // Unbekannte Werte werden ebenso neutral abgewiesen.
      ['betreuer', 'superadmin'],
      ['admin', 'superadmin'],
    ] as const)('weist %s mit der Rolle %s neutral ab, ohne Einladung und ohne Mail', async (wer, rolle) => {
      await zuruecksetzen();
      const cookie = wer === 'admin' ? admin.cookie : betreuer.cookie;

      const antwort = await app.inject({
        method: 'POST',
        url: '/einladung',
        headers: { ...FORMULAR_KOPF, cookie },
        payload: formular({ email: EINGELADEN, rolle }),
      });

      expect(antwort.statusCode).toBe(404);
      expect(antwort.body).toContain('Nicht gefunden');
      expect(await offeneEinladungen()).toBe(0);
      expect(gesendet).toHaveLength(0);
    });

    it('nimmt beim Einlösen die Rolle aus der Datenbank, nie aus dem Formular', async () => {
      await zuruecksetzen();
      const token = await einladen(EINGELADEN, { cookie: betreuer.cookie });

      // Ein untergeschobenes Feld im Einlöse-Formular ändert nichts.
      expect(await einlösen(token, { rolle: 'betreuer' })).toBe(303);

      expect(await rolleLesenDirekt(EINGELADEN)).toBe('betrieb_mitarbeiter');
    });

    it('wirkt bei einem Betreuerwechsel sofort, auch für angemeldete Sitzungen', async () => {
      // admin (Betriebs-Admin) wird Betreuer, der bisherige Betreuer Mitarbeiter.
      await betreuerUebergeben(pool, { an: admin.id });
      try {
        const alterBetreuer = await app.inject({
          method: 'GET',
          url: '/einladung',
          headers: { cookie: betreuer.cookie },
        });
        const neuerBetreuer = await app.inject({
          method: 'GET',
          url: '/einladung',
          headers: { cookie: admin.cookie },
        });

        expect(alterBetreuer.statusCode).toBe(404);
        expect(neuerBetreuer.statusCode).toBe(200);
        expect(neuerBetreuer.body).toContain('value="betriebs_admin"');
      } finally {
        // Zurück in den Ausgangszustand für die folgenden Tests.
        await betreuerUebergeben(pool, { an: betreuer.id, bisherigerWirdRolle: 'betriebs_admin' });
      }
      expect(await rolleLesenDirekt(BETREUER)).toBe('betreuer');
      expect(await rolleLesenDirekt(ADMIN)).toBe('betriebs_admin');
    });
  });

  describe('Protokoll (COPI-23)', () => {
    async function zuruecksetzen(): Promise<void> {
      await pool.query('DELETE FROM cockpit.einladung');
      await pool.query('DELETE FROM cockpit."user" WHERE lower(email) = $1', [EINGELADEN]);
      gesendet.length = 0;
    }

    async function einladungId(): Promise<number> {
      const ergebnis = await pool.query<{ id: string }>(
        'SELECT id::text AS id FROM cockpit.einladung ORDER BY id DESC LIMIT 1',
      );
      return Number(ergebnis.rows[0]?.id);
    }

    async function einloesen(token: string, passwort = PASSWORT): Promise<number> {
      const antwort = await app.inject({
        method: 'POST',
        url: `/einladung/${token}`,
        headers: FORMULAR_KOPF,
        payload: formular({
          name: 'Neue Kollegin',
          passwort,
          passwortWiederholung: passwort,
        }),
      });
      return antwort.statusCode;
    }

    it('hält das Erzeugen einer Einladung genau einmal fest, mit Einladendem und Rolle', async () => {
      await zuruecksetzen();
      const marke = await protokollMarke(pool);

      await einladen(EINGELADEN, { rolle: 'betriebs_admin', cookie: betreuer.cookie });

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'einladung_erzeugt',
          akteur: betreuer.id,
          ziel: null,
          einzelheiten: { rolle: 'betriebs_admin', einladung_id: await einladungId() },
        },
      ]);
    });

    it('hält das Einlösen fest: die Einladung, dann das angelegte Konto', async () => {
      await zuruecksetzen();
      const token = await einladen(EINGELADEN, { rolle: 'betriebs_admin', cookie: betreuer.cookie });
      const id = await einladungId();
      const marke = await protokollMarke(pool);

      expect(await einloesen(token)).toBe(303);

      const neuesKonto = await pool.query<{ id: string }>(
        'SELECT id FROM cockpit."user" WHERE lower(email) = $1',
        [EINGELADEN],
      );
      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'einladung_eingeloest',
          akteur: 'einladung',
          ziel: null,
          einzelheiten: { einladung_id: id, rolle: 'betriebs_admin' },
        },
        {
          art: 'konto_angelegt',
          akteur: 'einladung',
          ziel: neuesKonto.rows[0]?.id,
          einzelheiten: { weg: 'einladung', rolle: 'betriebs_admin' },
        },
      ]);
    });

    it('hält jede neue Einladung fest, auch wenn sie eine frühere an dieselbe Adresse entwertet', async () => {
      await zuruecksetzen();
      const marke = await protokollMarke(pool);

      await einladen(EINGELADEN);
      await einladen(EINGELADEN);

      expect((await protokollSeit(pool, marke)).map((zeile) => zeile.art)).toEqual([
        'einladung_erzeugt',
        'einladung_erzeugt',
      ]);
    });

    it('schreibt nichts, wenn nichts geschieht', async () => {
      await zuruecksetzen();
      const token = await einladen(EINGELADEN);
      const marke = await protokollMarke(pool);

      // Zu kurzes Passwort: die Einladung bleibt gültig, nichts wird angelegt.
      expect(await einloesen(token, 'zu-kurz')).toBe(400);
      // Ein erfundenes Token.
      const erfunden = await app.inject({
        method: 'POST',
        url: '/einladung/frei-erfunden',
        headers: FORMULAR_KOPF,
        payload: formular({ name: 'X', passwort: PASSWORT, passwortWiederholung: PASSWORT }),
      });
      expect(erfunden.statusCode).toBe(404);
      // Eine nicht erlaubte Rolle, eine unplausible Adresse, ein vorhandener Zugang.
      for (const payload of [
        { email: 'neu@example.org', rolle: 'betreuer' },
        { email: 'keine-adresse' },
        { email: MITARBEITER },
      ]) {
        await app.inject({
          method: 'POST',
          url: '/einladung',
          headers: { ...FORMULAR_KOPF, cookie: betreuer.cookie },
          payload: formular(payload),
        });
      }

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('legt keine Einladung an, wenn ihr Eintrag scheitert: beides gilt oder keins', async () => {
      await zuruecksetzen();
      const aufraeumen = await protokollSchreibenScheitern(pool, 'einladung_erzeugt');
      try {
        const antwort = await app.inject({
          method: 'POST',
          url: '/einladung',
          headers: { ...FORMULAR_KOPF, cookie: admin.cookie },
          payload: formular({ email: EINGELADEN }),
        });

        expect(antwort.statusCode).toBe(500);
      } finally {
        await aufraeumen();
      }

      expect(await offeneEinladungen()).toBe(0);
      expect(gesendet).toHaveLength(0);
    });

    it('entwertet die Einladung nicht, wenn der Eintrag beim Einlösen scheitert', async () => {
      await zuruecksetzen();
      const token = await einladen(EINGELADEN);
      const aufraeumen = await protokollSchreibenScheitern(pool, 'einladung_eingeloest');
      try {
        const antwort = await app.inject({
          method: 'POST',
          url: `/einladung/${token}`,
          headers: FORMULAR_KOPF,
          payload: formular({ name: 'Neue Kollegin', passwort: PASSWORT, passwortWiederholung: PASSWORT }),
        });

        expect(antwort.statusCode).toBe(500);
      } finally {
        await aufraeumen();
      }

      // Kein Konto, und die Einladung gilt weiter: ein zweiter Versuch klappt.
      expect(await offeneEinladungen()).toBe(1);
      expect(await einloesen(token)).toBe(303);
    });

    it('lässt eine Einladung nur einmal einlösen: der zweite Versuch schreibt nichts', async () => {
      await zuruecksetzen();
      const token = await einladen(EINGELADEN);
      expect(await einloesen(token)).toBe(303);
      const marke = await protokollMarke(pool);

      expect(await einloesen(token)).toBe(404);

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });
  });

  describe('Migration 0003 — Bestandskonto', () => {
    /** Die UPDATE-Anweisung aus der ausgelieferten Migration, nicht eine Kopie. */
    async function bestandsUpdate(): Promise<string> {
      const sql = await readFile('db/migrations/0003_rollen.up.sql', 'utf8');
      return sql.slice(sql.lastIndexOf('UPDATE "cockpit"."user"'));
    }

    it('macht genau ein vorhandenes Konto zum Betriebs-Admin', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      await kontenLoeschen(pool);
      await kontoEinrichten(app, auth, {
        email: 'bestand@example.org',
        passwort: PASSWORT,
        name: 'Bestand',
        mitZweitemFaktor: false,
      });
      expect(await rolleLesenDirekt('bestand@example.org')).toBe('betrieb_mitarbeiter');

      await pool.query(await bestandsUpdate());

      expect(await rolleLesenDirekt('bestand@example.org')).toBe('betriebs_admin');
    });

    it('rät bei mehreren Konten nichts zusammen', async () => {
      await pool.query('DELETE FROM cockpit.einladung');
      await kontenLoeschen(pool);
      await kontoEinrichten(app, auth, {
        email: 'eins@example.org',
        passwort: PASSWORT,
        name: 'Eins',
        mitZweitemFaktor: false,
      });
      await kontoEinrichten(app, auth, {
        email: 'zwei@example.org',
        passwort: PASSWORT,
        name: 'Zwei',
        mitZweitemFaktor: false,
      });

      await pool.query(await bestandsUpdate());

      expect(await rolleLesenDirekt('eins@example.org')).toBe('betrieb_mitarbeiter');
      expect(await rolleLesenDirekt('zwei@example.org')).toBe('betrieb_mitarbeiter');
    });

    it('lässt keine unbekannte Rolle zu', async () => {
      await expect(
        pool.query(`UPDATE cockpit."user" SET rolle = 'superadmin'`),
      ).rejects.toThrow(/user_rolle_bekannt/);
    });
  });

  it('erzeugt denselben Mailinhalt wie die reine Funktion', () => {
    // Stellt sicher, dass die Route den Inhalt nicht eigenständig zusammenbaut.
    const inhalt = einladungsMailBauen({
      einladungsUrl: `${BASIS_URL}/einladung/beispiel`,
      gueltigStunden: 3,
    });
    expect(inhalt.betreff).toBe('Ihr Zugang zum Cockpit');
  });
});
