/**
 * Fachmigrationen der Module (COPI-107): Buchführung je Fachschema und die Mindestversion im Block.
 *
 *   * Eine Migrationsdatei bucht sich selbst (Herkunft, Rolle) und bricht ab, wenn ihre Version schon gebucht ist —
 *     ohne etwas zu ändern. Auf eine von Hand angelegte Tabelle angewendet, bucht sie nur.
 *   * Der Einspieler (`scripts/dev/fach-migrationen.ts`) spielt in Nummernfolge ein, überspringt Gebuchtes und hält
 *     beim ersten Fehler an.
 *   * `modul-einspielen` nimmt einen Block mit `fach` erst an, wenn die Buchführung die Version zeigt.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Legt die Schemata `eingang` und `probe_fach` an und entfernt sie wieder.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fachMigrationenEinspielen } from '../scripts/dev/fach-migrationen.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { eingangViewsAnlegen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const EINGANG = 'docs/demo/fach/eingang';
const MIGRATION_0001 = readFileSync(`${EINGANG}/0001_vorgang.sql`, 'utf8');
const BLOCK_YAML = readFileSync('docs/demo/eingang.cockpit.yaml', 'utf8');

describe.skipIf(!datenbankUrl)('Fachmigrationen (echte Datenbank)', () => {
  let pool: pg.Pool;
  let probeOrdner: string;

  async function aufraeumen(): Promise<void> {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_eingang');
    await pool.query('DROP SCHEMA IF EXISTS eingang CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS probe_fach CASCADE');
  }

  async function gebucht(schema: string): Promise<{ version: number; herkunft: string; angewendet_von: string }[]> {
    const zeilen = await pool.query<{ version: number; herkunft: string; angewendet_von: string }>(
      `SELECT version, herkunft, angewendet_von FROM ${schema}._migration ORDER BY version`,
    );
    return zeilen.rows;
  }

  /** Eine Probe-Migration im Format der echten: bucht sich, bricht beim zweiten Lauf ab. */
  function probe(version: number, rumpf: string): string {
    return `BEGIN;
CREATE SCHEMA IF NOT EXISTS probe_fach;
CREATE TABLE IF NOT EXISTS probe_fach._migration (version int PRIMARY KEY, herkunft text NOT NULL,
  angewendet_am timestamptz NOT NULL DEFAULT now(), angewendet_von text NOT NULL DEFAULT current_user);
DO $$ BEGIN IF EXISTS (SELECT 1 FROM probe_fach._migration WHERE version = ${String(version)}) THEN
  RAISE EXCEPTION 'fach_migration: probe_fach ${String(version)} ist schon eingespielt'; END IF; END; $$;
${rumpf}
INSERT INTO probe_fach._migration (version, herkunft) VALUES (${String(version)}, coalesce(nullif(current_setting('fach.herkunft', true), ''), 'unbekannt'));
COMMIT;
`;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await aufraeumen();
  });

  beforeEach(async () => {
    await aufraeumen();
    // Der Ordnername ist das Schema: ein frischer Ordner `probe_fach` je Fall.
    probeOrdner = path.join(mkdtempSync(path.join(tmpdir(), 'fach-')), 'probe_fach');
    mkdirSync(probeOrdner);
  });

  afterAll(async () => {
    await aufraeumen();
    await pool.end();
  });

  describe('die Migrationsdatei 0001 von Eingang', () => {
    it('legt Tabelle und Buchführung an und bucht sich selbst mit Herkunft und Rolle', async () => {
      const client = await pool.connect();
      try {
        await client.query("SELECT set_config('fach.herkunft', 'bibliothek@abc1234:sql/eingang/0001_vorgang.sql', false)");
        await client.query(MIGRATION_0001);
      } finally {
        await client.query("SELECT set_config('fach.herkunft', '', false)");
        client.release();
      }

      const [zeile] = await gebucht('eingang');
      expect(zeile).toMatchObject({ version: 1, herkunft: 'bibliothek@abc1234:sql/eingang/0001_vorgang.sql' });
      expect(zeile?.angewendet_von).toBe((await pool.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u);
      expect((await pool.query("SELECT to_regclass('eingang.vorgang') IS NOT NULL AS da")).rows[0]).toEqual({ da: true });
    });

    it('bucht ohne Herkunft „unbekannt"', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, '');
      const client = await pool.connect();
      try {
        await client.query('DROP SCHEMA eingang CASCADE');
        await client.query(MIGRATION_0001);
      } finally {
        client.release();
      }
      expect((await gebucht('eingang'))[0]?.herkunft).toBe('unbekannt');
    });

    it('bricht beim zweiten Lauf ab und ändert nichts', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
      const vorher = await gebucht('eingang');
      await pool.query(`INSERT INTO eingang.vorgang (postfach, betreff, eingang, zusammenfassung) VALUES ('x', 'bleibt', now(), 'z')`);

      const client = await pool.connect();
      try {
        await expect(client.query(MIGRATION_0001)).rejects.toThrow(/eingang 0001 ist schon eingespielt/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(await gebucht('eingang')).toEqual(vorher);
      expect((await pool.query('SELECT betreff FROM eingang.vorgang')).rows).toEqual([{ betreff: 'bleibt' }]);
    });

    it('bucht auf einer schon von Hand angelegten Tabelle nur und lässt ihre Zeilen stehen', async () => {
      await pool.query(`CREATE SCHEMA eingang;
        CREATE TABLE eingang.vorgang (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, message_id text UNIQUE,
          in_reply_to text, postfach text NOT NULL, absender_name text, absender_adresse text, betreff text NOT NULL,
          eingang timestamptz NOT NULL, kunde text, zusammenfassung text NOT NULL, vorschlag text, anhaenge text,
          stand text NOT NULL DEFAULT 'neu', stand_seit timestamptz NOT NULL DEFAULT now(), angelegt_am timestamptz NOT NULL DEFAULT now());
        INSERT INTO eingang.vorgang (postfach, betreff, eingang, zusammenfassung) VALUES ('x', 'alt', now(), 'z');`);

      expect(await fachMigrationenEinspielen(pool, EINGANG, 'test')).toEqual([1, 2, 3, 4, 5]);

      expect((await gebucht('eingang')).map((z) => z.version)).toEqual([1, 2, 3, 4, 5]);
      expect((await pool.query('SELECT betreff FROM eingang.vorgang')).rows).toEqual([{ betreff: 'alt' }]);
    });

    it('weist DELETE auf die Buchführung ab', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
      await expect(pool.query('DELETE FROM eingang._migration')).rejects.toThrow(/nie_loeschen/);
    });
  });

  describe('die Migrationsdatei 0003 von Eingang (Entwurf und Versand, COPI-90)', () => {
    it('nimmt Fassungen je Vorgang einmal an, Versand nur zu einer Fassung, und weist DELETE ab', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
      const vorgang = (await pool.query<{ id: string }>(`INSERT INTO eingang.vorgang (postfach, betreff, eingang, zusammenfassung) VALUES ('x', 'b', now(), 'z') RETURNING id::text`)).rows[0]?.id;
      await pool.query(`INSERT INTO eingang.entwurf (vorgang_id, fassung, an, betreff, text) VALUES ($1, 1, 'a', 'b', 'Hallo')`, [vorgang]);
      await expect(pool.query(`INSERT INTO eingang.entwurf (vorgang_id, fassung, an, betreff, text) VALUES ($1, 1, 'a', 'b', 'Anders')`, [vorgang])).rejects.toThrow(/entwurf_je_fassung/);
      await expect(pool.query(`INSERT INTO eingang.entwurf (vorgang_id, fassung, an, betreff, text) VALUES ($1, 2, 'a', 'b', '')`, [vorgang])).rejects.toThrow(/entwurf_text_laenge/);
      await expect(pool.query(`INSERT INTO eingang.versand (vorgang_id, fassung) VALUES ($1, 2)`, [vorgang])).rejects.toThrow(/versand_hat_entwurf/);
      await pool.query(`INSERT INTO eingang.versand (vorgang_id, fassung) VALUES ($1, 1)`, [vorgang]);
      await expect(pool.query('DELETE FROM eingang.entwurf')).rejects.toThrow(/nie_loeschen/);
      await expect(pool.query('DELETE FROM eingang.versand')).rejects.toThrow(/nie_loeschen/);
    });
  });

  describe('die Migrationsdatei 0004 von Eingang (Anhänge, COPI-110)', () => {
    async function vorgang(messageId: string): Promise<void> {
      await pool.query(`INSERT INTO eingang.vorgang (message_id, postfach, betreff, eingang, zusammenfassung) VALUES ($1, 'x', 'b', now(), 'z')`, [messageId]);
    }

    it('rechnet den SHA-256 selbst, ordnet über die Message-ID zu und nimmt jede Position einmal an', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
      await vorgang('<a@example.org>');
      await pool.query(`INSERT INTO eingang.anhang (message_id, position, dateiname, groesse, inhalt, sha256) VALUES ('<a@example.org>', 1, 'a.pdf', 3, 'abc', repeat('0', 64))`);
      expect((await pool.query('SELECT sha256 FROM eingang.anhang')).rows).toEqual([{ sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }]);
      await expect(pool.query(`INSERT INTO eingang.anhang (message_id, position, dateiname, groesse) VALUES ('<a@example.org>', 1, 'b.pdf', 1)`)).rejects.toThrow(/anhang_je_position/);
      await expect(pool.query(`INSERT INTO eingang.anhang (message_id, position, dateiname, groesse) VALUES ('<fremd@example.org>', 2, 'b.pdf', 1)`)).rejects.toThrow(/foreign key/);
      await expect(pool.query('DELETE FROM eingang.anhang')).rejects.toThrow(/nie_loeschen/);
    });

    it('nimmt höchstens 10 MB Inhalt, passend zur Größe; größere nur ohne Inhalt', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
      await vorgang('<b@example.org>');
      const einfuegen = (position: number, groesse: number, inhalt: string | null) =>
        pool.query(`INSERT INTO eingang.anhang (message_id, position, dateiname, groesse, inhalt) VALUES ('<b@example.org>', $1, 'x.bin', $2, $3::bytea)`, [position, groesse, inhalt]);
      await expect(pool.query(`INSERT INTO eingang.anhang (message_id, position, dateiname, groesse, inhalt) VALUES ('<b@example.org>', 1, 'x.bin', 10485761, decode(repeat('00', 10485761), 'hex'))`)).rejects.toThrow(/anhang_inhalt_hoechstens/);
      await expect(einfuegen(2, 5, 'abc')).rejects.toThrow(/anhang_inhalt_passt/);
      await einfuegen(3, 48_000_000, null);
      expect((await pool.query('SELECT position, sha256 FROM eingang.anhang')).rows).toEqual([{ position: 3, sha256: null }]);
    });
  });

  describe('die Migrationsdatei 0005 von Eingang (Fristen, COPI-102)', () => {
    const ENTFERNT = '(entfernt nach Frist)';

    /** Ein Vorgang mit Text und einem Anhang, eingegangen vor `tage` Tagen. */
    async function mail(name: string, tage: number): Promise<string> {
      const id = (
        await pool.query<{ id: string }>(
          `INSERT INTO eingang.vorgang (message_id, in_reply_to, postfach, absender_name, absender_adresse, betreff, eingang, kunde, zusammenfassung, vorschlag, anhaenge, text)
           VALUES ($1, '<vorher@example.org>', 'agent@example.com', 'Jana Peters', 'j.peters@example.org', 'Betreff ' || $1, now() - make_interval(days => $2), 'Lead', 'Triage', 'Vorschlag', 'a.pdf', 'Mailtext')
           RETURNING id::text`,
          [name, tage],
        )
      ).rows[0]?.id ?? '';
      await pool.query(`INSERT INTO eingang.anhang (message_id, position, dateiname, typ, groesse, inhalt) VALUES ($1, 1, 'Bewerbung_Jana_Peters.pdf', 'application/pdf', 3, 'abc')`, [name]);
      return id;
    }

    async function entwurf(vorgang: string, fassung: number, gesendetVorTagen?: number): Promise<void> {
      await pool.query(`INSERT INTO eingang.entwurf (vorgang_id, fassung, an, betreff, text) VALUES ($1, $2, 'Jana Peters <j.peters@example.org>', 'Re: x', 'Antworttext')`, [vorgang, fassung]);
      if (gesendetVorTagen !== undefined) {
        await pool.query(`INSERT INTO eingang.versand (vorgang_id, fassung, gesendet_am) VALUES ($1, $2, now() - make_interval(days => $3))`, [vorgang, fassung, gesendetVorTagen]);
      }
    }

    async function vorgang(id: string) {
      return (
        await pool.query<Record<string, unknown>>(
          `SELECT message_id, in_reply_to, absender_name, absender_adresse, betreff, kunde, zusammenfassung, vorschlag, anhaenge, text,
                  text_entfernt_am IS NOT NULL AS text_weg, pseudonymisiert_am IS NOT NULL AS pseudonymisiert
             FROM eingang.vorgang WHERE id = $1`,
          [id],
        )
      ).rows[0];
    }

    async function anhang(vorgangId: string) {
      return (
        await pool.query<Record<string, unknown>>(
          `SELECT a.dateiname, a.typ, a.inhalt IS NULL AS inhalt_weg, a.inhalt_entfernt_am IS NOT NULL AS markiert, a.sha256 IS NOT NULL AS hash_da
             FROM eingang.anhang a JOIN eingang.vorgang v ON v.message_id = a.message_id WHERE v.id = $1`,
          [vorgangId],
        )
      ).rows[0];
    }

    async function entwuerfe(vorgangId: string) {
      return (await pool.query<Record<string, unknown>>('SELECT an, betreff, text FROM eingang.entwurf WHERE vorgang_id = $1 ORDER BY fassung', [vorgangId])).rows;
    }

    async function anwenden(): Promise<{ anhaenge: number; texte: number; vorgaenge: number }> {
      const zeile = (await pool.query<{ anhaenge: number; texte: number; vorgaenge: number }>('SELECT * FROM eingang.fristen_anwenden()')).rows[0];
      return zeile ?? { anhaenge: -1, texte: -1, vorgaenge: -1 };
    }

    beforeEach(async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
    });

    it('lässt frische Vorgänge ganz in Ruhe', async () => {
      const frisch = await mail('<frisch@example.org>', 10);
      expect(await anwenden()).toEqual({ anhaenge: 0, texte: 0, vorgaenge: 0 });
      expect(await vorgang(frisch)).toMatchObject({ text: 'Mailtext', text_weg: false, pseudonymisiert: false });
      expect(await anhang(frisch)).toMatchObject({ inhalt_weg: false });
    });

    it('entfernt nach 90 Tagen Anhang-Inhalt und Mailtext, Absender und Name bleiben', async () => {
      const alt = await mail('<alt@example.org>', 100);
      expect(await anwenden()).toEqual({ anhaenge: 1, texte: 1, vorgaenge: 0 });
      expect(await vorgang(alt)).toMatchObject({ text: ENTFERNT, text_weg: true, absender_adresse: 'j.peters@example.org', pseudonymisiert: false });
      expect(await anhang(alt)).toEqual({ dateiname: 'Bewerbung_Jana_Peters.pdf', typ: 'application/pdf', inhalt_weg: true, markiert: true, hash_da: true });
    });

    it('ersetzt nach 12 Monaten alles Personenbezogene, auch Message-ID, Entwurf und Dateiname — die Zeilen bleiben', async () => {
      const uralt = await mail('<uralt@example.org>', 400);
      await entwurf(uralt, 1, 395);
      expect(await anwenden()).toEqual({ anhaenge: 1, texte: 2, vorgaenge: 1 });
      expect(await vorgang(uralt)).toEqual({
        message_id: `<entfernt-${uralt}@cockpit.invalid>`,
        in_reply_to: null,
        absender_name: null,
        absender_adresse: 'entfernt@invalid',
        betreff: '(entfernt)',
        kunde: null,
        zusammenfassung: ENTFERNT,
        vorschlag: null,
        anhaenge: null,
        text: ENTFERNT,
        text_weg: true,
        pseudonymisiert: true,
      });
      expect(await entwuerfe(uralt)).toEqual([{ an: 'entfernt@invalid', betreff: '(entfernt)', text: ENTFERNT }]);
      expect(await anhang(uralt)).toEqual({ dateiname: ENTFERNT, typ: null, inhalt_weg: true, markiert: true, hash_da: true });
    });

    it('lässt einen offenen Vorgang stehen, nur der Anhang-Inhalt geht nach 90 Tagen', async () => {
      const offen = await mail('<offen@example.org>', 400);
      await entwurf(offen, 1, 390);
      await entwurf(offen, 2);
      expect(await anwenden()).toEqual({ anhaenge: 1, texte: 0, vorgaenge: 0 });
      expect(await vorgang(offen)).toMatchObject({ text: 'Mailtext', absender_adresse: 'j.peters@example.org', pseudonymisiert: false });
      expect((await entwuerfe(offen)).map((zeile) => zeile.text)).toEqual(['Antworttext', 'Antworttext']);
    });

    it('rechnet die Frist ab dem letzten Versand, nicht ab dem Eingang', async () => {
      const spaet = await mail('<spaet@example.org>', 200);
      await entwurf(spaet, 1, 30);
      expect(await anwenden()).toEqual({ anhaenge: 1, texte: 0, vorgaenge: 0 });
      expect(await vorgang(spaet)).toMatchObject({ text: 'Mailtext' });
    });

    it('ändert beim zweiten Lauf nichts', async () => {
      await mail('<uralt@example.org>', 400);
      await mail('<alt@example.org>', 100);
      await anwenden();
      expect(await anwenden()).toEqual({ anhaenge: 0, texte: 0, vorgaenge: 0 });
    });

    it('darf nicht jeder ausführen', async () => {
      await pool.query('DROP ROLE IF EXISTS probe_frist');
      await pool.query('CREATE ROLE probe_frist');
      try {
        const recht = await pool.query<{ darf: boolean }>(`SELECT has_function_privilege('probe_frist', 'eingang.fristen_anwenden()', 'EXECUTE') AS darf`);
        expect(recht.rows[0]?.darf).toBe(false);
      } finally {
        await pool.query('DROP ROLE probe_frist');
      }
    });
  });

  describe('die Migrationsdatei 0002 von Eingang (Mailtext, COPI-103)', () => {
    it('ergänzt text und text_gekuerzt, alte Zeilen bleiben ohne Text', async () => {
      const client = await pool.connect();
      try {
        await client.query(MIGRATION_0001);
      } finally {
        client.release();
      }
      await pool.query(`INSERT INTO eingang.vorgang (postfach, betreff, eingang, zusammenfassung) VALUES ('x', 'alt', now(), 'z')`);

      expect(await fachMigrationenEinspielen(pool, EINGANG, 'test')).toEqual([2, 3, 4, 5]);

      expect((await pool.query('SELECT betreff, text, text_gekuerzt FROM eingang.vorgang')).rows).toEqual([{ betreff: 'alt', text: null, text_gekuerzt: false }]);
    });

    it('begrenzt den Text auf 10.000 Zeichen', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
      await expect(
        pool.query(`INSERT INTO eingang.vorgang (postfach, betreff, eingang, zusammenfassung, text) VALUES ('x', 'b', now(), 'z', repeat('a', 10001))`),
      ).rejects.toThrow(/vorgang_text_hoechstens/);
      await pool.query(`INSERT INTO eingang.vorgang (postfach, betreff, eingang, zusammenfassung, text) VALUES ('x', 'b', now(), 'z', repeat('ä', 10000))`);
    });
  });

  describe('der Einspieler', () => {
    it('spielt in Nummernfolge ein und überspringt Gebuchtes', async () => {
      writeFileSync(path.join(probeOrdner, '0002_spalte.sql'), probe(2, 'ALTER TABLE probe_fach.ding ADD COLUMN farbe text;'));
      writeFileSync(path.join(probeOrdner, '0001_ding.sql'), probe(1, 'CREATE TABLE probe_fach.ding (id int PRIMARY KEY);'));
      writeFileSync(path.join(probeOrdner, 'liesmich.txt'), 'keine Migration');

      expect(await fachMigrationenEinspielen(pool, probeOrdner, 'test')).toEqual([1, 2]);
      expect(await fachMigrationenEinspielen(pool, probeOrdner, 'test')).toEqual([]);

      writeFileSync(path.join(probeOrdner, '0003_index.sql'), probe(3, 'CREATE INDEX ding_farbe ON probe_fach.ding (farbe);'));
      expect(await fachMigrationenEinspielen(pool, probeOrdner, 'test')).toEqual([3]);
      expect((await gebucht('probe_fach')).map((z) => [z.version, z.herkunft])).toEqual([
        [1, 'test:probe_fach/0001_ding.sql'],
        [2, 'test:probe_fach/0002_spalte.sql'],
        [3, 'test:probe_fach/0003_index.sql'],
      ]);
    });

    it('hält beim ersten Fehler an, rollt die gescheiterte Datei zurück und spielt keine weitere ein', async () => {
      writeFileSync(path.join(probeOrdner, '0001_ding.sql'), probe(1, 'CREATE TABLE probe_fach.ding (id int PRIMARY KEY);'));
      writeFileSync(path.join(probeOrdner, '0002_kaputt.sql'), probe(2, 'ALTER TABLE probe_fach.gibtsnicht ADD COLUMN x int;'));
      writeFileSync(path.join(probeOrdner, '0003_danach.sql'), probe(3, 'CREATE TABLE probe_fach.danach (id int);'));

      await expect(fachMigrationenEinspielen(pool, probeOrdner, 'test')).rejects.toThrow(/probe_fach\/0002_kaputt\.sql/);

      expect((await gebucht('probe_fach')).map((z) => z.version)).toEqual([1]);
      expect((await pool.query("SELECT to_regclass('probe_fach.danach') IS NULL AS fehlt")).rows[0]).toEqual({ fehlt: true });
    });

    it('lehnt zwei Dateien mit derselben Nummer ab', async () => {
      writeFileSync(path.join(probeOrdner, '0001_a.sql'), probe(1, ''));
      writeFileSync(path.join(probeOrdner, '0001_b.sql'), probe(1, ''));

      await expect(fachMigrationenEinspielen(pool, probeOrdner, 'test')).rejects.toThrow(/doppelt/);
    });
  });

  describe('modul-einspielen mit fach (Mindestversion)', () => {
    const block = (mindestens: number): string => BLOCK_YAML.replace(/fach: \{[^}]*\}/, `fach: { schema: eingang, mindestens: ${String(mindestens)} }`);

    it('verlangt im Beispiel-Block die Fachmigration 0004 (Anhänge, COPI-110)', () => {
      expect(BLOCK_YAML).toMatch(/fach: \{ schema: eingang, mindestens: 4 \}/);
    });

    it('lehnt ab, solange das Fachschema keine Buchführung hat', async () => {
      const ergebnis = await modulEinspielen(pool, { rohtext: BLOCK_YAML, akteur: 'konsole' });
      expect(ergebnis).toEqual({ ok: false, grund: expect.stringContaining('eingang._migration fehlt') as unknown });
      expect((await pool.query('SELECT count(*)::int AS n FROM cockpit.modul')).rows[0]).toEqual({ n: 0 });
    });

    it('nimmt den Block an, sobald die verlangte Version gebucht ist', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
      await eingangViewsAnlegen(pool);

      const ergebnis = await modulEinspielen(pool, { rohtext: BLOCK_YAML, akteur: 'konsole' });
      expect(ergebnis).toMatchObject({ ok: true, status: 'neu', kennung: 'eingang' });
    });

    it('nennt die fehlende Fachmigration, wenn der Block eine neuere verlangt', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
      await eingangViewsAnlegen(pool);

      const ergebnis = await modulEinspielen(pool, { rohtext: block(6), akteur: 'konsole' });
      expect(ergebnis).toEqual({ ok: false, grund: 'Fachmigration 0006 fehlt: eingang ist bis 0005 eingespielt, der Block verlangt 0006.' });
    });

    it('meldet ein fehlendes Leserecht verständlich', async () => {
      await fachMigrationenEinspielen(pool, EINGANG, 'test');
      await eingangViewsAnlegen(pool);
      await pool.query('DROP ROLE IF EXISTS probe_ohne_recht');
      await pool.query('CREATE ROLE probe_ohne_recht');
      await pool.query('GRANT USAGE ON SCHEMA cockpit TO probe_ohne_recht; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA cockpit TO probe_ohne_recht; GRANT USAGE ON ALL SEQUENCES IN SCHEMA cockpit TO probe_ohne_recht; GRANT USAGE ON SCHEMA eingang TO probe_ohne_recht');
      const eigener = new pg.Pool({ connectionString: datenbankUrl, max: 1 });
      eigener.on('connect', (client) => {
        void client.query('SET ROLE probe_ohne_recht');
      });
      try {
        const ergebnis = await modulEinspielen(eigener, { rohtext: BLOCK_YAML, akteur: 'konsole' });
        expect(ergebnis).toEqual({ ok: false, grund: expect.stringContaining('fehlt SELECT darauf') as unknown });
      } finally {
        await eigener.end();
        await pool.query('DROP OWNED BY probe_ohne_recht');
        await pool.query('DROP ROLE probe_ohne_recht');
      }
    });
  });
});
