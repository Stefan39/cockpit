/**
 * Fachmigrationen einspielen (COPI-107) — für `./dev demo` und die Tests. Auf einem Server macht dasselbe
 * `agent-blueprints/sql/fach-migrieren.sh`; beide folgen derselben Regel:
 *
 *   * Ein Ordner je Fachschema, der Ordnername **ist** das Schema (`docs/demo/fach/eingang/`).
 *   * Dateien `NNNN_<beschreibung>.sql`, in Nummernfolge; gebuchte Versionen (`<schema>._migration`) werden übersprungen.
 *   * Jede Datei ist ihre eigene Transaktion und bucht sich selbst; die Herkunft kommt aus `fach.herkunft`.
 *   * Beim ersten Fehler: zurückrollen und abbrechen — die folgenden Dateien setzen die gescheiterte voraus.
 *
 * Nur lokal und in Tests, nie im Image (`scripts/` steht in `.dockerignore`): das Cockpit spielt keine Fachmigrationen ein.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const DATEI = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface FachMigration {
  readonly version: number;
  readonly datei: string;
}

/** Die Migrationsdateien eines Ordners, nach Nummer sortiert. Zwei Dateien mit derselben Nummer sind ein Fehler. */
export function fachMigrationenLesen(ordner: string): FachMigration[] {
  const migrationen = readdirSync(ordner)
    .map((datei) => ({ datei, treffer: DATEI.exec(datei) }))
    .filter((eintrag) => eintrag.treffer !== null)
    .map(({ datei, treffer }) => ({ version: Number(treffer?.[1]), datei }))
    .sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrationen.length; i += 1) {
    if (migrationen[i]?.version === migrationen[i - 1]?.version) {
      throw new Error(`Fachmigration ${String(migrationen[i]?.version)} doppelt in ${ordner}`);
    }
  }
  return migrationen;
}

async function gebucht(pool: pg.Pool, schema: string): Promise<Set<number>> {
  const tabelle = `${pg.escapeIdentifier(schema)}._migration`;
  const da = await pool.query<{ da: boolean }>('SELECT to_regclass($1) IS NOT NULL AS da', [tabelle]);
  if (da.rows[0]?.da !== true) {
    return new Set();
  }
  const zeilen = await pool.query<{ version: number }>(`SELECT version FROM ${tabelle}`);
  return new Set(zeilen.rows.map((zeile) => zeile.version));
}

/** Spielt die fehlenden Migrationen eines Ordners ein und gibt die eingespielten Versionen zurück. */
export async function fachMigrationenEinspielen(pool: pg.Pool, ordner: string, herkunft: string): Promise<number[]> {
  const schema = path.basename(ordner);
  const schonDa = await gebucht(pool, schema);
  const eingespielt: number[] = [];
  for (const migration of fachMigrationenLesen(ordner)) {
    if (schonDa.has(migration.version)) {
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('fach.herkunft', $1, false)", [`${herkunft}:${schema}/${migration.datei}`]);
      await client.query(readFileSync(path.join(ordner, migration.datei), 'utf8'));
      eingespielt.push(migration.version);
    } catch (fehler) {
      // Eine Datei mit eigenem BEGIN lässt die Verbindung nach einem Fehler in einer abgebrochenen Transaktion zurück.
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Fachmigration ${schema}/${migration.datei}: ${fehler instanceof Error ? fehler.message : 'unbekannt'}`, { cause: fehler });
    } finally {
      await client.query("SELECT set_config('fach.herkunft', '', false)").catch(() => undefined);
      client.release();
    }
  }
  return eingespielt;
}
