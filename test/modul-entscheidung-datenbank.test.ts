/**
 * „Entscheiden" (COPI-91) gegen eine echte PostgreSQL, mit dem Beispiel-Modul Auswahl (Fachmigration `auswahl` 0001,
 * View und Block aus `docs/demo`): die Tabelle (Migration 0045), die Karte je Stand, Entscheiden und Zurücknehmen
 * über die Formulare, die Marke in der Liste und die Abfrage des Agenten.
 *
 * Jede Grenze steht einzeln da, jeweils mit dem Nachweis, dass nichts gespeichert wurde.
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
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { buildApp } from '../src/server/app.js';
import { fachMigrationenEinspielen } from '../scripts/dev/fach-migrationen.js';
import { formular, FORMULAR_KOPF, kontenLoeschen, protokollMarke, protokollSeit, sperrenLeeren, wieImBetrieb, betreuerDarf } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const VIEW_SQL = readFileSync('docs/demo/v_modul_auswahl.sql', 'utf8');
const BLOCK_YAML = readFileSync('docs/demo/auswahl.cockpit.yaml', 'utf8');
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HOST = 'cockpit.example.org';
const HERKUNFT = { host: HOST, origin: `https://${HOST}` };

interface Person {
  readonly id: string;
  readonly name: string;
  readonly rolle: Rolle;
}

const BEN: Person = { id: 'konto-ben', name: 'Ben Beispiel', rolle: 'betreuer' };
const CARLA: Person = { id: 'konto-carla', name: 'Carla Conrad', rolle: 'betriebs_admin' };

type Aktion = 'entscheiden' | 'entscheidung-zuruecknehmen';

describe.skipIf(!datenbankUrl)('Entscheiden (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let wer: Person;
  let vorgang: string;
  let lesen: string;

  const detail = (): string => `/module/auswahl/${vorgang}`;

  async function seite(url: string = detail(), als: Person = wer): Promise<{ status: number; html: string }> {
    wer = als;
    const antwort = await app.inject({ method: 'GET', url, headers: { host: HOST } });
    return { status: antwort.statusCode, html: antwort.body };
  }

  /** Die Felder eines Formulars der Karte: für `entscheiden` je Wert, für das Zurücknehmen das einzige. */
  async function felder(aktion: Aktion, wert?: string): Promise<Record<string, string>> {
    const { html } = await seite();
    const formulare = [...html.matchAll(new RegExp(`<form method="post" action="${detail()}/${aktion}">([\\s\\S]*?)</form>`, 'g'))].map((treffer) => {
      const werte: Record<string, string> = {};
      for (const feld of (treffer[1] ?? '').matchAll(/<input type="hidden" name="([a-z]+)" value="([^"]*)">/g)) {
        werte[feld[1] ?? ''] = feld[2] ?? '';
      }
      return werte;
    });
    const gefunden = formulare.find((werte) => wert === undefined || werte.wert === wert);
    if (gefunden === undefined) {
      throw new Error(`Kein Formular ${aktion} ${wert ?? ''}`);
    }
    return gefunden;
  }

  async function senden(aktion: Aktion, werte: Record<string, string>, kopf: Record<string, string> = HERKUNFT) {
    const antwort = await app.inject({ method: 'POST', url: `${detail()}/${aktion}`, headers: { ...FORMULAR_KOPF, ...kopf }, payload: formular(werte) });
    return { status: antwort.statusCode, ort: antwort.headers.location };
  }

  async function geltend(): Promise<{ wert: string; zurueck: boolean }[]> {
    return (
      await pool.query<{ wert: string; zurueck: boolean }>(
        'SELECT wert, zurueckgenommen_am IS NOT NULL AS zurueck FROM cockpit.entscheidung WHERE vorgang_id = $1 ORDER BY id',
        [vorgang],
      )
    ).rows;
  }

  async function abfragen(modul = 'auswahl', token = lesen) {
    const antwort = await app.inject({ method: 'GET', url: `/intern/vorgaenge/entscheidungen?modul=${modul}`, headers: { authorization: `Bearer ${token}` } });
    return { status: antwort.statusCode, body: antwort.json<Record<string, unknown>>() };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_auswahl');
    await pool.query('DROP SCHEMA IF EXISTS auswahl CASCADE');
    await fachMigrationenEinspielen(pool, 'docs/demo/fach/auswahl', 'test');
    await pool.query(VIEW_SQL);
    const basis = (): Promise<Zugang> => Promise.resolve({ angemeldet: true, rolle: wer.rolle, zweiterFaktorAktiv: true, benutzerId: wer.id });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => new Date(), sitzungLesen: MIT_FAKTOR, zugangLesen: basis });
    await app.ready();
  });

  beforeEach(async () => {
    wer = BEN;
    await sperrenLeeren(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('TRUNCATE auswahl.schritt, auswahl.treffer RESTART IDENTITY');
    for (const person of [BEN, CARLA]) {
      await pool.query(`INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, $2, $3, true, $4)`, [person.id, person.name, `${person.id}@example.org`, person.rolle]);
    }
    const eingespielt = await modulEinspielen(pool, { rohtext: BLOCK_YAML, akteur: 'konsole' });
    await betreuerDarf(pool, 'auswahl');
    if (!eingespielt.ok) {
      throw new Error(eingespielt.grund);
    }
    vorgang =
      (
        await pool.query<{ id: string }>(
          `INSERT INTO auswahl.treffer (url, plattform, titel, quelle) VALUES ('https://portal-a.example.com/vorschlag/1', 'portal-a', 'Beispiel-Vorschlag', 'manuell') RETURNING id::text`,
        )
      ).rows[0]?.id ?? '';
    lesen = (await apiTokenAnlegen(pool, { name: 'assistent-auswahl', scopes: ['vorgang_lesen'] })).token;
  });

  afterAll(async () => {
    await app.close();
    await sperrenLeeren(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_auswahl');
    await pool.query('DROP SCHEMA IF EXISTS auswahl CASCADE');
    await pool.end();
  });

  describe('die Tabelle (Migration 0045)', () => {
    it('ändert nichts außer dem einmaligen Rückzug, löscht nie und kennt nur gültige Werte', async () => {
      const id = (
        await pool.query<{ id: number }>(`INSERT INTO cockpit.entscheidung (modul_kennung, vorgang_id, wert, entschieden_von) VALUES ('auswahl', '1', 'interessant', $1) RETURNING id::int AS id`, [BEN.id])
      ).rows[0]?.id;
      await expect(pool.query(`UPDATE cockpit.entscheidung SET wert = 'beworben'`)).rejects.toThrow(/entscheidung_unveraenderlich/);
      await pool.query(`UPDATE cockpit.entscheidung SET zurueckgenommen_von = $1, zurueckgenommen_am = now() WHERE id = $2`, [BEN.id, id]);
      await expect(pool.query(`UPDATE cockpit.entscheidung SET zurueckgenommen_am = NULL, zurueckgenommen_von = NULL`)).rejects.toThrow(/entscheidung_unveraenderlich/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.entscheidung')).rejects.toThrow(/nie_loeschen/);
      await expect(
        pool.query(`INSERT INTO cockpit.entscheidung (modul_kennung, vorgang_id, wert, entschieden_von) VALUES ('auswahl', '1', 'offen', $1)`, [BEN.id]),
      ).rejects.toMatchObject({ constraint: 'entscheidung_wert_form' });
    });
  });

  describe('die Karte', () => {
    it('bietet bei einem neuen Treffer „Vormerken", „Passt nicht" und „Erledigt" an, nichts zum Zurücknehmen', async () => {
      const { html } = await seite();
      expect(html).toContain('Deine Entscheidung');
      expect(html).toContain('Wartet auf dich');
      expect(html).toContain('Vormerken – Entwurf erstellen</button>');
      expect(html).toContain('Passt nicht</button>');
      expect(html).toContain('Erledigt – außerhalb abgeschickt</button>');
      expect(html).not.toContain('entscheidung-zuruecknehmen');
      // Der Block hat keinen Eingriff „uebernehmen" (COPI-226): Der Assistent sendet nichts selbst.
      expect(html).not.toContain('übernehmen</button>');
    });

    it('zeigt den Entwurf des Agenten maskiert, mit Fassung und verborgenem Kopier-Knopf', async () => {
      await pool.query(`INSERT INTO auswahl.schritt (treffer_id, art, text) VALUES ($1, 'bewerbung', 'Hallo <script>alert(1)</script>‮')`, [vorgang]);
      const { html } = await seite();
      expect(html).toContain('Entwurf');
      expect(html).toContain('Fassung 1');
      expect(html).toContain('<p class="freigabe-text" id="entscheidung-entwurf">Hallo &lt;script&gt;alert(1)&lt;/script&gt;</p>');
      expect(html).toContain('data-kopieren="entscheidung-entwurf" hidden>');
    });
  });

  describe('entscheiden und zurücknehmen', () => {
    it('speichert „Vormerken", protokolliert, zeigt Band und Marke und bietet danach „Erledigt" an', async () => {
      const marke = await protokollMarke(pool);

      expect(await senden('entscheiden', await felder('entscheiden', 'interessant'))).toEqual({ status: 303, ort: detail() });

      expect(await geltend()).toEqual([{ wert: 'interessant', zurueck: false }]);
      expect((await protokollSeit(pool, marke)).map((eintrag) => [eintrag.art, eintrag.akteur])).toEqual([['entscheidung_getroffen', BEN.id]]);
      const { html } = await seite();
      expect(html).toContain('<strong>Vorgemerkt</strong> <span>von Ben Beispiel,');
      expect(html).toContain('Erledigt – außerhalb abgeschickt</button>');
      expect(html).not.toContain('Vormerken – Entwurf erstellen</button>');
      expect(html).toContain('<span class="entscheidung-marke">Vorgemerkt · Ben</span>');
    });

    it('nimmt zurück: danach gilt wieder „offen", protokolliert, die Zeile bleibt', async () => {
      await senden('entscheiden', await felder('entscheiden', 'interessant'));
      const marke = await protokollMarke(pool);

      expect(await senden('entscheidung-zuruecknehmen', await felder('entscheidung-zuruecknehmen'))).toEqual({ status: 303, ort: detail() });

      expect(await geltend()).toEqual([{ wert: 'interessant', zurueck: true }]);
      expect((await protokollSeit(pool, marke)).map((eintrag) => eintrag.art)).toEqual(['entscheidung_zurueckgenommen']);
      expect((await seite()).html).toContain('Vormerken – Entwurf erstellen</button>');
    });

    it('speichert nichts, wenn sich der Stand inzwischen geändert hat', async () => {
      const interessant = await felder('entscheiden', 'interessant');
      await senden('entscheiden', await felder('entscheiden', 'passt_nicht'));

      expect(await senden('entscheiden', interessant)).toEqual({ status: 303, ort: `${detail()}?hinweis=entscheidung-geaendert` });
      expect(await geltend()).toEqual([{ wert: 'passt_nicht', zurueck: false }]);
      expect((await seite(`${detail()}?hinweis=entscheidung-geaendert`)).html).toContain('Die Entscheidung wurde inzwischen geändert.');
    });

    it('nimmt nur die Entscheidung zurück, die die Seite gezeigt hat', async () => {
      await senden('entscheiden', await felder('entscheiden', 'interessant'));
      const zurueck = await felder('entscheidung-zuruecknehmen');
      await senden('entscheiden', await felder('entscheiden', 'beworben'));

      expect(await senden('entscheidung-zuruecknehmen', zurueck)).toEqual({ status: 303, ort: `${detail()}?hinweis=entscheidung-geaendert` });
      expect(await geltend()).toEqual([
        { wert: 'interessant', zurueck: false },
        { wert: 'beworben', zurueck: false },
      ]);
    });

    it('weist ab: ohne Herkunft (403), mit gefälschter Bestätigung, anderem Wert oder anderem Konto', async () => {
      const werte = await felder('entscheiden', 'interessant');
      expect((await senden('entscheiden', werte, { host: HOST })).status).toBe(403);
      const abgelehnt = { status: 303, ort: `${detail()}?hinweis=abgelaufen` };
      expect(await senden('entscheiden', { ...werte, wert: 'beworben' })).toEqual(abgelehnt);
      expect(await senden('entscheiden', { ...werte, erwartet: 'interessant' })).toEqual(abgelehnt);
      expect(await senden('entscheiden', { ...werte, token: `${werte.token?.startsWith('A') ? 'B' : 'A'}${werte.token?.slice(1) ?? ''}` })).toEqual(abgelehnt);
      // Carla (Betriebs-Admin) sieht das Modul seit COPI-134, aber die Bestätigung gehört dem Konto von Ben.
      wer = CARLA;
      expect(await senden('entscheiden', werte)).toEqual(abgelehnt);
      expect(await geltend()).toEqual([]);
    });

    it('weist eine Bestätigung für einen anderen Treffer ab', async () => {
      const werte = await felder('entscheiden', 'interessant');
      const antwort = await app.inject({ method: 'POST', url: '/module/auswahl/999999/entscheiden', headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: formular(werte) });
      expect(antwort.headers.location).toBe('/module/auswahl/999999?hinweis=abgelaufen');
      expect((await pool.query('SELECT count(*)::int AS n FROM cockpit.entscheidung')).rows).toEqual([{ n: 0 }]);
    });
  });

  describe('die Abfrage des Agenten', () => {
    it('liefert die geltenden Entscheidungen, ohne zurückgenommene, mit Anzeigename', async () => {
      await senden('entscheiden', await felder('entscheiden', 'interessant'));
      const { status, body } = await abfragen();
      expect(status).toBe(200);
      expect(body).toEqual({ entscheidungen: [{ id: vorgang, wert: 'interessant', von: 'Ben Beispiel', am: expect.any(String) as unknown }] });

      await senden('entscheidung-zuruecknehmen', await felder('entscheidung-zuruecknehmen'));
      expect((await abfragen()).body).toEqual({ entscheidungen: [] });
    });

    it('antwortet für ein unbekanntes Modul mit 404 und ohne Recht mit 403', async () => {
      expect((await abfragen('gibt-es-nicht')).status).toBe(404);
      const ohne = (await apiTokenAnlegen(pool, { name: 'admin', scopes: ['befund_schreiben'] })).token;
      expect((await abfragen('auswahl', ohne)).status).toBe(403);
    });
  });
});
