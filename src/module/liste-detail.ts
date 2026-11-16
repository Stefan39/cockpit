/**
 * Die Datenabfrage der Modulseiten (COPI-78): die Liste der Zeilen einer Modul-View und eine einzelne Zeile
 * daraus. „Der Vertrag zum Fachmodul ist eine SQL-View mit festen Spaltennamen, nie Code" (ADR) — hier wird
 * dieser Vertrag genutzt, nicht mehr nur geprüft.
 *
 * **Vor jedem Lesen erneut geprüft.** Der Katalog wurde schon beim Einspielen geprüft (`registry.ts`,
 * `modul-speicher.ts`), aber eine View kann sich danach per `CREATE OR REPLACE VIEW` verändert haben — ohne
 * dass die Registry davon etwas weiß (sie speichert den Block, nicht die View selbst). Scheitert die erneute
 * Prüfung, gibt es **keine** Daten: die Seite zeigt einen neutralen Hinweis, der Grund steht nur im Log
 * (Fastifys Logger), nie auf der Seite — das Cockpit prüft nichts selbst, aber es vertraut auch nicht blind
 * auf eine einmal geprüfte View.
 *
 * **Bezeichner nur aus dem geprüften Block, immer über `escapeIdentifier`.** View- und Spaltennamen kommen
 * nie durch String-Konkatenation einer Nutzereingabe in die Abfrage — sie stehen ohnehin schon fest im Block
 * (Regex-geprüft, `block.ts`), aber `escapeIdentifier` ist die zweite, unabhängige Absicherung. Werte (die
 * gesuchte `id`) gehen ausschließlich als Parameter. Nur die Pflichtspalten und die deklarierten Spalten
 * werden selektiert, nie `*`.
 *
 * **Eine eigene, lesende Transaktion je Abfrage** (`BEGIN READ ONLY`, `SET LOCAL statement_timeout = '2s'`):
 * eine langsame oder blockierende Fach-View soll das Cockpit nie über zwei Sekunden hinaus aufhalten.
 */
import pg from 'pg';
import type { ModulBlock } from './block.js';
import { modulViewPruefen, type KatalogErgebnis } from './registry.js';

const { escapeIdentifier } = pg;

/** Höchstens so viele Zeilen zeigt die Liste (COPI-78) — Blättern kommt, wenn es gebraucht wird. */
export const MODUL_ZEILEN_HOECHSTENS = 200;

/** Eine Zeile der View, roh: alle abgefragten Spalten unter ihrem Namen, so wie `pg` sie liefert. */
export interface ModulZeileRoh {
  readonly werte: Readonly<Record<string, unknown>>;
}

export type ModulLeseErgebnis<T> =
  | { readonly ok: true; readonly wert: T }
  /** `grund` ist für das Log gedacht, nie für die Seite — die zeigt nur einen neutralen Hinweis. */
  | { readonly ok: false; readonly grund: string };

export interface Meldung {
  warn(objekt: { grund: string }, nachricht: string): void;
}

/**
 * Pflichtspalten, die geprüften optionalen Spalten (COPI-83: Messwert) und die deklarierten Spalten, einmal je Name
 * (eine deklarierte Pflichtspalte wird nicht doppelt selektiert). Langtexte (COPI-103) nur mit `langtext`: Liste und
 * Kacheln zeigen sie nie, und bis zu 200 Zeilen à 10.000 Zeichen soll keine Liste lesen. Die Einzelzeile der
 * Detailseite liest sie, samt der Spalte, die „gekürzt" meldet.
 */
function spaltenListe(block: ModulBlock, optionale: readonly string[], langtext = false): readonly string[] {
  const deklariert = block.spalten.flatMap((spalte) => {
    if (spalte.format !== 'langtext') {
      return [spalte.name];
    }
    if (!langtext) {
      return [];
    }
    return spalte.gekuerzt === undefined ? [spalte.name] : [spalte.name, spalte.gekuerzt.spalte];
  });
  return [...new Set(['id', 'titel', 'status', 'aktualisiert_am', ...optionale, ...deklariert])];
}

function spaltenSql(spalten: readonly string[]): string {
  return spalten.map((name) => escapeIdentifier(name)).join(', ');
}

/**
 * Prüft den Katalog erneut — die View kann sich seit dem Einspielen verändert haben (siehe Kopf). Liefert die
 * vorhandenen optionalen Spalten (COPI-83), oder `undefined`, wenn die Prüfung scheitert.
 */
async function katalogAktuell(pruefen: () => Promise<KatalogErgebnis>, kennung: string, log: Meldung | undefined): Promise<readonly string[] | undefined> {
  const ergebnis = await pruefen();
  if (!ergebnis.ok) {
    log?.warn({ grund: ergebnis.grund }, `Modul ${kennung}: Katalogprüfung fehlgeschlagen, zeige keine Daten`);
    return undefined;
  }
  return ergebnis.optionale ?? [];
}

/** Die Zeitgrenze einer Leseabfrage (siehe Kopf); nur der Download eines Anhangs (COPI-110) bekommt mehr. */
export type LeseZeit = '2s' | '10s';

/** Eine eigene, lesende Transaktion mit kurzem Timeout (siehe Kopf) — nie länger als `zeit` blockierend. */
async function leseTransaktion<T>(pool: pg.Pool, arbeit: (client: pg.PoolClient) => Promise<T>, zeit: LeseZeit): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${zeit}'`);
    const ergebnis = await arbeit(client);
    await client.query('COMMIT');
    return ergebnis;
  } catch (fehler) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw fehler;
  } finally {
    client.release();
  }
}

/**
 * Der gemeinsame Ablauf von `modulListeLesen`, `modulListeUndZeileLesen` und `modulVerlaufLesen` (`verlauf.ts`):
 * Katalog erneut prüfen (`pruefen`), dann die übergebene Abfrage in einer eigenen, lesenden Transaktion (sie bekommt
 * die geprüften optionalen Spalten, COPI-83, und selektiert nur diese mit) — beides
 * mit derselben Fehlerbehandlung (ein Fehlschlag wird geloggt und als „keine Daten" gemeldet, nie als Ausnahme
 * nach außen gereicht).
 */
export async function modulLesen<T>(
  pool: pg.Pool,
  kennung: string,
  pruefen: () => Promise<KatalogErgebnis>,
  log: Meldung | undefined,
  fehlerText: string,
  abfrage: (client: pg.PoolClient, optionale: readonly string[]) => Promise<T>,
  zeit: LeseZeit = '2s',
): Promise<ModulLeseErgebnis<T>> {
  const optionale = await katalogAktuell(pruefen, kennung, log);
  if (optionale === undefined) {
    return { ok: false, grund: 'katalog' };
  }
  try {
    return { ok: true, wert: await leseTransaktion(pool, (client) => abfrage(client, optionale), zeit) };
  } catch (fehler) {
    log?.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, `Modul ${kennung}: ${fehlerText}`);
    return { ok: false, grund: 'lesefehler' };
  }
}

/**
 * Die Liste, sortiert nach Status (zuerst rot, dann gelb, dann grün, ein unbekannter Wert zuletzt), darin das zuletzt
 * Geänderte zuerst (COPI-131), bei gleicher Zeit nach Titel.
 */
async function zeilenAbfragen(client: pg.PoolClient, view: string, spalten: string): Promise<readonly ModulZeileRoh[]> {
  const ergebnis = await client.query<Record<string, unknown>>(
    `SELECT ${spalten} FROM cockpit.${view}
      ORDER BY (CASE status WHEN 'rot' THEN 0 WHEN 'gelb' THEN 1 WHEN 'gruen' THEN 2 ELSE 3 END), aktualisiert_am DESC NULLS LAST, titel
      LIMIT ${String(MODUL_ZEILEN_HOECHSTENS)}`,
  );
  return ergebnis.rows.map((werte) => ({ werte }));
}

/** Eine Zeile über ihre `id` — `undefined`, wenn es sie nicht (mehr) gibt. */
async function zeileAbfragen(client: pg.PoolClient, view: string, spalten: string, id: string): Promise<ModulZeileRoh | undefined> {
  const ergebnis = await client.query<Record<string, unknown>>(`SELECT ${spalten} FROM cockpit.${view} WHERE id = $1 LIMIT 1`, [id]);
  return ergebnis.rows[0] ? { werte: ergebnis.rows[0] } : undefined;
}

/**
 * Die Liste der Zeilen einer Modul-View — höchstens `MODUL_ZEILEN_HOECHSTENS`, für `GET /module/:kennung`.
 */
export async function modulListeLesen(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  log?: Meldung,
): Promise<ModulLeseErgebnis<readonly ModulZeileRoh[]>> {
  const view = escapeIdentifier(block.view);
  return modulLesen(pool, kennung, () => modulViewPruefen(pool, block), log, 'Liste konnte nicht gelesen werden', (client, optionale) =>
    zeilenAbfragen(client, view, spaltenSql(spaltenListe(block, optionale))),
  );
}

/** Liste und eine einzelne Zeile daraus, für die Detailseite (COPI-78 Nacharbeit): Desktop zeigt links dieselbe Liste. */
export interface ModulListeUndZeile {
  readonly zeilen: readonly ModulZeileRoh[];
  /** `undefined`, wenn es die `id` nicht (mehr) gibt. */
  readonly zeile: ModulZeileRoh | undefined;
}

/**
 * Liste und Einzelzeile in einem Aufwasch: **eine** Katalogprüfung, **eine** Transaktion, statt die Prüfung für
 * dieselbe View zweimal laufen zu lassen. Für `GET /module/:kennung/:id`, die am Desktop links dieselbe Liste
 * zeigt wie `GET /module/:kennung` (markiert die gewählte Zeile) und rechts das Detail.
 */
export async function modulListeUndZeileLesen(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  id: string,
  log?: Meldung,
): Promise<ModulLeseErgebnis<ModulListeUndZeile>> {
  const view = escapeIdentifier(block.view);
  return modulLesen(pool, kennung, () => modulViewPruefen(pool, block), log, 'Liste/Zeile konnten nicht gelesen werden', async (client, optionale) => {
    return {
      zeilen: await zeilenAbfragen(client, view, spaltenSql(spaltenListe(block, optionale))),
      zeile: await zeileAbfragen(client, view, spaltenSql(spaltenListe(block, optionale, true)), id),
    };
  });
}

/**
 * Gibt es die Zeile `id` in der View (COPI-85)? Ein Vorgang ist eine Zeile — übernehmen und zurückgeben gibt es nur für
 * eine, die es gibt. Dieselbe Katalogprüfung und dieselbe lesende Transaktion wie jedes andere Lesen.
 */
export async function modulZeileVorhanden(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  id: string,
  log?: Meldung,
): Promise<ModulLeseErgebnis<boolean>> {
  const view = escapeIdentifier(block.view);
  return modulLesen(pool, kennung, () => modulViewPruefen(pool, block), log, 'Zeile konnte nicht gelesen werden', async (client) => {
    const ergebnis = await client.query(`SELECT 1 FROM cockpit.${view} WHERE id = $1 LIMIT 1`, [id]);
    return (ergebnis.rowCount ?? 0) > 0;
  });
}
