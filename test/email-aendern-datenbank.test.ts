/**
 * Die E-Mail-Adresse eines Kontos ändern (COPI-47), der ganze Weg mit echten Sitzungen und abgefangenen Mails.
 *
 * Beantragen (Betreuer bzw. Betriebs-Admin, wie COPI-46) ändert am Konto nichts: die Mail an die neue Adresse trägt den
 * Link, die bisherige bekommt einen Hinweis ohne Adresse und Link. Erst der Knopf hinter dem Link macht die Adresse
 * gültig — genau einmal; ein bloßes Öffnen des Links ändert nichts.
 *
 * Mails werden über den JSON-Transport von nodemailer abgefangen (wie in `einladung-datenbank.test.ts`), nicht über
 * Mailpit: so hängt der Test an keinem laufenden Dienst.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit."user"` und `cockpit.einladung` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle } from '../src/auth/berechtigung.js';
import { offeneAenderungLesen } from '../src/auth/email-aenderung.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { mailversandBauen, type Mailversand } from '../src/mail/versand.js';
import { buildApp } from '../src/server/app.js';
import { FORMULAR_KOPF, formular, kontenLoeschen, kontoEinrichten, protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const PASSWORT = 'ein-ausreichend-langes-passwort';
const BASIS_URL = 'http://localhost:3000';
const HERKUNFT = { host: 'localhost:3000', origin: BASIS_URL };
const NEU = 'neu@example.org';

interface JsonNachricht {
  readonly to: { address: string }[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

type Wer = 'betreuer' | 'admin' | 'mitarbeiter';

describe.skipIf(!datenbankUrl)('E-Mail-Adresse ändern mit echten Sitzungen (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let ohneVersand: FastifyInstance;
  let mitDefektemVersand: FastifyInstance;
  let ohneHinweis: FastifyInstance;
  let einrichtung: FastifyInstance;
  const cookies: Record<Wer, string> = { betreuer: '', admin: '', mitarbeiter: '' };
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

  const DEFEKT: Mailversand = { senden: () => Promise.reject(new Error('SMTP nicht erreichbar')) };

  /** Schickt die erste Mail, verweigert die zweite: der Hinweis an die bisherige Adresse geht nicht raus. */
  function nurErsteMail(): Mailversand {
    const echt = versandMitErfassung();
    let anzahl = 0;
    return {
      senden: (nachricht) => {
        anzahl += 1;
        return anzahl === 1 ? echt.senden(nachricht) : Promise.reject(new Error('Postfach voll'));
      },
    };
  }

  async function ziel(id: string, rolle: Rolle): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", rolle, aktiviert_am)
       VALUES ($1, $1, $1 || '@example.org', true, now(), now(), $2, now())`,
      [id, rolle],
    );
  }

  async function email(id: string): Promise<string | undefined> {
    const ergebnis = await pool.query<{ email: string }>('SELECT email FROM cockpit."user" WHERE id = $1', [id]);
    return ergebnis.rows[0]?.email;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, versand: versandMitErfassung() });
    ohneVersand = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    mitDefektemVersand = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, versand: DEFEKT });
    ohneHinweis = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, versand: nurErsteMail() });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();
    const rollen: Record<Wer, Rolle> = { betreuer: 'betreuer', admin: 'betriebs_admin', mitarbeiter: 'betrieb_mitarbeiter' };
    for (const wer of Object.keys(cookies) as Wer[]) {
      const konto = await kontoEinrichten(einrichtung, auth, { email: `${wer}@example.org`, passwort: PASSWORT, name: wer, mitZweitemFaktor: true });
      cookies[wer] = konto.cookie;
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rollen[wer]]);
    }
  }, 90_000);

  beforeEach(async () => {
    gesendet.length = 0;
    await pool.query('DELETE FROM cockpit.einladung');
    await pool.query(`DELETE FROM cockpit."user" WHERE id LIKE 'ziel-%'`);
    await ziel('ziel-admin', 'betriebs_admin');
    await ziel('ziel-mitarbeiter', 'betrieb_mitarbeiter');
    await pool.query(`UPDATE cockpit.session SET "createdAt" = now()`);
  });

  afterAll(async () => {
    for (const instanz of [app, ohneVersand, mitDefektemVersand, ohneHinweis, einrichtung]) {
      await instanz.close();
    }
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await pool.end();
  });

  function senden(instanz: FastifyInstance, wer: Wer, url: string, felder: Record<string, string>) {
    return instanz.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...HERKUNFT, cookie: cookies[wer] }, payload: formular(felder) });
  }

  /** Beide Schritte auf der Seite des Kontos: Bestätigungsseite, dann bestätigen. */
  async function beantragen(wer: Wer, zielId: string, adresse: string, instanz: FastifyInstance = app) {
    const schritt1 = await senden(instanz, wer, `/benutzer/${zielId}/aendern`, { aktion: 'email', wert: adresse });
    const bis = /name="bis" value="(\d+)"/.exec(schritt1.body)?.[1] ?? '';
    const token = /name="token" value="([A-Za-z0-9_-]{43})"/.exec(schritt1.body)?.[1] ?? '';
    const wert = /name="wert" value="([^"]*)"/.exec(schritt1.body)?.[1] ?? '';
    const schritt2 = await senden(instanz, wer, `/benutzer/${zielId}/bestaetigen`, { aktion: 'email', wert, bis, token });
    return { schritt1, schritt2 };
  }

  function linkAus(nachricht: JsonNachricht | undefined): string {
    return /http:\/\/localhost:3000(\/email-bestaetigen\/[A-Za-z0-9_-]{43})/.exec(nachricht?.text ?? '')?.[1] ?? '';
  }

  it('beantragt: Mail mit Link an die neue Adresse, Hinweis ohne Adresse an die bisherige — am Konto ändert sich nichts', async () => {
    const marke = await protokollMarke(pool);

    const { schritt1, schritt2 } = await beantragen('admin', 'ziel-mitarbeiter', '  Neu@Example.org ');

    expect(schritt1.statusCode).toBe(200);
    expect(schritt1.body).toContain(`<strong>${NEU}</strong> beantragt`);
    expect(schritt2.statusCode).toBe(303);
    expect(schritt2.headers.location).toBe('/benutzer/ziel-mitarbeiter?erledigt=email');
    expect(gesendet.map((nachricht) => nachricht.to[0]?.address)).toEqual([NEU, 'ziel-mitarbeiter@example.org']);
    expect(linkAus(gesendet[0])).not.toBe('');
    expect(gesendet[1]?.text).not.toContain(NEU);
    expect(gesendet[1]?.text).not.toContain('http');
    expect(await email('ziel-mitarbeiter')).toBe('ziel-mitarbeiter@example.org');
    expect(await protokollSeit(pool, marke)).toEqual([
      { art: 'email_aenderung_beantragt', akteur: expect.any(String) as string, ziel: 'ziel-mitarbeiter', einzelheiten: {} },
    ]);
    const seite = await app.inject({ method: 'GET', url: '/benutzer/ziel-mitarbeiter?erledigt=email', headers: { cookie: cookies.admin } });
    expect(seite.body).toContain('Die Bestätigungsmail an die neue Adresse ist verschickt.');
    expect(seite.body).toContain(`Neue Adresse <strong>${NEU}</strong> wartet auf Bestätigung`);
  });

  it('lässt den Link ohne Anmeldung öffnen, ändert beim Öffnen nichts, erst mit dem Knopf — und nur einmal', async () => {
    await beantragen('betreuer', 'ziel-admin', NEU);
    const link = linkAus(gesendet[0]);
    const marke = await protokollMarke(pool);

    const geoeffnet = await app.inject({ method: 'GET', url: link });
    expect(geoeffnet.statusCode).toBe(200);
    expect(geoeffnet.headers['cache-control']).toBe('no-store');
    expect(geoeffnet.body).toContain(`<strong>${NEU}</strong>`);
    expect(await email('ziel-admin')).toBe('ziel-admin@example.org');

    const bestaetigt = await app.inject({ method: 'POST', url: link, headers: HERKUNFT });
    expect(bestaetigt.statusCode).toBe(200);
    expect(bestaetigt.body).toContain(`Ab jetzt gilt ${NEU}`);
    expect(await email('ziel-admin')).toBe(NEU);
    expect(await protokollSeit(pool, marke)).toEqual([{ art: 'email_geaendert', akteur: 'email_bestaetigung', ziel: 'ziel-admin', einzelheiten: {} }]);

    expect((await app.inject({ method: 'POST', url: link, headers: HERKUNFT })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(404);
  });

  it('bestätigt ohne Herkunft nicht', async () => {
    await beantragen('betreuer', 'ziel-admin', NEU);
    const link = linkAus(gesendet[0]);

    const antwort = await app.inject({ method: 'POST', url: link, headers: { host: 'localhost:3000' } });

    expect(antwort.statusCode).toBe(403);
    expect(await email('ziel-admin')).toBe('ziel-admin@example.org');
  });

  it.each(['/email-bestaetigen/kaputt', `/email-bestaetigen/${'A'.repeat(43)}`])('antwortet auf %s mit der neutralen 404', async (url) => {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url, headers: HERKUNFT })).statusCode).toBe(404);
  });

  it.each([
    ['keine Adresse', 'keine-adresse', 'Bitte eine gültige E-Mail-Adresse angeben.'],
    ['die bisherige', 'ziel-mitarbeiter@example.org', 'Das ist schon die Adresse dieses Kontos.'],
    ['die eines anderen Kontos', 'Betreuer@example.org', 'Für diese Adresse gibt es bereits ein Konto.'],
  ])('weist %s schon im ersten Schritt ab, ohne Mail', async (_name, adresse, fehler) => {
    const antwort = await senden(app, 'admin', '/benutzer/ziel-mitarbeiter/aendern', { aktion: 'email', wert: adresse });

    expect(antwort.statusCode).toBe(400);
    expect(antwort.body).toContain(fehler);
    expect(gesendet).toEqual([]);
  });

  it('weist eine Adresse mit offener Einladung ab', async () => {
    await pool.query(`INSERT INTO cockpit.einladung (email, token_hash, ablauf_am) VALUES ($1, $2, now() + interval '1 hour')`, [NEU, 'ab'.repeat(32)]);

    const antwort = await senden(app, 'admin', '/benutzer/ziel-mitarbeiter/aendern', { aktion: 'email', wert: NEU });

    expect(antwort.statusCode).toBe(400);
    expect(antwort.body).toContain('An diese Adresse ist eine Einladung offen.');
  });

  it('lässt den Admin die Adresse eines anderen Admins nicht ändern, den Mitarbeiter gar keine', async () => {
    expect((await senden(app, 'admin', '/benutzer/ziel-admin/aendern', { aktion: 'email', wert: NEU })).statusCode).toBe(404);
    expect((await senden(app, 'mitarbeiter', '/benutzer/ziel-mitarbeiter/aendern', { aktion: 'email', wert: NEU })).statusCode).toBe(404);
    expect(gesendet).toEqual([]);
  });

  it('bietet ohne Mailversand keine Adressänderung an und nimmt keine an', async () => {
    const seite = await ohneVersand.inject({ method: 'GET', url: '/benutzer/ziel-mitarbeiter', headers: { cookie: cookies.admin } });
    const versuch = await senden(ohneVersand, 'admin', '/benutzer/ziel-mitarbeiter/aendern', { aktion: 'email', wert: NEU });

    expect(seite.body).not.toContain('value="email"');
    expect(versuch.statusCode).toBe(403);
  });

  it('verwirft den Antrag, wenn die Mail an die neue Adresse nicht rausgeht', async () => {
    const { schritt2 } = await beantragen('admin', 'ziel-mitarbeiter', NEU, mitDefektemVersand);

    expect(schritt2.statusCode).toBe(502);
    expect(schritt2.body).toContain('ließ sich nicht verschicken');
    expect(await offeneAenderungLesen(pool, 'ziel-mitarbeiter', new Date())).toBeUndefined();
    expect(await email('ziel-mitarbeiter')).toBe('ziel-mitarbeiter@example.org');
  });

  it('lässt den Antrag gelten, wenn nur der Hinweis an die bisherige Adresse nicht rausgeht, und sagt es', async () => {
    const { schritt2 } = await beantragen('admin', 'ziel-mitarbeiter', NEU, ohneHinweis);

    expect(schritt2.headers.location).toBe('/benutzer/ziel-mitarbeiter?erledigt=email-ohne-hinweis');
    expect((await offeneAenderungLesen(pool, 'ziel-mitarbeiter', new Date()))?.neueEmail).toBe(NEU);
    const seite = await ohneHinweis.inject({ method: 'GET', url: String(schritt2.headers.location), headers: { cookie: cookies.admin } });
    expect(seite.body).toContain('Der Hinweis an die bisherige Adresse ließ sich nicht verschicken.');
  });
});
