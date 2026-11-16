/**
 * Der Posteingang im Kopf (COPI-112) gegen eine echte PostgreSQL: Badge, Panel und Zahl an „Nachrichten" aus Chat,
 * Postfach (Modul mit `posteingang:`) und Meldungen; gelesen durch Öffnen, durch die Seite Meldungen, den Chat-Kanal und
 * „Alle als gelesen"; die Postfach-Seite im Bereich Nachrichten.
 *
 * Grenzen einzeln: eine Rolle ohne Zugriff auf das Modul sieht dessen Zeilen weder im Badge noch in der Zahl, und
 * `/chat/postfach/<kennung>` ist für sie die neutrale 404; die Kundensicht sieht keinen internen Befund; Fremdtexte
 * (Mail-Betreff, Anriss) erscheinen nur escaped; „Alle als gelesen" verlangt die eigene Herkunft.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Legt eine eigene Test-Tabelle und -View an und entfernt sie am Ende.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { nachrichtAnlegen, teamKanal } from '../src/chat/nachricht-speicher.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { zugangLesenMitPosteingang } from '../src/posteingang/lesen.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { chatLeeren, kontenLoeschen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const START = new Date('2026-10-02T08:00:00.000Z');
const HOST = 'cockpit.example.org';
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

interface Person {
  readonly id: string;
  readonly name: string;
  readonly rolle: Rolle;
}

const CARLA: Person = { id: 'konto-carla', name: 'Carla Conrad', rolle: 'betriebs_admin' };
const ANNA: Person = { id: 'konto-anna', name: 'Anna Albers', rolle: 'betrieb_mitarbeiter' };
const STEFAN: Person = { id: 'konto-stefan', name: 'Stefan', rolle: 'betreuer' };

const BLOCK = [
  'kennung: postfach-test',
  'menuename: "Kommunikation"',
  'ansicht: liste-detail',
  'view: v_modul_test_postfach',
  'spalten:',
  '  - { name: absender, label: "Absender" }',
  '  - { name: zusammenfassung, label: "Worum es geht" }',
  '  - { name: eingang, label: "Eingang", format: zeitpunkt }',
  'rollen: [betreuer, betriebs_admin]',
  'eingriffe: []',
  'posteingang: { anriss: zusammenfassung, zeit: eingang }',
  '',
].join('\n');

function minuten(n: number): Date {
  return new Date(START.getTime() + n * 60_000);
}

/** Die Zahl im Badge (`aria-label` des Knopfs); 0, wenn es nichts Ungelesenes gibt. */
function badge(html: string): number {
  const treffer = /aria-label="Posteingang, (\d+) ungelesen"/.exec(html);
  return treffer ? Number(treffer[1]) : 0;
}

/** Die Zahl an „Nachrichten" in der Navigation; 0 ohne. */
function nachrichtenZahl(html: string): number {
  const treffer = /<span>Nachrichten<\/span><span class="hauptnav-zahl"><span aria-hidden="true">(\d+)<\/span>/.exec(html);
  return treffer ? Number(treffer[1]) : 0;
}

describe.skipIf(!datenbankUrl)('Posteingang (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let wer: Person;
  let jetzt: Date;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE cockpit.postfach_test_quelle (
        id              text        PRIMARY KEY,
        titel           text        NOT NULL,
        status          text        NOT NULL,
        absender        text        NOT NULL,
        zusammenfassung text        NOT NULL,
        eingang         timestamptz NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      CREATE VIEW cockpit.v_modul_test_postfach AS
        SELECT id, titel, status, aktualisiert_am, absender, zusammenfassung, eingang FROM cockpit.postfach_test_quelle;
    `);
    const basis = (): Promise<Zugang> => Promise.resolve({ angemeldet: true, rolle: wer.rolle, zweiterFaktorAktiv: true, benutzerId: wer.id });
    app = buildApp(
      { nodeEnv: 'test' },
      { pool, jetzt: () => jetzt, sitzungLesen: MIT_FAKTOR, zugangLesen: zugangLesenMitPosteingang(basis, pool, () => jetzt) },
    );
    await app.ready();
  });

  beforeEach(async () => {
    wer = CARLA;
    jetzt = START;
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.postfach_test_quelle');
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    for (const person of [CARLA, ANNA, STEFAN]) {
      await pool.query(`INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, $2, $3, true, $4)`, [
        person.id,
        person.name,
        `${person.id}@example.org`,
        person.rolle,
      ]);
    }
    const eingespielt = await modulEinspielen(pool, { rohtext: BLOCK, akteur: 'konsole' });
    if (!eingespielt.ok) {
      throw new Error(eingespielt.grund);
    }
    // Was vor dem ersten Laden da ist, gilt als gelesen.
    await mail('alt', 'Alte Anfrage', 'Längst bekannt', minuten(-60));
  });

  afterAll(async () => {
    await app.close();
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_test_postfach; DROP TABLE IF EXISTS cockpit.postfach_test_quelle;');
    await pool.end();
  });

  async function mail(id: string, titel: string, zusammenfassung: string, eingang: Date): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit.postfach_test_quelle (id, titel, status, absender, zusammenfassung, eingang) VALUES ($1, $2, 'gelb', 'anfrage@example.org', $3, $4)`,
      [id, titel, zusammenfassung, eingang],
    );
  }

  async function holen(url: string): Promise<{ status: number; html: string; kopf: Record<string, unknown> }> {
    const antwort = await app.inject({ method: 'GET', url });
    return { status: antwort.statusCode, html: antwort.body, kopf: antwort.headers };
  }

  async function befund(status: 'gelb' | 'rot', kundensichtbar: boolean, gemeldet: Date, wache = 'zertifikate'): Promise<void> {
    await befundMelden(pool, {
      wache,
      status,
      textIntern: 'roh: zertifikat n8n läuft ab',
      textKunde: kundensichtbar ? 'Das Zertifikat läuft in 6 Tagen ab.' : undefined,
      kundensichtbar,
      anzeigename: kundensichtbar ? 'Zertifikate' : undefined,
      taktSekunden: 900,
      quelle: 'admin-agent',
      jetzt: gemeldet,
    });
  }

  describe('Startpunkt und Postfach', () => {
    it('zählt beim ersten Laden nichts, was schon da war, und legt den Stand an', async () => {
      const { html } = await holen('/module');

      expect(badge(html)).toBe(0);
      expect(html).toContain('data-posteingang');
      expect(html).toContain('Alles gelesen.');
      const stand = await pool.query(`SELECT quelle FROM cockpit.posteingang_stand WHERE benutzer_id = $1 ORDER BY quelle`, [CARLA.id]);
      expect(stand.rows.map((zeile: { quelle: string }) => zeile.quelle)).toEqual(['meldungen', 'modul:postfach-test']);
    });

    it('zeigt eine neue Mail mit Titel, Anriss und Link — Fremdtext nur escaped', async () => {
      await holen('/module');
      await mail('neu', '<b>Angebot</b> Relaunch', 'Bitte <script>alert(1)</script> um Rückruf', minuten(1));
      jetzt = minuten(13);

      const { html } = await holen('/module');

      expect(badge(html)).toBe(1);
      expect(nachrichtenZahl(html)).toBe(1);
      expect(html).toContain('Mails · 1');
      expect(html).toContain('href="/module/postfach-test/neu?von=nachrichten"');
      expect(html).toContain('&lt;b&gt;Angebot&lt;/b&gt; Relaunch');
      expect(html).toContain('Bitte &lt;script&gt;alert(1)&lt;/script&gt; um Rückruf');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('vor 12 Min.');
      expect(html).not.toContain('Alte Anfrage');
    });

    it('markiert eine Mail als gelesen, sobald ihre Detailseite offen war — schon in deren eigener Navigation', async () => {
      await holen('/module');
      await mail('neu', 'Anfrage', 'Text', minuten(1));
      jetzt = minuten(2);

      const detail = await holen('/module/postfach-test/neu?von=nachrichten');

      expect(detail.status).toBe(200);
      expect(badge(detail.html)).toBe(0);
      // Zurück ins Postfach, und markiert ist „Nachrichten".
      expect(detail.html).toContain('href="/chat/postfach/postfach-test"');
      expect(detail.html).toMatch(/href="\/chat" class="hauptnav-eintrag" aria-current="page"/);
      expect(badge((await holen('/module')).html)).toBe(0);
    });

    it('zeigt das Postfach im Bereich Nachrichten, jüngste zuerst, Ungelesenes hervorgehoben', async () => {
      await holen('/chat');
      await mail('a', 'Erste neue', 'eins', minuten(1));
      await mail('b', 'Zweite neue', 'zwei', minuten(2));
      jetzt = minuten(3);

      const chat = await holen('/chat');
      expect(chat.html).toContain('Postfächer');
      expect(chat.html).toContain('href="/chat/postfach/postfach-test"');

      const { status, html } = await holen('/chat/postfach/postfach-test');
      expect(status).toBe(200);
      expect(html.indexOf('Zweite neue')).toBeLessThan(html.indexOf('Erste neue'));
      expect(html.indexOf('Erste neue')).toBeLessThan(html.indexOf('Alte Anfrage'));
      expect((html.match(/postfach-zeile postfach-zeile-neu/g) ?? []).length).toBe(2);
      expect(html).toContain('2 ungelesen');
    });

    it('zeigt einer Rolle ohne Zugriff auf das Modul dessen Mails nirgends, und das Postfach ist die neutrale 404', async () => {
      wer = ANNA;
      await holen('/module');
      await mail('neu', 'Geheime Anfrage', 'Text', minuten(1));
      jetzt = minuten(2);

      const { html } = await holen('/');
      expect(badge(html)).toBe(0);
      expect(html).not.toContain('Geheime Anfrage');
      expect(html).not.toContain('/chat/postfach/');
      expect((await holen('/chat/postfach/postfach-test')).status).toBe(404);
      expect((await holen('/chat')).html).not.toContain('Postfächer');
    });
  });

  it('weist beim Einspielen eine Zeit-Spalte ab, die kein timestamptz ist', async () => {
    await pool.query(`CREATE OR REPLACE VIEW cockpit.v_modul_test_postfach_falsch AS
      SELECT id, titel, status, aktualisiert_am, absender, zusammenfassung, eingang::text AS eingang FROM cockpit.postfach_test_quelle`);
    try {
      const ergebnis = await modulEinspielen(pool, {
        rohtext: BLOCK.replace('kennung: postfach-test', 'kennung: postfach-falsch').replace('v_modul_test_postfach', 'v_modul_test_postfach_falsch'),
        akteur: 'konsole',
      });
      expect(ergebnis.ok === false && ergebnis.grund).toContain('Die Spalte eingang in cockpit.v_modul_test_postfach_falsch hat den Typ text, erwartet timestamp with time zone.');
    } finally {
      await pool.query('DROP VIEW cockpit.v_modul_test_postfach_falsch');
    }
  });

  describe('Chat und Meldungen', () => {
    it('zeigt eine neue Nachricht im Team-Kanal und zählt sie an „Nachrichten" mit der Mail zusammen', async () => {
      await holen('/module');
      const kanal = await teamKanal(pool);
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'mensch', absenderId: STEFAN.id, inhalt: 'Zwei neue Treffer aus dem Radar' });
      await mail('neu', 'Anfrage', 'Text', minuten(1));
      jetzt = minuten(2);

      const { html } = await holen('/module');
      expect(badge(html)).toBe(2);
      expect(nachrichtenZahl(html)).toBe(2);
      expect(html).toContain('Chat · Team');
      expect(html).toContain('Zwei neue Treffer aus dem Radar');

      // Wer den Kanal ansieht, hat ihn gelesen — schon in der Navigation dieser Seite.
      const team = await holen('/chat/team');
      expect(badge(team.html)).toBe(1);
      expect(team.html).not.toContain('Chat · Team');
    });

    it('zeigt einen Wechsel auf Rot seit dem Stand, bis die Seite Meldungen offen war', async () => {
      await holen('/module');
      await befund('rot', true, minuten(1));
      jetzt = minuten(2);

      const vorher = await holen('/module');
      expect(badge(vorher.html)).toBe(1);
      expect(vorher.html).toContain('Meldung · Rot');
      expect(vorher.html).toContain('Das Zertifikat läuft in 6 Tagen ab.');
      // Meldungen zählen nur im Badge, nicht an „Nachrichten".
      expect(nachrichtenZahl(vorher.html)).toBe(0);

      expect(badge((await holen('/meldungen')).html)).toBe(0);
      expect(badge((await holen('/module')).html)).toBe(0);
    });

    it('zeigt der Kundensicht keinen internen Befund, dem Betreuer schon', async () => {
      wer = STEFAN;
      await holen('/module');
      wer = CARLA;
      await holen('/module');
      await befund('rot', false, minuten(1), 'container');
      jetzt = minuten(2);

      const kunde = await holen('/module');
      expect(badge(kunde.html)).toBe(0);
      expect(kunde.html).not.toContain('roh: zertifikat');

      wer = STEFAN;
      const betreuer = await holen('/module');
      expect(badge(betreuer.html)).toBe(1);
      expect(betreuer.html).toContain('roh: zertifikat n8n läuft ab');
    });
  });

  describe('Alle als gelesen und Nachladen', () => {
    async function allesUngelesen(): Promise<void> {
      await holen('/module');
      const kanal = await teamKanal(pool);
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'mensch', absenderId: STEFAN.id, inhalt: 'Hallo Team' });
      await mail('neu', 'Anfrage', 'Text', minuten(1));
      await befund('gelb', true, minuten(1));
      jetzt = minuten(2);
      expect(badge((await holen('/module')).html)).toBe(3);
    }

    it('markiert alles als gelesen und führt zurück auf die Seite, von der das Formular kam', async () => {
      await allesUngelesen();

      const antwort = await app.inject({
        method: 'POST',
        url: '/posteingang/gelesen',
        headers: { host: HOST, origin: `https://${HOST}`, referer: `https://${HOST}/module?x=1` },
      });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/module?x=1');
      expect(badge((await holen('/module')).html)).toBe(0);
    });

    it('ändert ohne eigene Herkunft nichts (403)', async () => {
      await allesUngelesen();

      const antwort = await app.inject({ method: 'POST', url: '/posteingang/gelesen', headers: { host: HOST, origin: 'https://fremd.example.org' } });

      expect(antwort.statusCode).toBe(403);
      expect(badge((await holen('/module')).html)).toBe(3);
    });

    it('liefert unter /posteingang nur das Badge samt Panel, ohne Zwischenspeicher', async () => {
      await allesUngelesen();

      const { status, html, kopf } = await holen('/posteingang');

      expect(status).toBe(200);
      expect(kopf['cache-control']).toBe('no-store');
      expect(html.trim().startsWith('<details class="posteingang" data-posteingang>')).toBe(true);
      expect(html).not.toContain('<html');
      expect(badge(html)).toBe(3);
    });
  });
});
