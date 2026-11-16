/**
 * Das Schema des Zustandsbilds (COPI-34, Epic E3): `wache`, `befund`, `agent`, `instanz`, `eingriff`.
 *
 * Geprüft werden die Regeln der Datenbank, nicht ein Anwendungsweg: Es gibt noch keinen. Was hier
 * abgelehnt wird, soll auch ein späterer Fehler in einer Route nicht durchbringen (Architektur-
 * Vorschlag 4 und 13.1: das Cockpit zeigt Befunde, prüft nichts selbst und beantragt Updates nur).
 *
 * Läuft nur mit `TEST_DATABASE_URL` (echte PostgreSQL) und räumt dort die fünf Tabellen ab. Niemals
 * gegen eine Kundendatenbank laufen lassen. Die erwarteten Werte (Constraint- und Fehlernamen,
 * Statusnamen) stehen als Literale: der Test soll nicht mitrechnen, wenn die Migration sie ändert.
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrationenAnwenden, migrationZuruecknehmen } from '../src/datenbank/migrationen.js';
import { leereDatenbankAnlegen, type LeereDatenbank, LEERE_DATENBANK_TIMEOUT_MS } from './leere-datenbank.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

/** Die Meldung, mit der die Datenbank eine Anweisung ablehnt; scheitert der Test, wenn sie angenommen wird. */
async function abgelehnt(anweisung: Promise<unknown>): Promise<string> {
  try {
    await anweisung;
  } catch (fehler) {
    return fehler instanceof Error ? fehler.message : String(fehler);
  }
  throw new Error('Die Datenbank hat die Anweisung angenommen, obwohl sie abgelehnt werden musste.');
}

describe.skipIf(!datenbankUrl)('Schema des Zustandsbilds (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function abraeumen(): Promise<void> {
    // Reihenfolge wegen des Fremdschlüssels: erst die Befunde, dann die Wachen.
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DELETE FROM cockpit.agent');
    await pool.query('DELETE FROM cockpit.instanz');
    await pool.query('DELETE FROM cockpit.eingriff');
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(abraeumen);

  afterAll(async () => {
    await abraeumen();
    await pool.end();
  });

  describe('wache', () => {
    it('legt eine Wache ohne bisherigen Lauf an: „noch nie gemeldet" ist NULL, nicht ein erfundener Zeitpunkt', async () => {
      await pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ('container', 300)`);

      const zeile = await pool.query<{ letzter_lauf: Date | null }>(
        `SELECT letzter_lauf FROM cockpit.wache WHERE kennung = 'container'`,
      );

      expect(zeile.rows[0]?.letzter_lauf).toBeNull();
    });

    it.each([0, -1, -300])('lehnt den Takt %i ab: eine Wache muss in einem positiven Abstand melden', async (takt) => {
      const meldung = await abgelehnt(
        pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ('container', $1)`, [takt]),
      );

      expect(meldung).toContain('wache_takt_positiv');
    });

    it.each(['', 'Container', 'mit leerzeichen', '_zuerst', 'a'.repeat(64), 'umlaut-ä'])(
      'lehnt die Kennung „%s" ab',
      async (kennung) => {
        const meldung = await abgelehnt(
          pool.query('INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ($1, 300)', [kennung]),
        );

        expect(meldung).toContain('wache_kennung_form');
      },
    );

    it('hat ohne Angabe keinen Anzeigenamen: NULL, nicht die Kennung (COPI-37)', async () => {
      await pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ('container', 300)`);

      const zeile = await pool.query<{ anzeigename: string | null }>(`SELECT anzeigename FROM cockpit.wache WHERE kennung = 'container'`);

      expect(zeile.rows[0]?.anzeigename).toBeNull();
    });

    it.each(['Buchungs-Agent', 'Ä', 'ä'.repeat(60)])('nimmt den Anzeigenamen „%s" an: der Name ist für Menschen, mit Umlauten und Leerzeichen', async (name) => {
      await pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden, anzeigename) VALUES ('container', 300, $1)`, [name]);
    });

    it.each(['', '   ', '\t\n', 'x'.repeat(61)])('lehnt den Anzeigenamen %j ab', async (name) => {
      const meldung = await abgelehnt(
        pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden, anzeigename) VALUES ('container', 300, $1)`, [name]),
      );

      expect(meldung).toContain('wache_anzeigename_form');
    });

    it.each(['container', 'backup.taeglich', 'versionen-woechentlich', 'a'.repeat(63)])(
      'nimmt die Kennung „%s" an',
      async (kennung) => {
        await pool.query('INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ($1, 300)', [kennung]);
      },
    );
  });

  describe('befund', () => {
    beforeEach(async () => {
      await pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ('container', 300)`);
    });

    it('ist ohne ausdrückliche Angabe nicht kundensichtbar (Rohbefunde gehen nie direkt an den Kunden)', async () => {
      await pool.query(
        `INSERT INTO cockpit.befund (wache, status, text_intern, quelle)
         VALUES ('container', 'gruen', 'alle Container laufen', 'admin-agent')`,
      );

      const zeile = await pool.query<{ kundensichtbar: boolean; gemeldet_am: Date }>(
        `SELECT kundensichtbar, gemeldet_am FROM cockpit.befund`,
      );

      expect(zeile.rows[0]?.kundensichtbar).toBe(false);
      // Die Meldezeit setzt die Datenbank.
      expect(zeile.rows[0]?.gemeldet_am).toBeInstanceOf(Date);
    });

    it.each(['gruen', 'gelb', 'rot'])('kennt den Status %s', async (status) => {
      await pool.query(
        `INSERT INTO cockpit.befund (wache, status, text_intern, quelle)
         VALUES ('container', $1, 'Text', 'admin-agent')`,
        [status],
      );
    });

    it.each(['blau', 'grün', 'GRUEN', ''])('lehnt den Status „%s" ab', async (status) => {
      const meldung = await abgelehnt(
        pool.query(
          `INSERT INTO cockpit.befund (wache, status, text_intern, quelle)
           VALUES ('container', $1, 'Text', 'admin-agent')`,
          [status],
        ),
      );

      expect(meldung).toContain('befund_status_bekannt');
    });

    it('verlangt eine bekannte Wache: ein Befund ohne Wache hätte keinen Herzschlag', async () => {
      const meldung = await abgelehnt(
        pool.query(
          `INSERT INTO cockpit.befund (wache, status, text_intern, quelle)
           VALUES ('gibt-es-nicht', 'gruen', 'Text', 'admin-agent')`,
        ),
      );

      expect(meldung).toContain('befund_wache_bekannt');
    });

    it.each([
      ['ohne Klartext', null],
      ['mit leerem Klartext', ''],
      ['mit Klartext aus Leerzeichen', '   '],
    ])('lässt keinen Befund kundensichtbar werden, %s: der Kunde sieht nie den Rohbefund', async (_name, klartext) => {
      const meldung = await abgelehnt(
        pool.query(
          `INSERT INTO cockpit.befund (wache, status, text_intern, text_kunde, kundensichtbar, quelle)
           VALUES ('container', 'rot', 'Rohbefund: postgres exit 137', $1, true, 'admin-agent')`,
          [klartext],
        ),
      );

      expect(meldung).toContain('befund_kundentext_noetig');
    });

    it('lässt einen Befund mit Klartext kundensichtbar werden, und einen mit Klartext auch unsichtbar bleiben', async () => {
      await pool.query(
        `INSERT INTO cockpit.befund (wache, status, text_intern, text_kunde, kundensichtbar, quelle)
         VALUES ('container', 'rot', 'Rohbefund', 'Die Buchungsverwaltung ist gerade nicht erreichbar.', true, 'koordinator'),
                ('container', 'rot', 'Rohbefund', 'Klartext liegt vor, ist aber noch nicht freigegeben.', false, 'admin-agent')`,
      );

      const anzahl = await pool.query<{ sichtbar: number }>(
        `SELECT count(*) FILTER (WHERE kundensichtbar)::int AS sichtbar FROM cockpit.befund`,
      );

      expect(anzahl.rows[0]?.sichtbar).toBe(1);
    });
  });

  describe('agent', () => {
    it('legt einen Agenten mit leeren Grenzen und leerem Zeitplan an, wenn nichts geliefert wird', async () => {
      await pool.query(`INSERT INTO cockpit.agent (kennung, rolle, version) VALUES ('admin', 'admin', '1.4.0')`);

      const zeile = await pool.query<{ grenzen: unknown; zeitplan: unknown }>(
        `SELECT grenzen, zeitplan FROM cockpit.agent WHERE kennung = 'admin'`,
      );

      expect(zeile.rows[0]?.grenzen).toEqual({});
      expect(zeile.rows[0]?.zeitplan).toEqual([]);
    });

    it('speichert Grenzen und Zeitplan, wie sie der Admin-Agent liefert', async () => {
      await pool.query(
        `INSERT INTO cockpit.agent (kennung, rolle, version, grenzen, zeitplan)
         VALUES ('admin', 'admin', '1.4.0',
                 '{"darf_nicht": ["updates-einspielen"]}',
                 '[{"name": "Zustandswache", "alle_sekunden": 300}]')`,
      );

      const zeile = await pool.query<{ grenzen: unknown; zeitplan: unknown }>(
        `SELECT grenzen, zeitplan FROM cockpit.agent WHERE kennung = 'admin'`,
      );

      expect(zeile.rows[0]?.grenzen).toEqual({ darf_nicht: ['updates-einspielen'] });
      expect(zeile.rows[0]?.zeitplan).toEqual([{ name: 'Zustandswache', alle_sekunden: 300 }]);
    });

    it('verlangt für die Grenzen ein Objekt und für den Zeitplan eine Liste', async () => {
      const grenzen = await abgelehnt(
        pool.query(
          `INSERT INTO cockpit.agent (kennung, rolle, version, grenzen) VALUES ('a', 'admin', '1', '[]')`,
        ),
      );
      const zeitplan = await abgelehnt(
        pool.query(
          `INSERT INTO cockpit.agent (kennung, rolle, version, zeitplan) VALUES ('b', 'admin', '1', '{}')`,
        ),
      );

      expect(grenzen).toContain('agent_grenzen_objekt');
      expect(zeitplan).toContain('agent_zeitplan_liste');
    });

    it.each([
      ['Kennung mit Großbuchstaben', `('Admin', 'admin', '1')`, 'agent_kennung_form'],
      ['leere Rolle', `('admin', '', '1')`, 'agent_rolle_nicht_leer'],
      ['Rolle aus Leerzeichen', `('admin', '  ', '1')`, 'agent_rolle_nicht_leer'],
      ['leere Version', `('admin', 'admin', '')`, 'agent_version_nicht_leer'],
    ])('lehnt %s ab', async (_name, werte, constraint) => {
      const meldung = await abgelehnt(
        pool.query(`INSERT INTO cockpit.agent (kennung, rolle, version) VALUES ${werte}`),
      );

      expect(meldung).toContain(constraint);
    });

    it('kennt jeden Agenten nur einmal: das Inventar wird überschrieben, nicht verdoppelt', async () => {
      await pool.query(`INSERT INTO cockpit.agent (kennung, rolle, version) VALUES ('admin', 'admin', '1')`);

      const meldung = await abgelehnt(
        pool.query(`INSERT INTO cockpit.agent (kennung, rolle, version) VALUES ('admin', 'admin', '2')`),
      );

      expect(meldung).toContain('agent_pkey');
    });
  });

  describe('instanz', () => {
    it('hält genau eine Zeile: eine zweite wird abgelehnt', async () => {
      await pool.query(`INSERT INTO cockpit.instanz (version, digest) VALUES ('0.2.0', $1)`, [DIGEST_A]);

      const meldung = await abgelehnt(
        pool.query(`INSERT INTO cockpit.instanz (version, digest) VALUES ('0.3.0', $1)`, [DIGEST_B]),
      );

      expect(meldung).toContain('instanz_pkey');
    });

    it('lässt sich nicht mit einer anderen Kennung als der einen Zeile anlegen', async () => {
      const meldung = await abgelehnt(
        pool.query(`INSERT INTO cockpit.instanz (id, version) VALUES (false, '0.2.0')`),
      );

      expect(meldung).toContain('instanz_genau_eine_zeile');
    });

    it('kennt lokal keinen Digest: NULL ist erlaubt (Entwicklung ohne Image)', async () => {
      await pool.query(`INSERT INTO cockpit.instanz (version) VALUES ('0.2.0-dev')`);

      const zeile = await pool.query<{ digest: string | null; gestartet_am: Date }>(
        'SELECT digest, gestartet_am FROM cockpit.instanz',
      );

      expect(zeile.rows[0]?.digest).toBeNull();
      expect(zeile.rows[0]?.gestartet_am).toBeInstanceOf(Date);
    });

    it.each(['latest', 'sha256:abc', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `sha1:${'a'.repeat(64)}`, ''])(
      'lehnt den Digest „%s" ab: nur ein vollständiger sha256-Digest, nie ein bewegliches Tag',
      async (digest) => {
        const meldung = await abgelehnt(
          pool.query(`INSERT INTO cockpit.instanz (version, digest) VALUES ('0.2.0', $1)`, [digest]),
        );

        expect(meldung).toContain('instanz_digest_form');
      },
    );

    it('verlangt eine Version', async () => {
      const meldung = await abgelehnt(pool.query(`INSERT INTO cockpit.instanz (version) VALUES ('')`));

      expect(meldung).toContain('instanz_version_nicht_leer');
    });
  });

  describe('eingriff', () => {
    const STATUS = ['beantragt', 'freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen', 'zurueckgezogen'] as const;
    type Status = (typeof STATUS)[number];

    /**
     * Die einzigen erlaubten Kanten der Kette (ADR 13.1): beantragt → freigegeben → laeuft → erledigt | fehlgeschlagen.
     * Dazu seit Migration 0018 (COPI-40): ein Antrag, der noch nicht freigegeben ist, lässt sich zurückziehen.
     */
    const ERLAUBT: readonly (readonly [Status, Status])[] = [
      ['beantragt', 'freigegeben'],
      ['freigegeben', 'laeuft'],
      ['laeuft', 'erledigt'],
      ['laeuft', 'fehlgeschlagen'],
      ['beantragt', 'zurueckgezogen'],
    ];
    /** Wege, auf denen eine Zeile den jeweiligen Status erreicht — immer nur über erlaubte Kanten. */
    const WEG: Record<Status, readonly Status[]> = {
      beantragt: [],
      freigegeben: ['freigegeben'],
      laeuft: ['freigegeben', 'laeuft'],
      erledigt: ['freigegeben', 'laeuft', 'erledigt'],
      fehlgeschlagen: ['freigegeben', 'laeuft', 'fehlgeschlagen'],
      zurueckgezogen: ['zurueckgezogen'],
    };

    /** Die Version, die der Agent mit der Freigabe nennt, und die Selbstmeldung, die dazu passt (Migration 0020). */
    const ZIEL_VERSION = '0.2.0';
    const GEMELDETE_VERSION = '0.2.0+0123456';

    // `erledigt` verlangt eine Selbstmeldung mit Ziel-Digest und Ziel-Version (COPI-41): die steht hier für den
    // üblichen Antrag (Ziel DIGEST_B) bereit. Wer den Beleg selbst prüft, ersetzt sie.
    beforeEach(async () => {
      await pool.query('INSERT INTO cockpit.instanz (version, digest) VALUES ($1, $2)', [GEMELDETE_VERSION, DIGEST_B]);
    });

    async function antragStellen(werte: { digest?: string; vorher?: string } = {}): Promise<number> {
      const zeile = await pool.query<{ id: number }>(
        `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von)
         VALUES ('cockpit-image', $1, $2, 'konto-1') RETURNING id::int AS id`,
        [werte.digest ?? DIGEST_B, werte.vorher ?? DIGEST_A],
      );
      const id = zeile.rows[0]?.id;
      if (id === undefined) {
        throw new Error('Kein Antrag angelegt');
      }
      return id;
    }

    /**
     * Schaltet eine Zeile weiter, wie es der Weg der Anwendung täte: die Freigabe nennt die Ziel-Version (COPI-41), und
     * zwar nur aus „beantragt" — sonst bliebe bei einer verbotenen Kante die Version statt der Kante hängen.
     */
    async function wechseln(id: number, nach: Status): Promise<void> {
      await pool.query(
        `UPDATE cockpit.eingriff
            SET status = $2::text,
                ziel_version = CASE WHEN status = 'beantragt' AND $2::text = 'freigegeben' THEN $3 ELSE ziel_version END
          WHERE id = $1`,
        [id, nach, ZIEL_VERSION],
      );
    }

    async function antragIn(status: Status): Promise<number> {
      const id = await antragStellen();
      for (const schritt of WEG[status]) {
        await wechseln(id, schritt);
      }
      return id;
    }

    async function statusVon(id: number): Promise<string | undefined> {
      const zeile = await pool.query<{ status: string }>('SELECT status FROM cockpit.eingriff WHERE id = $1', [id]);
      return zeile.rows[0]?.status;
    }

    describe('der Antrag', () => {
      it('beginnt als „beantragt", ohne einen einzigen Übergangs-Zeitstempel', async () => {
        const id = await antragStellen();

        const zeile = await pool.query<Record<string, unknown>>('SELECT * FROM cockpit.eingriff WHERE id = $1', [id]);

        expect(zeile.rows[0]).toMatchObject({
          art: 'cockpit-image',
          ziel_digest: DIGEST_B,
          digest_vorher: DIGEST_A,
          beantragt_von: 'konto-1',
          status: 'beantragt',
          freigegeben_am: null,
          laeuft_seit: null,
          abgeschlossen_am: null,
        });
        expect(zeile.rows[0]?.beantragt_am).toBeInstanceOf(Date);
      });

      it('kennt nur die Arten „cockpit-image" und „modul" (seit 0040, COPI-106)', async () => {
        const meldung = await abgelehnt(
          pool.query(
            `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von)
             VALUES ('paket', $1, $2, 'konto-1')`,
            [DIGEST_B, DIGEST_A],
          ),
        );

        expect(meldung).toContain('eingriff_art_bekannt');
      });

      it('nimmt keinen Modul-Antrag mit Digests an: ein Modul nennt einen Commit', async () => {
        const meldung = await abgelehnt(
          pool.query(
            `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von)
             VALUES ('modul', $1, $2, 'konto-1')`,
            [DIGEST_B, DIGEST_A],
          ),
        );

        expect(meldung).toContain('eingriff_art_passt');
      });

      it('trägt den Weg zurück in derselben Zeile: ohne `digest_vorher` gibt es keinen Antrag', async () => {
        const meldung = await abgelehnt(
          pool.query(
            `INSERT INTO cockpit.eingriff (art, ziel_digest, beantragt_von)
             VALUES ('cockpit-image', $1, 'konto-1')`,
            [DIGEST_B],
          ),
        );

        // Seit 0040 sind die Digests nur beim Image Pflicht: die Regel heißt `eingriff_art_passt`.
        expect(meldung).toContain('eingriff_art_passt');
      });

      it.each(['latest', 'sha256:abc', `sha256:${'A'.repeat(64)}`, ''])(
        'lehnt den Ziel-Digest „%s" ab: die Freigabe lautet auf einen vollständigen Digest, nie auf ein Tag',
        async (digest) => {
          const meldung = await abgelehnt(antragStellen({ digest }));

          expect(meldung).toContain('eingriff_ziel_digest_form');
        },
      );

      it.each(['latest', 'sha256:abc', ''])('lehnt den vorherigen Digest „%s" ab', async (vorher) => {
        const meldung = await abgelehnt(antragStellen({ vorher }));

        expect(meldung).toContain('eingriff_digest_vorher_form');
      });

      it.each([['leer', ''], ['aus Leerzeichen', '  ']])(
        'verlangt, wer beantragt hat (%s ist keine Angabe)',
        async (_name, wer) => {
          const meldung = await abgelehnt(
            pool.query(
              `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von)
               VALUES ('cockpit-image', $1, $2, $3)`,
              [DIGEST_B, DIGEST_A, wer],
            ),
          );

          expect(meldung).toContain('eingriff_beantragt_von_nicht_leer');
        },
      );

      it.each(STATUS.filter((status) => status !== 'beantragt'))(
        'lässt sich nicht gleich als „%s" anlegen: die Kette beginnt immer bei „beantragt"',
        async (status) => {
          const meldung = await abgelehnt(
            pool.query(
              `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von, status)
               VALUES ('cockpit-image', $1, $2, 'konto-1', $3)`,
              [DIGEST_B, DIGEST_A, status],
            ),
          );

          expect(meldung).toContain('eingriff_start_status');
        },
      );

      it('lässt sich nicht mit gesetzten Übergangs-Zeitstempeln anlegen, um die Kette zu überspringen', async () => {
        const meldung = await abgelehnt(
          pool.query(
            `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von, freigegeben_am)
             VALUES ('cockpit-image', $1, $2, 'konto-1', now())`,
            [DIGEST_B, DIGEST_A],
          ),
        );

        expect(meldung).toContain('eingriff_zeitstempel_passen');
      });
    });

    describe('die Statuskette', () => {
      it('geht vorwärts durch: beantragt → freigegeben → laeuft → erledigt, und die Datenbank setzt jeden Zeitstempel', async () => {
        const id = await antragStellen();

        await wechseln(id, 'freigegeben');
        await wechseln(id, 'laeuft');
        await wechseln(id, 'erledigt');

        const zeile = await pool.query<{ status: string; geordnet: boolean; frisch: boolean }>(
          `SELECT status,
                  (beantragt_am <= freigegeben_am AND freigegeben_am <= laeuft_seit AND laeuft_seit <= abgeschlossen_am) AS geordnet,
                  (abgeschlossen_am > now() - interval '1 minute') AS frisch
             FROM cockpit.eingriff WHERE id = $1`,
          [id],
        );
        expect(zeile.rows[0]).toEqual({ status: 'erledigt', geordnet: true, frisch: true });
      });

      it('endet auch als „fehlgeschlagen", und zwar nur aus „laeuft"', async () => {
        const id = await antragIn('laeuft');

        await wechseln(id, 'fehlgeschlagen');

        const zeile = await pool.query<{ status: string; abgeschlossen: boolean }>(
          'SELECT status, abgeschlossen_am IS NOT NULL AS abgeschlossen FROM cockpit.eingriff WHERE id = $1',
          [id],
        );
        expect(zeile.rows[0]).toEqual({ status: 'fehlgeschlagen', abgeschlossen: true });
      });

      // Jede Kante, die nicht in der Kette steht: rückwärts, überspringen, aus einem Endzustand heraus.
      const VERBOTEN = STATUS.flatMap((von) =>
        STATUS.filter(
          (nach) => nach !== von && !ERLAUBT.some(([erlaubtVon, erlaubtNach]) => erlaubtVon === von && erlaubtNach === nach),
        ).map((nach): [Status, Status] => [von, nach]),
      );

      it('kennt genau fünf erlaubte und fünfundzwanzig verbotene Kanten', () => {
        expect(ERLAUBT).toHaveLength(5);
        expect(VERBOTEN).toHaveLength(25);
      });

      it('lässt einen Antrag zurückziehen, solange er nicht freigegeben ist, und setzt dabei nur den Abschluss (COPI-40)', async () => {
        const id = await antragStellen();

        await wechseln(id, 'zurueckgezogen');

        const zeile = await pool.query<Record<string, unknown>>(
          `SELECT status, freigegeben_am, laeuft_seit, abgeschlossen_am > now() - interval '1 minute' AS frisch
             FROM cockpit.eingriff WHERE id = $1`,
          [id],
        );
        expect(zeile.rows[0]).toEqual({ status: 'zurueckgezogen', freigegeben_am: null, laeuft_seit: null, frisch: true });
      });

      it.each(VERBOTEN)('lehnt den Übergang %s → %s ab und lässt die Zeile unverändert', async (von, nach) => {
        const id = await antragIn(von);

        const meldung = await abgelehnt(wechseln(id, nach));

        expect(meldung).toContain('eingriff_uebergang');
        expect(await statusVon(id)).toBe(von);
      });

      it('nimmt einen Wechsel auf den bisherigen Status als Nichtstun hin und ändert keinen Zeitstempel', async () => {
        const id = await antragIn('freigegeben');
        const vorher = await pool.query('SELECT freigegeben_am FROM cockpit.eingriff WHERE id = $1', [id]);

        await wechseln(id, 'freigegeben');

        const nachher = await pool.query('SELECT freigegeben_am FROM cockpit.eingriff WHERE id = $1', [id]);
        expect(nachher.rows[0]).toEqual(vorher.rows[0]);
      });

      it('speichert „haengt" nie: der Status ist abgeleitet (länger als 15 Minuten in „laeuft"), ADR 13.1', async () => {
        const id = await antragIn('laeuft');

        const meldung = await abgelehnt(pool.query(`UPDATE cockpit.eingriff SET status = 'haengt' WHERE id = $1`, [id]));

        expect(meldung).toContain('eingriff_uebergang');
        expect(await statusVon(id)).toBe('laeuft');
      });
    });

    /**
     * Höchstens ein offener Antrag je Art (COPI-40, Migration 0018): offen ist, was beantragt, freigegeben oder im Lauf
     * ist. Ein zweiter Antrag — auch mit einem anderen Ziel — wartet, bis der erste abgeschlossen oder zurückgezogen
     * ist. So gibt es für den Admin-Agenten nie zwei Updates des Cockpits zugleich.
     */
    describe('höchstens ein offener Antrag', () => {
      it.each(['beantragt', 'freigegeben', 'laeuft'] as const)(
        'lehnt einen zweiten Antrag ab, solange einer „%s" ist — auch mit anderem Ziel',
        async (status) => {
          await antragIn(status);

          const gleich = await abgelehnt(antragStellen());
          const anders = await abgelehnt(antragStellen({ digest: `sha256:${'c'.repeat(64)}` }));

          expect(gleich).toContain('eingriff_ein_offener_antrag');
          expect(anders).toContain('eingriff_ein_offener_antrag');
          const anzahl = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM cockpit.eingriff');
          expect(anzahl.rows[0]?.n).toBe(1);
        },
      );

      it.each(['erledigt', 'fehlgeschlagen', 'zurueckgezogen'] as const)(
        'nimmt einen neuen Antrag an, wenn der vorige „%s" ist',
        async (status) => {
          await antragIn(status);

          await expect(antragStellen()).resolves.toBeGreaterThan(0);
        },
      );
    });

    /**
     * Die Ziel-Version (COPI-41, Migration 0020): der Agent nennt sie mit der Freigabe, danach steht sie fest. Sie gehört
     * zum Erfolgsbeleg — ohne sie könnte ein altes Image mit neuem Digest aus der Umgebung ein Update vortäuschen.
     */
    describe('die Ziel-Version', () => {
      async function versionVon(id: number): Promise<string | null | undefined> {
        const zeile = await pool.query<{ ziel_version: string | null }>('SELECT ziel_version FROM cockpit.eingriff WHERE id = $1', [id]);
        return zeile.rows[0]?.ziel_version;
      }

      it('fehlt im Antrag und kommt mit der Freigabe', async () => {
        const id = await antragStellen();
        expect(await versionVon(id)).toBeNull();

        await wechseln(id, 'freigegeben');

        expect(await versionVon(id)).toBe(ZIEL_VERSION);
      });

      it('lässt sich nicht schon mit dem Antrag angeben: den Antrag stellt der Betreuer, die Version nennt die Freigabe', async () => {
        const meldung = await abgelehnt(
          pool.query(
            `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von, ziel_version)
             VALUES ('cockpit-image', $1, $2, 'konto-1', '0.2.0')`,
            [DIGEST_B, DIGEST_A],
          ),
        );

        expect(meldung).toContain('eingriff_ziel_version_passt');
      });

      it('ist Pflicht für die Freigabe', async () => {
        const id = await antragStellen();

        const meldung = await abgelehnt(pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben' WHERE id = $1`, [id]));

        expect(meldung).toContain('eingriff_ziel_version_passt');
        expect(await statusVon(id)).toBe('beantragt');
      });

      it('lässt sich vor der Freigabe nicht setzen, ohne freizugeben', async () => {
        const id = await antragStellen();

        const meldung = await abgelehnt(pool.query(`UPDATE cockpit.eingriff SET ziel_version = '0.2.0' WHERE id = $1`, [id]));

        expect(meldung).toContain('eingriff_ziel_version');
      });

      it.each(['freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen'] as const)(
        'lässt sich im Status „%s" nicht mehr ändern oder entfernen',
        async (status) => {
          const id = await antragIn(status);

          const geaendert = await abgelehnt(pool.query(`UPDATE cockpit.eingriff SET ziel_version = '0.3.0' WHERE id = $1`, [id]));
          const entfernt = await abgelehnt(pool.query('UPDATE cockpit.eingriff SET ziel_version = NULL WHERE id = $1', [id]));

          expect(geaendert).toContain('eingriff_ziel_version');
          expect(entfernt).toContain('eingriff_ziel_version');
          expect(await versionVon(id)).toBe(ZIEL_VERSION);
        },
      );

      it('lässt sich auch nicht im selben Zug mit dem nächsten Übergang ändern', async () => {
        const id = await antragIn('freigegeben');

        const meldung = await abgelehnt(
          pool.query(`UPDATE cockpit.eingriff SET status = 'laeuft', ziel_version = '0.3.0' WHERE id = $1`, [id]),
        );

        expect(meldung).toContain('eingriff_ziel_version');
        expect(await statusVon(id)).toBe('freigegeben');
      });

      it.each(['1.4.0', '0.2.0', '10.20.30', '1.4.0-rc.1', '1.0.0-alpha-2.x'])('nimmt die Version „%s" an', async (version) => {
        const id = await antragStellen();

        await pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben', ziel_version = $2 WHERE id = $1`, [id, version]);

        expect(await versionVon(id)).toBe(version);
      });

      it.each(['', '1.4', 'v1.4.0', '1.4.0+0123456', '01.4.0', '1.4.0-', '1.4.0 ', 'latest', `1.4.0-${'x'.repeat(60)}`])(
        'lehnt die Version %j ab: SemVer ohne Build-Metadaten, wie das Tag des Release',
        async (version) => {
          const id = await antragStellen();

          const meldung = await abgelehnt(
            pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben', ziel_version = $2 WHERE id = $1`, [id, version]),
          );

          expect(meldung).toContain('eingriff_ziel_version_form');
          expect(await statusVon(id)).toBe('beantragt');
        },
      );
    });

    /**
     * Der Erfolgsbeleg (ADR 13.1, COPI-41): `erledigt` nur, wenn sich ein Cockpit mit Ziel-Digest und Ziel-Version
     * gemeldet hat. Das Cockpit setzt es beim Start selbst; die Datenbank lässt es ohne Beleg auch sonst nicht zu.
     */
    describe('erledigt nur mit Beleg', () => {
      async function instanzMelden(version: string, digest: string | null): Promise<void> {
        await pool.query('DELETE FROM cockpit.instanz');
        await pool.query('INSERT INTO cockpit.instanz (version, digest) VALUES ($1, $2)', [version, digest]);
      }

      it.each([
        ['ohne Selbstmeldung', undefined],
        ['mit einem anderen Digest', { version: GEMELDETE_VERSION, digest: DIGEST_A }],
        ['ohne Digest (lokal gebaut)', { version: GEMELDETE_VERSION, digest: null }],
        ['mit einer anderen Version (alter Stand, neuer Digest aus der Umgebung)', { version: '0.1.9+0123456', digest: DIGEST_B }],
        ['mit einer Vorabversion derselben Nummer', { version: '0.2.0-rc.1+0123456', digest: DIGEST_B }],
      ])('lehnt „erledigt" %s ab und lässt die Zeile in „laeuft"', async (_name, meldung) => {
        const id = await antragIn('laeuft');
        await pool.query('DELETE FROM cockpit.instanz');
        if (meldung !== undefined) {
          await instanzMelden(meldung.version, meldung.digest);
        }

        const fehler = await abgelehnt(wechseln(id, 'erledigt'));

        expect(fehler).toContain('eingriff_ohne_beleg');
        expect(await statusVon(id)).toBe('laeuft');
      });

      it.each(['0.2.0+0123456', '0.2.0+lokal', '0.2.0'])(
        'nimmt „erledigt" an, wenn die Selbstmeldung %j Ziel-Digest und Ziel-Version trägt: der Commit zählt nicht',
        async (version) => {
          const id = await antragIn('laeuft');
          await instanzMelden(version, DIGEST_B);

          await wechseln(id, 'erledigt');

          expect(await statusVon(id)).toBe('erledigt');
        },
      );

      it('braucht keinen Beleg für „fehlgeschlagen": ein Fehlschlag meldet sich gerade nicht', async () => {
        const id = await antragIn('laeuft');
        await pool.query('DELETE FROM cockpit.instanz');

        await wechseln(id, 'fehlgeschlagen');

        expect(await statusVon(id)).toBe('fehlgeschlagen');
      });
    });

    describe('was nach dem Antrag feststeht', () => {
      it.each([
        ['die Art', `SET art = 'modul'`],
        ['der Ziel-Digest', `SET ziel_digest = '${DIGEST_A}'`],
        ['der vorherige Digest', `SET digest_vorher = '${DIGEST_B}'`],
        ['wer beantragt hat', `SET beantragt_von = 'konto-2'`],
        ['der Zeitpunkt des Antrags', `SET beantragt_am = '2001-01-01T00:00:00Z'`],
      ])('lässt sich %s nicht mehr ändern', async (_name, aenderung) => {
        const id = await antragStellen();

        const meldung = await abgelehnt(pool.query(`UPDATE cockpit.eingriff ${aenderung} WHERE id = $1`, [id]));

        // Die Freigabe lautet auf Vorgangs-ID und Ziel-Digest (ADR 13.1); änderte sich der Digest, wäre sie wertlos.
        expect(meldung).toContain('eingriff_unveraenderlich');
      });

      it('lässt den Ziel-Digest auch nicht im selben Zug mit einem erlaubten Statuswechsel ändern', async () => {
        const id = await antragStellen();

        const meldung = await abgelehnt(
          pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben', ziel_digest = $2 WHERE id = $1`, [id, DIGEST_A]),
        );

        expect(meldung).toContain('eingriff_unveraenderlich');
        expect(await statusVon(id)).toBe('beantragt');
      });

      it('lässt die Zeitstempel nicht von Hand setzen, auch nicht beim Statuswechsel: sie kommen von der Datenbank', async () => {
        const id = await antragStellen();

        const meldung = await abgelehnt(
          pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben', freigegeben_am = '2001-01-01T00:00:00Z' WHERE id = $1`, [id]),
        );

        expect(meldung).toContain('eingriff_zeitstempel');
        expect(await statusVon(id)).toBe('beantragt');
      });

      it('lässt einen gesetzten Zeitstempel auch ohne Statuswechsel nicht nachträglich verschieben', async () => {
        const id = await antragIn('freigegeben');

        const meldung = await abgelehnt(
          pool.query(`UPDATE cockpit.eingriff SET freigegeben_am = '2001-01-01T00:00:00Z' WHERE id = $1`, [id]),
        );

        expect(meldung).toContain('eingriff_zeitstempel');
      });
    });
  });
});

describe.skipIf(!datenbankUrl)('Migration des Zustandsbilds gegen eine leere Datenbank', { timeout: LEERE_DATENBANK_TIMEOUT_MS }, () => {
  const TABELLEN = ['wache', 'befund', 'agent', 'instanz', 'eingriff'] as const;
  const MIGRATION = '0015_zustandsbild';

  let datenbank: LeereDatenbank;
  let pool: pg.Pool;

  beforeEach(async () => {
    datenbank = await leereDatenbankAnlegen(datenbankUrl ?? '');
    pool = datenbank.neuerPool();
  });

  afterEach(async () => {
    await datenbank.aufraeumen();
  });

  async function vorhandeneTabellen(): Promise<string[]> {
    const zeilen = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'cockpit' AND table_name = ANY($1) ORDER BY table_name`,
      [[...TABELLEN]],
    );
    return zeilen.rows.map((zeile) => zeile.table_name);
  }

  /**
   * Nimmt Migrationen zurück, bis `MIGRATION` an der Reihe war (spätere kommen zuerst). So hängt der
   * Test nicht an der Zahl der Migrationen, die nach dieser noch dazukommen.
   */
  async function zuruecknehmenBisEinschliesslichMigration(): Promise<void> {
    for (;;) {
      const id = await migrationZuruecknehmen(pool);
      if (id === undefined) {
        throw new Error(`${MIGRATION} war nie angewendet: es wurde nichts zurückgenommen.`);
      }
      if (id === MIGRATION) {
        return;
      }
    }
  }

  it('legt alle fünf Tabellen an', async () => {
    const angewendet = await migrationenAnwenden(pool);

    expect(angewendet).toContain(MIGRATION);
    expect(await vorhandeneTabellen()).toEqual([...TABELLEN].sort());
  });

  it('nimmt sie mit der Down-Migration wieder mit — und was davor kam, bleibt unberührt', async () => {
    await migrationenAnwenden(pool);

    await zuruecknehmenBisEinschliesslichMigration();

    expect(await vorhandeneTabellen()).toEqual([]);
    const davor = await pool.query<{ da: boolean }>(`SELECT to_regclass('cockpit.zugang_wiederherstellung') IS NOT NULL AS da`);
    expect(davor.rows[0]?.da).toBe(true);
  });

  it('trägt nach dem Zurücknehmen keine Funktion des Eingriffs mehr im Schema', async () => {
    await migrationenAnwenden(pool);

    await zuruecknehmenBisEinschliesslichMigration();

    const funktionen = await pool.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'cockpit' AND p.proname LIKE 'eingriff%'`,
    );
    expect(funktionen.rows).toEqual([]);
  });

  it('lässt sich danach wieder vorwärts anwenden', async () => {
    await migrationenAnwenden(pool);
    await zuruecknehmenBisEinschliesslichMigration();

    await migrationenAnwenden(pool);

    expect(await vorhandeneTabellen()).toEqual([...TABELLEN].sort());
  });

  describe('Migration 0017: der Anzeigename der Wache (COPI-37)', () => {
    async function hatSpalte(): Promise<boolean> {
      const zeile = await pool.query<{ da: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'cockpit' AND table_name = 'wache' AND column_name = 'anzeigename') AS da`,
      );
      return zeile.rows[0]?.da === true;
    }

    async function zuruecknehmenBis(id: string): Promise<void> {
      for (;;) {
        const genommen = await migrationZuruecknehmen(pool);
        if (genommen === undefined) {
          throw new Error(`${id} war nie angewendet`);
        }
        if (genommen === id) {
          return;
        }
      }
    }

    it('legt die Spalte an', async () => {
      const angewendet = await migrationenAnwenden(pool);

      expect(angewendet).toContain('0017_wache_anzeigename');
      expect(await hatSpalte()).toBe(true);
    });

    it('nimmt sie mit der Down-Migration wieder mit, ohne die Tabelle und ihre Zeilen anzufassen', async () => {
      await migrationenAnwenden(pool);
      await pool.query(`INSERT INTO cockpit.wache (kennung, takt_sekunden, anzeigename) VALUES ('container', 300, 'Buchungen')`);

      await zuruecknehmenBis('0017_wache_anzeigename');

      expect(await hatSpalte()).toBe(false);
      const zeile = await pool.query<{ takt_sekunden: number }>(`SELECT takt_sekunden FROM cockpit.wache WHERE kennung = 'container'`);
      expect(zeile.rows[0]?.takt_sekunden).toBe(300);
    });

    it('lässt sich danach wieder vorwärts anwenden', async () => {
      await migrationenAnwenden(pool);
      await zuruecknehmenBis('0017_wache_anzeigename');

      await migrationenAnwenden(pool);

      expect(await hatSpalte()).toBe(true);
    });
  });

  describe('Migration 0018: der Update-Antrag (COPI-40)', () => {
    const MIGRATION_0018 = '0018_update_antrag';

    async function hatIndex(): Promise<boolean> {
      const zeile = await pool.query<{ da: boolean }>(`SELECT to_regclass('cockpit.eingriff_ein_offener_antrag') IS NOT NULL AS da`);
      return zeile.rows[0]?.da === true;
    }

    async function zuruecknehmenBis0018(): Promise<void> {
      for (;;) {
        const genommen = await migrationZuruecknehmen(pool);
        if (genommen === undefined) {
          throw new Error(`${MIGRATION_0018} war nie angewendet`);
        }
        if (genommen === MIGRATION_0018) {
          return;
        }
      }
    }

    async function antrag(): Promise<number> {
      const zeile = await pool.query<{ id: number }>(
        `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von)
         VALUES ('cockpit-image', $1, $2, 'konto-1') RETURNING id::int AS id`,
        [DIGEST_B, DIGEST_A],
      );
      return zeile.rows[0]?.id ?? 0;
    }

    it('legt die Regel „höchstens ein offener Antrag" an', async () => {
      const angewendet = await migrationenAnwenden(pool);

      expect(angewendet).toContain(MIGRATION_0018);
      expect(await hatIndex()).toBe(true);
    });

    it('nimmt Rückzug und Regel zurück, lässt aber zurückgezogene Anträge und ihr Protokoll stehen', async () => {
      await migrationenAnwenden(pool);
      const id = await antrag();
      await pool.query(`UPDATE cockpit.eingriff SET status = 'zurueckgezogen' WHERE id = $1`, [id]);
      await pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('update_zurueckgezogen', 'konto-1')`);

      await zuruecknehmenBis0018();

      expect(await hatIndex()).toBe(false);
      const zeile = await pool.query<{ status: string }>('SELECT status FROM cockpit.eingriff WHERE id = $1', [id]);
      expect(zeile.rows[0]?.status).toBe('zurueckgezogen');
      // Die alte Kette gilt wieder: ein neuer Antrag lässt sich nicht mehr zurückziehen.
      const neu = await antrag();
      await expect(pool.query(`UPDATE cockpit.eingriff SET status = 'zurueckgezogen' WHERE id = $1`, [neu])).rejects.toThrow(
        /eingriff_uebergang/,
      );
      await expect(pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('update_beantragt', 'konto-1')`)).rejects.toThrow(
        /protokoll_art_bekannt/,
      );
    });

    it('lässt sich danach wieder vorwärts anwenden', async () => {
      await migrationenAnwenden(pool);
      await zuruecknehmenBis0018();

      await migrationenAnwenden(pool);

      expect(await hatIndex()).toBe(true);
    });
  });

  describe('Migration 0020: der Lebenszyklus des Eingriffs (COPI-41)', () => {
    const MIGRATION_0020 = '0020_eingriff_lebenszyklus';

    async function hatSpalte(): Promise<boolean> {
      const zeile = await pool.query<{ da: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'cockpit' AND table_name = 'eingriff' AND column_name = 'ziel_version') AS da`,
      );
      return zeile.rows[0]?.da === true;
    }

    async function zuruecknehmenBis0020(): Promise<void> {
      for (;;) {
        const genommen = await migrationZuruecknehmen(pool);
        if (genommen === undefined) {
          throw new Error(`${MIGRATION_0020} war nie angewendet`);
        }
        if (genommen === MIGRATION_0020) {
          return;
        }
      }
    }

    /** Ein Antrag, freigegeben mit Version und bis „erledigt" gebracht — mit dem Beleg, den 0020 verlangt. */
    async function erledigterAntrag(): Promise<number> {
      await pool.query('INSERT INTO cockpit.instanz (version, digest) VALUES ($1, $2)', ['0.2.0+0123456', DIGEST_B]);
      const zeile = await pool.query<{ id: number }>(
        `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von)
         VALUES ('cockpit-image', $1, $2, 'konto-1') RETURNING id::int AS id`,
        [DIGEST_B, DIGEST_A],
      );
      const id = zeile.rows[0]?.id ?? 0;
      await pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben', ziel_version = '0.2.0' WHERE id = $1`, [id]);
      await pool.query(`UPDATE cockpit.eingriff SET status = 'laeuft' WHERE id = $1`, [id]);
      await pool.query(`UPDATE cockpit.eingriff SET status = 'erledigt' WHERE id = $1`, [id]);
      return id;
    }

    it('legt die Spalte an', async () => {
      const angewendet = await migrationenAnwenden(pool);

      expect(angewendet).toContain(MIGRATION_0020);
      expect(await hatSpalte()).toBe(true);
    });

    it('nimmt Spalte, Beleg und Protokollarten zurück, lässt aber Eingriffe und ihr Protokoll stehen', async () => {
      await migrationenAnwenden(pool);
      const id = await erledigterAntrag();
      await pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('update_erledigt', 'system')`);

      await zuruecknehmenBis0020();

      expect(await hatSpalte()).toBe(false);
      const zeile = await pool.query<{ status: string }>('SELECT status FROM cockpit.eingriff WHERE id = $1', [id]);
      expect(zeile.rows[0]?.status).toBe('erledigt');
      // Die Kette aus 0018 gilt wieder: freigeben ohne Version, erledigt ohne Beleg.
      await pool.query('DELETE FROM cockpit.instanz');
      const neu = await pool.query<{ id: number }>(
        `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von)
         VALUES ('cockpit-image', $1, $2, 'konto-1') RETURNING id::int AS id`,
        [DIGEST_A, DIGEST_B],
      );
      for (const status of ['freigegeben', 'laeuft', 'erledigt']) {
        await pool.query('UPDATE cockpit.eingriff SET status = $2 WHERE id = $1', [neu.rows[0]?.id, status]);
      }
      await expect(pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('update_freigegeben', 'konto-1')`)).rejects.toThrow(
        /protokoll_art_bekannt/,
      );
    });

    it('lässt sich danach wieder vorwärts anwenden', async () => {
      await migrationenAnwenden(pool);
      await zuruecknehmenBis0020();

      await migrationenAnwenden(pool);

      expect(await hatSpalte()).toBe(true);
    });
  });
});
