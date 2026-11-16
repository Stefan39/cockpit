/**
 * Das Modul „KI-Verbrauch" (COPI-98) Ende zu Ende gegen eine echte PostgreSQL: die Beispiel-Views und der Block aus
 * `docs/beispiele` (Ansichtstyp `kennzahlen`), gemeldeter Verbrauch über die Agenten-API, die Modulseite mit
 * Zeitraum und Filter, die Hinweise, die Karte auf der Übersicht und die Katalogprüfung.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Legt die Beispiel-Views an und entfernt sie am Ende. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { buildApp } from '../src/server/app.js';
import { rueckwege } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const VIEW_SQL = readFileSync('docs/beispiele/v_modul_ki_verbrauch.sql', 'utf8');
// Die View rechnet mit now(): auf die feste Test-Uhr (JETZT) festnageln, sonst fallen die Testdaten aus dem 30-Tage-Fenster.
const HINWEISE_SQL = readFileSync('docs/beispiele/v_modul_ki_verbrauch_hinweise.sql', 'utf8').replaceAll('now()', "'2026-09-30T12:00:00Z'::timestamptz");
const BLOCK_YAML = readFileSync('docs/beispiele/ki-verbrauch.cockpit.yaml', 'utf8');

/** Mittwoch, 30.09.2026, 14:00 in Berlin. */
const JETZT = new Date('2026-09-30T12:00:00Z');

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function zugangMit(rolle: Rolle | undefined): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
}

/** 1 Mio. Eingabe-Tokens auf Sonnet 5: 2 USD, zum Kurs 1,25 also 1,60 EUR. */
const EINTRAG = {
  schluessel: 'cowork:s1:m1',
  zeitpunkt: '2026-09-29T10:00:00Z',
  quelle: 'cowork',
  modell: 'claude-sonnet-5',
  ticket: 'JAC-630',
  tokens_eingabe: 1_000_000,
  tokens_ausgabe: 0,
  tokens_cache_schreiben_5m: 0,
  tokens_cache_schreiben_1h: 0,
  tokens_cache_lesen: 0,
};

const DROP_VIEWS = 'DROP VIEW IF EXISTS cockpit.v_modul_ki_verbrauch_hinweise; DROP VIEW IF EXISTS cockpit.v_modul_ki_verbrauch;';

describe.skipIf(!datenbankUrl)('Modul „KI-Verbrauch": Ansichtstyp kennzahlen (echte Datenbank)', () => {
  let pool: pg.Pool;
  let melder: string;
  /**
   * Eine App je Rolle, einmal gebaut und bis zum Ende wiederverwendet: der Aufbau kostet in der CI jeweils Sekunden,
   * ein Test mit mehreren Seiten liefe sonst in den Timeout. Die Agenten-API prüft ihr Token selbst und nutzt die des
   * Betreuers.
   */
  const apps = new Map<Rolle | undefined, FastifyInstance>();

  async function appMit(rolle: Rolle | undefined): Promise<FastifyInstance> {
    let app = apps.get(rolle);
    if (app === undefined) {
      app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugangMit(rolle)) });
      await app.ready();
      apps.set(rolle, app);
    }
    return app;
  }

  async function seite(url: string, rolle: Rolle | undefined = 'betreuer') {
    const antwort = await (await appMit(rolle)).inject({ method: 'GET', url });
    return { html: antwort.body, status: antwort.statusCode };
  }

  async function intern(url: string, rumpf: unknown): Promise<void> {
    const antwort = await (await appMit('betreuer')).inject({ method: 'POST', url, headers: { authorization: `Bearer ${melder}` }, payload: rumpf as object });
    expect(antwort.statusCode).toBe(200);
  }

  async function einspielen(rohtext: string = BLOCK_YAML) {
    return modulEinspielen(pool, { rohtext, akteur: 'konsole' });
  }

  /** Das übliche Bild: drei Projekte bzw. ohne Ticket, zwei Quellen, zwei Modelle, ein Kurs. */
  async function verbrauchMelden(): Promise<void> {
    await intern('/intern/wechselkurs', { kurse: [{ tag: '2026-08-03', usd_je_eur: 1.25 }, { tag: '2026-09-01', usd_je_eur: 1.25 }] });
    await intern('/intern/verbrauch', {
      eintraege: [
        EINTRAG,
        { ...EINTRAG, schluessel: 'cowork:s1:m2', ticket: 'JAC-631', tokens_eingabe: 2_000_000 },
        { ...EINTRAG, schluessel: 'cc:s2:m1', quelle: 'claude-code', ticket: 'COPI-98', zeitpunkt: '2026-09-30T08:00:00Z', qualitaet: 'geschaetzt' },
        { ...EINTRAG, schluessel: 'n8n:lauf-1', quelle: 'n8n', ticket: null, modell: 'openai/gpt-oss-120b', tokens_eingabe: 4_000_000 },
        { ...EINTRAG, schluessel: 'cowork:s0:m1', zeitpunkt: '2026-08-20T10:00:00Z', tokens_eingabe: 500_000 },
      ],
    });
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(DROP_VIEWS);
    await pool.query(VIEW_SQL);
    await pool.query(HINWEISE_SQL);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('TRUNCATE cockpit.verbrauch, cockpit.verbrauch_tag, cockpit.wechselkurs RESTART IDENTITY');
    await pool.query('DELETE FROM cockpit.api_token');
    // Der Preis gilt in diesen Tests schon im August: der Vergleichszeitraum braucht Kosten.
    await pool.query(`UPDATE cockpit.preis SET gueltig_ab = '2026-08-01T00:00:00Z' WHERE modell = 'claude-sonnet-5'`);
    melder = (await apiTokenAnlegen(pool, { name: 'melder', scopes: ['verbrauch_schreiben'] })).token;
  });

  afterAll(async () => {
    for (const app of apps.values()) {
      await app.close();
    }
    await pool.query(`UPDATE cockpit.preis SET gueltig_ab = '2026-09-01T00:00:00Z' WHERE modell = 'claude-sonnet-5'`);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('TRUNCATE cockpit.verbrauch, cockpit.verbrauch_tag, cockpit.wechselkurs RESTART IDENTITY');
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query(DROP_VIEWS);
    await pool.end();
  });

  describe('einspielen', () => {
    it('nimmt den Beispiel-Block mit seinen beiden Views an', async () => {
      expect(await einspielen()).toMatchObject({ ok: true, status: 'neu', kennung: 'ki-verbrauch', version: 1 });
    });

    it('lehnt eine Kennzahl ab, deren Spalte nicht numeric ist', async () => {
      const ergebnis = await einspielen(BLOCK_YAML.replace('{ name: einsaetze, label: "Einsätze", format: zahl }', '{ name: modell, label: "Modell" }').replace('    - { name: modell, label: "Je Modell" }\n', ''));

      expect(ergebnis).toEqual({ ok: false, grund: 'Die Spalte modell in cockpit.v_modul_ki_verbrauch hat den Typ text, erwartet numeric.' });
    });

    it('lehnt eine Aufteilung ab, deren Spalte es nicht gibt, und eine fehlende Hinweis-View', async () => {
      expect(await einspielen(BLOCK_YAML.replace('name: quelle, label: "Je Quelle"', 'name: kunde, label: "Je Kunde"'))).toMatchObject({ ok: false, grund: expect.stringContaining('kunde') as string });
      expect(await einspielen(BLOCK_YAML.replace('hinweise: v_modul_ki_verbrauch_hinweise', 'hinweise: v_modul_gibt_es_nicht'))).toMatchObject({
        ok: false,
        grund: expect.stringContaining('v_modul_gibt_es_nicht') as string,
      });
    });
  });

  describe('Modulseite', () => {
    beforeEach(async () => {
      await einspielen();
    });

    it('führt mit dem Zurück-Knopf zu den Modulen, von einer Übersichtskarte zur Übersicht (COPI-100)', async () => {
      expect(rueckwege((await seite('/module/ki-verbrauch')).html)).toEqual([{ href: '/module', ziel: 'Module' }]);
      expect(rueckwege((await seite('/module/ki-verbrauch?von=uebersicht')).html)).toEqual([{ href: '/', ziel: 'Übersicht' }]);
    });

    it('lädt sich alle 60 s neu (COPI-105)', async () => {
      expect([...(await seite('/module/ki-verbrauch')).html.matchAll(/data-aktualisieren="(\d+)"/g)].map((m) => m[1])).toEqual(['60']);
    });

    it('zeigt ohne Meldungen den Leerzustand, mit den Zeitraum-Chips', async () => {
      const { html, status } = await seite('/module/ki-verbrauch');

      expect(status).toBe(200);
      expect(html).toContain('Noch keine Werte in diesem Zeitraum');
      expect(html).toContain('>30 Tage</a>');
      expect(html).not.toContain('Wie belastbar');
    });

    it('zeigt Kosten in Euro, Tokens, Einsätze und den Vergleich mit dem Zeitraum davor', async () => {
      await verbrauchMelden();

      const { html } = await seite('/module/ki-verbrauch');

      // Sonnet: (1 + 2 + 1) Mio. zu 2 USD = 8 USD = 6,40 EUR; gpt-oss: 4 Mio. zu 0,15 EUR = 0,60 EUR.
      expect(html).toContain('7,00\u00a0€');
      expect(html).toContain('8 Mio.');
      expect(html).toContain('Zeitraum davor: 0,80\u00a0€');
      expect(html).toContain('Kosten je Tag');
      expect(html).toContain('01.09. bis 30.09.2026');
      expect(html).toMatch(/aria-label="Kosten je Tag, 01\.09\. bis 30\.09\.2026: zwischen/);
      expect(html).toContain('Version 1 · eingespielt am');
    });

    it('teilt nach Projekt, Modell und Quelle auf; ohne Ticket heißt „nicht zugeordnet"', async () => {
      await verbrauchMelden();

      const { html } = await seite('/module/ki-verbrauch');

      expect(html).toContain('Je Projekt');
      expect(html).toContain('href="/module/ki-verbrauch?filter=JAC"');
      expect(html).toContain('href="/module/ki-verbrauch?filter=-"');
      expect(html).toContain('nicht zugeordnet');
      expect(html).toContain('openai/gpt-oss-120b');
      expect(html).toContain('claude-code');
      expect(html).toContain('Wie belastbar sind die Zahlen?');
    });

    it('zeigt gefiltert auf ein Projekt dessen Tickets statt der Projekte', async () => {
      await verbrauchMelden();

      const { html } = await seite('/module/ki-verbrauch?filter=JAC');

      expect(html).toContain('Je Ticket');
      expect(html).not.toContain('Je Projekt');
      expect(html).toContain('JAC-630');
      expect(html).toContain('JAC-631');
      expect(html).not.toContain('COPI-98');
      expect(html).toContain('Filter aufheben');
      // 3 Mio. zu 2 USD = 6 USD = 4,80 EUR von 7,00 EUR.
      expect(html).toContain('4,80\u00a0€');
      expect(html).toContain('69 % von allem im Zeitraum');
    });

    it('filtert mit „-" auf die Einsätze ohne Ticket', async () => {
      await verbrauchMelden();

      const { html } = await seite('/module/ki-verbrauch?filter=-');

      expect(html).toContain('0,60\u00a0€');
      expect(html).not.toContain('claude-sonnet-5');
    });

    it('wählt den Zeitraum über die Adresse; ein unbekannter gilt als 30 Tage', async () => {
      await verbrauchMelden();

      const heute = await seite('/module/ki-verbrauch?zeitraum=heute');
      expect(heute.html).toContain('aria-current="true">Heute</a>');
      // Heute nur der geschätzte Eintrag für COPI-98: 2 USD = 1,60 EUR.
      expect(heute.html).toContain('1,60\u00a0€');
      expect(heute.html).toContain('href="/module/ki-verbrauch?zeitraum=heute&amp;filter=COPI"');

      const vormonat = await seite('/module/ki-verbrauch?zeitraum=vormonat');
      expect(vormonat.html).toContain('01.08. bis 31.08.2026');
      expect(vormonat.html).toContain('0,80\u00a0€');

      expect((await seite('/module/ki-verbrauch?zeitraum=immer')).html).toContain('aria-current="true">30 Tage</a>');
    });

    it('warnt bei Einsätzen ohne Preis und nennt das Modell', async () => {
      await verbrauchMelden();
      await intern('/intern/verbrauch', { ...EINTRAG, schluessel: 'n8n:lauf-2', quelle: 'n8n', modell: 'meta-llama/Llama-3.1-405B-Instruct' });

      const { html } = await seite('/module/ki-verbrauch');

      expect(html).toContain('Achtung: 1 Einsätze ohne Preis');
      expect(html).toContain('Für meta-llama/Llama-3.1-405B-Instruct ist kein Preis hinterlegt.');
      expect(html).toContain('anteil-warnung');
    });

    it('warnt, wenn für Beträge in US-Dollar kein Wechselkurs vorliegt', async () => {
      await intern('/intern/verbrauch', EINTRAG);

      const { html } = await seite('/module/ki-verbrauch');

      expect(html).toContain('Achtung: 1 Einsätze ohne Wechselkurs');
      expect(html).toContain('bis zum 29.09.2026');
    });

    it('warnt, wenn der letzte Wechselkurs mehr als vier Tage vor dem Verbrauch liegt', async () => {
      await verbrauchMelden();

      const { html } = await seite('/module/ki-verbrauch');

      expect(html).toContain('Achtung: Wechselkurs zuletzt am 01.09.2026 gemeldet');
      expect(html).toContain('1 € = 1,25 $');
    });

    it('warnt bei Haiku 5.5 über 100K Prompt nicht mehr: die Staffel ist gerechnet (COPI-223)', async () => {
      await intern('/intern/wechselkurs', { tag: '2026-09-28', usd_je_eur: 1.25 });
      await pool.query(`UPDATE cockpit.preis SET gueltig_ab = '2026-09-01T00:00:00Z' WHERE modell = 'claude-haiku-5-5'`);
      // Seit COPI-234 rechnet `preis_nachrechnen` bei jeder Preisänderung nach: die Gültigkeit erst zurücksetzen,
      // wenn die Seite gelesen ist, sonst steht der Einsatz wieder ohne Preis da.
      let html: string;
      try {
        await intern('/intern/verbrauch', { ...EINTRAG, modell: 'claude-haiku-5-5', tokens_eingabe: 2, tokens_cache_lesen: 120_000 });
        ({ html } = await seite('/module/ki-verbrauch'));
      } finally {
        await pool.query(`UPDATE cockpit.preis SET gueltig_ab = '2026-10-01T00:00:00Z' WHERE modell = 'claude-haiku-5-5'`);
      }

      expect(html).not.toContain('Haiku 5.5');
      expect(html).not.toContain('Achtung:');
    });

    it('bleibt ohne Warnung, wenn Preis und aktueller Kurs vorliegen', async () => {
      await verbrauchMelden();
      await intern('/intern/wechselkurs', { tag: '2026-09-28', usd_je_eur: 1.25 });

      expect((await seite('/module/ki-verbrauch')).html).not.toContain('Achtung:');
    });

    it('setzt keine style-Attribute und verlinkt keine Moduldaten außer den eigenen Filtern', async () => {
      await verbrauchMelden();

      const { html } = await seite('/module/ki-verbrauch');
      const inhalt = html.slice(html.indexOf('kennzahlen-seite'));

      expect(inhalt).not.toMatch(/\sstyle="/);
      expect([...inhalt.matchAll(/href="([^"]+)"/g)].every((treffer) => (treffer[1] ?? '').startsWith('/'))).toBe(true);
    });

    it('ist nur für die freigegebene Rolle da: der Betriebs-Admin bekommt die neutrale 404', async () => {
      expect((await seite('/module/ki-verbrauch', 'betriebs_admin')).status).toBe(404);
      expect((await seite('/module/ki-verbrauch', 'betreuer')).status).toBe(200);
    });

    it('hat keine Detailseite: jede id endet in der neutralen 404', async () => {
      expect((await seite('/module/ki-verbrauch/JAC')).status).toBe(404);
    });

    it('zeigt nur den neutralen Hinweis, wenn die View nachträglich gegen den Vertrag verändert wurde', async () => {
      await verbrauchMelden();
      await pool.query(DROP_VIEWS);
      await pool.query(`CREATE VIEW cockpit.v_modul_ki_verbrauch AS SELECT tag, kosten::text AS wert FROM cockpit.verbrauch_tag`);
      try {
        const { html, status } = await seite('/module/ki-verbrauch');

        expect(status).toBe(200);
        expect(html).toContain('Dieses Modul ist gerade nicht verfügbar.');
        expect(html).not.toContain('Je Projekt');
      } finally {
        await pool.query(DROP_VIEWS);
        await pool.query(VIEW_SQL);
        await pool.query(HINWEISE_SQL);
      }
    });
  });

  describe('Übersicht', () => {
    it('zeigt dem Betreuer die Karte mit den Kosten des Monats, dem Vormonat und dem Link aufs Modul', async () => {
      await einspielen();
      await verbrauchMelden();

      const { html } = await seite('/');

      expect(html).toContain('Kosten im September');
      expect(html).toContain('7,00\u00a0€');
      expect(html).toContain('Vormonat 0,80\u00a0€');
      expect(html).toContain('href="/module/ki-verbrauch?von=uebersicht"');
    });

    it('zeigt die Karte gelb mit „Achtung", wenn das Modul einen Hinweis hat', async () => {
      await einspielen();
      await intern('/intern/verbrauch', EINTRAG);

      const { html } = await seite('/');

      expect(html).toContain('dienst-gelb');
      expect(html).toContain('1 Einsätze ohne Wechselkurs');
    });

    it('zeigt die Karte niemandem, der das Modul nicht sehen darf, und nicht ohne uebersicht im Block', async () => {
      await einspielen();
      expect((await seite('/', 'betriebs_admin')).html).not.toContain('Kosten im');

      await einspielen(BLOCK_YAML.slice(0, BLOCK_YAML.indexOf('  uebersicht:')));
      expect((await seite('/', 'betreuer')).html).not.toContain('Kosten im');
    });
  });
});
