/**
 * Der Update-Planer (COPI-142) gegen die echte Datenbank: im Modus `automatisch` stellt das Cockpit den Antrag selbst
 * und gibt ihn direkt frei — nur mit Ziel der Versions-Wache, beim Image nur im Wartungsfenster, höchstens einer je Tag
 * und nie wieder für ein Ziel, das gescheitert ist oder zurückgezogen wurde.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort Anträge, Freigabemodus, Instanz, Module, Versions-Wachen und die
 * eigenen Konten ab. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { freigabeModusSetzen, type FreigabeBereich, type FreigabeModus } from '../src/status/freigabe-modus.js';
import { instanzMelden } from '../src/status/instanz-speicher.js';
import { modulUpdateBeantragen } from '../src/status/update-antrag-speicher.js';
import { updatePlanerLaufen } from '../src/status/update-planer.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const KONTO = 'konto-planer-betreuer';
const LAUFEND = `sha256:${'9f'.repeat(32)}`;
const ZIEL = `sha256:${'e7'.repeat(32)}`;
const MODUL = 'test-planer';
const ANDERES_MODUL = 'test-planer-hand';
const VORHER_COMMIT = '3f2a9c1e0b7d44c2a9f1c0de5b6a7d8e9f0a1b2c';
const ZIEL_A = '8d41e07b2c9a4f10e5d6c7b8a9f0e1d2c3b4a5f6';
const ZIEL_B = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const WACHEN = ['version-cockpit', `version-modul-${MODUL}`, `version-modul-${ANDERES_MODUL}`];

/** Dienstag, 20.10.2026, 07:30 in Berlin: im Wartungsfenster. */
const IM_FENSTER = new Date('2026-10-20T05:30:00Z');
/** Derselbe Dienstag, 09:30: danach. */
const NACH_FENSTER = new Date('2026-10-20T07:30:00Z');
const TAG_MS = 24 * 60 * 60 * 1000;

function block(kennung: string): string {
  return [
    `kennung: ${kennung}`,
    'menuename: "Test-Planer"',
    'ansicht: liste-detail',
    'view: v_modul_planer_test',
    'spalten:',
    '  - { name: titel, label: "Titel" }',
    'rollen: [betreuer]',
    'art: betrieb',
    'eingriffe: []',
    '',
  ].join('\n');
}

interface AntragZeile {
  readonly id: number;
  readonly art: string;
  readonly modul: string | null;
  readonly status: string;
  readonly freigabe_modus: string;
  readonly automatisch: boolean;
  readonly ziel: string;
  readonly ziel_version: string | null;
  readonly beantragt_von: string;
  readonly beantragt_am: Date;
}

describe.skipIf(!datenbankUrl)('Update-Planer (COPI-142, echte Datenbank)', () => {
  let pool: pg.Pool;

  async function abraeumen(): Promise<void> {
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.update_freigabemodus');
    await pool.query('DELETE FROM cockpit.instanz');
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.befund WHERE wache = ANY($1)', [WACHEN]);
    await pool.query('DELETE FROM cockpit.wache WHERE kennung = ANY($1)', [WACHEN]);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cockpit.planer_quelle (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        titel text NOT NULL,
        aktualisiert_am timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE VIEW cockpit.v_modul_planer_test AS
        SELECT id::text AS id, titel, 'gruen'::text AS status, aktualisiert_am FROM cockpit.planer_quelle;
    `);
  });

  beforeEach(async () => {
    await abraeumen();
    await pool.query(`DELETE FROM cockpit."user" WHERE id = $1`, [KONTO]);
    await pool.query(
      `INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle) VALUES ($1, 'Stefan Test', $2, true, 'betreuer')`,
      [KONTO, `${KONTO}@example.org`],
    );
    await instanzMelden(pool, { version: '1.4.0+0123456', digest: LAUFEND }, new Date());
    for (const kennung of [MODUL, ANDERES_MODUL]) {
      const modul = await modulEinspielen(pool, {
        rohtext: block(kennung),
        akteur: 'test',
        herkunft: `agent-blueprints@${VORHER_COMMIT}:module/${kennung}.cockpit.yaml`,
      });
      expect(modul.ok).toBe(true);
    }
  });

  afterAll(async () => {
    await abraeumen();
    await pool.query(`DELETE FROM cockpit."user" WHERE id = $1`, [KONTO]);
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_planer_test; DROP TABLE IF EXISTS cockpit.planer_quelle;');
    await pool.end();
  });

  function modus(bereich: FreigabeBereich, wert: FreigabeModus): Promise<unknown> {
    return freigabeModusSetzen(pool, { bereich, modus: wert, konto: KONTO });
  }

  async function wacheMeldet(wache: string, updateZiel: Parameters<typeof befundMelden>[1]['updateZiel'], status: 'gelb' | 'gruen' = 'gelb'): Promise<void> {
    const ergebnis = await befundMelden(pool, {
      wache,
      status,
      textIntern: 'neuer Stand',
      kundensichtbar: false,
      taktSekunden: 3600,
      ...(status === 'gelb' ? { updateZiel } : {}),
      quelle: 'test',
      jetzt: new Date(),
    });
    expect(ergebnis.ok).toBe(true);
  }

  function modulMeldet(ziel: string, kennung = MODUL): Promise<void> {
    return wacheMeldet(`version-modul-${kennung}`, { art: 'modul', ziel, seit: '2026-10-19T04:25:00+02:00' });
  }

  function cockpitMeldet(angaben: { readonly version?: string; readonly ziel?: string } = { version: '1.5.0' }): Promise<void> {
    return wacheMeldet('version-cockpit', { art: 'cockpit', ziel: angaben.ziel ?? ZIEL, ...angaben, seit: '2026-10-19T04:25:00+02:00' });
  }

  async function antraege(): Promise<AntragZeile[]> {
    const ergebnis = await pool.query<AntragZeile>(
      `SELECT id::int AS id, art, modul_kennung AS modul, status, freigabe_modus, automatisch,
              coalesce(ziel_digest, ziel_commit) AS ziel, ziel_version, beantragt_von, beantragt_am
         FROM cockpit.eingriff ORDER BY id`,
    );
    return ergebnis.rows;
  }

  /** Was der Agent mit einem Antrag tut: starten und scheitern lassen (die Kette der Datenbank, 0050). */
  async function agentScheitert(id: number): Promise<void> {
    await pool.query(`UPDATE cockpit.eingriff SET status = 'laeuft' WHERE id = $1`, [id]);
    await pool.query(`UPDATE cockpit.eingriff SET status = 'fehlgeschlagen', fehler_grund = 'Test' WHERE id = $1`, [id]);
  }

  describe('Module', () => {
    it.each<FreigabeModus | undefined>([undefined, 'rueckfrage', 'direkt'])('stellt im Modus %s nichts', async (wert) => {
      if (wert !== undefined) {
        await modus('module', wert);
      }
      await modulMeldet(ZIEL_A);

      expect(await updatePlanerLaufen(pool, new Date())).toEqual([]);
      expect(await antraege()).toEqual([]);
    });

    it('stellt im Modus automatisch den Antrag selbst und gibt ihn direkt frei, protokolliert als automatisch', async () => {
      await modus('module', 'automatisch');
      await modulMeldet(ZIEL_A);
      const vorher = new Date();

      const versuche = await updatePlanerLaufen(pool, new Date());

      expect(versuche).toEqual([{ modul: MODUL, ziel: ZIEL_A, ergebnis: { ok: true, id: expect.any(Number) as number, modus: 'direkt' } }]);
      const [antrag] = await antraege();
      expect(antrag).toMatchObject({
        art: 'modul',
        modul: MODUL,
        status: 'freigegeben',
        freigabe_modus: 'direkt',
        automatisch: true,
        ziel: ZIEL_A,
        beantragt_von: KONTO,
      });
      const protokoll = await pool.query<{ art: string; akteur: string; einzelheiten: unknown }>(
        `SELECT art, akteur, einzelheiten FROM cockpit.protokoll WHERE zeitpunkt >= $1 AND art IN ('update_beantragt', 'update_freigegeben') ORDER BY id`,
        [new Date(vorher.getTime() - 1000)],
      );
      expect(protokoll.rows).toEqual([
        { art: 'update_beantragt', akteur: KONTO, einzelheiten: { eingriff_id: antrag?.id, weg: 'automatisch' } },
        { art: 'update_freigegeben', akteur: KONTO, einzelheiten: { eingriff_id: antrag?.id, weg: 'automatisch' } },
      ]);
    });

    it('stellt bei wiederholtem Lauf keinen zweiten Antrag (Idempotenz)', async () => {
      await modus('module', 'automatisch');
      await modulMeldet(ZIEL_A);

      await updatePlanerLaufen(pool, new Date());
      const zweiter = await updatePlanerLaufen(pool, new Date());
      await updatePlanerLaufen(pool, new Date());

      expect(zweiter).toEqual([]);
      expect(await antraege()).toHaveLength(1);
    });

    it('stellt keinen Antrag, solange ein anderer offen ist (auch ein von Hand gestellter)', async () => {
      await modus('module', 'automatisch');
      const hand = await modulUpdateBeantragen(pool, {
        modul: MODUL,
        zielCommit: ZIEL_B,
        herkunftVorher: `agent-blueprints@${VORHER_COMMIT}:module/${MODUL}.cockpit.yaml`,
        kontoId: KONTO,
        freigabe: { erwartet: 'rueckfrage', direktMoeglich: false },
      });
      expect(hand.ok).toBe(true);
      await modulMeldet(ZIEL_A);

      expect(await updatePlanerLaufen(pool, new Date())).toEqual([]);
      expect((await antraege()).map((a) => a.automatisch)).toEqual([false]);
    });

    it('stellt keinen Antrag ohne gemeldetes Update: keine Meldung, grüne Wache, schon eingespielter Commit', async () => {
      await modus('module', 'automatisch');
      expect(await updatePlanerLaufen(pool, new Date())).toEqual([]);

      await wacheMeldet(`version-modul-${MODUL}`, undefined, 'gruen');
      expect(await updatePlanerLaufen(pool, new Date())).toEqual([]);

      await modulMeldet(VORHER_COMMIT);
      expect(await updatePlanerLaufen(pool, new Date())).toEqual([]);
      expect(await antraege()).toEqual([]);
    });

    it('stellt nichts für ein Modul, dessen Herkunft nicht unter module/ liegt', async () => {
      await modulEinspielen(pool, { rohtext: block(MODUL), akteur: 'test', herkunft: `agent-blueprints@${VORHER_COMMIT}:blueprints/${MODUL}.yaml` });
      await modus('module', 'automatisch');
      await modulMeldet(ZIEL_A);

      expect(await updatePlanerLaufen(pool, new Date())).toEqual([]);
    });

    it('stellt höchstens einen automatischen Antrag je Modul und Tag, am nächsten Tag wieder', async () => {
      await modus('module', 'automatisch');
      await modulMeldet(ZIEL_A);
      await updatePlanerLaufen(pool, new Date());
      const [erster] = await antraege();
      if (erster === undefined) {
        throw new Error('kein Antrag');
      }
      await pool.query(`UPDATE cockpit.eingriff SET status = 'zurueckgezogen' WHERE id = $1`, [erster.id]);
      // Die Wache meldet ein neues Ziel: am selben Kalendertag trotzdem kein zweiter Antrag.
      await modulMeldet(ZIEL_B);

      expect(await updatePlanerLaufen(pool, erster.beantragt_am)).toEqual([{ modul: MODUL, ziel: ZIEL_B, ergebnis: { ok: false, grund: 'gesperrt' } }]);
      expect(await antraege()).toHaveLength(1);

      const morgen = await updatePlanerLaufen(pool, new Date(erster.beantragt_am.getTime() + TAG_MS));
      expect(morgen).toEqual([{ modul: MODUL, ziel: ZIEL_B, ergebnis: { ok: true, id: expect.any(Number) as number, modus: 'direkt' } }]);
    });

    it('zählt das Tageslimit je Modul: ein anderes Modul bekommt am selben Tag seinen Antrag', async () => {
      await modus('module', 'automatisch');
      await modulMeldet(ZIEL_A);
      await modulMeldet(ZIEL_B, ANDERES_MODUL);

      const versuche = await updatePlanerLaufen(pool, new Date());

      expect(versuche.map((v) => [v.modul, v.ergebnis.ok])).toEqual([
        [MODUL, true],
        [ANDERES_MODUL, true],
      ]);
    });

    it('stellt nach einem Fehlschlag keinen neuen Antrag für dasselbe Ziel, wohl aber für ein anderes', async () => {
      await modus('module', 'automatisch');
      await modulMeldet(ZIEL_A);
      await updatePlanerLaufen(pool, new Date());
      const [erster] = await antraege();
      if (erster === undefined) {
        throw new Error('kein Antrag');
      }
      await agentScheitert(erster.id);
      const morgen = new Date(erster.beantragt_am.getTime() + TAG_MS);

      expect(await updatePlanerLaufen(pool, morgen)).toEqual([{ modul: MODUL, ziel: ZIEL_A, ergebnis: { ok: false, grund: 'gesperrt' } }]);
      expect(await updatePlanerLaufen(pool, new Date(morgen.getTime() + TAG_MS))).toEqual([
        { modul: MODUL, ziel: ZIEL_A, ergebnis: { ok: false, grund: 'gesperrt' } },
      ]);

      await modulMeldet(ZIEL_B);
      expect((await updatePlanerLaufen(pool, morgen))[0]?.ergebnis).toMatchObject({ ok: true });
    });

    it('sperrt das Ziel auch nach einem Fehlschlag eines von Hand gestellten Antrags (gekürzter Commit)', async () => {
      await modus('module', 'automatisch');
      const hand = await modulUpdateBeantragen(pool, {
        modul: MODUL,
        zielCommit: ZIEL_A.slice(0, 7),
        herkunftVorher: `agent-blueprints@${VORHER_COMMIT}:module/${MODUL}.cockpit.yaml`,
        kontoId: KONTO,
        freigabe: { erwartet: 'rueckfrage', direktMoeglich: false },
      });
      if (!hand.ok) {
        throw new Error('kein Antrag');
      }
      await pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben' WHERE id = $1`, [hand.id]);
      await agentScheitert(hand.id);
      await modulMeldet(ZIEL_A);

      expect(await updatePlanerLaufen(pool, new Date())).toEqual([{ modul: MODUL, ziel: ZIEL_A, ergebnis: { ok: false, grund: 'gesperrt' } }]);
    });

    it('stellt nach einem zurückgezogenen automatischen Antrag keinen neuen für dasselbe Ziel', async () => {
      await modus('module', 'automatisch');
      await modulMeldet(ZIEL_A);
      await updatePlanerLaufen(pool, new Date());
      const [erster] = await antraege();
      if (erster === undefined) {
        throw new Error('kein Antrag');
      }
      await pool.query(`UPDATE cockpit.eingriff SET status = 'zurueckgezogen' WHERE id = $1`, [erster.id]);

      expect(await updatePlanerLaufen(pool, new Date(erster.beantragt_am.getTime() + TAG_MS))).toEqual([
        { modul: MODUL, ziel: ZIEL_A, ergebnis: { ok: false, grund: 'gesperrt' } },
      ]);
    });

    it('stellt nichts, wenn das Konto, das umgestellt hat, kein Betreuer mehr ist', async () => {
      await modus('module', 'automatisch');
      await modulMeldet(ZIEL_A);
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betriebs_admin' WHERE id = $1`, [KONTO]);

      expect(await updatePlanerLaufen(pool, new Date())).toEqual([]);
    });

    it('hält den Freigabemodus des Antrags fest: automatisch lässt sich nachträglich nicht ändern', async () => {
      await modus('module', 'automatisch');
      await modulMeldet(ZIEL_A);
      await updatePlanerLaufen(pool, new Date());
      const [antrag] = await antraege();

      await expect(pool.query(`UPDATE cockpit.eingriff SET automatisch = false WHERE id = $1`, [antrag?.id])).rejects.toThrow(/eingriff_unveraenderlich/);
      await expect(
        pool.query(`INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von, freigabe_modus, automatisch)
                    VALUES ('cockpit-image', $1, $2, $3, 'rueckfrage', true)`, [ZIEL, LAUFEND, KONTO]),
      ).rejects.toThrow(/eingriff_automatisch_direkt/);
    });
  });

  describe('Cockpit-Image', () => {
    it('stellt den Antrag im Wartungsfenster, mit Ziel-Version und Weg zurück', async () => {
      await modus('cockpit', 'automatisch');
      await cockpitMeldet();

      const versuche = await updatePlanerLaufen(pool, IM_FENSTER);

      expect(versuche).toEqual([{ modul: undefined, ziel: ZIEL, ergebnis: { ok: true, id: expect.any(Number) as number, modus: 'direkt' } }]);
      expect(await antraege()).toEqual([
        expect.objectContaining({ art: 'cockpit-image', status: 'freigegeben', automatisch: true, ziel: ZIEL, ziel_version: '1.5.0' }),
      ]);
      const vorher = await pool.query<{ digest_vorher: string }>('SELECT digest_vorher FROM cockpit.eingriff');
      expect(vorher.rows[0]?.digest_vorher).toBe(LAUFEND);
    });

    it('stellt außerhalb des Wartungsfensters nichts', async () => {
      await modus('cockpit', 'automatisch');
      await cockpitMeldet();

      expect(await updatePlanerLaufen(pool, NACH_FENSTER)).toEqual([]);
      expect(await updatePlanerLaufen(pool, new Date(IM_FENSTER.getTime() + TAG_MS))).toEqual([]);
    });

    // Ohne Ziel-Version meldet die Wache kein Cockpit-Update (`befund_update_ziel_form`, 0049).
    it('stellt nichts ohne laufenden Digest oder auf den laufenden Digest', async () => {
      await modus('cockpit', 'automatisch');
      await cockpitMeldet({ version: '1.4.0', ziel: LAUFEND });
      expect(await updatePlanerLaufen(pool, IM_FENSTER)).toEqual([]);

      await cockpitMeldet();
      await pool.query('DELETE FROM cockpit.instanz');
      expect(await updatePlanerLaufen(pool, IM_FENSTER)).toEqual([]);
      expect(await antraege()).toEqual([]);
    });

    it('trennt die Bereiche: Module auf automatisch stellt kein Image-Update', async () => {
      await modus('module', 'automatisch');
      await modus('cockpit', 'direkt');
      await cockpitMeldet();

      expect(await updatePlanerLaufen(pool, IM_FENSTER)).toEqual([]);
    });

    it('stellt nach einem Fehlschlag desselben Ziels keinen neuen Antrag, auch nicht in der nächsten Woche', async () => {
      await modus('cockpit', 'automatisch');
      await cockpitMeldet();
      await updatePlanerLaufen(pool, IM_FENSTER);
      const [erster] = await antraege();
      if (erster === undefined) {
        throw new Error('kein Antrag');
      }
      await agentScheitert(erster.id);

      // Eine Woche später, 07:30 Winterzeit (eine Stunde mehr in UTC).
      expect(await updatePlanerLaufen(pool, new Date(IM_FENSTER.getTime() + 7 * TAG_MS + 60 * 60 * 1000))).toEqual([
        { modul: undefined, ziel: ZIEL, ergebnis: { ok: false, grund: 'gesperrt' } },
      ]);
    });

    describe('Wartungsfenster jederzeit (COPI-235)', () => {
      /** Mittwoch, 21.10.2026, 14:00 in Berlin: weit außerhalb des Dienstagsfensters. */
      const MITTWOCH = new Date('2026-10-21T12:00:00Z');
      const ZIEL_NEU = `sha256:${'c4'.repeat(32)}`;

      it('stellt mit di 07-09 außerhalb des Fensters keinen Antrag', async () => {
        await modus('cockpit', 'automatisch');
        await cockpitMeldet();

        expect(await updatePlanerLaufen(pool, MITTWOCH, 'di 07-09')).toEqual([]);
        expect(await antraege()).toEqual([]);
      });

      it('stellt mit jederzeit am Mittwoch um 14:00 einen Antrag', async () => {
        await modus('cockpit', 'automatisch');
        await cockpitMeldet();

        expect(await updatePlanerLaufen(pool, MITTWOCH, 'jederzeit')).toEqual([
          { modul: undefined, ziel: ZIEL, ergebnis: { ok: true, id: expect.any(Number) as number, modus: 'direkt' } },
        ]);
        expect(await antraege()).toEqual([expect.objectContaining({ art: 'cockpit-image', status: 'freigegeben', automatisch: true, ziel: ZIEL })]);
      });

      it('stellt mit jederzeit am selben Tag für ein zweites, neueres Ziel einen weiteren Antrag', async () => {
        await modus('cockpit', 'automatisch');
        await cockpitMeldet();
        // Die Tagesgrenze rechnet gegen den Zeitpunkt des Antrags: beide Läufe gehören in denselben Kalendertag.
        const jetzt = new Date();
        await updatePlanerLaufen(pool, jetzt, 'jederzeit');
        const [erster] = await antraege();
        if (erster === undefined) {
          throw new Error('kein Antrag');
        }
        // Der erste Antrag ist abgeschlossen (offen verhindert jeden neuen); die Sperre gilt nur für sein Ziel.
        await agentScheitert(erster.id);
        await cockpitMeldet({ version: '1.6.0', ziel: ZIEL_NEU });

        expect(await updatePlanerLaufen(pool, jetzt, 'jederzeit')).toEqual([
          { modul: undefined, ziel: ZIEL_NEU, ergebnis: { ok: true, id: expect.any(Number) as number, modus: 'direkt' } },
        ]);
        expect(await antraege()).toEqual([expect.objectContaining({ ziel: ZIEL }), expect.objectContaining({ ziel: ZIEL_NEU })]);
      });

      it('stellt für ein gescheitertes Ziel auch mit jederzeit keinen neuen Antrag', async () => {
        await modus('cockpit', 'automatisch');
        await cockpitMeldet();
        await updatePlanerLaufen(pool, MITTWOCH, 'jederzeit');
        const [erster] = await antraege();
        if (erster === undefined) {
          throw new Error('kein Antrag');
        }
        await agentScheitert(erster.id);

        expect(await updatePlanerLaufen(pool, new Date(MITTWOCH.getTime() + TAG_MS), 'jederzeit')).toEqual([
          { modul: undefined, ziel: ZIEL, ergebnis: { ok: false, grund: 'gesperrt' } },
        ]);
        expect(await antraege()).toHaveLength(1);
      });
    });
  });
});
