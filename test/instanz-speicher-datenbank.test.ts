/**
 * Die Selbstmeldung in `cockpit.instanz` (COPI-39): genau eine Zeile, die jeder Start ersetzt — und der Erfolgsbeleg
 * eines Updates (COPI-41, ADR 13.1): nur ein Cockpit mit Ziel-Digest und Ziel-Version setzt den laufenden Eingriff auf
 * `erledigt`.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.instanz` und `cockpit.eingriff` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EingriffStatus } from '../src/status/eingriff.js';
import { instanzLesen, instanzMelden } from '../src/status/instanz-speicher.js';
import { eingriffIn, protokollMarke, protokollSchreibenScheitern, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const T0 = new Date('2026-09-21T12:00:00.000Z');
const DIGEST_ALT = `sha256:${'a1'.repeat(32)}`;
const DIGEST_NEU = `sha256:${'b2'.repeat(32)}`;

describe.skipIf(!testDatenbankUrl)('Selbstmeldung in cockpit.instanz (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDatenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.instanz');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.instanz');
    await pool.end();
  });

  it('legt beim ersten Start die Zeile mit Version, Digest und Startzeit an', async () => {
    await instanzMelden(pool, { version: '1.4.0+0123456', digest: DIGEST_ALT }, T0);

    expect(await instanzLesen(pool)).toEqual({ version: '1.4.0+0123456', digest: DIGEST_ALT, gestartetAm: T0 });
  });

  it('ersetzt sie beim nächsten Start: es gibt immer genau eine, die des laufenden Cockpits', async () => {
    await instanzMelden(pool, { version: '1.4.0+0123456', digest: DIGEST_ALT }, T0);
    const spaeter = new Date(T0.getTime() + 3600_000);

    await instanzMelden(pool, { version: '1.5.0+89abcde', digest: DIGEST_NEU }, spaeter);

    expect(await instanzLesen(pool)).toEqual({ version: '1.5.0+89abcde', digest: DIGEST_NEU, gestartetAm: spaeter });
    const anzahl = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM cockpit.instanz');
    expect(anzahl.rows[0]?.n).toBe(1);
  });

  it('löscht einen früheren Digest, wenn der neue Start keinen kennt: nie ein stehengebliebener Wert', async () => {
    await instanzMelden(pool, { version: '1.4.0+0123456', digest: DIGEST_ALT }, T0);

    await instanzMelden(pool, { version: '0.1.0+lokal', digest: undefined }, T0);

    expect(await instanzLesen(pool)).toEqual({ version: '0.1.0+lokal', digest: undefined, gestartetAm: T0 });
  });

  it('liefert vor der ersten Meldung nichts', async () => {
    expect(await instanzLesen(pool)).toBeUndefined();
  });

  it('lässt einen kaputten Digest an der Regel der Datenbank scheitern, auch wenn ihn jemand an der Prüfung vorbei schreibt', async () => {
    await expect(instanzMelden(pool, { version: '1.4.0+0123456', digest: 'latest' }, T0)).rejects.toThrow(/instanz_digest_form/);
    expect(await instanzLesen(pool)).toBeUndefined();
  });

  describe('Erfolgsbeleg eines Updates (COPI-41)', () => {
    /** Ein Update vom alten auf das neue Image, freigegeben mit Version 1.5.0 — so weit, wie `status` sagt. */
    async function update(status: EingriffStatus): Promise<number> {
      await instanzMelden(pool, { version: '1.4.0+0123456', digest: DIGEST_ALT }, T0);
      return eingriffIn(pool, status, { ziel: DIGEST_NEU, vorher: DIGEST_ALT, zielVersion: '1.5.0' });
    }

    async function statusVon(id: number): Promise<string | undefined> {
      const zeile = await pool.query<{ status: string }>('SELECT status FROM cockpit.eingriff WHERE id = $1', [id]);
      return zeile.rows[0]?.status;
    }

    it('setzt den laufenden Eingriff auf „erledigt", wenn sich ein Cockpit mit Ziel-Digest und Ziel-Version meldet', async () => {
      const id = await update('laeuft');
      const marke = await protokollMarke(pool);

      const ergebnis = await instanzMelden(pool, { version: '1.5.0+89abcde', digest: DIGEST_NEU }, T0);

      expect(ergebnis).toEqual({ erledigt: id });
      expect(await statusVon(id)).toBe('erledigt');
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'update_erledigt', akteur: 'system', ziel: null, einzelheiten: { eingriff_id: id } },
      ]);
    });

    it.each([
      ['ein Cockpit mit dem alten Digest (das Update lief nicht)', { version: '1.4.0+0123456', digest: DIGEST_ALT }],
      ['das alte Image mit dem neuen Digest aus der Umgebung (die image-Zeile blieb stehen)', { version: '1.4.0+0123456', digest: DIGEST_NEU }],
      ['ein Cockpit ohne Digest', { version: '1.5.0+89abcde', digest: undefined }],
      ['eine Vorabversion derselben Nummer', { version: '1.5.0-rc.1+89abcde', digest: DIGEST_NEU }],
    ])('lässt den Eingriff in „laeuft", wenn sich %s meldet', async (_name, meldung) => {
      const id = await update('laeuft');
      const marke = await protokollMarke(pool);

      const ergebnis = await instanzMelden(pool, meldung, T0);

      expect(ergebnis).toEqual({ erledigt: undefined });
      expect(await statusVon(id)).toBe('laeuft');
      expect(await protokollSeit(pool, marke)).toEqual([]);
      // Die Meldung selbst gilt trotzdem: sie sagt, was jetzt läuft.
      expect((await instanzLesen(pool))?.version).toBe(meldung.version);
    });

    it.each(['beantragt', 'freigegeben', 'fehlgeschlagen', 'zurueckgezogen'] as const)(
      'belegt nichts, was „%s" ist: nur ein laufender Eingriff wird erledigt',
      async (status) => {
        const id = await update(status);

        const ergebnis = await instanzMelden(pool, { version: '1.5.0+89abcde', digest: DIGEST_NEU }, T0);

        expect(ergebnis).toEqual({ erledigt: undefined });
        expect(await statusVon(id)).toBe(status);
      },
    );

    it('belegt ein Update nur einmal: ein weiterer Start schreibt keinen zweiten Eintrag', async () => {
      await update('laeuft');
      await instanzMelden(pool, { version: '1.5.0+89abcde', digest: DIGEST_NEU }, T0);
      const marke = await protokollMarke(pool);

      const ergebnis = await instanzMelden(pool, { version: '1.5.0+89abcde', digest: DIGEST_NEU }, T0);

      expect(ergebnis).toEqual({ erledigt: undefined });
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('nimmt alles zurück, wenn der Protokolleintrag scheitert: keine Meldung, kein Beleg', async () => {
      const id = await update('laeuft');
      const entfernen = await protokollSchreibenScheitern(pool, 'update_erledigt');
      try {
        await expect(instanzMelden(pool, { version: '1.5.0+89abcde', digest: DIGEST_NEU }, T0)).rejects.toThrow();
      } finally {
        await entfernen();
      }

      expect(await statusVon(id)).toBe('laeuft');
      expect(await instanzLesen(pool)).toEqual({ version: '1.4.0+0123456', digest: DIGEST_ALT, gestartetAm: T0 });
    });
  });
});
