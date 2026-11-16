/**
 * Anhänge einer Modulzeile (COPI-110) gegen eine echte PostgreSQL, mit dem Beispiel-Modul Eingang (Fachmigrationen
 * 0001–0004, Views und Block aus `docs/demo`): die Liste auf der Detailseite, die Warnseite je Klasse und der
 * Download über das Formular.
 *
 * Sicherheitskritisch (Fremdinhalt wird ausgeliefert): gesperrte Typen nie, Download nur mit gültiger Bestätigung für
 * genau diesen Inhalt, nur für Anhänge einer sichtbaren Zeile, immer als `attachment` mit den strengen Headern, jeder
 * Download mit Nachweis. Jede Grenze steht einzeln da, jeweils mit dem Nachweis, dass nichts ausgeliefert wurde.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { buildApp } from '../src/server/app.js';
import { fachMigrationenEinspielen } from '../scripts/dev/fach-migrationen.js';
import { formular, FORMULAR_KOPF, eingangViewsAnlegen, kontenLoeschen, protokollMarke, protokollSeit, wieImBetrieb, betreuerDarf } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const BLOCK_YAML = readFileSync('docs/demo/eingang.cockpit.yaml', 'utf8');
const ANHANG_VIEW_SQL = readFileSync('docs/demo/v_modul_eingang_anhaenge.sql', 'utf8');
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HOST = 'cockpit.example.org';
const HERKUNFT = { host: HOST, origin: `https://${HOST}` };
const MESSAGE_ID = '<relaunch@example.org>';

interface Person {
  readonly id: string;
  readonly name: string;
  readonly rolle: Rolle;
}

const BETREUER: Person = { id: 'konto-betreuer', name: 'Erika Beispiel', rolle: 'betreuer' };
const CARLA: Person = { id: 'konto-carla', name: 'Carla Conrad', rolle: 'betriebs_admin' };
const ANNA: Person = { id: 'konto-anna', name: 'Anna Albers', rolle: 'betrieb_mitarbeiter' };

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('Anforderungen')]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('Archiv')]);
const MZ = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.from('Programm')]);

describe.skipIf(!datenbankUrl)('Anhänge einer Modulzeile (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let wer: Person;
  let uhr: Date;
  let vorgang: string;
  /** Die `id` je Dateiname, wie die Anhang-View sie liefert. */
  let anhang: Record<string, string>;

  const detail = (): string => `/module/eingang/${vorgang}`;
  const warnseite = (name: string): string => `${detail()}/anhang/${anhang[name] ?? 'fehlt'}`;

  async function seite(url: string, als: Person = wer): Promise<{ status: number; html: string }> {
    wer = als;
    const antwort = await app.inject({ method: 'GET', url, headers: { host: HOST } });
    return { status: antwort.statusCode, html: antwort.body };
  }

  /** Die Felder des Download-Formulars auf der Warnseite (signierte Bestätigung und SHA-256). */
  async function felder(name: string, als: Person = wer): Promise<{ bis: string; token: string; sha256: string }> {
    const { html } = await seite(warnseite(name), als);
    const form = new RegExp(
      `<form method="post" action="${warnseite(name)}" class="warn-form">\\s*<input type="hidden" name="bis" value="(\\d+)">\\s*<input type="hidden" name="token" value="([A-Za-z0-9_-]+)">\\s*<input type="hidden" name="sha256" value="([0-9a-f]{64})">`,
    ).exec(html);
    if (!form?.[1] || !form[2] || !form[3]) {
      throw new Error(`Kein Download-Formular auf ${warnseite(name)}`);
    }
    return { bis: form[1], token: form[2], sha256: form[3] };
  }

  async function laden(name: string, werte: Readonly<Record<string, string>>, kopf: Record<string, string> = HERKUNFT) {
    const antwort = await app.inject({ method: 'POST', url: warnseite(name), headers: { ...FORMULAR_KOPF, ...kopf }, payload: formular(werte) });
    return { status: antwort.statusCode, ort: antwort.headers.location, kopf: antwort.headers, inhalt: antwort.rawPayload };
  }

  async function nachweise(): Promise<{ anhang_id: string; dateiname: string; klasse: string; konto: string; sha256: string; groesse: string }[]> {
    return (await pool.query<{ anhang_id: string; dateiname: string; klasse: string; konto: string; sha256: string; groesse: string }>(
      'SELECT anhang_id, dateiname, klasse, konto, sha256, groesse::text FROM cockpit.anhang_download ORDER BY id',
    )).rows;
  }

  async function anhangEinfuegen(messageId: string, position: number, name: string, inhalt: Buffer | null, groesse = inhalt?.length ?? 0): Promise<string> {
    await pool.query(`INSERT INTO eingang.anhang (message_id, position, dateiname, typ, groesse, inhalt) VALUES ($1, $2, $3, 'application/x-probe', $4, $5)`, [
      messageId,
      position,
      name,
      groesse,
      inhalt,
    ]);
    const id = (await pool.query<{ id: string }>('SELECT id FROM cockpit.v_modul_eingang_anhaenge WHERE dateiname = $1', [name])).rows[0]?.id;
    return id ?? '';
  }

  async function vorgangEinfuegen(messageId: string, eingang = 'now()'): Promise<string> {
    return (
      (
        await pool.query<{ id: string }>(
          `INSERT INTO eingang.vorgang (message_id, postfach, absender_name, absender_adresse, betreff, eingang, zusammenfassung)
           VALUES ($1, 'agent@example.com', 'Jana Peters', 'j.peters@example.org', 'Relaunch', ${eingang}, 'Termin') RETURNING id::text`,
          [messageId],
        )
      ).rows[0]?.id ?? ''
    );
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_eingang');
    await pool.query('DROP SCHEMA IF EXISTS eingang CASCADE');
    await fachMigrationenEinspielen(pool, 'docs/demo/fach/eingang', 'test');
    await eingangViewsAnlegen(pool);
    const basis = (): Promise<Zugang> => Promise.resolve({ angemeldet: true, rolle: wer.rolle, zweiterFaktorAktiv: true, benutzerId: wer.id });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => uhr, sitzungLesen: MIT_FAKTOR, zugangLesen: basis });
    await app.ready();
  });

  beforeEach(async () => {
    wer = BETREUER;
    uhr = new Date();
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
    vorgang = await vorgangEinfuegen(MESSAGE_ID);
    anhang = {};
    for (const [stelle, [name, inhalt, groesse]] of (
      [
        ['Anforderungen.pdf', PDF],
        ['Bestandsseite.zip', ZIP],
        ['Angebot_alt.pdf', ZIP],
        ['Rechnung.pdf', MZ],
        ['setup.exe', PDF],
        ['Baustellenvideo.mov', null, 48_000_000],
      ] as const
    ).entries()) {
      anhang[name] = await anhangEinfuegen(MESSAGE_ID, stelle + 1, name, inhalt, groesse);
    }
  });

  afterAll(async () => {
    await app.close();
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_eingang');
    await pool.query('DROP SCHEMA IF EXISTS eingang CASCADE');
    await pool.end();
  });

  describe('die Tabelle (Migration 0044)', () => {
    it('ist unveränderlich und wird nie gelöscht', async () => {
      await pool.query(
        `INSERT INTO cockpit.anhang_download (modul_kennung, vorgang_id, anhang_id, dateiname, groesse, sha256, klasse, konto) VALUES ('eingang', '1', '1', 'a.pdf', 3, $1, 'normal', $2)`,
        ['0'.repeat(64), BETREUER.id],
      );
      await expect(pool.query(`UPDATE cockpit.anhang_download SET dateiname = 'b.pdf'`)).rejects.toThrow(/anhang_download_unveraenderlich/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.anhang_download')).rejects.toThrow(/nie_loeschen/);
      await expect(
        pool.query(`INSERT INTO cockpit.anhang_download (modul_kennung, vorgang_id, anhang_id, dateiname, groesse, sha256, klasse, konto) VALUES ('eingang', '1', '1', 'a.exe', 3, $1, 'gesperrt', $2)`, [
          '0'.repeat(64),
          BETREUER.id,
        ]),
      ).rejects.toMatchObject({ constraint: 'anhang_download_klasse' });
    });
  });

  describe('die Detailseite', () => {
    it('zeigt alle Anhänge mit Klasse, verlinkt nur ladbare und nur auf die Warnseite', async () => {
      const { status, html } = await seite(detail());
      expect(status).toBe(200);
      expect(html).toContain('Anhänge · 6');
      expect(html).toContain(`<a class="anhang anhang-normal" href="${warnseite('Anforderungen.pdf')}">`);
      expect(html).toContain(`<a class="anhang anhang-warnung" href="${warnseite('Bestandsseite.zip')}">`);
      expect(html).toContain(`<a class="anhang anhang-warnung" href="${warnseite('Angebot_alt.pdf')}">`);
      expect(html).toContain('Endung passt nicht zum Inhalt');
      // Programme sind gesperrt, gleich ob nach Endung oder Inhalt — und kein Link.
      expect((html.match(/<div class="anhang anhang-gesperrt">/g) ?? []).length).toBe(2);
      expect(html).not.toContain(`href="${warnseite('Rechnung.pdf')}"`);
      expect(html).not.toContain(`href="${warnseite('setup.exe')}"`);
      expect(html).toContain('<div class="anhang anhang-postfach">');
      expect(html).toContain('Zu groß fürs Cockpit, liegt im Postfach');
      expect(html).not.toContain('<dt>Anhänge</dt>');
    });

    it('maskiert Dateinamen und entfernt Bidi-Zeichen', async () => {
      await anhangEinfuegen(MESSAGE_ID, 7, '<img src=x onerror=alert(1)>‮fdp.exe', PDF);
      const { html } = await seite(detail());
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;fdp.exe');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('‮');
    });

    it('zeigt ohne Anhänge keinen Abschnitt', async () => {
      const ohne = await vorgangEinfuegen('<ohne@example.org>');
      const { html } = await seite(`/module/eingang/${ohne}`);
      expect(html).not.toContain('anhang-liste');
    });
  });

  describe('die Warnseite', () => {
    it('bietet eine normale Datei mit einfacher Bestätigung an, mit SHA-256', async () => {
      const { status, html } = await seite(warnseite('Anforderungen.pdf'));
      expect(status).toBe(200);
      expect(html).toContain('Anhang herunterladen');
      expect(html).toContain('Eingang · Relaunch');
      expect(html).toContain('application/x-probe');
      expect(html).toContain('Herunterladen</button>');
      expect(html).not.toContain('name="erwartet"');
      expect((await felder('Anforderungen.pdf')).sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('verlangt bei einer Warnung den Pflicht-Haken und nennt den Grund', async () => {
      const { html } = await seite(warnseite('Angebot_alt.pdf'));
      expect(html).toContain('Die Endung passt nicht zum Inhalt.');
      expect(html).toContain('Der Name sagt „PDF“, der Inhalt ist aber „ZIP-Archiv“.');
      expect(html).toContain('name="erwartet" value="ja" required');
      expect(html).toContain('Trotzdem herunterladen</button>');
    });

    it.each(['Rechnung.pdf', 'setup.exe', 'Baustellenvideo.mov'])('zeigt %s ohne Formular und ohne SHA-256', async (name) => {
      const { status, html } = await seite(warnseite(name));
      expect(status).toBe(200);
      expect(html).not.toContain('<form method="post" action="' + warnseite(name));
      expect(html).not.toContain('SHA-256');
      expect(html).toContain('Zurück zum Vorgang');
    });
  });

  describe('der Download', () => {
    it('liefert nach Bestätigung aus, als attachment mit den strengen Headern, und weist ihn nach', async () => {
      const marke = await protokollMarke(pool);
      const werte = await felder('Anforderungen.pdf', CARLA);

      const antwort = await laden('Anforderungen.pdf', werte);

      expect(antwort.status).toBe(200);
      expect(antwort.inhalt.equals(PDF)).toBe(true);
      expect(antwort.kopf['content-type']).toBe('application/octet-stream');
      expect(antwort.kopf['content-disposition']).toBe(`attachment; filename="Anforderungen.pdf"; filename*=UTF-8''Anforderungen.pdf`);
      expect(antwort.kopf['x-content-type-options']).toBe('nosniff');
      expect(antwort.kopf['cache-control']).toBe('no-store');
      expect(antwort.kopf['content-security-policy']).toBe("sandbox; default-src 'none'");
      expect(antwort.kopf['cross-origin-resource-policy']).toBe('same-origin');
      expect(await nachweise()).toEqual([
        { anhang_id: anhang['Anforderungen.pdf'], dateiname: 'Anforderungen.pdf', klasse: 'normal', konto: CARLA.id, sha256: werte.sha256, groesse: String(PDF.length) },
      ]);
      const eintraege = await protokollSeit(pool, marke);
      expect(eintraege.map((eintrag) => [eintrag.art, eintrag.akteur])).toEqual([['anhang_heruntergeladen', CARLA.id]]);
      expect(Object.keys(eintraege[0]?.einzelheiten ?? {})).toEqual(['anhang_download_id']);
    });

    it('lässt die allgemeine CSP auf allen anderen Seiten stehen', async () => {
      const antwort = await app.inject({ method: 'GET', url: warnseite('Anforderungen.pdf'), headers: { host: HOST } });
      expect(antwort.headers['content-security-policy']).toContain("default-src 'self'");
    });

    it('liefert eine Warnung erst mit dem Haken aus', async () => {
      const werte = await felder('Bestandsseite.zip');
      expect(await laden('Bestandsseite.zip', werte)).toMatchObject({ status: 303, ort: `${warnseite('Bestandsseite.zip')}?hinweis=haken` });
      expect(await nachweise()).toEqual([]);

      const antwort = await laden('Bestandsseite.zip', { ...werte, erwartet: 'ja' });
      expect(antwort.status).toBe(200);
      expect(antwort.inhalt.equals(ZIP)).toBe(true);
      expect((await nachweise()).map((zeile) => zeile.klasse)).toEqual(['warnung']);
    });

    it('liefert gesperrte und fehlende Inhalte nie aus, auch nicht mit einer Bestätigung einer anderen Datei', async () => {
      const fremd = await felder('Anforderungen.pdf');
      for (const name of ['Rechnung.pdf', 'setup.exe', 'Baustellenvideo.mov']) {
        const antwort = await laden(name, fremd);
        expect(antwort.status).toBe(303);
        expect(antwort.inhalt.length).toBe(0);
      }
      expect(await nachweise()).toEqual([]);
    });

    it('weist ab: ohne Herkunft (403), abgelaufen, gefälscht, von einem anderen Konto oder mit anderem SHA-256', async () => {
      const werte = await felder('Anforderungen.pdf');
      expect((await laden('Anforderungen.pdf', werte, { host: HOST })).status).toBe(403);
      expect((await laden('Anforderungen.pdf', werte, { host: HOST, origin: 'https://boese.example' })).status).toBe(403);

      const abgelehnt = { status: 303, ort: `${warnseite('Anforderungen.pdf')}?hinweis=abgelaufen` };
      // Das erste Zeichen ändern: am letzten hängen bei Base64url nicht alle Bits am Wert.
      const gefaelscht = `${werte.token.startsWith('A') ? 'B' : 'A'}${werte.token.slice(1)}`;
      expect(await laden('Anforderungen.pdf', { ...werte, token: gefaelscht })).toMatchObject(abgelehnt);
      expect(await laden('Anforderungen.pdf', { ...werte, sha256: 'f'.repeat(64) })).toMatchObject(abgelehnt);
      expect(await laden('Anforderungen.pdf', { bis: werte.bis, token: werte.token })).toMatchObject(abgelehnt);
      wer = CARLA;
      expect(await laden('Anforderungen.pdf', werte)).toMatchObject(abgelehnt);
      wer = BETREUER;
      uhr = new Date(uhr.getTime() + 11 * 60_000);
      expect(await laden('Anforderungen.pdf', werte)).toMatchObject(abgelehnt);
      expect(await nachweise()).toEqual([]);

      const { html } = await seite(`${warnseite('Anforderungen.pdf')}?hinweis=abgelaufen`);
      expect(html).toContain('Die Bestätigung war abgelaufen');
    });

    it('weist eine Bestätigung für einen anderen Anhang ab', async () => {
      const werte = await felder('Anforderungen.pdf');
      const zweite = await anhangEinfuegen(MESSAGE_ID, 7, 'Kopie.pdf', PDF);
      const antwort = await app.inject({ method: 'POST', url: `${detail()}/anhang/${zweite}`, headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: formular(werte) });
      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toContain('hinweis=abgelaufen');
      expect(await nachweise()).toEqual([]);
    });
  });

  describe('neutrale 404', () => {
    it('für eine Rolle ohne Zugriff auf das Modul, auf Seite und Formular', async () => {
      const werte = await felder('Anforderungen.pdf');
      expect((await seite(warnseite('Anforderungen.pdf'), ANNA)).status).toBe(404);
      expect((await laden('Anforderungen.pdf', werte)).status).toBe(404);
      expect(await nachweise()).toEqual([]);
    });

    it('für erfundene und fremde Anhänge und für Zeilen außerhalb der Modul-View', async () => {
      const andere = await vorgangEinfuegen('<andere@example.org>');
      const alt = await vorgangEinfuegen('<alt@example.org>', "now() - interval '20 days'");
      const altAnhang = await anhangEinfuegen('<alt@example.org>', 1, 'alt.pdf', PDF);
      expect((await seite(`${detail()}/anhang/999999`)).status).toBe(404);
      expect((await seite(`/module/eingang/${andere}/anhang/${anhang['Anforderungen.pdf'] ?? ''}`)).status).toBe(404);
      expect((await seite(`/module/eingang/${alt}/anhang/${altAnhang}`)).status).toBe(404);
      expect((await seite(`${detail()}/anhang/${'1'.repeat(201)}`)).status).toBe(404);
    });

    it('für ein Modul ohne Anhänge im Block', async () => {
      await modulEinspielen(pool, { rohtext: BLOCK_YAML.replace(/\n {2}anhaenge: v_modul_eingang_anhaenge\n/, '\n'), akteur: 'konsole' });
      expect((await seite(warnseite('Anforderungen.pdf'))).status).toBe(404);
      const { html } = await seite(detail());
      expect(html).not.toContain('anhang-liste');
    });
  });

  describe('Grenzen der Auslieferung', () => {
    async function viewErsetzen(sql: string): Promise<void> {
      await pool.query('DROP VIEW cockpit.v_modul_eingang_anhaenge');
      await pool.query(sql);
    }

    afterAll(async () => {
      await viewErsetzen(ANHANG_VIEW_SQL);
    });

    it('zeigt die Zeile ohne Anhänge, wenn die Anhang-View den Vertrag bricht, und lehnt den Block beim Einspielen ab', async () => {
      await viewErsetzen(ANHANG_VIEW_SQL.replace('a.groesse::numeric AS groesse', 'a.groesse::text AS groesse'));
      try {
        const { status, html } = await seite(detail());
        expect(status).toBe(200);
        expect(html).toContain('Relaunch');
        expect(html).not.toContain('anhang-liste');
        expect((await seite(warnseite('Anforderungen.pdf'))).status).toBe(503);
        const ergebnis = await modulEinspielen(pool, { rohtext: BLOCK_YAML.replace('menuename: "Eingang"', 'menuename: "Eingang neu"'), akteur: 'konsole' });
        await betreuerDarf(pool, 'eingang');
        expect(ergebnis).toEqual({ ok: false, grund: expect.stringContaining('groesse in cockpit.v_modul_eingang_anhaenge hat den Typ text') as unknown });
      } finally {
        await viewErsetzen(ANHANG_VIEW_SQL);
      }
    });

    it('liefert nichts über 10 MB aus, auch wenn eine View es anbietet', async () => {
      await viewErsetzen(`${ANHANG_VIEW_SQL.trimEnd().replace(/;$/, '')}
        UNION ALL SELECT 'gross', ${vorgang}::text, 'gross.pdf', 10485761, '\\x25504446'::bytea || decode(repeat('00', 10485757), 'hex'), NULL, NULL;`);
      try {
        const { html } = await seite(detail());
        expect(html).toContain('<div class="anhang anhang-postfach">');
        const warn = await seite(`${detail()}/anhang/gross`);
        expect(warn.html).not.toContain('SHA-256');
        expect(warn.html).not.toContain('class="warn-form"');
      } finally {
        await viewErsetzen(ANHANG_VIEW_SQL);
      }
    });

    it('lässt höchstens zwei Downloads gleichzeitig laufen', async () => {
      const werte = await felder('Anforderungen.pdf');
      // Jedes Lesen des Inhalts dauert eine halbe Sekunde: drei gleichzeitige Downloads überlappen sicher.
      await viewErsetzen(ANHANG_VIEW_SQL.replace('a.inhalt,', '(SELECT a.inhalt FROM pg_sleep(0.5)) AS inhalt,'));
      try {
        const antworten = await Promise.all([1, 2, 3].map(() => laden('Anforderungen.pdf', werte)));
        expect(antworten.map((antwort) => antwort.status).sort()).toEqual([200, 200, 503]);
        expect(await nachweise()).toHaveLength(2);
      } finally {
        await viewErsetzen(ANHANG_VIEW_SQL);
      }
    });
  });
});
