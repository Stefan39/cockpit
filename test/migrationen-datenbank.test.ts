/**
 * Migrationen gegen eine echte PostgreSQL (COPI-31). Läuft nur, wenn `TEST_DATABASE_URL`
 * gesetzt ist.
 *
 * Jeder Test bekommt eine **eigene, leere** Datenbank auf demselben Server (`leere-datenbank.ts`)
 * und löscht sie am Ende. Die Testdatenbank der übrigen Tests wird nicht angefasst.
 *
 * Auf einer neuen Kundeninstanz entsteht das Schema, ohne dass jemand von Hand SQL ausführt:
 * dafür braucht das Image den Runner (`src/datenbank/migrationen.ts`) und die Migrationen. Hier
 * steht, was er leisten muss: aus einer leeren Datenbank das ganze Schema machen, beim zweiten
 * Lauf nichts tun, bei zwei gleichzeitigen Läufen niemanden überholen, bei einer kaputten
 * Migration nichts Halbes hinterlassen und die ganze Kette auch rückwärts gehen.
 */
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  migrationenAnwenden,
  migrationenLaden,
  migrationsstand,
  migrationZuruecknehmen,
  startpruefung,
} from '../src/datenbank/migrationen.js';
import { leereDatenbankAnlegen, migrationsOrdnerBauen, type LeereDatenbank, LEERE_DATENBANK_TIMEOUT_MS } from './leere-datenbank.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

/** Das Kommando, das die Meldung nennt: ein beendeter Container erlaubt kein `exec`, also `run --rm`. */
const BEFEHL = 'docker compose run --rm cockpit node dist/cli/index.js migrieren';

describe.skipIf(!datenbankUrl)('Migrationen gegen eine leere Datenbank', { timeout: LEERE_DATENBANK_TIMEOUT_MS }, () => {
  let datenbank: LeereDatenbank;
  let pool: pg.Pool;
  const aufraeumer: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    datenbank = await leereDatenbankAnlegen(datenbankUrl ?? '');
    pool = datenbank.neuerPool();
  });

  afterEach(async () => {
    for (const aufraeumen of aufraeumer.splice(0)) {
      await aufraeumen();
    }
    await datenbank.aufraeumen();
  });

  async function ordner(migrationen: Parameters<typeof migrationsOrdnerBauen>[0]) {
    const gebaut = await migrationsOrdnerBauen(migrationen);
    aufraeumer.push(gebaut.aufraeumen);
    return gebaut;
  }

  async function angewendeteIds(): Promise<string[]> {
    const ergebnis = await pool.query<{ id: string }>('SELECT id FROM cockpit.schema_migrations ORDER BY id');
    return ergebnis.rows.map((zeile) => zeile.id);
  }

  async function tabelleDa(name: string): Promise<boolean> {
    const ergebnis = await pool.query<{ da: boolean }>('SELECT to_regclass($1) IS NOT NULL AS da', [name]);
    return ergebnis.rows[0]?.da === true;
  }

  /** Alle Tabellen im Schema `cockpit`, sortiert. */
  async function tabellen(): Promise<string[]> {
    const ergebnis = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'cockpit' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    return ergebnis.rows.map((zeile) => zeile.table_name);
  }

  /** Die Tabellen, die eine `.down.sql` ausdrücklich mit `DROP TABLE` entfernt. */
  async function tabellenDerDownMigration(pfad: string): Promise<string[]> {
    const sql = await readFile(pfad, 'utf8');
    return [...sql.matchAll(/DROP TABLE\s+(?:IF EXISTS\s+)?"?cockpit"?\."?([a-z_]+)"?/gi)].map((treffer) => treffer[1] ?? '');
  }

  describe('Aus einer leeren Datenbank entsteht das ganze Schema', () => {
    it('sieht eine leere Datenbank als „Schema fehlt", mit allen Migrationen ausstehend', async () => {
      const alle = await migrationenLaden();

      const stand = await migrationsstand(pool);

      expect(stand.schemaFehlt).toBe(true);
      expect(stand.angewendet).toEqual([]);
      expect(stand.ausstehend.map((migration) => migration.id)).toEqual(alle.map((migration) => migration.id));
    });

    it('wendet alle Migrationen in der Reihenfolge ihrer Nummern an und verzeichnet sie vollständig', async () => {
      const alle = (await migrationenLaden()).map((migration) => migration.id);
      const gemeldet: string[] = [];

      const angewendet = await migrationenAnwenden(pool, { angewendet: (id) => gemeldet.push(id) });

      expect(angewendet).toEqual(alle);
      expect(gemeldet).toEqual(alle);
      expect(await angewendeteIds()).toEqual(alle);
      // Das Schema ist wirklich da, nicht nur das Verzeichnis: Tabellen aus ersten und letzten Migrationen.
      for (const tabelle of [
        'cockpit.user',
        'cockpit.session',
        'cockpit.einladung',
        'cockpit.protokoll',
        'cockpit.passkey',
        'cockpit.zugang_wiederherstellung',
      ]) {
        expect(await tabelleDa(tabelle), tabelle).toBe(true);
      }
      const stand = await migrationsstand(pool);
      expect(stand.schemaFehlt).toBe(false);
      expect(stand.ausstehend).toEqual([]);
    });

    it('ändert bei einem zweiten Lauf nichts: nichts angewendet, keine neue Zeile, kein neuer Zeitpunkt', async () => {
      await migrationenAnwenden(pool);
      const vorher = await pool.query('SELECT id, angewendet_am FROM cockpit.schema_migrations ORDER BY id');

      const zweiter = await migrationenAnwenden(pool);

      expect(zweiter).toEqual([]);
      const nachher = await pool.query('SELECT id, angewendet_am FROM cockpit.schema_migrations ORDER BY id');
      expect(nachher.rows).toEqual(vorher.rows);
    });

    it('lässt bereits Vorhandenes stehen: angewendete Migrationen laufen nicht noch einmal', async () => {
      const alle = await migrationenLaden();
      await migrationenAnwenden(pool);
      await pool.query(
        `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
         VALUES ('bleibt', 'bleibt@example.org', 'bleibt', true, now(), now())`,
      );

      await migrationenAnwenden(pool);

      const konten = await pool.query('SELECT id FROM cockpit."user"');
      expect(konten.rows).toEqual([{ id: 'bleibt' }]);
      expect(await angewendeteIds()).toEqual(alle.map((migration) => migration.id));
    });
  });

  describe('Gleichzeitige Läufe', () => {
    it('überholen sich nicht: zwei Prozesse gleichzeitig, jede Migration läuft genau einmal, kein Fehler', async () => {
      const alle = (await migrationenLaden()).map((migration) => migration.id);

      const [erster, zweiter] = await Promise.all([
        migrationenAnwenden(datenbank.neuerPool()),
        migrationenAnwenden(datenbank.neuerPool()),
      ]);

      // Zusammen haben beide jede Migration angewendet, keine doppelt (der Sperrhalter macht alles,
      // der andere sieht danach ein fertiges Schema).
      expect([...erster, ...zweiter].sort()).toEqual([...alle].sort());
      expect(await angewendeteIds()).toEqual(alle);
    });

    it('hält auch vier gleichzeitige Läufe aus', async () => {
      const alle = (await migrationenLaden()).map((migration) => migration.id);

      const ergebnisse = await Promise.all(
        Array.from({ length: 4 }, () => migrationenAnwenden(datenbank.neuerPool())),
      );

      expect(ergebnisse.flat().sort()).toEqual([...alle].sort());
      expect(await angewendeteIds()).toEqual(alle);
    });
  });

  describe('Eine kaputte Migration hinterlässt nichts Halbes', () => {
    const EINS = { id: '0001_eins', up: 'CREATE TABLE cockpit.probe_a (id int)', down: 'DROP TABLE cockpit.probe_a' };
    const ZWEI = { id: '0002_zwei', up: 'CREATE TABLE cockpit.probe_b (id int)', down: 'DROP TABLE cockpit.probe_b' };
    // Legt eine Tabelle an und scheitert erst danach: ohne Transaktion bliebe `probe_c` stehen.
    const KAPUTT = {
      id: '0003_kaputt',
      up: 'CREATE TABLE cockpit.probe_c (id int); SELECT 1 / 0;',
      down: 'DROP TABLE cockpit.probe_c',
    };

    it('nimmt die kaputte Migration zurück, behält die vorherigen und nennt die kaputte beim Namen', async () => {
      const { ordner: verzeichnis } = await ordner([EINS, ZWEI, KAPUTT]);
      const gemeldet: string[] = [];

      await expect(migrationenAnwenden(pool, { ordner: verzeichnis, angewendet: (id) => gemeldet.push(id) })).rejects.toThrow(
        /0003_kaputt.*division by zero/,
      );

      expect(gemeldet).toEqual(['0001_eins', '0002_zwei']);
      expect(await angewendeteIds()).toEqual(['0001_eins', '0002_zwei']);
      expect(await tabelleDa('cockpit.probe_a')).toBe(true);
      expect(await tabelleDa('cockpit.probe_b')).toBe(true);
      expect(await tabelleDa('cockpit.probe_c')).toBe(false);
    });

    it('setzt nach der Reparatur genau dort fort, wo es stehen blieb', async () => {
      const gebaut = await ordner([EINS, ZWEI, KAPUTT]);
      await migrationenAnwenden(pool, { ordner: gebaut.ordner }).catch(() => undefined);
      await gebaut.aendern('0003_kaputt', 'CREATE TABLE cockpit.probe_c (id int)');

      const angewendet = await migrationenAnwenden(pool, { ordner: gebaut.ordner });

      expect(angewendet).toEqual(['0003_kaputt']);
      expect(await tabelleDa('cockpit.probe_c')).toBe(true);
    });

    it('hält SQL und Verzeichniseintrag zusammen: scheitert der Eintrag, bleibt auch die Migration nicht stehen', async () => {
      // Ein mehrteiliger SQL-String läuft in Postgres ohnehin atomar; was die Transaktion des Runners
      // sichert, ist die Einheit aus der Migration UND ihrem Eintrag in `schema_migrations`. Scheitert
      // der Eintrag (hier: ein Auslöser, der ihn verweigert), darf `probe_b` nicht übrig bleiben —
      // sonst wäre `probe_b` da, aber unverzeichnet, und der nächste Lauf scheiterte an „existiert schon".
      const gebaut = await ordner([EINS, ZWEI]);
      await migrationenAnwenden(pool, { ordner: (await ordner([EINS])).ordner });
      await pool.query(`
        CREATE FUNCTION cockpit.eintrag_verweigern() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'Eintrag verweigert'; END $$;
        CREATE TRIGGER eintrag_verweigern BEFORE INSERT ON cockpit.schema_migrations
        FOR EACH ROW WHEN (NEW.id = '0002_zwei') EXECUTE FUNCTION cockpit.eintrag_verweigern();
      `);

      await expect(migrationenAnwenden(pool, { ordner: gebaut.ordner })).rejects.toThrow(/0002_zwei.*Eintrag verweigert/);

      expect(await tabelleDa('cockpit.probe_b')).toBe(false);
      expect(await angewendeteIds()).toEqual(['0001_eins']);
    });

    it('gibt die Sperre nach einem Fehler frei: ein nächster Lauf wartet nicht ewig', async () => {
      const gebaut = await ordner([EINS, KAPUTT]);
      await migrationenAnwenden(pool, { ordner: gebaut.ordner }).catch(() => undefined);
      await gebaut.aendern('0003_kaputt', 'SELECT 1');

      const ergebnis = await Promise.race([
        migrationenAnwenden(datenbank.neuerPool(), { ordner: gebaut.ordner }),
        new Promise<string>((_ok, fehler) => setTimeout(() => fehler(new Error('Sperre nicht frei')), 5000)),
      ]);

      expect(ergebnis).toEqual(['0003_kaputt']);
    });
  });

  describe('Start-Prüfung', () => {
    it('lehnt eine leere Datenbank ab und nennt Migration und Befehl, statt mit einem SQL-Fehler zu enden', async () => {
      const anzahl = (await migrationenLaden()).length;

      const ergebnis = await startpruefung(pool);

      expect(ergebnis).toEqual({
        ok: false,
        meldung:
          `Das Schema cockpit fehlt in der Datenbank. Migration 0001_init ausstehend (und ${String(anzahl - 1)} weitere).\n` +
          `Bitte ausführen: ${BEFEHL}`,
      });
    });

    it('lässt eine vollständig migrierte Datenbank durch, ohne Warnung', async () => {
      await migrationenAnwenden(pool);

      expect(await startpruefung(pool)).toEqual({ ok: true });
    });

    it('lehnt eine Datenbank ab, der die letzte Migration fehlt, und nennt genau diese', async () => {
      await migrationenAnwenden(pool);
      const alle = await migrationenLaden();
      const letzte = alle[alle.length - 1]?.id ?? '';
      await pool.query('DELETE FROM cockpit.schema_migrations WHERE id = $1', [letzte]);

      const ergebnis = await startpruefung(pool);

      expect(ergebnis).toEqual({
        ok: false,
        meldung: `Das Schema ist nicht auf dem Stand dieses Images. Migration ${letzte} ausstehend.\nBitte ausführen: ${BEFEHL}`,
      });
    });

    it('zählt bei mehreren fehlenden die übrigen', async () => {
      await migrationenAnwenden(pool);
      const alle = await migrationenLaden();
      const drittletzte = alle[alle.length - 3]?.id ?? '';
      await pool.query('DELETE FROM cockpit.schema_migrations WHERE id >= $1', [drittletzte]);

      const ergebnis = await startpruefung(pool);

      expect(ergebnis.ok).toBe(false);
      expect(ergebnis.ok === false && ergebnis.meldung).toContain(`Migration ${drittletzte} ausstehend (und 2 weitere).`);
    });

    it('lässt eine Datenbank durch, die neuer ist als das Image, und warnt: ein Rückbau soll nicht am Schema scheitern', async () => {
      await migrationenAnwenden(pool);
      await pool.query(`INSERT INTO cockpit.schema_migrations (id) VALUES ('9999_aus_der_zukunft')`);

      const ergebnis = await startpruefung(pool);

      expect(ergebnis.ok).toBe(true);
      expect(ergebnis.ok && ergebnis.warnung).toContain('9999_aus_der_zukunft');
      const stand = await migrationsstand(pool);
      expect(stand.unbekannt).toEqual(['9999_aus_der_zukunft']);
      expect(stand.ausstehend).toEqual([]);
    });

    it('meldet nicht das Schema, wenn nur eine erfundene Migration fehlt, sondern diese', async () => {
      const gebaut = await ordner([
        { id: '0001_eins', up: 'CREATE TABLE cockpit.probe_a (id int)', down: 'DROP TABLE cockpit.probe_a' },
        { id: '0002_zwei', up: 'CREATE TABLE cockpit.probe_b (id int)', down: 'DROP TABLE cockpit.probe_b' },
      ]);
      await migrationenAnwenden(pool, { ordner: gebaut.ordner });
      await pool.query(`DELETE FROM cockpit.schema_migrations WHERE id = '0002_zwei'`);

      const ergebnis = await startpruefung(pool, gebaut.ordner);

      expect(ergebnis.ok === false && ergebnis.meldung).toContain('Migration 0002_zwei ausstehend.');
    });
  });

  describe('Rückwärts', () => {
    it('nimmt nur die letzte Migration zurück und lässt die übrigen stehen', async () => {
      const migrationen = await migrationenLaden();
      const alle = migrationen.map((migration) => migration.id);
      const letzte = migrationen[migrationen.length - 1];
      await migrationenAnwenden(pool);
      const tabellenVorher = await tabellen();

      const zurueck = await migrationZuruecknehmen(pool);

      expect(zurueck).toBe(alle[alle.length - 1]);
      expect(await angewendeteIds()).toEqual(alle.slice(0, -1));
      // Welche Tabellen die letzte Migration mitnimmt, steht in ihrer `.down.sql`; der Test nennt sie
      // nicht selbst, damit er nicht bei jeder neuen Migration nachgezogen werden muss (0015 hat den
      // alten Test mit einer festen Tabelle aus 0014 gebrochen).
      const weg = letzte === undefined ? [] : await tabellenDerDownMigration(letzte.downPfad);
      const tabellenNachher = await tabellen();
      for (const tabelle of weg) {
        expect(tabellenNachher).not.toContain(tabelle);
      }
      // Alles andere steht noch, auch Tabellen aus früheren Migrationen.
      expect(tabellenNachher).toEqual(tabellenVorher.filter((tabelle) => !weg.includes(tabelle)));
      expect(tabellenNachher).toContain('passkey');
    });

    it('geht die ganze Kette rückwärts durch alle Migrationen, bis nichts mehr übrig ist — und wieder vorwärts', async () => {
      const alle = (await migrationenLaden()).map((migration) => migration.id);
      await migrationenAnwenden(pool);

      const zurueckgenommen: string[] = [];
      for (;;) {
        const id = await migrationZuruecknehmen(pool);
        if (id === undefined) {
          break;
        }
        zurueckgenommen.push(id);
      }

      // Genau in umgekehrter Reihenfolge, einschließlich 0001, die das Schema samt Verzeichnis entfernt.
      expect(zurueckgenommen).toEqual([...alle].reverse());
      expect(await tabelleDa('cockpit.user')).toBe(false);
      expect(await tabelleDa('cockpit.schema_migrations')).toBe(false);
      // Danach beginnt alles von vorn.
      expect(await migrationenAnwenden(pool)).toEqual(alle);
    });

    it('meldet bei einer Datenbank ohne Schema, dass es nichts zurückzunehmen gibt, statt zu scheitern', async () => {
      expect(await migrationZuruecknehmen(pool)).toBeUndefined();
    });

    it('ignoriert eine angewendete Migration, die das Image nicht kennt: zurückgenommen wird die letzte bekannte', async () => {
      const alle = (await migrationenLaden()).map((migration) => migration.id);
      await migrationenAnwenden(pool);
      await pool.query(`INSERT INTO cockpit.schema_migrations (id) VALUES ('9999_aus_der_zukunft')`);

      const zurueck = await migrationZuruecknehmen(pool);

      expect(zurueck).toBe(alle[alle.length - 1]);
      expect(await angewendeteIds()).toEqual([...alle.slice(0, -1), '9999_aus_der_zukunft']);
    });

    it('macht bei einer kaputten down-Datei nichts kaputt: das Verzeichnis behält die Migration', async () => {
      const gebaut = await ordner([
        { id: '0001_eins', up: 'CREATE TABLE cockpit.probe_a (id int)', down: 'SELECT 1 / 0' },
      ]);
      await migrationenAnwenden(pool, { ordner: gebaut.ordner });

      await expect(migrationZuruecknehmen(pool, { ordner: gebaut.ordner })).rejects.toThrow(/0001_eins.*division by zero/);

      expect(await angewendeteIds()).toEqual(['0001_eins']);
      expect(await tabelleDa('cockpit.probe_a')).toBe(true);
    });
  });
});
