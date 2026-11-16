/**
 * Die Übernahme-Sperre (COPI-85) gegen eine echte PostgreSQL: die Regeln der Tabelle (Migration 0030) und der Speicher
 * (`src/module/vorgang-sperre.ts`) — übernehmen, zurückgeben, gleichzeitige Übernahmen, Rückgaberechte, Protokoll.
 *
 * Sicherheitskritisch (Architektur-Leitplanken, Quality Gate 3): Die Sperre ist die Zusage an einen Menschen, dass kein Agent ihm in
 * einem Vorgang dazwischenantwortet. Deshalb steht jede Regel hier einzeln, auch die der Datenbank selbst.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EHEMALIGES_KONTO,
  aktiveSperren,
  darfZurueckgeben,
  sperreLesen,
  sperrMarke,
  uebernehmen,
  zurueckgeben,
  type Handelnder,
} from '../src/module/vorgang-sperre.js';
import { kontenLoeschen, protokollMarke, protokollSeit, sperrenLeeren, wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const ANNA: Handelnder = { id: 'konto-anna', rolle: 'betrieb_mitarbeiter' };
const BERT: Handelnder = { id: 'konto-bert', rolle: 'betrieb_mitarbeiter' };
const CARLA: Handelnder = { id: 'konto-carla', rolle: 'betriebs_admin' };
const STEFAN: Handelnder = { id: 'konto-stefan', rolle: 'betreuer' };

const VORGANG = { modul: 'anfragen', vorgangId: 'anfrage-1' };

async function konto(pool: pg.Pool, id: string, name: string, rolle: string): Promise<void> {
  await pool.query(`INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, $2, $3, true, $4)`, [
    id,
    name,
    `${id}@example.org`,
    rolle,
  ]);
}

describe.skipIf(!datenbankUrl)('Übernahme-Sperre (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    // Mehr Verbindungen als gleichzeitige Übernahmen im Parallel-Test, sonst stünden sie am Pool Schlange statt an der Datenbank.
    pool = new pg.Pool({ connectionString: datenbankUrl, max: 12 });
  });

  beforeEach(async () => {
    await sperrenLeeren(pool);
    await kontenLoeschen(pool);
    await konto(pool, ANNA.id, 'Anna Albers', 'betrieb_mitarbeiter');
    await konto(pool, BERT.id, 'Bert', 'betrieb_mitarbeiter');
    await konto(pool, CARLA.id, 'Carla Conrad', 'betriebs_admin');
    await konto(pool, STEFAN.id, 'Stefan Jacomeit', 'betreuer');
  });

  afterAll(async () => {
    await sperrenLeeren(pool);
    await kontenLoeschen(pool);
    await pool.end();
  });

  async function einfuegen(werte: { modul?: string; vorgang?: string; von?: string }): Promise<number> {
    const ergebnis = await pool.query<{ id: number }>(
      `INSERT INTO cockpit.vorgang_sperre (modul_kennung, vorgang_id, uebernommen_von) VALUES ($1, $2, $3) RETURNING id::int AS id`,
      [werte.modul ?? 'anfragen', werte.vorgang ?? 'anfrage-1', werte.von ?? ANNA.id],
    );
    return ergebnis.rows[0]?.id ?? 0;
  }

  describe('die Tabelle (Migration 0030)', () => {
    it('lässt je Vorgang höchstens eine aktive Sperre zu', async () => {
      await einfuegen({});
      await expect(einfuegen({ von: BERT.id })).rejects.toMatchObject({ code: '23505', constraint: 'vorgang_sperre_eine_aktive' });
    });

    it('lässt nach der Rückgabe eine neue Sperre zu, und derselbe Vorgang in einem anderen Modul ist ein anderer', async () => {
      const erste = await einfuegen({});
      await pool.query(`UPDATE cockpit.vorgang_sperre SET zurueckgegeben_von = $2, zurueckgegeben_am = now() WHERE id = $1`, [erste, ANNA.id]);
      await expect(einfuegen({ von: BERT.id })).resolves.toBeGreaterThan(erste);
      await expect(einfuegen({ modul: 'buchungen' })).resolves.toBeGreaterThan(0);
    });

    it.each([
      ['eine ungültige Modul-Kennung', { modul: 'Anfragen_1' }, 'vorgang_sperre_modul_form'],
      ['eine leere Vorgangs-id', { vorgang: '' }, 'vorgang_sperre_vorgang_laenge'],
      ['eine Vorgangs-id über 200 Zeichen', { vorgang: 'x'.repeat(201) }, 'vorgang_sperre_vorgang_laenge'],
    ])('weist %s ab', async (_fall, werte, regel) => {
      await expect(einfuegen(werte)).rejects.toMatchObject({ code: '23514', constraint: regel });
    });

    it('verlangt ein bestehendes Konto (Fremdschlüssel)', async () => {
      await expect(einfuegen({ von: 'gibt-es-nicht' })).rejects.toMatchObject({ code: '23503' });
    });

    it('verlangt bei der Rückgabe wer und wann zusammen (CHECK)', async () => {
      const id = await einfuegen({});
      await expect(pool.query(`UPDATE cockpit.vorgang_sperre SET zurueckgegeben_am = now() WHERE id = $1`, [id])).rejects.toMatchObject({
        constraint: 'vorgang_sperre_rueckgabe_vollstaendig',
      });
      await expect(pool.query(`UPDATE cockpit.vorgang_sperre SET zurueckgegeben_von = $2 WHERE id = $1`, [id, ANNA.id])).rejects.toMatchObject({
        constraint: 'vorgang_sperre_rueckgabe_vollstaendig',
      });
    });

    it('weist eine Rückgabe vor der Übernahme ab (CHECK)', async () => {
      const id = await einfuegen({});
      await expect(
        pool.query(`UPDATE cockpit.vorgang_sperre SET zurueckgegeben_von = $2, zurueckgegeben_am = uebernommen_am - interval '1 second' WHERE id = $1`, [
          id,
          ANNA.id,
        ]),
      ).rejects.toMatchObject({ constraint: 'vorgang_sperre_rueckgabe_danach' });
    });

    it.each([
      ['das Modul', `modul_kennung = 'buchungen'`],
      ['den Vorgang', `vorgang_id = 'anfrage-2'`],
      ['wer übernommen hat', `uebernommen_von = 'konto-bert'`],
      ['wann übernommen wurde', `uebernommen_am = now() - interval '1 hour'`],
    ])('lässt %s nach der Anlage nicht mehr ändern', async (_feld, setzen) => {
      const id = await einfuegen({});
      await expect(pool.query(`UPDATE cockpit.vorgang_sperre SET ${setzen} WHERE id = $1`, [id])).rejects.toThrow(/vorgang_sperre_unveraenderlich/);
    });

    it('lässt eine Rückgabe genau einmal zu: danach bleibt sie, wie sie ist', async () => {
      const id = await einfuegen({});
      await pool.query(`UPDATE cockpit.vorgang_sperre SET zurueckgegeben_von = $2, zurueckgegeben_am = now() WHERE id = $1`, [id, ANNA.id]);
      await expect(
        pool.query(`UPDATE cockpit.vorgang_sperre SET zurueckgegeben_von = $2, zurueckgegeben_am = now() WHERE id = $1`, [id, CARLA.id]),
      ).rejects.toThrow(/vorgang_sperre_rueckgabe_endgueltig/);
      await expect(pool.query(`UPDATE cockpit.vorgang_sperre SET zurueckgegeben_von = NULL, zurueckgegeben_am = NULL WHERE id = $1`, [id])).rejects.toThrow(
        /vorgang_sperre_rueckgabe_endgueltig/,
      );
    });

    it('weist DELETE ab wie jede Nachweistabelle (nie löschen)', async () => {
      await einfuegen({});
      await expect(wieImBetrieb(pool, 'DELETE FROM cockpit.vorgang_sperre')).rejects.toThrow(/nie_loeschen/);
    });

    it('kennt das Recht vorgang_lesen für Zugänge der Agenten-API', async () => {
      const ergebnis = await pool.query<{ ok: boolean }>(
        `SELECT pg_get_constraintdef(oid) LIKE '%vorgang_lesen%' AS ok FROM pg_constraint WHERE conname = 'api_token_scopes_bekannt'`,
      );
      expect(ergebnis.rows[0]?.ok).toBe(true);
    });
  });

  describe('übernehmen', () => {
    it('legt eine Sperre an, liest sie mit Anzeigename zurück und protokolliert die Nummer', async () => {
      const marke = await protokollMarke(pool);

      const ergebnis = await uebernehmen(pool, VORGANG, ANNA);

      expect(ergebnis.ok).toBe(true);
      const sperre = await sperreLesen(pool, VORGANG);
      expect(sperre).toMatchObject({ vorgangId: 'anfrage-1', uebernommenVon: ANNA.id, anzeigename: 'Anna Albers' });
      expect(ergebnis.sperre).toEqual(sperre);
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'vorgang_uebernommen', akteur: ANNA.id, ziel: null, einzelheiten: { vorgang_sperre_id: sperre?.id } },
      ]);
    });

    it('meldet einen schon gesperrten Vorgang mit Name und Zeitpunkt und ändert nichts — auch für dieselbe Person', async () => {
      const erste = await uebernehmen(pool, VORGANG, ANNA);
      const marke = await protokollMarke(pool);

      const zweite = await uebernehmen(pool, VORGANG, BERT);
      const nochmal = await uebernehmen(pool, VORGANG, ANNA);

      expect(zweite).toEqual({ ok: false, grund: 'schon_gesperrt', sperre: erste.sperre });
      expect(nochmal).toEqual({ ok: false, grund: 'schon_gesperrt', sperre: erste.sperre });
      expect(await protokollSeit(pool, marke)).toEqual([]);
      expect((await pool.query('SELECT 1 FROM cockpit.vorgang_sperre')).rowCount).toBe(1);
    });

    it('lässt von zehn gleichzeitigen Übernahmen genau eine gewinnen', async () => {
      const handelnde = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? ANNA : BERT));
      const marke = await protokollMarke(pool);

      const ergebnisse = await Promise.all(handelnde.map((wer) => uebernehmen(pool, VORGANG, wer)));

      const gewonnen = ergebnisse.filter((ergebnis) => ergebnis.ok);
      expect(gewonnen).toHaveLength(1);
      const sieger = gewonnen[0]?.sperre;
      for (const ergebnis of ergebnisse.filter((e) => !e.ok)) {
        expect(ergebnis).toEqual({ ok: false, grund: 'schon_gesperrt', sperre: sieger });
      }
      expect((await pool.query('SELECT 1 FROM cockpit.vorgang_sperre')).rowCount).toBe(1);
      expect((await protokollSeit(pool, marke)).map((eintrag) => eintrag.art)).toEqual(['vorgang_uebernommen']);
    });

    it('schreibt nichts, wenn der Protokolleintrag scheitert (eine Transaktion)', async () => {
      await pool.query(`
        CREATE FUNCTION cockpit.test_sperre_protokoll_scheitert() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'test_sperre_protokoll_scheitert'; END $$`);
      await pool.query(`
        CREATE TRIGGER test_sperre_protokoll_scheitert BEFORE INSERT ON cockpit.protokoll
        FOR EACH ROW WHEN (NEW.art = 'vorgang_uebernommen') EXECUTE FUNCTION cockpit.test_sperre_protokoll_scheitert()`);
      try {
        await expect(uebernehmen(pool, VORGANG, ANNA)).rejects.toThrow(/test_sperre_protokoll_scheitert/);
        expect(await sperreLesen(pool, VORGANG)).toBeUndefined();
      } finally {
        await pool.query('DROP TRIGGER test_sperre_protokoll_scheitert ON cockpit.protokoll');
        await pool.query('DROP FUNCTION cockpit.test_sperre_protokoll_scheitert()');
      }
    });

    it('legt nach der Rückgabe bei erneuter Übernahme eine neue Zeile an; die alte bleibt als Nachweis', async () => {
      const erste = await uebernehmen(pool, VORGANG, ANNA);
      await zurueckgeben(pool, VORGANG, ANNA);

      const zweite = await uebernehmen(pool, VORGANG, BERT);

      expect(zweite.ok).toBe(true);
      expect(zweite.sperre.id).not.toBe(erste.sperre.id);
      const zeilen = await pool.query<{ id: number; uebernommen_von: string; zurueckgegeben_von: string | null }>(
        'SELECT id::int AS id, uebernommen_von, zurueckgegeben_von FROM cockpit.vorgang_sperre ORDER BY id',
      );
      expect(zeilen.rows).toEqual([
        { id: erste.sperre.id, uebernommen_von: ANNA.id, zurueckgegeben_von: ANNA.id },
        { id: zweite.sperre.id, uebernommen_von: BERT.id, zurueckgegeben_von: null },
      ]);
    });
  });

  describe('zurückgeben', () => {
    it('gibt die eigene Übernahme zurück und protokolliert mit dem Konto, das übernommen hatte, als Ziel', async () => {
      const { sperre } = await uebernehmen(pool, VORGANG, ANNA);
      const marke = await protokollMarke(pool);

      expect(await zurueckgeben(pool, VORGANG, ANNA)).toEqual({ ok: true });

      expect(await sperreLesen(pool, VORGANG)).toBeUndefined();
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'vorgang_zurueckgegeben', akteur: ANNA.id, ziel: ANNA.id, einzelheiten: { vorgang_sperre_id: sperre.id } },
      ]);
    });

    it.each([
      ['der Betriebs-Admin', CARLA],
      ['der Betreuer', STEFAN],
    ])('%s gibt eine fremde Übernahme zurück', async (_wer, handelnder) => {
      await uebernehmen(pool, VORGANG, ANNA);
      const marke = await protokollMarke(pool);

      expect(await zurueckgeben(pool, VORGANG, handelnder)).toEqual({ ok: true });

      expect(await sperreLesen(pool, VORGANG)).toBeUndefined();
      expect(await protokollSeit(pool, marke)).toMatchObject([{ art: 'vorgang_zurueckgegeben', akteur: handelnder.id, ziel: ANNA.id }]);
    });

    it('ein anderer Mitarbeiter gibt eine fremde Übernahme nicht zurück: nichts ändert sich, nichts wird protokolliert', async () => {
      const { sperre } = await uebernehmen(pool, VORGANG, ANNA);
      const marke = await protokollMarke(pool);

      expect(await zurueckgeben(pool, VORGANG, BERT)).toEqual({ ok: false, grund: 'nicht_erlaubt', sperre });

      expect(await sperreLesen(pool, VORGANG)).toEqual(sperre);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('meldet einen freien Vorgang als nicht gesperrt', async () => {
      expect(await zurueckgeben(pool, VORGANG, CARLA)).toEqual({ ok: false, grund: 'nicht_gesperrt' });
    });

    it('prüft das Recht aus der Rolle, nicht aus einer Angabe im Konto: ein Mitarbeiter bleibt Mitarbeiter', () => {
      expect(darfZurueckgeben(BERT, { uebernommenVon: ANNA.id })).toBe(false);
      expect(darfZurueckgeben({ id: BERT.id, rolle: undefined }, { uebernommenVon: ANNA.id })).toBe(false);
      expect(darfZurueckgeben({ id: ANNA.id, rolle: undefined }, { uebernommenVon: ANNA.id })).toBe(true);
    });
  });

  describe('lesen', () => {
    it('liest die Sperren einer ganzen Liste in einer Abfrage, nur aktive, nur dieses Modul', async () => {
      await uebernehmen(pool, { modul: 'anfragen', vorgangId: 'a' }, ANNA);
      await uebernehmen(pool, { modul: 'anfragen', vorgangId: 'b' }, CARLA);
      await zurueckgeben(pool, { modul: 'anfragen', vorgangId: 'b' }, CARLA);
      await uebernehmen(pool, { modul: 'buchungen', vorgangId: 'c' }, ANNA);

      const sperren = await aktiveSperren(pool, 'anfragen', ['a', 'b', 'c', 'd']);

      expect([...sperren.keys()]).toEqual(['a']);
      expect(await aktiveSperren(pool, 'anfragen', [])).toEqual(new Map());
    });

    it('zeigt ein als gelöscht markiertes Konto als „ehemaliges Konto", nie mit seiner Adresse', async () => {
      await uebernehmen(pool, VORGANG, ANNA);
      await pool.query(
        `UPDATE cockpit."user" SET geloescht_am = now(), geloescht_von = 'system', geloescht_email = email,
                email = 'geloescht-' || id || '@geloescht.invalid' WHERE id = $1`,
        [ANNA.id],
      );

      const sperre = await sperreLesen(pool, VORGANG);

      expect(sperre?.anzeigename).toBe(EHEMALIGES_KONTO);
      expect(JSON.stringify(sperre)).not.toContain('@');
    });

    it('baut die Marke: Vorname aus dem Anzeigenamen, Zeit wie überall im Cockpit', () => {
      const am = new Date('2026-09-28T12:02:00.000Z');
      const jetzt = new Date('2026-09-28T13:00:00.000Z');
      const basis = { id: 1, vorgangId: 'a', uebernommenVon: ANNA.id, uebernommenAm: am };

      expect(sperrMarke({ ...basis, anzeigename: 'Stefan Jacomeit' }, jetzt)).toEqual({
        name: 'Stefan Jacomeit',
        vorname: 'Stefan',
        seit: 'heute, 14:02',
        seitKurz: '14:02',
      });
      expect(sperrMarke({ ...basis, anzeigename: 'Anna' }, new Date('2026-09-29T08:00:00.000Z')).seit).toBe(sperrMarke({ ...basis, anzeigename: 'Anna' }, new Date('2026-09-29T08:00:00.000Z')).seitKurz);
      expect(sperrMarke({ ...basis, anzeigename: EHEMALIGES_KONTO }, jetzt).vorname).toBe(EHEMALIGES_KONTO);
    });
  });
});
