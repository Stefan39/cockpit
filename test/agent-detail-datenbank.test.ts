/**
 * Die Detailseite eines Agenten (COPI-113) gegen eine echte PostgreSQL: die Regeln der Migration 0037, die Agenten-API
 * (`agent` an Antwort, Befund und Verbrauch, `POST /intern/chat/agenten`) und die Seite `/agenten/<schlüssel>` je Rolle.
 *
 * Grenzen einzeln: Die Kundensicht zeigt die Kennung nirgends (auch nicht in Links, COPI-38), weder Gespräche zwischen
 * Agenten noch Verbrauch noch interne Befunde; fremde Assistenten-Kanäle sieht niemand; im Kanal zweier Agenten schreibt
 * nur einer der beiden; Fremdtext erscheint nur escaped.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Legt eine eigene Test-Tabelle und -View an und entfernt sie am Ende.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { agentPfad, agentSchluessel } from '../src/agenten/detail.js';
import { agentenKanal, assistentKanal, nachrichtAnlegen, teamKanal } from '../src/chat/nachricht-speicher.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { buildApp } from '../src/server/app.js';
import { inventarErsetzen } from '../src/status/agenten-speicher.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { chatLeeren, kontenLoeschen, sperrenLeeren, wieImBetrieb, betreuerDarf } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const JETZT = new Date('2026-10-02T10:00:00.000Z');
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

const KENNUNG = 'geheim-assistent-4711';
const VERSION = 'V-9.8.7-GEHEIM';

const BLOCK = [
  'kennung: agent-postfach',
  'menuename: "Kommunikation"',
  'ansicht: liste-detail',
  'view: v_modul_test_agent',
  'spalten:',
  '  - { name: zusammenfassung, label: "Worum es geht" }',
  '  - { name: eingang, label: "Eingang", format: zeitpunkt }',
  'rollen: [betreuer, betriebs_admin]',
  'eingriffe: [uebernehmen]',
  'posteingang: { anriss: zusammenfassung, zeit: eingang }',
  `agent: ${KENNUNG}`,
  '',
].join('\n');

describe.skipIf(!datenbankUrl)('Agenten-Detailseite (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let wer: { id: string; rolle: Rolle };

  async function konto(id: string, rolle: Rolle): Promise<void> {
    await pool.query(`INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, $1, $2, true, $3)`, [id, `${id}@example.org`, rolle]);
  }

  async function seite(url: string, rolle: Rolle = 'betreuer', id = 'konto-stefan'): Promise<{ status: number; html: string }> {
    wer = { id, rolle };
    const antwort = await app.inject({ method: 'GET', url });
    return { status: antwort.statusCode, html: antwort.body };
  }

  function intern(url: string, token: string, koerper: unknown) {
    return app.inject({ method: 'POST', url: `/intern${url}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(koerper) });
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE cockpit.agent_test_quelle (
        id text PRIMARY KEY, titel text NOT NULL, status text NOT NULL, zusammenfassung text NOT NULL,
        eingang timestamptz NOT NULL, aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      CREATE VIEW cockpit.v_modul_test_agent AS
        SELECT id, titel, status, aktualisiert_am, zusammenfassung, eingang FROM cockpit.agent_test_quelle;
    `);
    const basis = (): Promise<Zugang> => Promise.resolve({ angemeldet: true, rolle: wer.rolle, zweiterFaktorAktiv: true, benutzerId: wer.id });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT, sitzungLesen: MIT_FAKTOR, zugangLesen: basis });
    await app.ready();
  });

  beforeEach(async () => {
    wer = { id: 'konto-stefan', rolle: 'betreuer' };
    await chatLeeren(pool);
    await sperrenLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.agent_test_quelle');
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('TRUNCATE cockpit.verbrauch CASCADE');
    await pool.query('DELETE FROM cockpit.agent');
    await konto('konto-stefan', 'betreuer');
    await konto('konto-carla', 'betriebs_admin');
    await konto('konto-anna', 'betrieb_mitarbeiter');
    await inventarErsetzen(
      pool,
      [
        { kennung: KENNUNG, rolle: 'Assistent – Akquise', version: VERSION, grenzen: { Senden: 'nur nach Freigabe' }, zeitplan: [{ name: 'Posteingang prüfen', wann: 'alle 5 Minuten' }] },
        { kennung: 'koordinator', rolle: 'Koordinator – Koordinator', version: '1.0.0', grenzen: {}, zeitplan: [] },
      ],
      JETZT,
    );
    const eingespielt = await modulEinspielen(pool, { rohtext: BLOCK, akteur: 'konsole' });
    if (!eingespielt.ok) {
      throw new Error(eingespielt.grund);
    }
    await betreuerDarf(pool, 'agent-postfach');
  });

  afterAll(async () => {
    await app.close();
    await chatLeeren(pool);
    await sperrenLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('TRUNCATE cockpit.verbrauch CASCADE');
    await pool.query('DELETE FROM cockpit.agent');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_test_agent; DROP TABLE IF EXISTS cockpit.agent_test_quelle;');
    await pool.end();
  });

  describe('Migration 0037', () => {
    it('lässt im Kanal zweier Agenten nur einen der beiden schreiben, mit Kennung', async () => {
      const kanal = await agentenKanal(pool, 'koordinator', KENNUNG);
      await expect(nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', absenderAgent: 'wache', inhalt: 'x' })).rejects.toThrow(/nachricht_agentenkanal/);
      await expect(nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', inhalt: 'x' })).rejects.toThrow(/nachricht_agentenkanal/);
      await expect(nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'mensch', absenderId: 'konto-stefan', inhalt: 'x' })).rejects.toThrow(/nachricht_agentenkanal/);
      await expect(nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', absenderAgent: 'koordinator', inhalt: 'Hallo' })).resolves.toMatchObject({ absenderAgent: 'koordinator' });
    });

    it('hält je Paar genau einen Kanal, egal in welcher Reihenfolge', async () => {
      const eins = await agentenKanal(pool, KENNUNG, 'koordinator');
      const zwei = await agentenKanal(pool, 'koordinator', KENNUNG);
      expect(zwei.id).toBe(eins.id);
      expect(eins.agenten).toEqual([KENNUNG, 'koordinator'].sort());
    });

    it('lässt die Kennung des Absenders nicht ändern, nur bei Agenten zu, und Nachrichten nicht löschen', async () => {
      const team = await teamKanal(pool);
      await expect(nachrichtAnlegen(pool, { kanalId: team.id, absenderArt: 'mensch', absenderId: 'konto-stefan', absenderAgent: 'koordinator', inhalt: 'x' })).rejects.toMatchObject({
        constraint: 'nachricht_absender_agent_nur_beim_agenten',
      });
      const kanal = await agentenKanal(pool, 'koordinator', KENNUNG);
      const nachricht = await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', absenderAgent: 'koordinator', inhalt: 'Hallo' });
      await expect(pool.query(`UPDATE cockpit.nachricht SET absender_agent = $2 WHERE id = $1`, [nachricht.id, KENNUNG])).rejects.toThrow(/nachricht_unveraenderlich/);
      await expect(wieImBetrieb(pool, `DELETE FROM cockpit.nachricht WHERE id = ${String(nachricht.id)}`)).rejects.toThrow(/nie_loeschen/);
    });
  });

  describe('Agenten-API', () => {
    it('nimmt Nachrichten zwischen Agenten an (Recht chat_antworten), nie an sich selbst, nie ohne Recht', async () => {
      const chat = (await apiTokenAnlegen(pool, { name: 'agenten', scopes: ['chat_antworten'] })).token;
      const fremd = (await apiTokenAnlegen(pool, { name: 'admin', scopes: ['befund_schreiben'] })).token;

      const ok = await intern('/chat/agenten', chat, { von: 'koordinator', an: KENNUNG, text: 'Bitte Radar prüfen.\r\nDanke' });
      expect(ok.statusCode).toBe(201);
      const gespeichert = await pool.query<{ inhalt: string; absender_agent: string }>(`SELECT inhalt, absender_agent FROM cockpit.nachricht WHERE id = $1`, [ok.json<{ id: number }>().id]);
      expect(gespeichert.rows[0]).toEqual({ inhalt: 'Bitte Radar prüfen.\nDanke', absender_agent: 'koordinator' });

      expect((await intern('/chat/agenten', chat, { von: 'koordinator', an: 'koordinator', text: 'x' })).statusCode).toBe(400);
      expect((await intern('/chat/agenten', chat, { von: 'Koordinator', an: KENNUNG, text: 'x' })).statusCode).toBe(400);
      expect((await intern('/chat/agenten', chat, { von: 'koordinator', an: KENNUNG, text: 'x', extra: 1 })).statusCode).toBe(400);
      expect((await intern('/chat/agenten', fremd, { von: 'koordinator', an: KENNUNG, text: 'x' })).statusCode).toBe(403);
    });

    it('ordnet Antwort, Befund und Verbrauch dem genannten Agenten zu', async () => {
      const token = (await apiTokenAnlegen(pool, { name: 'alle', scopes: ['chat_antworten', 'befund_schreiben', 'verbrauch_schreiben'] })).token;
      const frage = await nachrichtAnlegen(pool, { kanalId: (await assistentKanal(pool, 'konto-stefan')).id, absenderArt: 'mensch', absenderId: 'konto-stefan', inhalt: 'Wie läuft es?' });

      expect((await intern('/chat/antwort', token, { nachricht_id: frage.id, text: 'Gut.', agent: 'koordinator' })).statusCode).toBe(201);
      expect((await intern('/befund', token, { wache: 'mailserver', status: 'gelb', text_intern: 'IMAP langsam', takt_sekunden: 900, agent: KENNUNG })).statusCode).toBe(201);
      // Ein späterer Befund ohne Angabe lässt die Zuordnung stehen.
      expect((await intern('/befund', token, { wache: 'mailserver', status: 'gruen', text_intern: 'ok' })).statusCode).toBe(201);
      const verbrauch = await intern('/verbrauch', token, {
        schluessel: 'n8n:1', zeitpunkt: '2026-10-02T08:00:00Z', quelle: 'n8n', modell: 'claude-haiku-4-5', agent: KENNUNG,
        tokens_eingabe: 10, tokens_ausgabe: 5, tokens_cache_schreiben_5m: 0, tokens_cache_schreiben_1h: 0, tokens_cache_lesen: 100,
      });
      expect(verbrauch.statusCode).toBe(200);

      expect((await pool.query(`SELECT absender_agent FROM cockpit.nachricht WHERE antwort_auf = $1`, [frage.id])).rows[0]).toEqual({ absender_agent: 'koordinator' });
      expect((await pool.query(`SELECT agent FROM cockpit.wache WHERE kennung = 'mailserver'`)).rows[0]).toEqual({ agent: KENNUNG });
      expect((await pool.query(`SELECT agent FROM cockpit.verbrauch WHERE schluessel = 'n8n:1'`)).rows[0]).toEqual({ agent: KENNUNG });
      expect((await intern('/befund', token, { wache: 'x', status: 'gelb', text_intern: 'x', takt_sekunden: 60, agent: 'Ungültig!' })).statusCode).toBe(400);
    });
  });

  describe('die Seite', () => {
    const pfad = (bereich?: Parameters<typeof agentPfad>[1]) => agentPfad(KENNUNG, bereich);

    it('ist über den Schlüssel erreichbar; Kennung, unbekannter Schlüssel und falsche Form sind die neutrale 404', async () => {
      expect((await seite(pfad())).status).toBe(200);
      expect((await seite(`/agenten/${KENNUNG}`)).status).toBe(404);
      expect((await seite(`/agenten/${agentSchluessel('gibt-es-nicht')}`)).status).toBe(404);
      expect((await seite('/agenten/ZZZ')).status).toBe(404);
    });

    it('bleibt für einen entfernten Agenten erreichbar (nie löschen)', async () => {
      await inventarErsetzen(pool, [{ kennung: 'koordinator', rolle: 'Koordinator', version: '1', grenzen: {}, zeitplan: [] }], JETZT);
      const { status, html } = await seite(pfad());
      expect(status).toBe(200);
      expect(html).toContain('Nicht mehr gemeldet seit');
    });

    it('zeigt dem Betreuer Kennung, Version, Gespräche zwischen Agenten und Verbrauch', async () => {
      const kanal = await agentenKanal(pool, 'koordinator', KENNUNG);
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', absenderAgent: 'koordinator', inhalt: 'Prüf bitte <b>das Radar</b>.' });

      const steckbrief = await seite(pfad());
      expect(steckbrief.html).toContain(KENNUNG);
      expect(steckbrief.html).toContain(VERSION);
      expect(steckbrief.html).toContain('>Verbrauch<');

      const chats = await seite(pfad('chats'));
      expect(chats.html).toContain(`${KENNUNG} ↔ koordinator`);
      expect(chats.html).toContain('Prüf bitte &lt;b&gt;das Radar&lt;/b&gt;.');
      expect(chats.html).toContain('nur lesen · Agenten unter sich');

      expect((await seite(pfad('verbrauch'))).html).toContain('Noch kein Verbrauch zugeordnet');
    });

    it.each<Rolle>(['betriebs_admin', 'betrieb_mitarbeiter'])('zeigt der Kundensicht (%s) weder Kennung noch Version, keine Gespräche zwischen Agenten und keinen Verbrauch', async (rolle) => {
      const kanal = await agentenKanal(pool, 'koordinator', KENNUNG);
      await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', absenderAgent: 'koordinator', inhalt: 'INTERNES-GESPRAECH' });

      for (const bereich of [undefined, 'chats', 'mails', 'protokoll', 'verbrauch'] as const) {
        const { status, html } = await seite(pfad(bereich), rolle, rolle === 'betriebs_admin' ? 'konto-carla' : 'konto-anna');
        expect(status, String(bereich)).toBe(200);
        expect(html, String(bereich)).not.toContain(KENNUNG);
        expect(html, String(bereich)).not.toContain(VERSION);
        expect(html, String(bereich)).not.toContain('INTERNES-GESPRAECH');
        expect(html, String(bereich)).not.toContain('>Verbrauch<');
      }
    });

    it('zeigt im Bereich Chats nur den eigenen Assistenten-Kanal, nie den eines anderen Kontos', async () => {
      const eigen = await assistentKanal(pool, 'konto-stefan');
      const fremd = await assistentKanal(pool, 'konto-carla');
      const frageEigen = await nachrichtAnlegen(pool, { kanalId: eigen.id, absenderArt: 'mensch', absenderId: 'konto-stefan', inhalt: 'Frage' });
      const frageFremd = await nachrichtAnlegen(pool, { kanalId: fremd.id, absenderArt: 'mensch', absenderId: 'konto-carla', inhalt: 'Frage' });
      await nachrichtAnlegen(pool, { kanalId: eigen.id, absenderArt: 'agent', absenderAgent: KENNUNG, antwortAuf: frageEigen.id, inhalt: 'ANTWORT-AN-STEFAN' });
      await nachrichtAnlegen(pool, { kanalId: fremd.id, absenderArt: 'agent', absenderAgent: KENNUNG, antwortAuf: frageFremd.id, inhalt: 'ANTWORT-AN-CARLA' });

      const stefan = await seite(pfad('chats'));
      expect(stefan.html).toContain('ANTWORT-AN-STEFAN');
      expect(stefan.html).not.toContain('ANTWORT-AN-CARLA');
      // Auch über die Adresse nicht: ein fremder Kanal fällt auf das erste eigene Gespräch zurück.
      const versuch = await seite(`${pfad('chats')}&kanal=${String(fremd.id)}`);
      expect(versuch.html).not.toContain('ANTWORT-AN-CARLA');
    });

    it('zeigt die Mails seines Moduls und im Protokoll Mails, Übernahmen und Befunde seiner Wachen', async () => {
      await pool.query(`INSERT INTO cockpit.agent_test_quelle (id, titel, status, zusammenfassung, eingang) VALUES ('m1', 'Anfrage <i>Relaunch</i>', 'gelb', 'Bitte um Rückruf', $1)`, [
        new Date(JETZT.getTime() - 3600_000),
      ]);
      await pool.query(`INSERT INTO cockpit.vorgang_sperre (modul_kennung, vorgang_id, uebernommen_von, uebernommen_am) VALUES ('agent-postfach', 'm1', 'konto-carla', $1)`, [
        new Date(JETZT.getTime() - 1800_000),
      ]);
      await befundMelden(pool, { wache: 'mailserver', status: 'rot', textIntern: 'ROH-IMAP', textKunde: 'Mails kommen verzögert.', kundensichtbar: true, anzeigename: 'Mailserver', taktSekunden: 900, agent: KENNUNG, quelle: 'test', jetzt: new Date(JETZT.getTime() - 600_000) });
      await befundMelden(pool, { wache: 'fremd', status: 'rot', textIntern: 'FREMDE-WACHE', kundensichtbar: false, taktSekunden: 900, quelle: 'test', jetzt: new Date(JETZT.getTime() - 600_000) });

      const mails = await seite(pfad('mails'));
      expect(mails.html).toContain('Anfrage &lt;i&gt;Relaunch&lt;/i&gt;');
      expect(mails.html).toContain('href="/module/agent-postfach/m1?von=nachrichten"');

      const betreuer = await seite(pfad('protokoll'));
      expect(betreuer.html).toContain('Mail eingegangen');
      expect(betreuer.html).toContain('konto-carla hat „Anfrage &lt;i&gt;Relaunch&lt;/i&gt;');
      expect(betreuer.html).toContain('ROH-IMAP');
      expect(betreuer.html).not.toContain('FREMDE-WACHE');

      const kunde = await seite(pfad('protokoll'), 'betriebs_admin', 'konto-carla');
      expect(kunde.html).toContain('Mails kommen verzögert.');
      expect(kunde.html).not.toContain('ROH-IMAP');

      const gefiltert = await seite(`${pfad('protokoll')}&art=befund`);
      expect(gefiltert.html).not.toContain('Mail eingegangen');
      expect(gefiltert.html).toContain('ROH-IMAP');
    });

    it('zeigt einer Rolle ohne Zugriff auf das Modul dessen Mails nicht', async () => {
      await pool.query(`INSERT INTO cockpit.agent_test_quelle (id, titel, status, zusammenfassung, eingang) VALUES ('m1', 'GEHEIME-ANFRAGE', 'gelb', 'x', $1)`, [JETZT]);
      const anna = await seite(pfad('mails'), 'betrieb_mitarbeiter', 'konto-anna');
      expect(anna.html).not.toContain('GEHEIME-ANFRAGE');
      expect(anna.html).toContain('Kein Postfach');
      expect((await seite(pfad(), 'betrieb_mitarbeiter', 'konto-anna')).html).not.toContain('GEHEIME-ANFRAGE');
    });

    it('verlinkt jede Karte der Seite Agenten über den Schlüssel', async () => {
      const { html } = await seite('/agenten', 'betriebs_admin', 'konto-carla');
      expect(html).toContain(`href="${pfad()}"`);
      expect(html).not.toContain(KENNUNG);
    });
  });
});
