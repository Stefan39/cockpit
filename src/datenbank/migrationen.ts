/**
 * Der Migrations-Runner (COPI-31): das Schema `cockpit` entsteht und wird nachgezogen, ohne dass
 * jemand von Hand SQL ausführt.
 *
 * Bis COPI-31 lag der Runner in `db/migrate.ts`, lief nur lokal über `tsx` und war nicht im
 * Image; auch die Migrationen fehlten dort. Auf einer neuen Kundeninstanz gab es keinen Weg zum
 * Schema, und der Container brach beim Start mit `relation "cockpit.user" does not exist` ab. Jetzt
 * ist der Runner Teil des Builds (`dist/datenbank`), das Image bringt `db/migrations` mit, und es
 * gibt genau **eine** Implementierung: `db/migrate.ts` (`npm run migrate`, Testdatenbank, CI) und
 * der Befehl `migrieren` des Server-Kommandos rufen diese Datei.
 *
 * Migrationen sind Paare `NNNN_name.up.sql` / `NNNN_name.down.sql`; angewendete Nummern stehen in
 * `cockpit.schema_migrations`. Dazu die Regeln:
 *
 *   * **Nur ein Lauf zugleich.** Ein Advisory-Lock der Sitzung umschließt jeden Lauf. Zwei
 *     Aufrufer gleichzeitig (Betreuer und Admin-Agent) überholen sich nicht: der zweite wartet und
 *     findet danach ein fertiges Schema vor.
 *   * **Jede Migration in einer eigenen Transaktion**, samt dem Eintrag in `schema_migrations`. Eine
 *     kaputte Migration hinterlässt nichts Halbes; die vorherigen bleiben stehen, und ein nächster
 *     Lauf setzt genau dort fort. Der Fehler nennt die Migration.
 *   * **Die Start-Prüfung** (`startpruefung`) verweigert den Start, solange eine Migration aussteht.
 *     Sie ist der Grund, warum es keine automatische Migration beim Start gibt: ein Image-Update
 *     soll die Datenbank nicht ohne Freigabe verändern („Updates sind Anträge", ADR 13.1). Wer sie
 *     ausführt, ist der Betreuer oder der Admin-Agent über `cockpit-update`.
 *   * **Eine Datenbank, die neuer ist als das Image,** startet mit einer Warnung: ein Rückbau auf ein
 *     älteres Image soll nicht am Schema scheitern; additive Migrationen tragen das.
 *   * **Rückwärts** nimmt immer nur die **letzte** bekannte Migration zurück. Die `.down.sql`
 *     löschen Tabellen und Daten; deshalb verlangt der Befehl eine ausdrückliche Bestätigung.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Von `src/datenbank` und `dist/datenbank` aus zeigen zwei Ordner nach oben auf die Wurzel (im
 * Image `/app`); dort liegt `db/migrations`.
 */
export const MIGRATIONEN_ORDNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'db',
  'migrations',
);

/** Was ein Betreiber ausführt, wenn eine Migration aussteht. `run --rm`, denn ein beendeter Container erlaubt kein `exec`. */
export const MIGRIEREN_BEFEHL = 'docker compose run --rm cockpit node dist/cli/index.js migrieren';

/** Vier Ziffern, ein Unterstrich, ein Name in Kleinbuchstaben, Ziffern und Unterstrichen. */
const MIGRATIONS_NAME = /^\d{4}_[a-z0-9_]+$/;

/** Ein Schlüssel für den Advisory-Lock; Postgres bildet ihn auf eine Zahl ab. */
const SPERRE = 'cockpit.migrationen';

export interface Migration {
  readonly id: string;
  readonly upPfad: string;
  readonly downPfad: string;
}

/** Eine Migration ist fehlgeschlagen; die Meldung nennt sie und den Grund. */
export class MigrationFehler extends Error {
  readonly migrationId: string;

  constructor(migrationId: string, grund: string) {
    super(`Migration ${migrationId} fehlgeschlagen: ${grund}`);
    this.name = 'MigrationFehler';
    this.migrationId = migrationId;
  }
}

function grundVon(fehler: unknown): string {
  return fehler instanceof Error ? fehler.message : 'unbekannt';
}

/**
 * Liest die Migrationen eines Ordners, sortiert nach ihrer Nummer. Weist ab, was einen Rückweg
 * unmöglich machte oder die Reihenfolge unklar ließe: einen ungültigen Namen und eine Migration
 * ohne `down`-Paar.
 */
export async function migrationenLaden(ordner: string = MIGRATIONEN_ORDNER): Promise<Migration[]> {
  const dateien = await readdir(ordner);
  const migrationen: Migration[] = [];
  for (const datei of dateien.filter((name) => name.endsWith('.up.sql')).sort()) {
    const id = datei.replace(/\.up\.sql$/, '');
    if (!MIGRATIONS_NAME.test(id)) {
      throw new Error(`Ungültiger Migrationsname: ${datei} (erwartet NNNN_name.up.sql, Kleinbuchstaben)`);
    }
    if (!dateien.includes(`${id}.down.sql`)) {
      throw new Error(`Zu ${datei} fehlt das down-Paar ${id}.down.sql: ohne down gäbe es keinen Rückweg.`);
    }
    migrationen.push({
      id,
      upPfad: path.join(ordner, datei),
      downPfad: path.join(ordner, `${id}.down.sql`),
    });
  }
  return migrationen;
}

export interface Migrationsstand {
  /** Es gibt kein Verzeichnis `cockpit.schema_migrations`: das Schema wurde nie angelegt. */
  readonly schemaFehlt: boolean;
  /** Was die Datenbank als angewendet kennt (auch Unbekanntes), nach Nummer sortiert. */
  readonly angewendet: readonly string[];
  /** Was das Image kennt und die Datenbank noch nicht, in der Reihenfolge der Anwendung. */
  readonly ausstehend: readonly Migration[];
  /** Was die Datenbank angewendet hat und das Image nicht kennt: sie ist neuer als das Image. */
  readonly unbekannt: readonly string[];
}

type Abfrager = Pick<pg.Pool, 'query'>;

async function angewendeteLesen(db: Abfrager): Promise<string[] | undefined> {
  const da = await db.query<{ da: boolean }>(`SELECT to_regclass('cockpit.schema_migrations') IS NOT NULL AS da`);
  if (da.rows[0]?.da !== true) {
    return undefined;
  }
  const ergebnis = await db.query<{ id: string }>('SELECT id FROM cockpit.schema_migrations ORDER BY id');
  return ergebnis.rows.map((zeile) => zeile.id);
}

/** Der Stand der Datenbank gegen die Migrationen des Images. Ändert nichts. */
export async function migrationsstand(
  db: Abfrager,
  ordner: string = MIGRATIONEN_ORDNER,
): Promise<Migrationsstand> {
  const migrationen = await migrationenLaden(ordner);
  const gelesen = await angewendeteLesen(db);
  const angewendet = gelesen ?? [];
  const bekannt = new Set(migrationen.map((migration) => migration.id));
  return {
    schemaFehlt: gelesen === undefined,
    angewendet,
    ausstehend: migrationen.filter((migration) => !angewendet.includes(migration.id)),
    unbekannt: angewendet.filter((id) => !bekannt.has(id)),
  };
}

/** Die Meldung zu ausstehenden Migrationen; `undefined`, wenn nichts aussteht. */
export function ausstehendMeldung(stand: Migrationsstand): string | undefined {
  const erste = stand.ausstehend[0];
  if (erste === undefined) {
    return undefined;
  }
  const weitere = stand.ausstehend.length - 1;
  const anfang = stand.schemaFehlt
    ? 'Das Schema cockpit fehlt in der Datenbank.'
    : 'Das Schema ist nicht auf dem Stand dieses Images.';
  return `${anfang} Migration ${erste.id} ausstehend${weitere > 0 ? ` (und ${String(weitere)} weitere)` : ''}.`;
}

export type Startpruefung =
  | { readonly ok: true; readonly warnung?: string }
  | { readonly ok: false; readonly meldung: string };

/**
 * Darf das Cockpit starten? Nicht, solange eine Migration aussteht: dann eine Meldung, die sagt,
 * was fehlt und was zu tun ist — statt eines SQL-Fehlers mitten im Start. Ist die Datenbank neuer
 * als das Image, startet es mit einer Warnung.
 */
export async function startpruefung(
  db: Abfrager,
  ordner: string = MIGRATIONEN_ORDNER,
): Promise<Startpruefung> {
  const stand = await migrationsstand(db, ordner);
  const meldung = ausstehendMeldung(stand);
  if (meldung !== undefined) {
    return { ok: false, meldung: `${meldung}\nBitte ausführen: ${MIGRIEREN_BEFEHL}` };
  }
  if (stand.unbekannt.length > 0) {
    return {
      ok: true,
      warnung:
        `Die Datenbank ist neuer als dieses Image: ${stand.unbekannt.join(', ')} ` +
        'kennt das Image nicht. Es startet trotzdem; ein neueres Image gleicht den Stand aus.',
    };
  }
  return { ok: true };
}

/** Führt `aufgabe` mit dem Advisory-Lock aus: immer nur ein Lauf zugleich, auch über Prozesse hinweg. */
async function mitSperre<T>(pool: pg.Pool, aufgabe: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [SPERRE]);
    try {
      return await aufgabe(client);
    } finally {
      // Bricht die Verbindung ab, gibt Postgres die Sperre von selbst frei.
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [SPERRE]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * Legt das Schema nur an, wenn es fehlt (COPI-66). `CREATE SCHEMA IF NOT EXISTS` verlangt das Recht `CREATE` auf die
 * Datenbank, auch wenn das Schema schon da ist. Die Rolle `cockpit` hat es nicht: Die Verwaltung legt ihr Schema an
 * (`docs/installation.md`, Schritt 2), und mehr darf die Rolle bewusst nicht.
 */
async function verzeichnisSicherstellen(client: pg.PoolClient): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF to_regnamespace('cockpit') IS NULL THEN
        CREATE SCHEMA cockpit;
      END IF;
    END
    $$;
    CREATE TABLE IF NOT EXISTS cockpit.schema_migrations (
      id TEXT PRIMARY KEY,
      angewendet_am TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export interface AnwendenOptionen {
  readonly ordner?: string;
  /** Wird nach jeder angewendeten Migration gerufen (für die Ausgabe des Kommandos). */
  readonly angewendet?: (id: string) => void;
}

/**
 * Wendet alle ausstehenden Migrationen an, in der Reihenfolge ihrer Nummern, und liefert ihre
 * Namen. Bei einem Fehler wirft es `MigrationFehler` mit dem Namen der Migration; die vorherigen
 * bleiben angewendet.
 */
export async function migrationenAnwenden(
  pool: pg.Pool,
  optionen: AnwendenOptionen = {},
): Promise<string[]> {
  const migrationen = await migrationenLaden(optionen.ordner);
  return mitSperre(pool, async (client) => {
    await verzeichnisSicherstellen(client);
    // Erst nach der Sperre lesen: ein anderer Lauf hat vielleicht gerade alles erledigt.
    const angewendet = new Set(await angewendeteLesen(client));
    const neu: string[] = [];
    for (const migration of migrationen) {
      if (angewendet.has(migration.id)) {
        continue;
      }
      const sql = await readFile(migration.upPfad, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO cockpit.schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
      } catch (fehler) {
        await client.query('ROLLBACK');
        throw new MigrationFehler(migration.id, grundVon(fehler));
      }
      neu.push(migration.id);
      optionen.angewendet?.(migration.id);
    }
    return neu;
  });
}

export interface ZuruecknehmenOptionen {
  readonly ordner?: string;
}

/**
 * Nimmt die **letzte** Migration zurück, die das Image kennt und die Datenbank angewendet hat, und
 * liefert ihren Namen; `undefined`, wenn es nichts zurückzunehmen gibt (auch ohne Schema). Die
 * `.down.sql` löscht Tabellen und Daten.
 *
 * Nach `0001_init` gibt es das Verzeichnis nicht mehr (es entfernt das ganze Schema): der Eintrag wird
 * nur gelöscht, wenn es noch da ist. Der alte Runner löschte ihn immer und konnte 0001 deshalb nie
 * zurücknehmen.
 */
export async function migrationZuruecknehmen(
  pool: pg.Pool,
  optionen: ZuruecknehmenOptionen = {},
): Promise<string | undefined> {
  const migrationen = await migrationenLaden(optionen.ordner);
  return mitSperre(pool, async (client) => {
    const angewendet = await angewendeteLesen(client);
    if (angewendet === undefined) {
      return undefined;
    }
    const letzte = migrationen.filter((migration) => angewendet.includes(migration.id)).pop();
    if (letzte === undefined) {
      return undefined;
    }
    const sql = await readFile(letzte.downPfad, 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      if ((await angewendeteLesen(client)) !== undefined) {
        await client.query('DELETE FROM cockpit.schema_migrations WHERE id = $1', [letzte.id]);
      }
      await client.query('COMMIT');
    } catch (fehler) {
      await client.query('ROLLBACK');
      throw new MigrationFehler(letzte.id, grundVon(fehler));
    }
    return letzte.id;
  });
}
