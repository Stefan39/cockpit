/**
 * Die Modulseiten (COPI-78) gegen eine echte PostgreSQL: `GET /module`, `GET /module/:kennung` und
 * `GET /module/:kennung/:id`.
 *
 * Zwei Abschnitte:
 *
 *   1. Rollen, Sortierung, Escaping, Injection und eine nachträglich veränderte View — mit einer
 *      eingesetzten `zugangLesen` (wie `agenten-seiten-datenbank.test.ts`), schnell und ohne echte
 *      Sitzungen.
 *   2. Navigation mit echten Sitzungen je Rolle: nur hier läuft die echte Verdrahtung
 *      (`zugangLesenMitModulen`, `server/app.ts`), die `moduleSichtbar` in den Zugang schreibt — eine
 *      eingesetzte `zugangLesen` bekommt das nie, würde die Navigation also immer ausgegraut zeigen,
 *      egal was in der Registry steht.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Legt eigene Test-Tabellen und -Views an (Präfix `v_modul_test_…`)
 * und entfernt sie am Ende; räumt `cockpit.modul` vor jedem Test. Niemals gegen eine Kundendatenbank
 * laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { buildApp } from '../src/server/app.js';
import { kontenLoeschen, kontoEinrichten, betreuerDarf } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-27T12:00:00.000Z');

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function zugangMit(rolle: Rolle | undefined): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
}

/** Label und Format je Spaltenname, für `block()` unten. */
const SPALTEN_VORLAGE: Readonly<Record<string, string>> = {
  titel: '{ name: titel, label: "Titel" }',
  status: '{ name: status, label: "Status" }',
  text: '{ name: text, label: "Text" }',
  aktualisiert_am: '{ name: aktualisiert_am, label: "Zuletzt", format: zeitpunkt }',
};

/**
 * Ein Block gegen eine der Test-Views, mit variabler Kennung, View, Rollen und Spalten (ohne Angabe: alle
 * vier, inklusive `status` — für den Test, der `status` bewusst **nicht** deklariert, siehe COPI-78 Review).
 */
function block(
  kennung: string,
  view: string,
  rollen: readonly string[] = ['betreuer', 'betriebs_admin'],
  spaltenNamen: readonly string[] = ['titel', 'status', 'text', 'aktualisiert_am'],
): string {
  return [
    `kennung: ${kennung}`,
    `menuename: "Test Modul ${kennung}"`,
    'ansicht: liste-detail',
    `view: ${view}`,
    'spalten:',
    ...spaltenNamen.map((name) => `  - ${SPALTEN_VORLAGE[name]}`),
    `rollen: [${rollen.join(', ')}]`,
    'eingriffe: []',
    '',
  ].join('\n');
}

describe.skipIf(!datenbankUrl)('Modulseiten: Rollen, Sortierung, Escaping, Injection, veränderte View (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE cockpit.modul_seiten_test_quelle (
        id              text        PRIMARY KEY,
        titel           text        NOT NULL,
        status          text        NOT NULL,
        text_kunde      text        NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      CREATE VIEW cockpit.v_modul_test_seiten AS
        SELECT id, titel, status, aktualisiert_am, text_kunde AS text
          FROM cockpit.modul_seiten_test_quelle;

      CREATE TABLE cockpit.modul_seiten_test_wechsel_quelle (
        id              text        PRIMARY KEY,
        titel           text        NOT NULL,
        status          text        NOT NULL,
        text_kunde      text        NOT NULL,
        text_intern     text        NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      CREATE VIEW cockpit.v_modul_test_wechsel AS
        SELECT id, titel, status, aktualisiert_am, text_kunde AS text
          FROM cockpit.modul_seiten_test_wechsel_quelle;
    `);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.modul_seiten_test_quelle');
    await pool.query('DELETE FROM cockpit.modul_seiten_test_wechsel_quelle');
    // Zurück in den unauffälligen Ausgangszustand: ein Test, der die View absichtlich auf text_intern
    // umstellt, soll die folgenden Tests nicht mit einer schon kaputten View starten lassen.
    await pool.query(`
      CREATE OR REPLACE VIEW cockpit.v_modul_test_wechsel AS
        SELECT id, titel, status, aktualisiert_am, text_kunde AS text
          FROM cockpit.modul_seiten_test_wechsel_quelle;
    `);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query(`
      DROP VIEW IF EXISTS cockpit.v_modul_test_wechsel;
      DROP TABLE IF EXISTS cockpit.modul_seiten_test_wechsel_quelle;
      DROP VIEW IF EXISTS cockpit.v_modul_test_seiten;
      DROP TABLE IF EXISTS cockpit.modul_seiten_test_quelle;
    `);
    await pool.end();
  });

  async function einspielen(kennung: string, view: string, rollen?: readonly string[], spaltenNamen?: readonly string[]) {
    const ergebnis = await modulEinspielen(pool, { rohtext: block(kennung, view, rollen, spaltenNamen), akteur: 'konsole' });
    if (!ergebnis.ok) {
      throw new Error(ergebnis.grund);
    }
    await betreuerDarf(pool, kennung);
    return ergebnis;
  }

  async function zeile(werte: { id: string; titel: string; status: string; text?: string; aktualisiertAm?: Date }) {
    await pool.query(
      `INSERT INTO cockpit.modul_seiten_test_quelle (id, titel, status, text_kunde, aktualisiert_am) VALUES ($1, $2, $3, $4, $5)`,
      [werte.id, werte.titel, werte.status, werte.text ?? werte.titel, werte.aktualisiertAm ?? JETZT],
    );
  }

  async function seite(url: string, rolle: Rolle | undefined) {
    const app: FastifyInstance = buildApp(
      { nodeEnv: 'test' },
      { pool, jetzt: () => JETZT, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugangMit(rolle)) },
    );
    try {
      const antwort = await app.inject({ method: 'GET', url });
      return { html: antwort.body, status: antwort.statusCode };
    } finally {
      await app.close();
    }
  }

  describe('/module — die Liste der sichtbaren Module', () => {
    it('zeigt ein Modul, das für die Rolle freigegeben ist', async () => {
      await einspielen('sichtbares-modul', 'v_modul_test_seiten', ['betreuer', 'betriebs_admin']);

      const { html, status } = await seite('/module', 'betriebs_admin');

      expect(status).toBe(200);
      expect(html).toContain('Test Modul sichtbares-modul');
      expect(html).toContain('href="/module/sichtbares-modul"');
    });

    it('zeigt kein Modul, das für die Rolle nicht freigegeben ist', async () => {
      await einspielen('nur-admin-gesperrt', 'v_modul_test_seiten', ['betriebs_admin']);

      const { html } = await seite('/module', 'betrieb_mitarbeiter');

      expect(html).not.toContain('nur-admin-gesperrt');
      expect(html).toContain('Noch keine Module');
    });

    it('zeigt dem Betreuer ein freigegebenes Modul, auch ohne seine Rolle in der Liste', async () => {
      await einspielen('nur-admin', 'v_modul_test_seiten', ['betriebs_admin']);

      const { html } = await seite('/module', 'betreuer');

      expect(html).toContain('Test Modul nur-admin');
    });
  });

  describe('/module/:kennung — die Zeilen', () => {
    it('sortiert zuerst nach Status (rot, gelb, grün), dann nach Titel', async () => {
      await einspielen('sortiert', 'v_modul_test_seiten');
      await zeile({ id: '1', titel: 'B grün', status: 'gruen' });
      await zeile({ id: '2', titel: 'A gelb', status: 'gelb' });
      await zeile({ id: '3', titel: 'A rot', status: 'rot' });
      await zeile({ id: '4', titel: 'Z rot', status: 'rot' });

      const { html, status } = await seite('/module/sortiert', 'betreuer');

      expect(status).toBe(200);
      const reihenfolge = ['A rot', 'Z rot', 'A gelb', 'B grün'].map((titel) => html.indexOf(titel));
      expect(reihenfolge).toEqual([...reihenfolge].sort((a, b) => a - b));
      expect(reihenfolge.every((position) => position >= 0)).toBe(true);
    });

    it('zeigt Status als Wort neben dem Punkt und den formatierten Zeitpunkt', async () => {
      await einspielen('mit-status', 'v_modul_test_seiten');
      await zeile({ id: '1', titel: 'Eine Zeile', status: 'rot' });

      const { html } = await seite('/module/mit-status', 'betreuer');

      expect(html).toContain('punkt-rot');
      expect(html).toContain('Störung');
    });

    it('zeigt neben der Liste einen ruhigen Leerzustand für die Desktop-Detailspalte (Review COPI-78)', async () => {
      await einspielen('mit-leerzustand', 'v_modul_test_seiten');
      await zeile({ id: '1', titel: 'Eine Zeile', status: 'gruen' });

      const { html, status } = await seite('/module/mit-leerzustand', 'betreuer');

      expect(status).toBe(200);
      expect(html).toContain('modul-splitt');
      expect(html).toContain('modul-splitt-rechts-nur-lg');
      expect(html).toContain('Wählen Sie links einen Eintrag aus.');
    });

    it('maskiert Fremdtext im Zeilentitel und verlinkt ihn nie (die Liste zeigt nur titel, status, aktualisiert_am)', async () => {
      await einspielen('fremdtext', 'v_modul_test_seiten');
      await zeile({ id: '1', titel: '<script>alert(1)</script> <a href="https://boese.example">Link</a>', status: 'gruen' });

      const { html } = await seite('/module/fremdtext', 'betreuer');

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<a href="https://boese.example">');
      expect(html).toContain('&lt;a href=');
    });

    it('gibt für eine unbekannte Kennung 404 (neutral)', async () => {
      const { html, status } = await seite('/module/unbekannt', 'betreuer');

      expect(status).toBe(404);
      expect(html).toContain('Diese Seite gibt es nicht.');
    });

    it('gibt für eine ungültige Kennung 404, ohne die Datenbank zu fragen', async () => {
      const { status } = await seite('/module/Gross_Falsch!', 'betreuer');

      expect(status).toBe(404);
    });

    it('gibt für ein inaktives Modul 404', async () => {
      await einspielen('wird-inaktiv', 'v_modul_test_seiten');
      await pool.query(`UPDATE cockpit.modul SET aktiv = false, aktiv_seit = NULL WHERE kennung = 'wird-inaktiv'`);

      const { status } = await seite('/module/wird-inaktiv', 'betreuer');

      expect(status).toBe(404);
    });

    it('gibt einer Rolle ohne Zugriff 404, statt die Existenz des Moduls zu verraten', async () => {
      await einspielen('gesperrt', 'v_modul_test_seiten', ['betreuer', 'betriebs_admin']);

      const { html, status } = await seite('/module/gesperrt', 'betrieb_mitarbeiter');

      expect(status).toBe(404);
      expect(html).toContain('Diese Seite gibt es nicht.');
    });

    it('zeigt der Betreuersicht auch ein Modul nur für andere Rollen, wenn der Kunde es freigegeben hat', async () => {
      await einspielen('nur-admin-liste', 'v_modul_test_seiten', ['betriebs_admin']);
      await zeile({ id: '1', titel: 'Sichtbar für den Betreuer', status: 'gruen' });

      const { html, status } = await seite('/module/nur-admin-liste', 'betreuer');

      expect(status).toBe(200);
      expect(html).toContain('Sichtbar für den Betreuer');
    });

    it('zeigt ohne Datenbank 404, statt zu scheitern', async () => {
      const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_FAKTOR });
      try {
        const antwort = await app.inject({ method: 'GET', url: '/module/irgendein-modul' });
        expect(antwort.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('zeigt einen neutralen Hinweis, wenn die View sich seit dem Einspielen unerlaubt verändert hat', async () => {
      await einspielen('view-wechsel', 'v_modul_test_wechsel', ['betreuer', 'betriebs_admin']);
      await pool.query(
        `INSERT INTO cockpit.modul_seiten_test_wechsel_quelle (id, titel, status, text_kunde, text_intern) VALUES ('1', 'Zeile', 'gruen', 'Klartext', 'Rohbefund, nie für den Kunden')`,
      );
      // Eine Zwischen-Fassung hätte niemandem geschadet — erst nach dem Wechsel auf text_intern greift die
      // erneute Katalogprüfung.
      const vorher = await seite('/module/view-wechsel', 'betriebs_admin');
      expect(vorher.status).toBe(200);
      expect(vorher.html).toContain('Zeile');

      await pool.query(`
        CREATE OR REPLACE VIEW cockpit.v_modul_test_wechsel AS
          SELECT id, titel, status, aktualisiert_am, text_intern AS text
            FROM cockpit.modul_seiten_test_wechsel_quelle;
      `);

      const { html, status } = await seite('/module/view-wechsel', 'betriebs_admin');

      expect(status).toBe(200);
      expect(html).toContain('Dieses Modul ist gerade nicht verfügbar.');
      expect(html).not.toContain('Rohbefund, nie für den Kunden');
    });
  });

  describe('/module/:kennung/:id — eine Zeile', () => {
    it('zeigt alle deklarierten Spalten mit Label', async () => {
      await einspielen('detail', 'v_modul_test_seiten');
      await zeile({ id: 'zeile-1', titel: 'Eine Zeile', status: 'gelb', text: 'Ein Text' });

      const { html, status } = await seite('/module/detail/zeile-1', 'betreuer');

      expect(status).toBe(200);
      expect(html).toContain('<dt>Titel</dt><dd>Eine Zeile</dd>');
      // Review COPI-78: Status roh war zu wenig — Punkt + Wort wie in der Liste, nicht der Rohwert.
      expect(html).toContain('<dt>Status</dt><dd><span class="punkt punkt-gelb werte-status-punkt" aria-hidden="true"></span>Achtung</dd>');
      expect(html).not.toContain('<dt>Status</dt><dd>gelb</dd>');
      expect(html).toContain('<dt>Text</dt><dd>Ein Text</dd>');
      expect(html).toContain('<dt>Zuletzt</dt>');
    });

    it('zeigt die Pflichtspalte status als Punkt + Wort, auch wenn der Block sie nicht deklariert', async () => {
      await einspielen('detail-ohne-status-spalte', 'v_modul_test_seiten', undefined, ['titel', 'text', 'aktualisiert_am']);
      await zeile({ id: 'zeile-1', titel: 'Eine Zeile', status: 'rot', text: 'Ein Text' });

      const { html, status } = await seite('/module/detail-ohne-status-spalte/zeile-1', 'betreuer');

      expect(status).toBe(200);
      expect(html).toContain('<dt>Status</dt><dd><span class="punkt punkt-rot werte-status-punkt" aria-hidden="true"></span>Störung</dd>');
      expect(html).toContain('<dt>Titel</dt><dd>Eine Zeile</dd>');
    });

    it('zeigt links dieselbe Liste wie /module/:kennung und markiert die gewählte Zeile (Review COPI-78: Desktop-Aufteilung)', async () => {
      await einspielen('mit-liste', 'v_modul_test_seiten');
      await zeile({ id: 'z1', titel: 'Erste Zeile', status: 'gruen' });
      await zeile({ id: 'z2', titel: 'Zweite Zeile', status: 'rot' });

      const { html, status } = await seite('/module/mit-liste/z2', 'betreuer');

      expect(status).toBe(200);
      expect(html).toContain('modul-splitt-liste-detailseite');
      expect(html).toContain('Erste Zeile');
      expect(html).toContain('Zweite Zeile');
      expect(html).toMatch(/<a href="\/module\/mit-liste\/z2" class="liste-zeile" aria-current="true">/);
      expect(html).not.toMatch(/<a href="\/module\/mit-liste\/z1" class="liste-zeile" aria-current="true">/);
      expect(html).toContain('<a href="/module/mit-liste/z1" class="liste-zeile">');
    });

    it('gibt für eine unbekannte id 404', async () => {
      await einspielen('detail-404', 'v_modul_test_seiten');
      await zeile({ id: 'echt', titel: 'Echt', status: 'gruen' });

      const { status } = await seite('/module/detail-404/nicht-echt', 'betreuer');

      expect(status).toBe(404);
    });

    it('lässt eine id wie eine SQL-Injection als Parameter ins Leere laufen: 404, kein Fehler', async () => {
      await einspielen('injektion', 'v_modul_test_seiten');
      await zeile({ id: 'echt', titel: 'Echt', status: 'gruen' });

      const { status } = await seite("/module/injektion/x' OR '1'='1", 'betreuer');

      expect(status).toBe(404);
    });

    it('gibt für eine zu lange id 404', async () => {
      await einspielen('zu-lang', 'v_modul_test_seiten');

      const { status } = await seite(`/module/zu-lang/${'x'.repeat(201)}`, 'betreuer');

      expect(status).toBe(404);
    });

    it('gibt einer Rolle ohne Zugriff 404, auch mit einer echten id', async () => {
      await einspielen('gesperrtes-detail', 'v_modul_test_seiten', ['betriebs_admin']);
      await zeile({ id: 'echt', titel: 'Echt', status: 'gruen' });

      const { status } = await seite('/module/gesperrtes-detail/echt', 'betrieb_mitarbeiter');

      expect(status).toBe(404);
    });

    it('maskiert Fremdtext im Detail und verlinkt ihn nie', async () => {
      await einspielen('detail-fremd', 'v_modul_test_seiten');
      await zeile({ id: 'z1', titel: '<b>Titel</b>', status: 'gruen', text: '<a href="https://boese.example">x</a>' });

      const { html } = await seite('/module/detail-fremd/z1', 'betreuer');

      expect(html).not.toContain('<b>Titel</b>');
      expect(html).not.toContain('<a href="https://boese.example">');
    });

    it('zeigt einen neutralen Hinweis, wenn die erneute Katalogprüfung scheitert', async () => {
      await einspielen('detail-wechsel', 'v_modul_test_wechsel', ['betreuer', 'betriebs_admin']);
      await pool.query(
        `INSERT INTO cockpit.modul_seiten_test_wechsel_quelle (id, titel, status, text_kunde, text_intern) VALUES ('z1', 'Zeile', 'gruen', 'Klartext', 'Rohbefund')`,
      );
      await pool.query(`
        CREATE OR REPLACE VIEW cockpit.v_modul_test_wechsel AS
          SELECT id, titel, status, aktualisiert_am, text_intern AS text
            FROM cockpit.modul_seiten_test_wechsel_quelle;
      `);

      const { html, status } = await seite('/module/detail-wechsel/z1', 'betriebs_admin');

      expect(status).toBe(200);
      expect(html).toContain('Dieses Modul ist gerade nicht verfügbar.');
      expect(html).not.toContain('Rohbefund');
    });
  });
});

describe.skipIf(!datenbankUrl)('Modulseiten: Navigation mit echten Sitzungen je Rolle (echte Datenbank)', () => {
  const PASSWORT = 'ein-ausreichend-langes-passwort';
  const BASIS_URL = 'http://localhost:3000';
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let einrichtung: FastifyInstance;
  const cookies: Record<'mitarbeiter' | 'admin' | 'betreuer', string> = { mitarbeiter: '', admin: '', betreuer: '' };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query(`
      CREATE TABLE cockpit.modul_nav_test_quelle (id text PRIMARY KEY, titel text NOT NULL, status text NOT NULL, aktualisiert_am timestamptz NOT NULL DEFAULT now());
      CREATE VIEW cockpit.v_modul_test_nav AS SELECT id, titel, status, aktualisiert_am, titel AS text FROM cockpit.modul_nav_test_quelle;
    `);
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, jetzt: () => JETZT });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();

    const rollen: Record<keyof typeof cookies, Rolle> = {
      mitarbeiter: 'betrieb_mitarbeiter',
      admin: 'betriebs_admin',
      betreuer: 'betreuer',
    };
    for (const name of Object.keys(cookies) as (keyof typeof cookies)[]) {
      const konto = await kontoEinrichten(einrichtung, auth, {
        email: `${name}-modul@example.org`,
        passwort: PASSWORT,
        name,
        mitZweitemFaktor: true,
      });
      cookies[name] = konto.cookie;
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rollen[name]]);
    }
    await modulEinspielen(pool, {
      rohtext: block('nav-modul', 'v_modul_test_nav', ['betreuer', 'betriebs_admin']),
      akteur: 'konsole',
    });
    await betreuerDarf(pool, 'nav-modul');
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query(`DROP VIEW IF EXISTS cockpit.v_modul_test_nav; DROP TABLE IF EXISTS cockpit.modul_nav_test_quelle;`);
    await kontenLoeschen(pool);
    await pool.end();
  });

  it.each(['betreuer', 'admin'] as const)('zeigt „Module" als Link, wenn für das Konto %s ein Modul sichtbar ist', async (name) => {
    const antwort = await app.inject({ method: 'GET', url: '/', headers: { cookie: cookies[name] } });

    expect(antwort.body).toContain('<a href="/module" class="hauptnav-eintrag">');
  });

  it('lässt „Module" für ein Konto ohne sichtbares Modul ausgegraut', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/', headers: { cookie: cookies.mitarbeiter } });

    expect(antwort.body).toContain('hauptnav-folgt');
    expect(antwort.body).not.toContain('<a href="/module" class="hauptnav-eintrag">');
  });

  it('lässt den Mitarbeiter ohne sichtbares Modul auf /module keine Liste sehen', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/module', headers: { cookie: cookies.mitarbeiter } });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain('Noch keine Module');
  });

  it('lässt Betreuer und Betriebs-Admin das Modul unter /module sehen', async () => {
    for (const name of ['betreuer', 'admin'] as const) {
      const antwort = await app.inject({ method: 'GET', url: '/module', headers: { cookie: cookies[name] } });
      expect(antwort.body, name).toContain('Test Modul nav-modul');
    }
  });
});
