/**
 * Betreuer-Zugriff auf Fachmodule (COPI-134) gegen eine echte PostgreSQL: Der Betriebs-Admin legt je Modul fest, ob der
 * Betreuer die Fachdaten sieht (`aus`, `lesen`, `entscheiden`). Geprüft werden der Speicher (Zeile, Protokoll, nur
 * anhängen), die Sichtbarkeit auf Seiten und bei Aktionen, technische Module (`art: betrieb`), die Ablehnung eines
 * Fachmoduls nur für den Betreuer und der Abschnitt in den Einstellungen samt Formular.
 *
 * Als Fachmodul dient das Beispiel „Auswahl" (`docs/demo`, mit dem Eingriff „entscheiden").
 *
 * Läuft nur mit `TEST_DATABASE_URL`.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { betreuerZugriffSetzen } from '../src/module/betreuer-zugriff.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { buildApp } from '../src/server/app.js';
import { fachMigrationenEinspielen } from '../scripts/dev/fach-migrationen.js';
import { formular, FORMULAR_KOPF, kontenLoeschen, protokollMarke, protokollSeit, wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const VIEW_SQL = readFileSync('docs/demo/v_modul_auswahl.sql', 'utf8');
const BLOCK_YAML = readFileSync('docs/demo/auswahl.cockpit.yaml', 'utf8');
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HOST = 'cockpit.example.org';
const HERKUNFT = { host: HOST, origin: `https://${HOST}` };

/** Ein technisches Modul über derselben View: der Betreuer sieht es immer. */
const TECHNIK_YAML = [
  'kennung: technik',
  'art: betrieb',
  'menuename: "Technik"',
  'ansicht: liste-detail',
  'view: v_modul_auswahl',
  'spalten:',
  '  - { name: titel, label: "Titel" }',
  'rollen: [betreuer]',
  'eingriffe: []',
  '',
].join('\n');

interface Person {
  readonly id: string;
  readonly name: string;
  readonly rolle: Rolle;
}

const BEN: Person = { id: 'konto-ben', name: 'Ben Betreuer', rolle: 'betreuer' };
const CARLA: Person = { id: 'konto-carla', name: 'Carla Admin', rolle: 'betriebs_admin' };
const MIA: Person = { id: 'konto-mia', name: 'Mia Mitarbeiterin', rolle: 'betrieb_mitarbeiter' };

describe.skipIf(!datenbankUrl)('Betreuer-Zugriff auf Fachmodule (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let wer: Person = BEN;
  let treffer = '';

  async function seite(url: string, person: Person = wer): Promise<{ status: number; html: string }> {
    wer = person;
    const antwort = await app.inject({ method: 'GET', url, headers: { host: HOST } });
    return { status: antwort.statusCode, html: antwort.body };
  }

  async function senden(url: string, felder: Record<string, string>, person: Person = wer, kopf: Record<string, string> = HERKUNFT) {
    wer = person;
    const antwort = await app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...kopf }, payload: formular(felder) });
    return { status: antwort.statusCode, ort: antwort.headers.location, html: antwort.body };
  }

  async function stufe(kennung: string): Promise<{ stufe: string; weg: string; gesetzt_von: string | null } | undefined> {
    const ergebnis = await pool.query<{ stufe: string; weg: string; gesetzt_von: string | null }>(
      'SELECT stufe, weg, gesetzt_von FROM cockpit.modul_betreuer_zugriff WHERE modul_kennung = $1 ORDER BY id DESC LIMIT 1',
      [kennung],
    );
    return ergebnis.rows[0];
  }

  async function setzen(kennung: string, wert: 'aus' | 'lesen' | 'entscheiden'): Promise<void> {
    const ergebnis = await betreuerZugriffSetzen(pool, { kennung, stufe: wert });
    expect(ergebnis.ok, !ergebnis.ok ? ergebnis.grund : undefined).toBe(true);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await kontenLoeschen(pool);
    for (const person of [BEN, CARLA, MIA]) {
      await pool.query(`INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, $2, $3, true, $4)`, [
        person.id,
        person.name,
        `${person.id}@example.org`,
        person.rolle,
      ]);
    }
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_auswahl');
    await pool.query('DROP SCHEMA IF EXISTS auswahl CASCADE');
    await fachMigrationenEinspielen(pool, 'docs/demo/fach/auswahl', 'test');
    await pool.query(VIEW_SQL);
    const zugangLesen = (): Promise<Zugang> => Promise.resolve({ angemeldet: true, rolle: wer.rolle, zweiterFaktorAktiv: true, benutzerId: wer.id });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => new Date(), sitzungLesen: MIT_FAKTOR, zugangLesen });
    await app.ready();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('TRUNCATE auswahl.schritt, auswahl.treffer RESTART IDENTITY');
    for (const rohtext of [BLOCK_YAML, TECHNIK_YAML]) {
      const eingespielt = await modulEinspielen(pool, { rohtext, akteur: 'konsole' });
      expect(eingespielt.ok, !eingespielt.ok ? eingespielt.grund : undefined).toBe(true);
    }
    await setzen('auswahl', 'aus');
    const ergebnis = await pool.query<{ id: string }>(
      `INSERT INTO auswahl.treffer (url, plattform, titel, honorar, ort, einschaetzung, ausschreibung, art, quelle)
       VALUES ('https://portal-a.example.com/vorschlag/zugriff', 'portal-a', 'Geheimer Treffer', '1.000 $', 'remote', 'Passt.', 'Text', 'treffer', 'manuell')
       RETURNING id::text`,
    );
    treffer = ergebnis.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await app.close();
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_auswahl');
    await pool.query('DROP SCHEMA IF EXISTS auswahl CASCADE');
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('der Speicher', () => {
    it('legt je Änderung eine Zeile mit Protokoll an und keine bei derselben Stufe', async () => {
      const marke = await protokollMarke(pool);
      expect(await betreuerZugriffSetzen(pool, { kennung: 'auswahl', stufe: 'lesen' })).toEqual({ ok: true, status: 'gesetzt', stufe: 'lesen' });
      expect(await betreuerZugriffSetzen(pool, { kennung: 'auswahl', stufe: 'lesen' })).toEqual({ ok: true, status: 'unveraendert', stufe: 'lesen' });
      expect(await betreuerZugriffSetzen(pool, { kennung: 'auswahl', stufe: 'entscheiden', konto: CARLA.id })).toMatchObject({ ok: true, status: 'gesetzt' });

      expect(await stufe('auswahl')).toEqual({ stufe: 'entscheiden', weg: 'oberflaeche', gesetzt_von: CARLA.id });
      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege.map((eintrag) => [eintrag.art, eintrag.akteur, eintrag.einzelheiten.an])).toEqual([
        ['betreuer_zugriff_geaendert', 'konsole', 'lesen'],
        ['betreuer_zugriff_geaendert', CARLA.id, 'entscheiden'],
      ]);
    });

    it('weist ein unbekanntes und ein technisches Modul ab', async () => {
      expect(await betreuerZugriffSetzen(pool, { kennung: 'gibt-es-nicht', stufe: 'lesen' })).toMatchObject({ ok: false });
      expect(await betreuerZugriffSetzen(pool, { kennung: 'technik', stufe: 'lesen' })).toMatchObject({ ok: false, grund: expect.stringContaining('art: betrieb') as unknown });
    });

    it('ändert nie eine Zeile und löscht im Betrieb nie eine', async () => {
      await setzen('auswahl', 'lesen');
      await expect(pool.query(`UPDATE cockpit.modul_betreuer_zugriff SET stufe = 'entscheiden'`)).rejects.toThrow(/modul_betreuer_zugriff_bleibt/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.modul_betreuer_zugriff')).rejects.toThrow(/nie_loeschen/);
    });
  });

  describe('ein Fachmodul nur für den Betreuer', () => {
    it('wird beim Einspielen abgewiesen; ein technisches nicht', async () => {
      const nurBetreuer = BLOCK_YAML.replace('rollen: [betriebs_admin]', 'rollen: [betreuer]');
      expect(nurBetreuer).not.toBe(BLOCK_YAML);
      const ergebnis = await modulEinspielen(pool, { rohtext: nurBetreuer, akteur: 'konsole' });
      expect(ergebnis).toMatchObject({ ok: false, grund: expect.stringContaining('Kundenrolle') as unknown });
    });
  });

  describe('auf den Seiten', () => {
    it('zeigt dem Betreuer ohne Freigabe das Fachmodul nirgends, das technische schon', async () => {
      const liste = await seite('/module', BEN);
      expect(liste.html).not.toContain('/module/auswahl');
      expect(liste.html).toContain('/module/technik');
      expect((await seite('/module/auswahl')).status).toBe(404);
      expect((await seite(`/module/auswahl/${treffer}`)).status).toBe(404);
      expect((await seite('/module/technik')).status).toBe(200);
    });

    it('zeigt es dem Betriebs-Admin immer, dem Mitarbeiter nie — unabhängig vom Betreuer-Zugriff', async () => {
      expect((await seite(`/module/auswahl/${treffer}`, CARLA)).status).toBe(200);
      expect((await seite(`/module/auswahl/${treffer}`, MIA)).status).toBe(404);
      await setzen('auswahl', 'entscheiden');
      expect((await seite(`/module/auswahl/${treffer}`, MIA)).status).toBe(404);
    });

    it('zeigt mit „lesen" Inhalte ohne Aktionen und weist eine Aktion mit 403 ab', async () => {
      await setzen('auswahl', 'lesen');
      const detail = await seite(`/module/auswahl/${treffer}`, BEN);
      expect(detail.status).toBe(200);
      expect(detail.html).toContain('Geheimer Treffer');
      expect(detail.html).not.toContain(`action="/module/auswahl/${treffer}/entscheiden"`);

      const aktion = await senden(`/module/auswahl/${treffer}/entscheiden`, { wert: 'interessant', erwartet: 'offen', bis: '0', token: 'x' }, BEN);
      expect(aktion.status).toBe(403);
      expect(aktion.html).toContain('nur Lesen freigegeben');
    });

    it('bietet mit „entscheiden" die Aktionen an', async () => {
      await setzen('auswahl', 'entscheiden');
      const detail = await seite(`/module/auswahl/${treffer}`, BEN);
      expect(detail.html).toContain(`action="/module/auswahl/${treffer}/entscheiden"`);
    });
  });

  describe('in den Einstellungen', () => {
    it('lässt den Betriebs-Admin die Stufe wählen und speichern', async () => {
      const { html } = await seite('/einstellungen', CARLA);
      expect(html).toContain('Betreuer-Zugriff');
      expect(html).toContain('action="/einstellungen/betreuer-zugriff"');
      expect(html).toContain('<option value="aus" selected>Kein Zugriff</option>');
      // Das technische Modul steht nicht im Abschnitt.
      expect(html).not.toContain('value="technik"');

      const antwort = await senden('/einstellungen/betreuer-zugriff', { kennung: 'auswahl', stufe: 'lesen' }, CARLA);
      expect(antwort).toMatchObject({ status: 303, ort: '/einstellungen?zugriff=gesetzt#betreuer-zugriff-titel' });
      expect(await stufe('auswahl')).toEqual({ stufe: 'lesen', weg: 'oberflaeche', gesetzt_von: CARLA.id });

      const danach = await seite('/einstellungen?zugriff=gesetzt', CARLA);
      expect(danach.html).toContain('Gespeichert.');
      expect(danach.html).toContain('Zuletzt geändert von Carla Admin');
    });

    it('zeigt dem Betreuer den Stand, aber kein Formular, und weist sein Speichern ab', async () => {
      const { html } = await seite('/einstellungen', BEN);
      expect(html).toContain('Betreuer-Zugriff');
      expect(html).toContain('Kein Zugriff');
      expect(html).not.toContain('action="/einstellungen/betreuer-zugriff"');

      expect((await senden('/einstellungen/betreuer-zugriff', { kennung: 'auswahl', stufe: 'entscheiden' }, BEN)).status).toBe(404);
      expect((await stufe('auswahl'))?.stufe).toBe('aus');
    });

    it('zeigt dem Mitarbeiter nichts und weist ihn ab', async () => {
      expect((await seite('/einstellungen', MIA)).html).not.toContain('Betreuer-Zugriff');
      expect((await senden('/einstellungen/betreuer-zugriff', { kennung: 'auswahl', stufe: 'lesen' }, MIA)).status).toBe(404);
    });

    it('weist ohne Herkunft, mit unbekannter Stufe und für ein technisches Modul ab — ohne etwas zu ändern', async () => {
      expect((await senden('/einstellungen/betreuer-zugriff', { kennung: 'auswahl', stufe: 'lesen' }, CARLA, { host: HOST, origin: 'https://boese.example' })).status).toBe(403);
      expect(await senden('/einstellungen/betreuer-zugriff', { kennung: 'auswahl', stufe: 'alles' }, CARLA)).toMatchObject({ status: 303, ort: expect.stringContaining('zugriff=abgewiesen') as unknown });
      expect(await senden('/einstellungen/betreuer-zugriff', { kennung: 'technik', stufe: 'lesen' }, CARLA)).toMatchObject({ status: 303, ort: expect.stringContaining('zugriff=abgewiesen') as unknown });
      expect((await stufe('auswahl'))?.stufe).toBe('aus');
    });
  });
});
