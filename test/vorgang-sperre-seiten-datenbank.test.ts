/**
 * Die Routen der Übernahme-Sperre (COPI-85) gegen eine echte PostgreSQL: `POST /module/:kennung/:id/uebernehmen`,
 * `POST /module/:kennung/:id/zurueckgeben` und was die Detailseite, die Liste und die Kacheln davon zeigen.
 *
 * Sicherheitskritisch (Architektur-Leitplanken): Tor (Sitzung, zweiter Faktor), Zugriff auf das Modul, Eingriff im Block, CSRF
 * (Herkunft und signierte Bestätigung), unbekannte Zeile, fremde Sperre — jede Grenze einzeln, jeweils mit dem
 * Nachweis, dass nichts geschrieben wurde. Die Anfragen laufen über `inject()` gegen die ganze Anwendung (Tor
 * eingeschlossen), die Rolle kommt aus einer eingesetzten `zugangLesen` (wie `modul-seiten-datenbank.test.ts`).
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Legt eine eigene Test-Tabelle und -View an und entfernt sie am Ende.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { buildApp } from '../src/server/app.js';
import { FORMULAR_KOPF, formular, kontenLoeschen, protokollMarke, protokollSeit, sperrenLeeren } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-28T12:00:00.000Z');
const HOST = 'cockpit.example.org';
const HERKUNFT = { host: HOST, origin: `https://${HOST}` };

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

interface Person {
  readonly id: string;
  readonly name: string;
  readonly rolle: Rolle;
}

const ANNA: Person = { id: 'konto-anna', name: 'Anna Albers', rolle: 'betrieb_mitarbeiter' };
const BERT: Person = { id: 'konto-bert', name: 'Bert <script>alert(1)</script>', rolle: 'betrieb_mitarbeiter' };
const CARLA: Person = { id: 'konto-carla', name: 'Carla Conrad', rolle: 'betriebs_admin' };

function block(kennung: string, eingriffe: string, rollen = '[betreuer, betriebs_admin, betrieb_mitarbeiter]', darstellung = ''): string {
  return [
    `kennung: ${kennung}`,
    'menuename: "Anfragen"',
    'ansicht: liste-detail',
    'view: v_modul_test_sperre',
    ...(darstellung === '' ? [] : [`darstellung: ${darstellung}`]),
    'spalten:',
    '  - { name: gast, label: "Gast" }',
    `rollen: ${rollen}`,
    `eingriffe: ${eingriffe}`,
    '',
  ].join('\n');
}

describe.skipIf(!datenbankUrl)('Übernahme-Sperre: Routen und Oberfläche (echte Datenbank)', () => {
  let pool: pg.Pool;
  let wer: Person | undefined;
  let sitzung: SitzungLesen;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE cockpit.sperre_test_quelle (
        id              text        PRIMARY KEY,
        titel           text        NOT NULL,
        status          text        NOT NULL,
        gast            text        NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      CREATE VIEW cockpit.v_modul_test_sperre AS
        SELECT id, titel, status, aktualisiert_am, gast FROM cockpit.sperre_test_quelle;
    `);
    app = buildApp(
      { nodeEnv: 'test' },
      {
        pool,
        jetzt: () => JETZT,
        sitzungLesen: (request) => sitzung(request),
        zugangLesen: (): Promise<Zugang> =>
          Promise.resolve(
            wer === undefined
              ? { angemeldet: false, rolle: undefined, zweiterFaktorAktiv: false, benutzerId: undefined }
              : { angemeldet: true, rolle: wer.rolle, zweiterFaktorAktiv: true, benutzerId: wer.id },
          ),
      },
    );
    await app.ready();
  });

  beforeEach(async () => {
    wer = ANNA;
    sitzung = MIT_FAKTOR;
    await sperrenLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.sperre_test_quelle');
    for (const person of [ANNA, BERT, CARLA]) {
      await pool.query(`INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, $2, $3, true, $4)`, [
        person.id,
        person.name,
        `${person.id}@example.org`,
        person.rolle,
      ]);
    }
    await pool.query(
      `INSERT INTO cockpit.sperre_test_quelle (id, titel, status, gast, aktualisiert_am) VALUES
         ('brandt', 'Familie Brandt – Buchungsanfrage', 'gelb', 'Familie Brandt', $1),
         ('vogt', 'Lena Vogt – Frage zu Haustieren', 'gruen', 'Lena Vogt', $1)`,
      [JETZT],
    );
    await einspielen(block('anfragen', '[uebernehmen]'));
  });

  afterAll(async () => {
    await app.close();
    await sperrenLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_test_sperre; DROP TABLE IF EXISTS cockpit.sperre_test_quelle;');
    await pool.end();
  });

  async function einspielen(rohtext: string): Promise<void> {
    const ergebnis = await modulEinspielen(pool, { rohtext, akteur: 'konsole' });
    if (!ergebnis.ok) {
      throw new Error(ergebnis.grund);
    }
  }

  async function seite(url: string) {
    const antwort = await app.inject({ method: 'GET', url, headers: { host: HOST } });
    return { status: antwort.statusCode, html: antwort.body };
  }

  /** Die Felder der signierten Bestätigung aus dem Formular der Detailseite, das zu `aktion` führt. */
  async function formularFelder(pfad: string, aktion: 'uebernehmen' | 'zurueckgeben'): Promise<{ bis: string; token: string }> {
    const { html } = await seite(pfad);
    const form = new RegExp(`<form method="post" action="${pfad}/${aktion}"[^>]*>\\s*<input type="hidden" name="bis" value="(\\d+)">\\s*<input type="hidden" name="token" value="([A-Za-z0-9_-]+)">`).exec(html);
    if (form?.[1] === undefined || form[2] === undefined) {
      throw new Error(`Kein Formular ${aktion} auf ${pfad}`);
    }
    return { bis: form[1], token: form[2] };
  }

  async function senden(pfad: string, felder: Record<string, string>, kopf: Record<string, string> = HERKUNFT) {
    const antwort = await app.inject({ method: 'POST', url: pfad, headers: { ...FORMULAR_KOPF, ...kopf }, payload: formular(felder) });
    return { status: antwort.statusCode, ort: antwort.headers.location, html: antwort.body };
  }

  async function sperrenZahl(): Promise<number> {
    return (await pool.query('SELECT 1 FROM cockpit.vorgang_sperre')).rowCount ?? 0;
  }

  async function uebernehmenAls(person: Person, pfad = '/module/anfragen/brandt') {
    wer = person;
    return senden(`${pfad}/uebernehmen`, await formularFelder(pfad, 'uebernehmen'));
  }

  describe('übernehmen', () => {
    it('zeigt den Knopf, übernimmt mit 303 zurück auf die Detailseite und zeigt danach Band und Marke', async () => {
      const vorher = await seite('/module/anfragen/brandt');
      expect(vorher.html).toContain('Übernehmen</button>');
      expect(vorher.html).toContain('Diesen Vorgang bearbeiten gerade die Agenten des Moduls.');
      const marke = await protokollMarke(pool);

      const antwort = await uebernehmenAls(ANNA);

      expect(antwort).toMatchObject({ status: 303, ort: '/module/anfragen/brandt' });
      expect(await sperrenZahl()).toBe(1);
      expect((await protokollSeit(pool, marke)).map((eintrag) => eintrag.art)).toEqual(['vorgang_uebernommen']);
      const nachher = await seite('/module/anfragen/brandt');
      // Den Zeitpunkt setzt die Datenbank (`now()`), nicht die eingesetzte Uhr: hier nur seine Form.
      expect(nachher.html).toMatch(/Von Anna Albers übernommen seit [^<]*[0-9]{2}:[0-9]{2}<\/span>/);
      expect(nachher.html).toContain('Zurückgeben</button>');
      expect(nachher.html).not.toContain('Übernehmen</button>');
      const liste = await seite('/module/anfragen');
      expect((liste.html.match(/class="sperr-marke"/g) ?? []).length).toBe(1);
      expect(liste.html).toMatch(/übernommen · Anna<\/span>/);
    });

    it('zeigt die Marke auch auf den Kacheln, mit Zeit', async () => {
      await einspielen(block('anfragen', '[uebernehmen]', undefined, 'kacheln'));
      await uebernehmenAls(ANNA);

      const { html } = await seite('/module/anfragen');

      expect(html).toMatch(/übernommen · Anna · seit [^<]*[0-9]{2}:[0-9]{2}<\/span>/);
    });

    it('meldet einen schon übernommenen Vorgang auf der Detailseite, ohne Fehler und ohne zweite Sperre', async () => {
      const felder = await formularFelder('/module/anfragen/brandt', 'uebernehmen');
      await uebernehmenAls(CARLA);
      wer = ANNA;

      const antwort = await senden('/module/anfragen/brandt/uebernehmen', felder);

      expect(antwort).toMatchObject({ status: 303, ort: '/module/anfragen/brandt?hinweis=bereits-uebernommen' });
      expect(await sperrenZahl()).toBe(1);
      const { html } = await seite(antwort.ort ?? '');
      expect(html).toContain('Dieser Vorgang wurde bereits von Carla Conrad übernommen.');
    });

    it('escaped den Namen aus dem Konto überall', async () => {
      await uebernehmenAls(BERT);
      wer = CARLA;

      const detail = await seite('/module/anfragen/brandt?hinweis=bereits-uebernommen');
      const liste = await seite('/module/anfragen');

      expect(detail.html).toContain('Von Bert &lt;script&gt;alert(1)&lt;/script&gt; übernommen');
      expect(detail.html).toContain('bereits von Bert &lt;script&gt;');
      expect(liste.html).toContain('übernommen · Bert</span>');
      expect(detail.html + liste.html).not.toContain('<script>alert(1)');
    });

    it('ignoriert einen unbekannten Hinweis in der Adresse', async () => {
      const { html } = await seite('/module/anfragen/brandt?hinweis=%3Cb%3Ex%3C%2Fb%3E');
      expect(html).not.toContain('<b>x</b>');
      expect(html).not.toContain('class="hinweis hinweis-info"');
    });
  });

  describe('die Grenzen: nichts wird geschrieben', () => {
    it('ohne Sitzung: das Tor schickt zur Anmeldung', async () => {
      const felder = await formularFelder('/module/anfragen/brandt', 'uebernehmen');
      sitzung = () => Promise.resolve({ sitzungVorhanden: false, zweiterFaktorAktiv: false });
      wer = undefined;

      const antwort = await senden('/module/anfragen/brandt/uebernehmen', felder);

      expect(antwort).toMatchObject({ status: 303, ort: '/anmelden' });
      expect(await sperrenZahl()).toBe(0);
    });

    it('ohne zweiten Faktor: das Tor schickt zur Einrichtung', async () => {
      const felder = await formularFelder('/module/anfragen/brandt', 'uebernehmen');
      sitzung = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: false });

      const antwort = await senden('/module/anfragen/brandt/uebernehmen', felder);

      expect(antwort).toMatchObject({ status: 303, ort: '/zwei-faktor' });
      expect(await sperrenZahl()).toBe(0);
    });

    it.each([
      ['ohne Herkunft', { host: HOST }],
      ['mit fremder Origin', { host: HOST, origin: 'https://boese.example' }],
      ['mit Origin einer Nachbar-Subdomain', { host: HOST, origin: `https://nachbar.${HOST}` }],
    ])('%s: 403', async (_fall, kopf) => {
      const felder = await formularFelder('/module/anfragen/brandt', 'uebernehmen');

      const antwort = await senden('/module/anfragen/brandt/uebernehmen', felder, kopf);

      expect(antwort.status).toBe(403);
      expect(antwort.html).toContain('Die Anfrage kam nicht von dieser Seite. Es wurde nichts geändert.');
      expect(await sperrenZahl()).toBe(0);
    });

    it.each([
      ['ohne Bestätigung', async () => ({})],
      ['mit verfälschtem Token', async () => ({ ...(await formularFelder('/module/anfragen/brandt', 'uebernehmen')), token: 'x'.repeat(43) })],
      ['mit der Bestätigung eines anderen Vorgangs', () => formularFelder('/module/anfragen/vogt', 'uebernehmen')],
      [
        'mit der Bestätigung eines anderen Kontos',
        async () => {
          wer = CARLA;
          const felder = await formularFelder('/module/anfragen/brandt', 'uebernehmen');
          wer = ANNA;
          return felder;
        },
      ],
    ])('%s: zurück zur Detailseite mit Hinweis, nichts geändert', async (_fall, felderHolen) => {
      const felder = await felderHolen();

      const antwort = await senden('/module/anfragen/brandt/uebernehmen', felder);

      expect(antwort).toMatchObject({ status: 303, ort: '/module/anfragen/brandt?hinweis=abgelaufen' });
      expect(await sperrenZahl()).toBe(0);
      expect((await seite(antwort.ort ?? '')).html).toContain('Die Seite war zu lange geöffnet. Es wurde nichts geändert');
    });

    it('die Bestätigung von „Übernehmen" gilt nicht für „Zurückgeben"', async () => {
      const felder = await formularFelder('/module/anfragen/brandt', 'uebernehmen');
      await uebernehmenAls(ANNA);

      const antwort = await senden('/module/anfragen/brandt/zurueckgeben', felder);

      expect(antwort.ort).toBe('/module/anfragen/brandt?hinweis=abgelaufen');
      expect((await pool.query('SELECT 1 FROM cockpit.vorgang_sperre WHERE zurueckgegeben_am IS NULL')).rowCount).toBe(1);
    });

    it('ein Modul ohne den Eingriff uebernehmen: kein Knopf, und die Route antwortet mit der neutralen 404', async () => {
      const felder = await formularFelder('/module/anfragen/brandt', 'uebernehmen');
      await einspielen(block('anfragen', '[]'));

      expect((await seite('/module/anfragen/brandt')).html).not.toContain('Übernehmen</button>');
      const antwort = await senden('/module/anfragen/brandt/uebernehmen', felder);

      expect(antwort.status).toBe(404);
      expect(await sperrenZahl()).toBe(0);
    });

    it('eine Rolle ohne Zugriff auf das Modul: dieselbe neutrale 404', async () => {
      const felder = await formularFelder('/module/anfragen/brandt', 'uebernehmen');
      await einspielen(block('anfragen', '[uebernehmen]', '[betriebs_admin]'));

      const antwort = await senden('/module/anfragen/brandt/uebernehmen', felder);

      expect(antwort.status).toBe(404);
      expect(await sperrenZahl()).toBe(0);
    });

    it('eine unbekannte Zeile: dieselbe neutrale 404, auch mit gültiger Bestätigung', async () => {
      const felder = await formularFelder('/module/anfragen/brandt', 'uebernehmen');
      await pool.query(`DELETE FROM cockpit.sperre_test_quelle WHERE id = 'brandt'`);

      const antwort = await senden('/module/anfragen/brandt/uebernehmen', felder);
      const unbekanntesModul = await senden('/module/gibt-es-nicht/brandt/uebernehmen', felder);

      expect(antwort.status).toBe(404);
      expect(unbekanntesModul.status).toBe(404);
      expect(antwort.html).toBe(unbekanntesModul.html);
      expect(await sperrenZahl()).toBe(0);
    });
  });

  describe('zurückgeben', () => {
    it('wer übernommen hat, gibt zurück: 303 auf die Detailseite, danach wieder „Übernehmen"', async () => {
      await uebernehmenAls(ANNA);
      const marke = await protokollMarke(pool);

      const antwort = await senden('/module/anfragen/brandt/zurueckgeben', await formularFelder('/module/anfragen/brandt', 'zurueckgeben'));

      expect(antwort).toMatchObject({ status: 303, ort: '/module/anfragen/brandt' });
      expect(await protokollSeit(pool, marke)).toMatchObject([{ art: 'vorgang_zurueckgegeben', akteur: ANNA.id, ziel: ANNA.id }]);
      const { html } = await seite('/module/anfragen/brandt');
      expect(html).toContain('Übernehmen</button>');
      expect(html).not.toContain('vorgang-band');
    });

    it('ein anderer Mitarbeiter sieht das Band, aber keinen Knopf — und die Route antwortet 403 (Rolle frisch gelesen)', async () => {
      await uebernehmenAls(ANNA);
      wer = BERT;
      const { html } = await seite('/module/anfragen/brandt');
      expect(html).toContain('Von Anna Albers übernommen');
      expect(html).not.toContain('Zurückgeben</button>');
      // Eine gültige Bestätigung für Berts Konto: aus der Zeit, als er noch Betriebs-Admin war. Inzwischen ist er wieder
      // Mitarbeiter — die Rolle kommt bei jeder Anfrage frisch aus der Datenbank, nicht aus dem Formular.
      wer = { ...BERT, rolle: 'betriebs_admin' };
      const felder = await formularFelder('/module/anfragen/brandt', 'zurueckgeben');
      wer = BERT;
      const marke = await protokollMarke(pool);

      const antwort = await senden('/module/anfragen/brandt/zurueckgeben', felder);

      expect(antwort.status).toBe(403);
      expect(antwort.html).toContain('Diesen Vorgang kann nur zurückgeben, wer ihn übernommen hat, oder ein Betriebs-Admin.');
      expect((await pool.query('SELECT 1 FROM cockpit.vorgang_sperre WHERE zurueckgegeben_am IS NULL')).rowCount).toBe(1);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('die Betriebs-Admin gibt eine fremde Übernahme zurück', async () => {
      await uebernehmenAls(ANNA);
      wer = CARLA;

      const antwort = await senden('/module/anfragen/brandt/zurueckgeben', await formularFelder('/module/anfragen/brandt', 'zurueckgeben'));

      expect(antwort.status).toBe(303);
      expect((await pool.query('SELECT 1 FROM cockpit.vorgang_sperre WHERE zurueckgegeben_am IS NULL')).rowCount).toBe(0);
    });

    it('zurückgeben geht auch, wenn das Modul den Eingriff inzwischen nicht mehr anbietet', async () => {
      await uebernehmenAls(ANNA);
      const felder = await formularFelder('/module/anfragen/brandt', 'zurueckgeben');
      await einspielen(block('anfragen', '[]'));

      const antwort = await senden('/module/anfragen/brandt/zurueckgeben', felder);

      expect(antwort.status).toBe(303);
      expect((await pool.query('SELECT 1 FROM cockpit.vorgang_sperre WHERE zurueckgegeben_am IS NULL')).rowCount).toBe(0);
    });
  });
});
