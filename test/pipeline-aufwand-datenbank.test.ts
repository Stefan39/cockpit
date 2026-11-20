/**
 * Aufwand, Merkmale und Kalkulation je Ticket (COPI-254) gegen eine echte PostgreSQL: Constraints der Migration 0060,
 * `POST /intern/pipeline/aufwand`, `POST /intern/pipeline/merkmal` und `ticketKalkulation`.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import type { ApiScope } from '../src/intern/token.js';
import { freigabeErledigen } from '../src/pipeline/freigaben.js';
import { ticketKalkulation } from '../src/pipeline/kalkulation.js';
import { jobAnlegen, type JobArt } from '../src/pipeline/queue.js';
import { repoConfigPruefen, repoConfigSpeichern } from '../src/pipeline/repo-config.js';
import { buildApp } from '../src/server/app.js';
import { wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const REPO = 'Stefan39/cockpit';
const JETZT = new Date('2026-11-18T12:00:00Z');
const PAUSCHALEN = { freigabeMin: 5, eskalationMin: 15 };
const AUFWAND = '/intern/pipeline/aufwand';
const MERKMAL = '/intern/pipeline/merkmal';

function eintrag(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ticket_key: 'COPI-1', quelle: 'zeiterfassung', extern_id: 'z-1', tag: '2026-11-17', minuten: 60, ...extra };
}

describe.skipIf(!testDatenbankUrl)('Aufwand, Merkmale und Kalkulation je Ticket (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let koordinator: string;

  async function leeren(): Promise<void> {
    await pool.query(
      `TRUNCATE cockpit.pipeline_aufwand, cockpit.pipeline_ticket_merkmal, cockpit.pipeline_usage, cockpit.pipeline_job_event,
                cockpit.pipeline_job, cockpit.pipeline_provider_state, cockpit.pipeline_repo_config`,
    );
    await pool.query('DELETE FROM cockpit.api_token');
  }

  async function senden(url: string, rumpf: unknown, mit: string = koordinator) {
    const antwort = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${mit}` }, payload: rumpf as object });
    return { status: antwort.statusCode, json: antwort.json() as Record<string, unknown>, body: antwort.body };
  }

  async function job(ticketKey: string, kind: JobArt, payload?: Record<string, unknown>): Promise<string> {
    const angelegt = await jobAnlegen(pool, { ticketKey, repo: REPO, kind, payload }, JETZT);
    if (angelegt.art === 'repo_unbekannt') {
      throw new Error('Repo fehlt');
    }
    return angelegt.job.id;
  }

  async function ereignis(jobId: string, type: string, data: Record<string, unknown>): Promise<void> {
    await pool.query('INSERT INTO cockpit.pipeline_job_event (job_id, type, data) VALUES ($1, $2, $3)', [jobId, type, data]);
  }

  async function parken(jobId: string): Promise<void> {
    await pool.query(`UPDATE cockpit.pipeline_job SET status = 'parked' WHERE id = $1`, [jobId]);
    await ereignis(jobId, 'status', { von: 'leased', nach: 'parked', grund: 'lease_abgelaufen' });
  }

  async function nutzung(jobId: string, ticketKey: string, billing: 'abo' | 'api', notional: number | null, real: number | null): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit.pipeline_usage (job_id, ticket_key, tool, billing, cost_eur_notional, cost_eur_real) VALUES ($1, $2, 'claude-code', $3, $4, $5)`,
      [jobId, ticketKey, billing, notional, real],
    );
  }

  async function zeile(ticketKey: string) {
    const alle = await ticketKalkulation(pool, PAUSCHALEN);
    const treffer = alle.find((k) => k.ticketKey === ticketKey);
    if (treffer === undefined) {
      throw new Error(`Ticket ${ticketKey} fehlt`);
    }
    return treffer;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testDatenbankUrl });
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT });
    await app.ready();
  });

  beforeEach(async () => {
    await leeren();
    const config = repoConfigPruefen(`repo: ${REPO}\nquelle: jira\njira_project: COPI\n`);
    if (!config.ok) {
      throw new Error(config.grund);
    }
    await repoConfigSpeichern(pool, config.wert, JETZT);
    const scopes: ApiScope[] = ['pipeline_verwalten'];
    koordinator = (await apiTokenAnlegen(pool, { name: 'koordinator-pipeline', scopes })).token;
  });

  afterAll(async () => {
    await app.close();
    await leeren();
    await pool.end();
  });

  describe('Constraints der Migration 0060', () => {
    const einfuegen = (spalten: string, werte: unknown[]) =>
      pool.query(`INSERT INTO cockpit.pipeline_aufwand (ticket_key, quelle, extern_id, tag, minuten${spalten}) VALUES ($1, $2, $3, $4, $5${werte.map((_, i) => `, $${String(i + 6)}`).join('')})`, [
        'COPI-1', 'manuell', 'm-1', '2026-11-17', 10, ...werte,
      ]);

    it.each([
      ['unbekannte Quelle', `INSERT INTO cockpit.pipeline_aufwand (ticket_key, quelle, extern_id, tag, minuten) VALUES ('T', 'kalender', 'x', '2026-11-17', 1)`],
      ['negative Minuten', `INSERT INTO cockpit.pipeline_aufwand (ticket_key, quelle, extern_id, tag, minuten) VALUES ('T', 'manuell', 'x', '2026-11-17', -1)`],
      ['mehr als ein Tag', `INSERT INTO cockpit.pipeline_aufwand (ticket_key, quelle, extern_id, tag, minuten) VALUES ('T', 'manuell', 'x', '2026-11-17', 1441)`],
      ['leere extern_id', `INSERT INTO cockpit.pipeline_aufwand (ticket_key, quelle, extern_id, tag, minuten) VALUES ('T', 'manuell', '', '2026-11-17', 1)`],
      ['unbekannter Aufgabentyp', `INSERT INTO cockpit.pipeline_ticket_merkmal (ticket_key, aufgabentyp) VALUES ('T', 'urlaub')`],
      ['Stack mit Großbuchstaben', `INSERT INTO cockpit.pipeline_ticket_merkmal (ticket_key, stack) VALUES ('T', ARRAY['PHP'])`],
      ['Stack mit leerer Marke', `INSERT INTO cockpit.pipeline_ticket_merkmal (ticket_key, stack) VALUES ('T', ARRAY[''])`],
      ['Stack mit mehr als 10 Marken', `INSERT INTO cockpit.pipeline_ticket_merkmal (ticket_key, stack) VALUES ('T', ARRAY['a','b','c','d','e','f','g','h','i','j','k'])`],
      ['negative Zeilen', `INSERT INTO cockpit.pipeline_ticket_merkmal (ticket_key, geaenderte_zeilen) VALUES ('T', -1)`],
    ])('weist ab: %s', async (_name, sql) => {
      await expect(pool.query(sql)).rejects.toThrow();
    });

    it('nimmt gültige Stack-Marken an (c#, node.js, c++)', async () => {
      await pool.query(`INSERT INTO cockpit.pipeline_ticket_merkmal (ticket_key, stack) VALUES ('T', ARRAY['c#','node.js','c++'])`);
    });

    it('verlangt (quelle, extern_id) eindeutig', async () => {
      await einfuegen('', []);
      await expect(einfuegen('', [])).rejects.toThrow(/pipeline_aufwand_quelle_extern/);
    });

    it('weist DELETE an beiden Tabellen ab', async () => {
      await einfuegen('', []);
      await pool.query(`INSERT INTO cockpit.pipeline_ticket_merkmal (ticket_key) VALUES ('COPI-1')`);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.pipeline_aufwand')).rejects.toThrow(/nie_loeschen/);
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.pipeline_ticket_merkmal')).rejects.toThrow(/nie_loeschen/);
    });
  });

  describe('POST /intern/pipeline/aufwand', () => {
    it('speichert einen Eintrag und zählt ihn als angelegt', async () => {
      const antwort = await senden(AUFWAND, eintrag());

      expect(antwort).toMatchObject({ status: 200, json: { angelegt: 1, geaendert: 0, unveraendert: 0 } });
      expect((await zeile('COPI-1')).minutenErfasst).toBe(60);
    });

    it('nimmt einen Sammelrumpf an', async () => {
      const antwort = await senden(AUFWAND, { eintraege: [eintrag(), eintrag({ extern_id: 'z-2', minuten: 30 }), eintrag({ ticket_key: 'COPI-2', extern_id: 'z-3', minuten: 5 })] });

      expect(antwort.json).toEqual({ angelegt: 3, geaendert: 0, unveraendert: 0 });
      expect((await zeile('COPI-1')).minutenErfasst).toBe(90);
      expect((await zeile('COPI-2')).minutenErfasst).toBe(5);
    });

    it('überschreibt bei erneuter Meldung (Upsert) und zählt geändert und unverändert', async () => {
      await senden(AUFWAND, { eintraege: [eintrag(), eintrag({ extern_id: 'z-2', minuten: 30 })] });

      const antwort = await senden(AUFWAND, { eintraege: [eintrag({ minuten: 90, ticket_key: 'COPI-9' }), eintrag({ extern_id: 'z-2', minuten: 30 }), eintrag({ extern_id: 'z-3' })] });

      expect(antwort.json).toEqual({ angelegt: 1, geaendert: 1, unveraendert: 1 });
      expect((await zeile('COPI-9')).minutenErfasst).toBe(90);
      expect((await zeile('COPI-1')).minutenErfasst).toBe(30 + 60);
    });

    it('nimmt einen Eintrag mit minuten 0 aus der Summe, die Zeile bleibt', async () => {
      await senden(AUFWAND, eintrag());
      await senden(AUFWAND, eintrag({ minuten: 0 }));

      expect((await zeile('COPI-1')).minutenErfasst).toBe(0);
      expect((await pool.query('SELECT 1 FROM cockpit.pipeline_aufwand')).rowCount).toBe(1);
    });

    it('trennt gleiche extern_id verschiedener Quellen', async () => {
      const antwort = await senden(AUFWAND, { eintraege: [eintrag(), eintrag({ quelle: 'manuell' })] });

      expect(antwort.json).toEqual({ angelegt: 2, geaendert: 0, unveraendert: 0 });
    });

    it('weist eine doppelte (quelle, extern_id) in einer Meldung ab und schreibt nichts', async () => {
      const antwort = await senden(AUFWAND, { eintraege: [eintrag({ extern_id: 'neu' }), eintrag(), eintrag({ minuten: 5 })] });

      expect(antwort.status).toBe(400);
      expect(antwort.json).toMatchObject({ fehler: 'ungueltige_anfrage', felder: ['eintraege'] });
      expect((await pool.query('SELECT 1 FROM cockpit.pipeline_aufwand')).rowCount).toBe(0);
    });

    it('schreibt bei einem ungültigen Eintrag nichts und nennt nur Feldnamen', async () => {
      const antwort = await senden(AUFWAND, { eintraege: [eintrag(), eintrag({ extern_id: 'z-2', minuten: 1441, ticket_key: 'GEHEIM-1' })] });

      expect(antwort.status).toBe(400);
      expect(antwort.json.felder).toEqual(['eintraege.1.minuten']);
      expect(antwort.body).not.toContain('GEHEIM-1');
      expect((await pool.query('SELECT 1 FROM cockpit.pipeline_aufwand')).rowCount).toBe(0);
    });

    it.each([
      ['unbekanntes Feld', { zusatz: 1 }],
      ['unbekannte Quelle', { quelle: 'kalender' }],
      ['kein Kalendertag', { tag: '2026-02-30' }],
      ['gebrochene Minuten', { minuten: 1.5 }],
    ])('weist ab: %s', async (_name, extra) => {
      expect((await senden(AUFWAND, eintrag(extra))).status).toBe(400);
    });

    it('lässt den morgigen Tag zu, weist den übermorgigen ab', async () => {
      expect((await senden(AUFWAND, eintrag({ tag: '2026-11-19' }))).status).toBe(200);

      const zukunft = await senden(AUFWAND, { eintraege: [eintrag({ extern_id: 'z-2', tag: '2026-11-20' })] });
      expect(zukunft.status).toBe(400);
      expect(zukunft.json.felder).toEqual(['eintraege.0.tag']);
      expect((await senden(AUFWAND, eintrag({ extern_id: 'z-3', tag: '2026-11-20' }))).json.felder).toEqual(['tag']);
    });

    it('weist 201 Einträge und eine leere Liste ab', async () => {
      const viele = Array.from({ length: 201 }, (_, i) => eintrag({ extern_id: `z-${String(i)}` }));

      expect((await senden(AUFWAND, { eintraege: viele })).status).toBe(400);
      expect((await senden(AUFWAND, { eintraege: [] })).status).toBe(400);
    });

    it('verlangt das Recht pipeline_verwalten', async () => {
      const fremd = (await apiTokenAnlegen(pool, { name: 'nur-verbrauch', scopes: ['verbrauch_schreiben'] })).token;

      expect((await senden(AUFWAND, eintrag(), fremd)).status).toBe(403);
      expect((await senden(MERKMAL, { ticket_key: 'COPI-1', stack: ['php'] }, fremd)).status).toBe(403);
    });
  });

  describe('POST /intern/pipeline/merkmal', () => {
    it('legt die Merkmale an und gibt den Stand zurück', async () => {
      const antwort = await senden(MERKMAL, { ticket_key: 'COPI-1', aufgabentyp: 'bugfix', stack: ['php', 'c#'], geaenderte_zeilen: 42 });

      expect(antwort).toMatchObject({ status: 200, json: { ticket_key: 'COPI-1', aufgabentyp: 'bugfix', stack: ['php', 'c#'], geaenderte_zeilen: 42 } });
    });

    it('lässt bei einer Teilmeldung die übrigen Felder stehen', async () => {
      await senden(MERKMAL, { ticket_key: 'COPI-1', aufgabentyp: 'feature', stack: ['php'], geaenderte_zeilen: 10 });

      const antwort = await senden(MERKMAL, { ticket_key: 'COPI-1', geaenderte_zeilen: 99 });

      expect(antwort.json).toEqual({ ticket_key: 'COPI-1', aufgabentyp: 'feature', stack: ['php'], geaenderte_zeilen: 99 });
    });

    it('leert den Typ mit null und ersetzt den Stack, auch mit einer leeren Liste', async () => {
      await senden(MERKMAL, { ticket_key: 'COPI-1', aufgabentyp: 'feature', stack: ['php'] });

      expect((await senden(MERKMAL, { ticket_key: 'COPI-1', aufgabentyp: null })).json).toMatchObject({ aufgabentyp: null, stack: ['php'] });
      expect((await senden(MERKMAL, { ticket_key: 'COPI-1', stack: [] })).json).toMatchObject({ stack: [] });
    });

    it('legt mit einem Teil ein Ticket an: der Rest ist leer', async () => {
      const antwort = await senden(MERKMAL, { ticket_key: 'COPI-7', aufgabentyp: 'doku' });

      expect(antwort.json).toEqual({ ticket_key: 'COPI-7', aufgabentyp: 'doku', stack: [], geaenderte_zeilen: null });
    });

    it.each([
      ['nur ticket_key', { ticket_key: 'COPI-1' }],
      ['unbekannter Typ', { ticket_key: 'COPI-1', aufgabentyp: 'urlaub' }],
      ['Stack-Marke in Großbuchstaben', { ticket_key: 'COPI-1', stack: ['PHP'] }],
      ['11 Marken', { ticket_key: 'COPI-1', stack: Array.from({ length: 11 }, (_, i) => `s${String(i)}`) }],
      ['negative Zeilen', { ticket_key: 'COPI-1', geaenderte_zeilen: -1 }],
      ['unbekanntes Feld', { ticket_key: 'COPI-1', stack: ['php'], extra: 1 }],
    ])('weist ab: %s', async (_name, rumpf) => {
      expect((await senden(MERKMAL, rumpf)).status).toBe(400);
    });

    it('zeigt die Merkmale in der Kalkulation, auch ohne Job und Aufwand', async () => {
      await senden(MERKMAL, { ticket_key: 'COPI-1', aufgabentyp: 'skript', stack: ['bash'], geaenderte_zeilen: 5 });

      expect(await zeile('COPI-1')).toMatchObject({ aufgabentyp: 'skript', stack: ['bash'], geaenderteZeilen: 5, minutenErfasst: 0, ergebnis: 'offen' });
    });
  });

  describe('ticketKalkulation', () => {
    it('ist ohne Daten leer', async () => {
      expect(await ticketKalkulation(pool, PAUSCHALEN)).toEqual([]);
    });

    it('führt ein Ticket nur mit Aufwand, ohne Job, mit Nullen und ohne Kosten', async () => {
      await senden(AUFWAND, eintrag({ minuten: 45 }));

      expect(await zeile('COPI-1')).toEqual({
        ticketKey: 'COPI-1',
        aufgabentyp: null,
        stack: [],
        geaenderteZeilen: null,
        minutenErfasst: 45,
        freigaben: 0,
        eskalationen: 0,
        minutenPauschale: 0,
        minutenGesamt: 45,
        reviewRunden: 0,
        nacharbeitRunden: 0,
        konfliktRunden: 0,
        ergebnis: 'offen',
        costEurNotional: null,
        costEurReal: null,
      });
    });

    it('zählt Freigaben, Eskalationen, Reviews und Nacharbeit; Pauschale und Gesamt rechnen mit den übergebenen Werten', async () => {
      const umsetzung = await job('COPI-1', 'implement');
      await job('COPI-1', 'review:codex');
      await job('COPI-1', 'review:gemini');
      await job('COPI-1', 'rework');
      await ereignis(umsetzung, 'merge.approval_requested', { pr: 1 });
      await ereignis(umsetzung, 'merge.approval_requested', { pr: 1 });
      await ereignis(umsetzung, 'status', { von: 'leased', nach: 'queued', grund: 'lease_abgelaufen' });
      await ereignis(umsetzung, 'status', { von: 'leased', nach: 'parked', grund: 'lease_abgelaufen' });
      await senden(AUFWAND, eintrag({ minuten: 100 }));

      const kalkulation = await ticketKalkulation(pool, { freigabeMin: 7, eskalationMin: 20 });

      expect(kalkulation[0]).toMatchObject({
        freigaben: 2,
        eskalationen: 1,
        minutenErfasst: 100,
        minutenPauschale: 2 * 7 + 20,
        minutenGesamt: 100 + 34,
        reviewRunden: 2,
        nacharbeitRunden: 1,
        konfliktRunden: 0,
      });
    });

    it('nimmt als Review-Runden die höchste Runde aus den Review-Ereignissen aller Jobs des Tickets', async () => {
      const umsetzung = await job('COPI-1', 'implement');
      await pool.query(`UPDATE cockpit.pipeline_job SET status = 'done' WHERE id = $1`, [umsetzung]);
      const nacharbeit = await job('COPI-1', 'rework');
      await ereignis(umsetzung, 'review.round_done', { reviewer: 'codex', round: 1, pr: 4 });
      await ereignis(umsetzung, 'review.round_done', { reviewer: 'codex', round: 2, pr: 4 });
      await ereignis(nacharbeit, 'review.clean', { reviewer: 'codex', round: 3, pr: 4 });
      await ereignis(nacharbeit, 'review.round_done', { reviewer: 'codex', round: 'viele', pr: 4 });
      const anderes = await job('COPI-2', 'implement');
      await ereignis(anderes, 'review.clean', { reviewer: 'codex', round: 9, pr: 5 });

      expect(await zeile('COPI-1')).toMatchObject({ reviewRunden: 3, nacharbeitRunden: 1 });
    });

    it('zählt einen Rework zum Abgleich mit der Basis als Konflikt, nicht als Nacharbeit', async () => {
      await job('COPI-1', 'implement');
      for (const payload of [{ basis_abgleich: true, basis_sha: 'abc' }, { basis_abgleich: false }, { basis_abgleich: 'true' }]) {
        const id = await job('COPI-1', 'rework', payload);
        await pool.query(`UPDATE cockpit.pipeline_job SET status = 'done' WHERE id = $1`, [id]);
      }

      expect(await zeile('COPI-1')).toMatchObject({ nacharbeitRunden: 2, konfliktRunden: 1 });
    });

    it('wertet nur die Ereignisse des eigenen Tickets', async () => {
      const eins = await job('COPI-1', 'implement');
      await job('COPI-2', 'implement');
      await ereignis(eins, 'merge.approval_requested', { pr: 1 });

      expect((await zeile('COPI-1')).freigaben).toBe(1);
      expect((await zeile('COPI-2')).freigaben).toBe(0);
    });

    describe('Ergebnis', () => {
      it('ist offen ohne Abschluss', async () => {
        await job('COPI-1', 'implement');

        expect((await zeile('COPI-1')).ergebnis).toBe('offen');
      });

      it('ist eskaliert, solange ein Job geparkt ist', async () => {
        await parken(await job('COPI-1', 'implement'));

        expect(await zeile('COPI-1')).toMatchObject({ ergebnis: 'eskaliert', eskalationen: 1, minutenPauschale: 15 });
      });

      it('bleibt eskaliert-frei, wenn der Job nach dem Parken wieder läuft, zählt die Eskalation aber weiter', async () => {
        const id = await job('COPI-1', 'implement');
        await parken(id);
        await pool.query(`UPDATE cockpit.pipeline_job SET status = 'queued' WHERE id = $1`, [id]);

        expect(await zeile('COPI-1')).toMatchObject({ ergebnis: 'offen', eskalationen: 1 });
      });

      it('ist gemergt mit merge.erledigt/gemergt, auch wenn ein Job geparkt ist', async () => {
        const id = await job('COPI-1', 'implement');
        await ereignis(id, 'merge.approval_requested', { pr: 1 });
        await parken(await job('COPI-1', 'rework'));
        expect(await freigabeErledigen(pool, { jobId: id, grund: 'gemergt', jetzt: JETZT })).toBe('erledigt');

        expect(await zeile('COPI-1')).toMatchObject({ ergebnis: 'gemergt', freigaben: 1 });
      });

      it('ist abgebrochen mit merge.erledigt/geschlossen, auch wenn ein Job geparkt ist', async () => {
        const id = await job('COPI-1', 'implement');
        await ereignis(id, 'merge.approval_requested', { pr: 1 });
        await parken(await job('COPI-1', 'rework'));
        await freigabeErledigen(pool, { jobId: id, grund: 'geschlossen', jetzt: JETZT });

        expect((await zeile('COPI-1')).ergebnis).toBe('abgebrochen');
      });

      it('gibt gemergt Vorrang vor abgebrochen (Anfrage geschlossen, später ein neuer PR gemergt)', async () => {
        const id = await job('COPI-1', 'implement');
        await ereignis(id, 'merge.approval_requested', { pr: 1 });
        await freigabeErledigen(pool, { jobId: id, grund: 'geschlossen', jetzt: JETZT });
        await ereignis(id, 'merge.approval_requested', { pr: 2 });
        await freigabeErledigen(pool, { jobId: id, grund: 'gemergt', jetzt: JETZT });

        expect((await zeile('COPI-1')).ergebnis).toBe('gemergt');
      });
    });

    describe('KI-Kosten', () => {
      it('summiert rechnerische Kosten über alle Läufe, reale nur bei billing api', async () => {
        const id = await job('COPI-1', 'implement');
        await nutzung(id, 'COPI-1', 'abo', 1.5, 1.5);
        await nutzung(id, 'COPI-1', 'api', 0.25, 0.1);
        await nutzung(id, 'COPI-1', 'api', 0.25, 0.2);

        expect(await zeile('COPI-1')).toMatchObject({ costEurNotional: 2, costEurReal: expect.closeTo(0.3, 6) as number });
      });

      it('lässt reale Kosten null, wenn nur Abo-Läufe vorliegen, und beides null ohne Werte', async () => {
        const id = await job('COPI-1', 'implement');
        await nutzung(id, 'COPI-1', 'abo', 1, 1);
        const ohne = await job('COPI-2', 'implement');
        await nutzung(ohne, 'COPI-2', 'abo', null, null);

        expect(await zeile('COPI-1')).toMatchObject({ costEurNotional: 1, costEurReal: null });
        expect(await zeile('COPI-2')).toMatchObject({ costEurNotional: null, costEurReal: null });
      });
    });

    it('sortiert nach ticket_key und vereinigt die drei Quellen', async () => {
      await job('COPI-3', 'implement');
      await senden(AUFWAND, eintrag({ ticket_key: 'COPI-10' }));
      await senden(MERKMAL, { ticket_key: 'COPI-2', stack: ['php'] });

      expect((await ticketKalkulation(pool, PAUSCHALEN)).map((k) => k.ticketKey)).toEqual(['COPI-10', 'COPI-2', 'COPI-3']);
    });
  });
});
