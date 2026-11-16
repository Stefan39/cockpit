/**
 * „Antwort freigeben" (COPI-90) gegen eine echte PostgreSQL, mit dem Beispiel-Modul Eingang (Fachmigrationen
 * 0001–0003, View und Block aus `docs/demo`): die Entwurfskarte je Zustand, Freigeben und Zurückziehen über die
 * Formulare, die Abfrage des Agenten und die offenen Freigaben im Posteingang.
 *
 * Sicherheitskritisch (eine Mail geht nach außen): Gesendet werden darf nur die jüngste Fassung mit genau dem
 * freigegebenen Text, nie zweimal, nie in einem übernommenen Vorgang. Jede Grenze steht einzeln da, jeweils mit dem
 * Nachweis, dass nichts freigegeben wurde.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { entwurfHash } from '../src/module/freigabe.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { zugangLesenMitPosteingang } from '../src/posteingang/lesen.js';
import { buildApp } from '../src/server/app.js';
import { fachMigrationenEinspielen } from '../scripts/dev/fach-migrationen.js';
import { formular, FORMULAR_KOPF, eingangViewsAnlegen, kontenLoeschen, protokollMarke, protokollSeit, sperrenLeeren, wieImBetrieb, betreuerDarf } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const BLOCK_YAML = readFileSync('docs/demo/eingang.cockpit.yaml', 'utf8');
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HOST = 'cockpit.example.org';
const HERKUNFT = { host: HOST, origin: `https://${HOST}` };

interface Person {
  readonly id: string;
  readonly name: string;
  readonly rolle: Rolle;
}

const BETREUER: Person = { id: 'konto-betreuer', name: 'Erika Beispiel', rolle: 'betreuer' };
const CARLA: Person = { id: 'konto-carla', name: 'Carla Conrad', rolle: 'betriebs_admin' };
const ANNA: Person = { id: 'konto-anna', name: 'Anna Albers', rolle: 'betrieb_mitarbeiter' };

const ENTWURF_1 = 'Hallo Frau Peters,\n\nich biete Dienstag 10 Uhr an. <script>alert(1)</script>\n\nViele Grüße';
const ENTWURF_2 = 'Hallo Frau Peters,\n\nich biete Donnerstag 14:30 Uhr an.\n\nViele Grüße';

describe.skipIf(!datenbankUrl)('Antwort freigeben (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let wer: Person;
  let vorgang: string;
  let lesen: string;
  let ohneRecht: string;

  const detail = (): string => `/module/eingang/${vorgang}`;

  async function seite(url: string, als: Person = wer): Promise<{ status: number; html: string }> {
    wer = als;
    const antwort = await app.inject({ method: 'GET', url, headers: { host: HOST } });
    return { status: antwort.statusCode, html: antwort.body };
  }

  /** Die Felder des Formulars `aktion` auf der Seite `url` (signierte Bestätigung, Fassung, Hash). */
  async function felder(url: string, aktion: 'freigeben' | 'freigabe-zurueckziehen'): Promise<Record<string, string>> {
    const { html } = await seite(url);
    const form = new RegExp(
      `<form method="post" action="${detail()}/${aktion}"[^>]*>\\s*<input type="hidden" name="bis" value="(\\d+)">\\s*<input type="hidden" name="token" value="([A-Za-z0-9_-]+)">\\s*<input type="hidden" name="fassung" value="(\\d+)">\\s*<input type="hidden" name="hash" value="([0-9a-f]{64})">`,
    ).exec(html);
    if (!form?.[1] || !form[2] || !form[3] || !form[4]) {
      throw new Error(`Kein Formular ${aktion} auf ${url}`);
    }
    return { bis: form[1], token: form[2], fassung: form[3], hash: form[4] };
  }

  async function senden(aktion: 'freigeben' | 'freigabe-zurueckziehen', werte: Record<string, string>, kopf: Record<string, string> = HERKUNFT) {
    const antwort = await app.inject({ method: 'POST', url: `${detail()}/${aktion}`, headers: { ...FORMULAR_KOPF, ...kopf }, payload: formular(werte) });
    return { status: antwort.statusCode, ort: antwort.headers.location };
  }

  async function freigebenAls(person: Person) {
    wer = person;
    return senden('freigeben', await felder(`${detail()}?bestaetigen=freigabe`, 'freigeben'));
  }

  async function entwurf(fassung: number, text: string): Promise<void> {
    await pool.query(`INSERT INTO eingang.entwurf (vorgang_id, fassung, an, betreff, text) VALUES ($1, $2, 'Jana Peters <j.peters@example.org>', 'Re: Relaunch', $3)`, [
      vorgang,
      fassung,
      text,
    ]);
  }

  async function aktive(): Promise<{ fassung: number; entwurf_hash: string }[]> {
    return (await pool.query<{ fassung: number; entwurf_hash: string }>('SELECT fassung, entwurf_hash FROM cockpit.freigabe WHERE zurueckgezogen_am IS NULL ORDER BY id')).rows;
  }

  async function abfragen(fassung: number, text: string, token = lesen, modul = 'eingang') {
    const antwort = await app.inject({
      method: 'GET',
      url: `/intern/vorgaenge/freigabe?modul=${modul}&id=${vorgang}&fassung=${String(fassung)}&hash=${entwurfHash(text)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: antwort.statusCode, body: antwort.json<Record<string, unknown>>() };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_eingang');
    await pool.query('DROP SCHEMA IF EXISTS eingang CASCADE');
    await fachMigrationenEinspielen(pool, 'docs/demo/fach/eingang', 'test');
    await eingangViewsAnlegen(pool);
    const basis = (): Promise<Zugang> => Promise.resolve({ angemeldet: true, rolle: wer.rolle, zweiterFaktorAktiv: true, benutzerId: wer.id });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => new Date(), sitzungLesen: MIT_FAKTOR, zugangLesen: zugangLesenMitPosteingang(basis, pool, () => new Date()) });
    await app.ready();
  });

  beforeEach(async () => {
    wer = BETREUER;
    await sperrenLeeren(pool);
    await pool.query('TRUNCATE cockpit.freigabe RESTART IDENTITY');
    await pool.query('DELETE FROM cockpit.api_token');
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('TRUNCATE eingang.anhang, eingang.versand, eingang.entwurf, eingang.vorgang RESTART IDENTITY');
    for (const person of [BETREUER, CARLA, ANNA]) {
      await pool.query(`INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, $2, $3, true, $4)`, [person.id, person.name, `${person.id}@example.org`, person.rolle]);
    }
    const eingespielt = await modulEinspielen(pool, { rohtext: BLOCK_YAML, akteur: 'konsole' });
    await betreuerDarf(pool, 'eingang');
    if (!eingespielt.ok) {
      throw new Error(eingespielt.grund);
    }
    vorgang = (
      await pool.query<{ id: string }>(
        `INSERT INTO eingang.vorgang (postfach, absender_name, absender_adresse, betreff, eingang, zusammenfassung) VALUES ('agent@example.com', 'Jana Peters', 'j.peters@example.org', 'Relaunch', now(), 'Termin') RETURNING id::text`,
      )
    ).rows[0]?.id ?? '';
    lesen = (await apiTokenAnlegen(pool, { name: 'assistent-sperre', scopes: ['vorgang_lesen'] })).token;
    ohneRecht = (await apiTokenAnlegen(pool, { name: 'admin', scopes: ['befund_schreiben'] })).token;
  });

  afterAll(async () => {
    await app.close();
    await sperrenLeeren(pool);
    await pool.query('TRUNCATE cockpit.freigabe RESTART IDENTITY');
    await pool.query('DELETE FROM cockpit.api_token');
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_eingang');
    await pool.query('DROP SCHEMA IF EXISTS eingang CASCADE');
    await pool.end();
  });

  describe('die Tabelle (Migration 0038)', () => {
    it('lässt je Vorgang und Fassung höchstens eine aktive Freigabe zu, nichts ändern und nichts löschen', async () => {
      const einfuegen = (): Promise<pg.QueryResult> =>
        pool.query(`INSERT INTO cockpit.freigabe (modul_kennung, vorgang_id, fassung, entwurf_hash, freigegeben_von) VALUES ('eingang', '1', 1, $1, $2)`, [
          entwurfHash('x'),
          BETREUER.id,
        ]);
      await einfuegen();
      await expect(einfuegen()).rejects.toMatchObject({ constraint: 'freigabe_eine_aktive' });
      await expect(pool.query(`UPDATE cockpit.freigabe SET fassung = 2`)).rejects.toThrow(/freigabe_unveraenderlich/);
      await expect(pool.query(`UPDATE cockpit.freigabe SET entwurf_hash = $1`, [entwurfHash('y')])).rejects.toThrow(/freigabe_unveraenderlich/);
      await pool.query(`UPDATE cockpit.freigabe SET zurueckgezogen_von = $1, zurueckgezogen_am = now()`, [BETREUER.id]);
      await expect(pool.query(`UPDATE cockpit.freigabe SET zurueckgezogen_am = NULL, zurueckgezogen_von = NULL`)).rejects.toThrow(/freigabe_rueckzug_endgueltig/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.freigabe')).rejects.toThrow(/nie_loeschen/);
      await expect(
        pool.query(`INSERT INTO cockpit.freigabe (modul_kennung, vorgang_id, fassung, entwurf_hash, freigegeben_von) VALUES ('eingang', '1', 1, 'kein-hash', $1)`, [BETREUER.id]),
      ).rejects.toMatchObject({ constraint: 'freigabe_hash_form' });
    });
  });

  describe('die Detailseite', () => {
    it('zeigt ohne Entwurf keine Karte', async () => {
      const { html } = await seite(detail());
      expect(html).not.toContain('Antwortentwurf');
      expect(html).toContain('Übernehmen</button>');
    });

    it('zeigt den Entwurf escaped, mit „Freigeben" als Link auf die Rückfrage und „Selbst übernehmen"', async () => {
      await entwurf(1, ENTWURF_1);
      const { html } = await seite(detail());
      expect(html).toContain('Antwortentwurf');
      expect(html).toContain('Wartet auf Freigabe');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain(`href="${detail()}?bestaetigen=freigabe"`);
      expect(html).toContain('Selbst übernehmen</button>');
      // Kein zweiter Übernehmen-Knopf neben der Karte.
      expect((html.match(/übernehmen<\/button>/gi) ?? []).length).toBe(1);
      expect(html).not.toContain(`action="${detail()}/freigeben"`);
    });

    it('gibt nach der Rückfrage frei: genau diese Fassung mit dem Hash ihres Texts, protokolliert', async () => {
      await entwurf(1, ENTWURF_1);
      const marke = await protokollMarke(pool);

      const antwort = await freigebenAls(CARLA);

      expect(antwort).toMatchObject({ status: 303, ort: detail() });
      expect(await aktive()).toEqual([{ fassung: 1, entwurf_hash: entwurfHash(ENTWURF_1) }]);
      expect((await protokollSeit(pool, marke)).map((eintrag) => eintrag.art)).toEqual(['antwort_freigegeben']);
      const { html } = await seite(detail());
      expect(html).toMatch(/Freigegeben von Carla Conrad um [0-9:,. ]+\./);
      expect(html).toContain('Freigabe zurückziehen</button>');
    });

    it('gibt nichts frei, wenn sich der Entwurf zwischen Rückfrage und Absenden geändert hat', async () => {
      await entwurf(1, ENTWURF_1);
      const alt = await felder(`${detail()}?bestaetigen=freigabe`, 'freigeben');
      await entwurf(2, ENTWURF_2);

      const antwort = await senden('freigeben', alt);

      expect(antwort).toMatchObject({ status: 303, ort: `${detail()}?hinweis=entwurf-geaendert` });
      expect(await aktive()).toEqual([]);
      expect((await seite(antwort.ort ?? '')).html).toContain('Der Entwurf wurde inzwischen geändert.');
    });

    it('zeigt eine neue Fassung nach der Freigabe als „Neue Fassung · Freigabe nötig"', async () => {
      await entwurf(1, ENTWURF_1);
      await freigebenAls(BETREUER);
      await entwurf(2, ENTWURF_2);

      const { html } = await seite(detail());
      expect(html).toContain('Neue Fassung · Freigabe nötig');
      expect(html).toContain('Fassung 2');
      expect(html).toContain('Die Freigabe gilt für die neue Fassung nicht');
    });

    it('weist ab: ohne Herkunft (403), mit fremder oder abgelaufener Bestätigung, manipuliertem Hash', async () => {
      await entwurf(1, ENTWURF_1);
      const echt = await felder(`${detail()}?bestaetigen=freigabe`, 'freigeben');

      expect((await senden('freigeben', echt, { host: HOST })).status).toBe(403);
      expect((await senden('freigeben', echt, { host: HOST, origin: 'https://fremd.example.org' })).status).toBe(403);
      expect(await senden('freigeben', { ...echt, token: 'x'.repeat(43) })).toMatchObject({ status: 303, ort: `${detail()}?hinweis=abgelaufen` });
      expect(await senden('freigeben', { ...echt, hash: entwurfHash('anderer Text') })).toMatchObject({ status: 303, ort: `${detail()}?hinweis=abgelaufen` });
      // Die Bestätigung gehört zu einem Konto: ein anderes kann sie nicht benutzen.
      wer = CARLA;
      expect(await senden('freigeben', echt)).toMatchObject({ status: 303, ort: `${detail()}?hinweis=abgelaufen` });
      expect(await aktive()).toEqual([]);
    });

    it('bietet in einem übernommenen Vorgang kein Freigeben an und gibt auch per Formular nichts frei', async () => {
      await entwurf(1, ENTWURF_1);
      const echt = await felder(`${detail()}?bestaetigen=freigabe`, 'freigeben');
      await pool.query(`INSERT INTO cockpit.vorgang_sperre (modul_kennung, vorgang_id, uebernommen_von) VALUES ('eingang', $1, $2)`, [vorgang, CARLA.id]);

      const { html } = await seite(detail());
      expect(html).toContain('Der Vorgang ist übernommen');
      expect(html).not.toContain('?bestaetigen=freigabe');
      expect(await senden('freigeben', echt)).toMatchObject({ status: 303, ort: detail() });
      expect(await aktive()).toEqual([]);
    });

    it('zieht zurück: wer freigegeben hat und ein Betriebs-Admin, protokolliert; danach wieder offen', async () => {
      await entwurf(1, ENTWURF_1);
      await freigebenAls(BETREUER);
      const marke = await protokollMarke(pool);

      wer = CARLA;
      const antwort = await senden('freigabe-zurueckziehen', await felder(detail(), 'freigabe-zurueckziehen'));

      expect(antwort).toMatchObject({ status: 303, ort: detail() });
      expect(await aktive()).toEqual([]);
      expect((await protokollSeit(pool, marke)).map((eintrag) => eintrag.art)).toEqual(['freigabe_zurueckgezogen']);
      expect((await seite(detail())).html).toContain('Wartet auf Freigabe');
    });

    it('zeigt den Versand als Nachweis, ohne Zurückziehen', async () => {
      await entwurf(1, ENTWURF_1);
      await freigebenAls(BETREUER);
      await pool.query(`INSERT INTO eingang.versand (vorgang_id, fassung) VALUES ($1, 1)`, [vorgang]);

      const { html } = await seite(detail());
      expect(html).toMatch(/Gesendet um [0-9:,. ]+\./);
      expect(html).toContain('Freigegeben von Erika Beispiel');
      expect(html).not.toContain('Freigabe zurückziehen');
    });

    it('verweigert einer Rolle ohne Zugriff auf das Modul Seite und Formular (neutrale 404)', async () => {
      await entwurf(1, ENTWURF_1);
      const echt = await felder(`${detail()}?bestaetigen=freigabe`, 'freigeben');
      expect((await seite(detail(), ANNA)).status).toBe(404);
      expect((await senden('freigeben', echt)).status).toBe(404);
      expect(await aktive()).toEqual([]);
    });
  });

  describe('die Abfrage des Agenten', () => {
    it('bejaht nur die jüngste, ungesendete Fassung mit genau diesem Text', async () => {
      await entwurf(1, ENTWURF_1);
      expect((await abfragen(1, ENTWURF_1)).body).toEqual({ freigegeben: false });

      await freigebenAls(BETREUER);
      expect((await abfragen(1, ENTWURF_1)).body).toMatchObject({ freigegeben: true, fassung: 1, von: 'Erika Beispiel' });
      expect((await abfragen(1, `${ENTWURF_1} `)).body).toMatchObject({ freigegeben: false, grund: 'nicht_aktuell' });
      expect((await abfragen(2, ENTWURF_1)).body).toMatchObject({ freigegeben: false, grund: 'nicht_aktuell' });

      // Eine neuere Fassung macht die alte Freigabe wertlos, auch ohne Rückzug.
      await entwurf(2, ENTWURF_2);
      expect((await abfragen(1, ENTWURF_1)).body).toMatchObject({ freigegeben: false, grund: 'nicht_aktuell' });
      expect((await abfragen(2, ENTWURF_2)).body).toEqual({ freigegeben: false });

      await freigebenAls(BETREUER);
      expect((await abfragen(2, ENTWURF_2)).body).toMatchObject({ freigegeben: true, fassung: 2 });
      // Nie zweimal senden.
      await pool.query(`INSERT INTO eingang.versand (vorgang_id, fassung) VALUES ($1, 2)`, [vorgang]);
      expect((await abfragen(2, ENTWURF_2)).body).toMatchObject({ freigegeben: false, grund: 'gesendet' });
    });

    it('verneint in einem übernommenen Vorgang, kennt kein fremdes Modul und verlangt das Recht', async () => {
      await entwurf(1, ENTWURF_1);
      await freigebenAls(BETREUER);
      await pool.query(`INSERT INTO cockpit.vorgang_sperre (modul_kennung, vorgang_id, uebernommen_von) VALUES ('eingang', $1, $2)`, [vorgang, CARLA.id]);

      expect((await abfragen(1, ENTWURF_1)).body).toEqual({ freigegeben: false, grund: 'uebernommen' });
      expect((await abfragen(1, ENTWURF_1, lesen, 'gibt-es-nicht')).status).toBe(404);
      expect((await abfragen(1, ENTWURF_1, ohneRecht)).status).toBe(403);
      const ungueltig = await app.inject({ method: 'GET', url: `/intern/vorgaenge/freigabe?modul=eingang&id=${vorgang}&fassung=1&hash=abc`, headers: { authorization: `Bearer ${lesen}` } });
      expect(ungueltig.statusCode).toBe(400);
    });
  });

  describe('der Posteingang', () => {
    const offen = (html: string): number => (html.match(/posteingang-eintrag posteingang-eintrag-aufgabe/g) ?? []).length;

    it('zeigt eine offene Freigabe als Aufgabe, bis sie erteilt ist — nur wer das Modul sieht', async () => {
      await entwurf(1, ENTWURF_1);

      const vorher = await seite('/meldungen', BETREUER);
      expect(offen(vorher.html)).toBe(1);
      expect(vorher.html).toContain('Freigabe nötig · Eingang');
      expect(vorher.html).toContain('Antwort an Jana Peters: Relaunch');
      expect(vorher.html).toContain(`href="/module/eingang/${vorgang}?von=nachrichten"`);
      expect(offen((await seite('/meldungen', ANNA)).html)).toBe(0);

      await freigebenAls(CARLA);
      expect(offen((await seite('/meldungen', BETREUER)).html)).toBe(0);
    });
  });
});
