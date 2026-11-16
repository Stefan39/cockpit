/**
 * Die Kachel-Darstellung der Modulseite (COPI-82, `darstellung: kacheln`) gegen eine echte PostgreSQL:
 * `GET /module/:kennung` zeigt ein Kartenraster statt der Liste, der Filter `?status=` und die Chips, das Band
 * aus der Verlaufs-View (`uebersicht.verlauf`, dasselbe Lesen wie das Dashboard, COPI-81) — oder dessen Fehlen.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Legt eigene Test-Tabellen und -Views an (Präfix
 * `modul_kacheln_test_…`/`v_modul_test_kacheln…`) und entfernt sie am Ende; räumt `cockpit.modul` vor jedem
 * Test. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { betreuerDarf } from './hilfen.js';
import { buildApp } from '../src/server/app.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-28T07:50:00.000Z'); // 09:50 in Berlin
const STUNDE = 3_600_000;
const GEHEIM = 'GEHEIM-INTERN-KACHELN-0815';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function zugangMit(rolle: Rolle | undefined): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
}

/** Der Block gegen die Test-Views; `darstellung` und `verlauf` (die Verlaufs-View aus `uebersicht.verlauf`) optional. */
function block(opts: {
  readonly kennung: string;
  readonly view?: string;
  readonly rollen?: readonly string[];
  readonly darstellung?: 'liste' | 'kacheln';
  readonly verlauf?: string;
}): string {
  const { kennung, view = 'v_modul_test_kacheln', rollen = ['betreuer', 'betriebs_admin'], darstellung, verlauf } = opts;
  return [
    `kennung: ${kennung}`,
    `menuename: "Kacheln ${kennung}"`,
    'ansicht: liste-detail',
    `view: ${view}`,
    ...(darstellung === undefined ? [] : [`darstellung: ${darstellung}`]),
    'spalten:',
    '  - { name: titel, label: "Titel" }',
    '  - { name: status, label: "Status" }',
    '  - { name: text, label: "Meldung" }',
    '  - { name: aktualisiert_am, label: "Zuletzt", format: zeitpunkt }',
    `rollen: [${rollen.join(', ')}]`,
    'eingriffe: []',
    ...(verlauf === undefined ? [] : ['uebersicht:', '  kurztext: text', `  verlauf: ${verlauf}`]),
    '',
  ].join('\n');
}

describe.skipIf(!datenbankUrl)('Kacheln der Modulseite: darstellung: kacheln (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE cockpit.modul_kacheln_test_quelle (
        id              text        PRIMARY KEY,
        titel           text        NOT NULL,
        status          text        NOT NULL,
        text_kunde      text        NOT NULL,
        text_intern     text        NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      CREATE VIEW cockpit.v_modul_test_kacheln AS
        SELECT id, titel, status, aktualisiert_am, text_kunde AS text FROM cockpit.modul_kacheln_test_quelle;

      CREATE TABLE cockpit.modul_kacheln_test_verlauf (
        id          text        NOT NULL,
        zeitpunkt   timestamptz NOT NULL,
        status      text        NOT NULL,
        text_intern text        NOT NULL DEFAULT '${GEHEIM}'
      );
      CREATE VIEW cockpit.v_modul_test_kacheln_verlauf AS
        SELECT id, zeitpunkt, status FROM cockpit.modul_kacheln_test_verlauf;
    `);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.modul_kacheln_test_quelle');
    await pool.query('DELETE FROM cockpit.modul_kacheln_test_verlauf');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query(`
      DROP VIEW IF EXISTS cockpit.v_modul_test_kacheln_verlauf;
      DROP TABLE IF EXISTS cockpit.modul_kacheln_test_verlauf;
      DROP VIEW IF EXISTS cockpit.v_modul_test_kacheln;
      DROP TABLE IF EXISTS cockpit.modul_kacheln_test_quelle;
    `);
    await pool.end();
  });

  async function einspielen(opts: Parameters<typeof block>[0]) {
    const ergebnis = await modulEinspielen(pool, { rohtext: block(opts), akteur: 'konsole' });
    if (!ergebnis.ok) {
      throw new Error(ergebnis.grund);
    }
    await betreuerDarf(pool, opts.kennung);
    return ergebnis;
  }

  async function zeile(werte: { id: string; titel: string; status: string; text?: string; textIntern?: string; aktualisiertAm?: Date }) {
    await pool.query(
      `INSERT INTO cockpit.modul_kacheln_test_quelle (id, titel, status, text_kunde, text_intern, aktualisiert_am) VALUES ($1, $2, $3, $4, $5, $6)`,
      [werte.id, werte.titel, werte.status, werte.text ?? werte.titel, werte.textIntern ?? GEHEIM, werte.aktualisiertAm ?? JETZT],
    );
  }

  async function verlaufPunkt(id: string, stundenVor: number, status: string) {
    await pool.query(`INSERT INTO cockpit.modul_kacheln_test_verlauf (id, zeitpunkt, status) VALUES ($1, $2, $3)`, [
      id,
      new Date(JETZT.getTime() - stundenVor * STUNDE),
      status,
    ]);
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

  it('zeigt bei darstellung: kacheln ein Kartenraster statt der Liste, mit Pfad und Stand', async () => {
    await einspielen({ kennung: 'kacheln-an', darstellung: 'kacheln' });
    await zeile({ id: 'web', titel: 'Webserver', status: 'rot', text: 'Antwortet nicht.' });

    const { html, status } = await seite('/module/kacheln-an', 'betriebs_admin');

    expect(status).toBe(200);
    expect(html).toContain('class="modul-kacheln"');
    expect(html).not.toContain('class="modul-splitt"');
    expect(html).toMatch(/<p class="seiten-krume">\s*<a href="\/module">Module<\/a>/);
    expect(html).toContain('Stand: heute, 09:50');
    expect(html).toContain('Webserver');
    expect(html).toContain('punkt-rot');
    expect(html).toContain('Störung');
    expect(html).toContain('Antwortet nicht.');
    expect(html).toContain('href="/module/kacheln-an/web"');
  });

  it('zeigt ohne das Feld darstellung weiterhin die Liste (genau das bisherige Verhalten)', async () => {
    await einspielen({ kennung: 'ohne-darstellung' });
    await zeile({ id: 'web', titel: 'Webserver', status: 'rot' });

    const { html, status } = await seite('/module/ohne-darstellung', 'betreuer');

    expect(status).toBe(200);
    expect(html).toContain('class="modul-splitt"');
    expect(html).not.toContain('class="modul-kacheln"');
  });

  it('filtert mit ?status=rot nur die roten Kacheln, zählt die Chips aber aus allen Zeilen', async () => {
    await einspielen({ kennung: 'gefiltert', darstellung: 'kacheln' });
    await zeile({ id: '1', titel: 'Rote Kachel', status: 'rot' });
    await zeile({ id: '2', titel: 'Gelbe Kachel', status: 'gelb' });
    await zeile({ id: '3', titel: 'Grüne Kachel', status: 'gruen' });

    const { html, status } = await seite('/module/gefiltert?status=rot', 'betreuer');

    expect(status).toBe(200);
    expect(html).toContain('Rote Kachel');
    expect(html).not.toContain('Gelbe Kachel');
    expect(html).not.toContain('Grüne Kachel');
    expect(html).toContain('Alle · 3');
    expect(html).toContain('Störung · 1');
    expect(html).toContain('Achtung · 1');
    expect(html).toContain('Läuft · 1');
    expect(html).toMatch(/class="modul-chip modul-chip-rot" aria-current="true"/);
  });

  it('zeigt einen Leerzustand, wenn der Filter nichts trifft, ohne die anderen Chips zu verlieren', async () => {
    await einspielen({ kennung: 'gefiltert-leer', darstellung: 'kacheln' });
    await zeile({ id: '1', titel: 'Grüne Kachel', status: 'gruen' });

    const { html, status } = await seite('/module/gefiltert-leer?status=rot', 'betreuer');

    expect(status).toBe(200);
    expect(html).toContain('Keine passenden Einträge');
    expect(html).toContain('Läuft · 1');
    expect(html).not.toContain('Grüne Kachel');
  });

  it('ignoriert einen ungültigen Filterwert und zeigt „Alle"', async () => {
    await einspielen({ kennung: 'ungueltiger-filter', darstellung: 'kacheln' });
    await zeile({ id: '1', titel: 'Grüne Kachel', status: 'gruen' });

    const { html, status } = await seite('/module/ungueltiger-filter?status=blau', 'betreuer');

    expect(status).toBe(200);
    expect(html).toContain('Grüne Kachel');
    expect(html).toMatch(/class="modul-chip" aria-current="true"/);
  });

  it('maskiert Fremdtext in Titel und Meldung einer Kachel und verlinkt ihn nie', async () => {
    await einspielen({ kennung: 'kacheln-fremd', darstellung: 'kacheln' });
    await zeile({ id: '1', titel: '<script>alert(1)</script>', status: 'gruen', text: '<a href="https://boese.example">Link</a>' });

    const { html } = await seite('/module/kacheln-fremd', 'betreuer');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<a href="https://boese.example">');
    expect(html).toContain('&lt;a href=');
  });

  it('zeigt dem Betriebs-Admin nirgends einen text_intern aus der Quelle', async () => {
    await einspielen({ kennung: 'kacheln-geheim', darstellung: 'kacheln', verlauf: 'v_modul_test_kacheln_verlauf' });
    await zeile({ id: 'web', titel: 'Webserver', status: 'rot', textIntern: GEHEIM });
    await verlaufPunkt('web', 2, 'rot');

    const { html, status } = await seite('/module/kacheln-geheim', 'betriebs_admin');

    expect(status).toBe(200);
    expect(html).not.toContain(GEHEIM);
  });

  it('zeigt ohne uebersicht.verlauf keinen Band-Block „Letzte 7 Tage"', async () => {
    await einspielen({ kennung: 'ohne-verlauf', darstellung: 'kacheln' });
    await zeile({ id: 'web', titel: 'Webserver', status: 'rot' });

    const { html, status } = await seite('/module/ohne-verlauf', 'betreuer');

    expect(status).toBe(200);
    expect(html).toContain('Webserver');
    expect(html).not.toContain('Letzte 7 Tage');
    expect(html).not.toContain('band-kachel');
  });

  it('zeigt mit uebersicht.verlauf das Band „Letzte 7 Tage" mit den Segmenten aus der Verlaufs-View', async () => {
    await einspielen({ kennung: 'mit-verlauf', darstellung: 'kacheln', verlauf: 'v_modul_test_kacheln_verlauf' });
    await zeile({ id: 'web', titel: 'Webserver', status: 'rot' });
    await verlaufPunkt('web', 30, 'gruen');
    await verlaufPunkt('web', 2, 'rot');

    const { html, status } = await seite('/module/mit-verlauf', 'betreuer');

    expect(status).toBe(200);
    expect(html).toContain('Letzte 7 Tage');
    expect(html).toContain('class="band band-kachel"');
    expect(html).toContain('class="band-rot"');
    expect(html).toContain('class="band-gruen"');
    expect(html).toMatch(/\d+ % in Ordnung/);
  });

  it('zeigt bei einer nachträglich kaputten Verlaufs-View die Kacheln trotzdem, nur ohne Band', async () => {
    await einspielen({ kennung: 'verlauf-kaputt', darstellung: 'kacheln', verlauf: 'v_modul_test_kacheln_verlauf' });
    await zeile({ id: 'web', titel: 'Webserver', status: 'rot' });
    await verlaufPunkt('web', 2, 'rot');
    // Eine Zwischen-Fassung hätte niemandem geschadet — erst nach dem Wechsel greift die erneute Katalogprüfung.
    const vorher = await seite('/module/verlauf-kaputt', 'betreuer');
    expect(vorher.html).toContain('Letzte 7 Tage');

    // Nachträglich gegen den Vertrag verändert: text_intern in einer Kundensicht (dieselbe Erkennung wie
    // `test/modul-uebersicht-datenbank.test.ts` — Postgres verweigert das Entfernen einer Spalte per
    // `CREATE OR REPLACE VIEW`, also bricht dieser Test den Vertrag stattdessen über eine Abhängigkeit im
    // `WHERE`, ohne die Ausgabespalten zu ändern).
    await pool.query(`
      CREATE OR REPLACE VIEW cockpit.v_modul_test_kacheln_verlauf AS
        SELECT id, zeitpunkt, status FROM cockpit.modul_kacheln_test_verlauf WHERE text_intern IS NOT NULL`);
    try {
      const { html, status } = await seite('/module/verlauf-kaputt', 'betreuer');

      expect(status).toBe(200);
      expect(html).toContain('Webserver');
      expect(html).not.toContain('Letzte 7 Tage');
      expect(html).not.toContain('band-kachel');
    } finally {
      await pool.query(`
        CREATE OR REPLACE VIEW cockpit.v_modul_test_kacheln_verlauf AS
          SELECT id, zeitpunkt, status FROM cockpit.modul_kacheln_test_verlauf`);
    }
  });

  it('gibt für eine Rolle ohne Zugriff auf ein Kacheln-Modul dieselbe neutrale 404', async () => {
    await einspielen({ kennung: 'kacheln-gesperrt', darstellung: 'kacheln', rollen: ['betriebs_admin'] });
    await zeile({ id: '1', titel: 'Geheim', status: 'gruen' });

    const { html, status } = await seite('/module/kacheln-gesperrt', 'betrieb_mitarbeiter');

    expect(status).toBe(404);
    expect(html).toContain('Diese Seite gibt es nicht.');
  });
});
