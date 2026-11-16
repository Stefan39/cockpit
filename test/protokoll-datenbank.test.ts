/**
 * Das Protokoll in der Datenbank (COPI-23): nur anhängen, bekannte Arten, keine
 * Bindung an Konten.
 *
 * Läuft nur mit `TEST_DATABASE_URL` (echte PostgreSQL). Das Protokoll lässt sich
 * nicht abräumen — das ist der Punkt —, die Testdatenbank wächst also von Lauf zu
 * Lauf. Tests zählen deshalb nie „alle Einträge", sondern die seit einer Marke.
 * Zurücksetzen: `DROP DATABASE cockpit_test`, der nächste Lauf legt sie neu an.
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTOKOLL_ARTEN, protokollNotieren, protokollSchreiben, type Ereignis } from '../src/auth/protokoll.js';
import { migrationenAnwenden, migrationZuruecknehmen } from '../src/datenbank/migrationen.js';
import { kontenLoeschen, protokollMarke, protokollSeit } from './hilfen.js';
import { leereDatenbankAnlegen, type LeereDatenbank, LEERE_DATENBANK_TIMEOUT_MS } from './leere-datenbank.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const KONTO = 'protokolltest_konto_1';

/** Die Ereignisse dieses Tickets, als Literal: die Tabelle soll genau diese kennen. */
const ARTEN = [
  'konto_angelegt',
  'einladung_erzeugt',
  'einladung_eingeloest',
  'anmeldung_erfolgreich',
  'anmeldung_fehlgeschlagen',
  'sperre_ausgeloest',
  'zweiter_faktor_eingerichtet',
  'ersatzcode_verwendet',
  'abmeldung',
  'konto_verfallen',
  'betreuer_uebergeben',
  'erststart_token_erzeugt',
  // Update-Antrag (COPI-40, Migration 0018).
  'update_beantragt',
  'update_zurueckgezogen',
  // Übergänge des Eingriffs (COPI-41, Migrationen 0019 und 0020).
  'update_freigegeben',
  'update_gestartet',
  'update_erledigt',
  'update_fehlgeschlagen',
  // Konten bearbeiten (COPI-46, Migration 0022).
  'name_geaendert',
  'rolle_geaendert',
  'konto_entfernt',
  // E-Mail ändern (COPI-47, Migration 0023).
  'email_aenderung_beantragt',
  'email_geaendert',
  // E-Mail-Zweitkanal des Chats (COPI-60, Migration 0027).
  'chat_mail_gesendet',
  // Übernahme-Sperre (COPI-85, Migration 0030).
  'vorgang_uebernommen',
  'vorgang_zurueckgegeben',
  // App-Symbol (COPI-101, Migration 0035).
  'erscheinungsbild_geaendert',
  // Antwort freigeben (COPI-90, Migration 0038).
  'antwort_freigegeben',
  'freigabe_zurueckgezogen',
  // Zweite Faktoren verwalten (COPI-94, Migration 0042).
  'zweiter_faktor_hinzugefuegt',
  'zweiter_faktor_entfernt',
  'ersatzcodes_erneuert',
  'faktor_bestaetigt',
  // Anhang heruntergeladen (COPI-110, Migration 0044).
  'anhang_heruntergeladen',
  // Entscheidung (COPI-91, Migration 0045).
  'entscheidung_getroffen',
  'entscheidung_zurueckgenommen',
  // Betreuer-Zugriff (COPI-134, Migration 0048).
  'betreuer_zugriff_geaendert',
  // Freigabemodus für Updates (COPI-141, Migration 0050).
  'update_freigabemodus_geaendert',
];

describe.skipIf(!datenbankUrl)('Protokoll (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function eintragAnlegen(art = 'anmeldung_erfolgreich'): Promise<string> {
    const ergebnis = await pool.query<{ id: string }>(
      `INSERT INTO cockpit.protokoll (art, akteur) VALUES ($1, $2) RETURNING id::text AS id`,
      [art, KONTO],
    );
    return ergebnis.rows[0]?.id ?? '';
  }

  async function eintragVorhanden(id: string): Promise<boolean> {
    const ergebnis = await pool.query('SELECT 1 FROM cockpit.protokoll WHERE id = $1', [id]);
    return (ergebnis.rowCount ?? 0) === 1;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('nur anhängen', () => {
    it('legt einen Eintrag mit fortlaufender Nummer und Zeitpunkt an', async () => {
      const marke = await protokollMarke(pool);

      await protokollSchreiben(pool, { art: 'abmeldung', akteur: KONTO, ziel: KONTO });

      const zeilen = await pool.query<{ id: string; zeitpunkt: Date }>(
        'SELECT id::text AS id, zeitpunkt FROM cockpit.protokoll WHERE id > $1',
        [marke],
      );
      expect(zeilen.rows).toHaveLength(1);
      expect(Math.abs(Date.now() - (zeilen.rows[0]?.zeitpunkt.getTime() ?? 0))).toBeLessThan(60_000);
    });

    it('lässt keinen Eintrag ändern', async () => {
      const id = await eintragAnlegen();

      await expect(
        pool.query(`UPDATE cockpit.protokoll SET art = 'abmeldung' WHERE id = $1`, [id]),
      ).rejects.toThrow(/protokoll_nur_anhaengen/);
      await expect(
        pool.query(`UPDATE cockpit.protokoll SET akteur = 'anderer'`),
      ).rejects.toThrow(/protokoll_nur_anhaengen/);

      const zeile = await pool.query<{ art: string }>(
        'SELECT art FROM cockpit.protokoll WHERE id = $1',
        [id],
      );
      expect(zeile.rows[0]?.art).toBe('anmeldung_erfolgreich');
    });

    it('lässt keinen Eintrag löschen', async () => {
      const id = await eintragAnlegen();

      await expect(pool.query('DELETE FROM cockpit.protokoll WHERE id = $1', [id])).rejects.toThrow(
        /protokoll_nur_anhaengen/,
      );
      await expect(pool.query('DELETE FROM cockpit.protokoll')).rejects.toThrow(
        /protokoll_nur_anhaengen/,
      );

      expect(await eintragVorhanden(id)).toBe(true);
    });

    it('lässt das Protokoll nicht leeren', async () => {
      const id = await eintragAnlegen();

      await expect(pool.query('TRUNCATE cockpit.protokoll')).rejects.toThrow(
        /protokoll_nur_anhaengen/,
      );

      expect(await eintragVorhanden(id)).toBe(true);
    });

    it('lässt auch innerhalb einer Transaktion nichts ändern oder löschen', async () => {
      const id = await eintragAnlegen();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expect(client.query('DELETE FROM cockpit.protokoll WHERE id = $1', [id])).rejects.toThrow(
          /protokoll_nur_anhaengen/,
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      expect(await eintragVorhanden(id)).toBe(true);
    });
  });

  describe('bekannte Ereignisse', () => {
    it.each(ARTEN)('nimmt die Art %s an', async (art) => {
      await expect(eintragAnlegen(art)).resolves.not.toBe('');
    });

    it('kennt keine andere Art', async () => {
      await expect(eintragAnlegen('irgendwas')).rejects.toThrow(/protokoll_art_bekannt/);
    });

    it('kennt in der Tabelle protokoll_art genau die Arten der Anwendung (Migration 0019)', async () => {
      const arten = await pool.query<{ art: string }>('SELECT art FROM cockpit.protokoll_art ORDER BY art');

      expect(arten.rows.map((zeile) => zeile.art)).toEqual([...PROTOKOLL_ARTEN].sort());
    });

    it('verlangt einen Akteur', async () => {
      await expect(
        pool.query(`INSERT INTO cockpit.protokoll (art) VALUES ('abmeldung')`),
      ).rejects.toThrow(/akteur/);
    });
  });

  describe('keine Bindung an Konten', () => {
    it('lässt den Eintrag stehen, wenn das Konto verschwindet', async () => {
      const marke = await protokollMarke(pool);
      await pool.query(
        `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
         VALUES ('protokolltest_kontoweg', 'weg@example.org', 'weg', true, now(), now())`,
      );
      await protokollSchreiben(pool, {
        art: 'konto_verfallen',
        akteur: 'system',
        ziel: 'protokolltest_kontoweg',
      });

      await kontenLoeschen(pool);

      const neu = await protokollSeit(pool, marke);
      expect(neu.map((zeile) => zeile.ziel)).toEqual(['protokolltest_kontoweg']);
    });
  });

  describe('protokollSchreiben', () => {
    it('schreibt Einzelheiten als kleines JSON-Objekt', async () => {
      const marke = await protokollMarke(pool);

      await protokollSchreiben(pool, {
        art: 'konto_angelegt',
        akteur: 'erststart',
        ziel: KONTO,
        einzelheiten: { weg: 'erststart', rolle: 'betreuer', einladung_id: 7 },
      });

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'konto_angelegt',
          akteur: 'erststart',
          ziel: KONTO,
          einzelheiten: { weg: 'erststart', rolle: 'betreuer', einladung_id: 7 },
        },
      ]);
    });

    it('schreibt nichts, wenn das Ereignis abgewiesen wird', async () => {
      const marke = await protokollMarke(pool);

      await expect(
        protokollSchreiben(pool, { art: 'anmeldung_erfolgreich', akteur: 'stefan@example.org' }),
      ).rejects.toThrow(/Protokoll/);

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('gehört zur Transaktion des Aufrufers: ein Rollback nimmt den Eintrag zurück', async () => {
      const marke = await protokollMarke(pool);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await protokollSchreiben(client, { art: 'abmeldung', akteur: KONTO });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      expect(await protokollSeit(pool, marke)).toEqual([]);
    });
  });

  describe('protokollNotieren', () => {
    const ereignis: Ereignis = { art: 'abmeldung', akteur: KONTO };

    it('schreibt wie protokollSchreiben, wenn alles gut geht', async () => {
      const marke = await protokollMarke(pool);
      const meldungen: string[] = [];

      await protokollNotieren(pool, { error: (_o, n) => meldungen.push(n) }, ereignis);

      expect(meldungen).toEqual([]);
      expect(await protokollSeit(pool, marke)).toHaveLength(1);
    });

    it('meldet einen Datenbankfehler laut und wirft nicht', async () => {
      const meldungen: { grund: string; nachricht: string }[] = [];
      const kaputt = { query: () => Promise.reject(new Error('Verbindung weg')) };

      await expect(
        protokollNotieren(
          kaputt as never,
          { error: (o, n) => meldungen.push({ grund: o.grund, nachricht: n }) },
          ereignis,
        ),
      ).resolves.toBeUndefined();

      expect(meldungen).toHaveLength(1);
      expect(meldungen[0]?.grund).toContain('Verbindung weg');
      expect(meldungen[0]?.nachricht).toContain('abmeldung');
    });

    it('meldet ein abgewiesenes Ereignis laut, ohne es zu wiederholen', async () => {
      const meldungen: string[] = [];

      await protokollNotieren(
        pool,
        { error: (o) => meldungen.push(o.grund) },
        { art: 'abmeldung', akteur: 'stefan@example.org' },
      );

      expect(meldungen).toHaveLength(1);
      expect(meldungen[0]).not.toContain('stefan@example.org');
    });
  });

  describe('Datensparsamkeit über alle Einträge', () => {
    it('enthält in keiner Zeile eine Adresse, ein Passwort oder ein Token', async () => {
      // Über alle Zeilen, auch die aus früheren Läufen und aus den Abläufen der
      // anderen Testdateien (Anmeldung, Einladung, Erststart, ...). Gesucht wird
      // nach den Testpasswörtern selbst, nicht nach dem Wort „passwort": das ist
      // als Schritt der Anmeldung ein erlaubter fester Begriff.
      const treffer = await pool.query<{ zeile: string }>(
        `SELECT p::text AS zeile FROM cockpit.protokoll p
          WHERE p::text LIKE '%@%'
             OR p::text ILIKE '%ein-ausreichend-langes%'
             OR p::text ~ '[A-Za-z0-9_-]{41,}'
          LIMIT 5`,
      );

      expect(treffer.rows).toEqual([]);
    });
  });
});

/**
 * Migration 0019 (COPI-41): die Protokollarten als Tabelle statt als Liste in der Bedingung. Übernommen wird die Liste
 * aus der bisherigen Bedingung, nicht abgeschrieben; zurück entsteht die Bedingung aus der Tabelle. Jede Probe läuft auf
 * einer eigenen, leeren Datenbank.
 */
describe.skipIf(!datenbankUrl)('Migration 0019: Protokollarten als Tabelle (echte Datenbank)', { timeout: LEERE_DATENBANK_TIMEOUT_MS }, () => {
  const MIGRATION = '0019_protokoll_arten';
  let datenbank: LeereDatenbank;
  let pool: pg.Pool;

  beforeEach(async () => {
    datenbank = await leereDatenbankAnlegen(datenbankUrl ?? '');
    pool = datenbank.neuerPool();
  });

  afterEach(async () => {
    await datenbank.aufraeumen();
  });

  /** Nimmt Migrationen zurück, bis `id` zurückgenommen ist (spätere zuerst). */
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

  /** Wendet an, was vor 0019 kommt: alles, dann bis einschließlich 0019 zurück. */
  async function standVor0019(): Promise<void> {
    await migrationenAnwenden(pool);
    await zuruecknehmenBis(MIGRATION);
  }

  async function arten(): Promise<string[]> {
    const ergebnis = await pool.query<{ art: string }>('SELECT art FROM cockpit.protokoll_art ORDER BY art');
    return ergebnis.rows.map((zeile) => zeile.art);
  }

  it('übernimmt die 19 Arten der bisherigen Bedingung, dazu die späterer Migrationen (0020, 0022, 0023, 0027, 0030, 0035, 0038, 0042, 0044, 0045, 0048, 0050)', async () => {
    await migrationenAnwenden(pool);

    expect(await arten()).toEqual([...PROTOKOLL_ARTEN].sort());
    expect(await arten()).toHaveLength(43);
  });

  it('übernimmt auch eine Art, die ein Eintrag nutzt, aber nicht mehr in der Bedingung steht', async () => {
    await standVor0019();
    // Wie nach einer früheren Down-Migration mit `NOT VALID`: der Eintrag bleibt, die Art steht nicht mehr in der Liste.
    await pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('abmeldung', 'konto-1')`);
    await pool.query('ALTER TABLE cockpit.protokoll DROP CONSTRAINT protokoll_art_bekannt');
    await pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('alte_art', 'konto-1')`);
    await pool.query(
      `ALTER TABLE cockpit.protokoll ADD CONSTRAINT protokoll_art_bekannt CHECK (art IN (${[...PROTOKOLL_ARTEN]
        .slice(0, 19)
        .map((art) => `'${art}'`)
        .join(', ')})) NOT VALID`,
    );

    await migrationenAnwenden(pool);

    expect(await arten()).toContain('alte_art');
  });

  it('lässt sich wieder anwenden, wenn beim Zurücknehmen eine genutzte Art des Eingriffs stehen blieb', async () => {
    await migrationenAnwenden(pool);
    await pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('update_erledigt', 'system')`);
    await zuruecknehmenBis(MIGRATION);

    await migrationenAnwenden(pool);

    expect(await arten()).toEqual([...PROTOKOLL_ARTEN].sort());
  });

  it('bricht ab, wenn die bisherige Bedingung weniger als 19 Arten ergibt, statt eine halbe Liste zu übernehmen', async () => {
    await standVor0019();
    await pool.query('ALTER TABLE cockpit.protokoll DROP CONSTRAINT protokoll_art_bekannt');
    await pool.query(`ALTER TABLE cockpit.protokoll ADD CONSTRAINT protokoll_art_bekannt CHECK (art IN ('abmeldung'))`);

    await expect(migrationenAnwenden(pool)).rejects.toThrow(/protokoll_art_uebernahme/);
  });

  it('lehnt eine unbekannte Art unter demselben Namen ab: protokoll_art_bekannt', async () => {
    await migrationenAnwenden(pool);

    await expect(pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('irgendwas', 'konto-1')`)).rejects.toThrow(
      /protokoll_art_bekannt/,
    );
  });

  it('baut beim Zurücknehmen die Bedingung aus der Tabelle, und danach geht es wieder vorwärts', async () => {
    await migrationenAnwenden(pool);
    await pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('update_beantragt', 'konto-1')`);

    await zuruecknehmenBis(MIGRATION);

    const tabelle = await pool.query<{ da: boolean }>(`SELECT to_regclass('cockpit.protokoll_art') IS NOT NULL AS da`);
    expect(tabelle.rows[0]?.da).toBe(false);
    await pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('konto_angelegt', 'konto-1')`);
    await expect(pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('irgendwas', 'konto-1')`)).rejects.toThrow(
      /protokoll_art_bekannt/,
    );
    // Die Arten des Eingriffs nahm 0020 zurück: sie gelten nicht mehr.
    await expect(pool.query(`INSERT INTO cockpit.protokoll (art, akteur) VALUES ('update_gestartet', 'konto-1')`)).rejects.toThrow(
      /protokoll_art_bekannt/,
    );

    await migrationenAnwenden(pool);

    expect(await arten()).toEqual([...PROTOKOLL_ARTEN].sort());
  });
});
