/**
 * Die Datenabfrage einer Kennzahlen-Seite (COPI-98): Summen je Tag, der Vergleichszeitraum, die Aufteilungen und die
 * Hinweise — aus der geprüften View des Blocks. Derselbe Rahmen wie bei Liste+Detail (`liste-detail.ts`): vor jedem
 * Lesen die Katalogprüfung, eine eigene lesende Transaktion mit 2 Sekunden Timeout, Bezeichner nur aus dem geprüften
 * Block und immer über `escapeIdentifier`, Werte (Tage, Filter) nur als Parameter.
 *
 * Das Cockpit **rechnet** hier zum ersten Mal über einer Fach-View (`sum`, `GROUP BY`) — deshalb prüft die
 * Katalogprüfung die Typen aller deklarierten Spalten (`kennzahlenViewPruefen`), nicht nur ihr Vorhandensein.
 *
 * Die Hinweis-View wird getrennt gelesen: scheitert sie, erscheinen die Zahlen trotzdem.
 */
import pg from 'pg';
import { kennzahlenSpalten, type ModulBlock } from './block.js';
import type { Spanne } from './kennzahlen-zeitraum.js';
import { modulLesen, type Meldung, type ModulLeseErgebnis } from './liste-detail.js';
import { hinweiseViewPruefen, kennzahlenViewPruefen } from './registry.js';

const { escapeIdentifier } = pg;

/** So viele Gruppen liest eine Aufteilung höchstens; gezeigt werden die größten, der Rest als „weitere". */
const GRUPPEN_HOECHSTENS = 200;

/** So viele Warnzeilen zeigt eine Seite höchstens. */
const HINWEISE_HOECHSTENS = 5;

/** Der Filter einer Seite: die Spalte der Aufteilung mit `filter: true` und ihr Wert; `null` heißt „ohne Wert". */
export interface KennzahlenFilter {
  readonly spalte: string;
  readonly wert: string | null;
}

/** Die Summen eines Tages: je numerischer Spalte ein Wert; `null`, wenn der Tag für sie nur leere Zeilen hat. */
export interface TagesSummen {
  readonly tag: string;
  readonly summen: Readonly<Record<string, number | null>>;
}

export interface Gruppe {
  /** Der Wert der Textspalte; `null` für Zeilen ohne Wert („nicht zugeordnet"). */
  readonly schluessel: string | null;
  readonly wert: number;
}

export interface AufteilungDaten {
  /** Die gelesene Spalte — die der Aufteilung oder, gefiltert, ihr `darunter`. */
  readonly spalte: string;
  readonly label: string;
  /** Ob die Zeilen auf die gefilterte Seite verlinken (`filter: true`, solange nicht schon gefiltert ist). */
  readonly verlinkt: boolean;
  readonly gruppen: readonly Gruppe[];
}

export interface KennzahlenDaten {
  readonly tage: readonly TagesSummen[];
  /** Der Hauptwert im Vergleichszeitraum, mit demselben Filter; `null` ohne Daten. */
  readonly vergleich: number | null;
  /** Nur gefiltert: der Hauptwert im Zeitraum **ohne** Filter — für „45 % von allem". */
  readonly ungefiltert: number | null;
  readonly aufteilungen: readonly AufteilungDaten[];
}

export interface Hinweis {
  readonly titel: string;
  readonly text: string;
}

function zahl(wert: unknown): number | null {
  return wert === null || wert === undefined ? null : Number(wert);
}

/** `WHERE`-Teil und Parameter für eine Spanne mit optionalem Filter. */
function bedingung(spanne: Spanne, filter: KennzahlenFilter | undefined): { readonly sql: string; readonly werte: unknown[] } {
  if (filter === undefined) {
    return { sql: 'tag BETWEEN $1::date AND $2::date', werte: [spanne.von, spanne.bis] };
  }
  return {
    sql: `tag BETWEEN $1::date AND $2::date AND ${escapeIdentifier(filter.spalte)} IS NOT DISTINCT FROM $3::text`,
    werte: [spanne.von, spanne.bis, filter.wert],
  };
}

async function summeLesen(client: pg.PoolClient, view: string, spanne: Spanne, filter: KennzahlenFilter | undefined): Promise<number | null> {
  const wo = bedingung(spanne, filter);
  const ergebnis = await client.query<{ wert: unknown }>(`SELECT sum(wert)::float8 AS wert FROM cockpit.${view} WHERE ${wo.sql}`, wo.werte);
  return zahl(ergebnis.rows[0]?.wert);
}

async function tageLesen(
  client: pg.PoolClient,
  view: string,
  zahlen: readonly string[],
  spanne: Spanne,
  filter: KennzahlenFilter | undefined,
): Promise<TagesSummen[]> {
  const wo = bedingung(spanne, filter);
  const summen = zahlen.map((name, nummer) => `sum(${escapeIdentifier(name)})::float8 AS s${String(nummer)}`).join(', ');
  const ergebnis = await client.query<Record<string, unknown>>(
    `SELECT to_char(tag, 'YYYY-MM-DD') AS tag, ${summen} FROM cockpit.${view} WHERE ${wo.sql} GROUP BY tag ORDER BY tag`,
    wo.werte,
  );
  return ergebnis.rows.map((zeile) => ({
    tag: String(zeile.tag),
    summen: Object.fromEntries(zahlen.map((name, nummer) => [name, zahl(zeile[`s${String(nummer)}`])])),
  }));
}

async function gruppenLesen(client: pg.PoolClient, view: string, spalte: string, spanne: Spanne, filter: KennzahlenFilter | undefined): Promise<Gruppe[]> {
  const wo = bedingung(spanne, filter);
  const name = escapeIdentifier(spalte);
  const ergebnis = await client.query<{ schluessel: string | null; wert: unknown }>(
    `SELECT ${name} AS schluessel, coalesce(sum(wert), 0)::float8 AS wert FROM cockpit.${view} WHERE ${wo.sql}
      GROUP BY ${name} ORDER BY 2 DESC, 1 NULLS LAST LIMIT ${String(GRUPPEN_HOECHSTENS)}`,
    wo.werte,
  );
  return ergebnis.rows.map((zeile) => ({ schluessel: zeile.schluessel, wert: zahl(zeile.wert) ?? 0 }));
}

/**
 * Alles, was die Kennzahlen-Seite zeigt, in einer Katalogprüfung und einer Transaktion. Gefiltert tritt bei der
 * gefilterten Aufteilung ihr `darunter` an die Stelle (ohne `darunter` entfällt sie: sie hätte nur noch eine Zeile).
 */
export async function kennzahlenLesen(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  auswahl: { readonly spanne: Spanne; readonly vergleich: Spanne; readonly filter?: KennzahlenFilter | undefined },
  log?: Meldung,
): Promise<ModulLeseErgebnis<KennzahlenDaten>> {
  const view = escapeIdentifier(block.view);
  const { spanne, vergleich, filter } = auswahl;
  return modulLesen(pool, kennung, () => kennzahlenViewPruefen(pool, block), log, 'Kennzahlen konnten nicht gelesen werden', async (client) => {
    const aufteilungen: AufteilungDaten[] = [];
    for (const aufteilung of block.aufteilungen ?? []) {
      const gefiltert = filter !== undefined && aufteilung.filter === true;
      const gelesen = gefiltert ? aufteilung.darunter : aufteilung;
      if (gelesen !== undefined) {
        aufteilungen.push({
          spalte: gelesen.name,
          label: gelesen.label,
          verlinkt: aufteilung.filter === true && !gefiltert,
          gruppen: await gruppenLesen(client, view, gelesen.name, spanne, filter),
        });
      }
    }
    return {
      tage: await tageLesen(client, view, kennzahlenSpalten(block).zahlen, spanne, filter),
      vergleich: await summeLesen(client, view, vergleich, filter),
      ungefiltert: filter === undefined ? null : await summeLesen(client, view, spanne, undefined),
      aufteilungen,
    };
  });
}

/** Die Warnzeilen der Hinweis-View; ohne `hinweise` im Block eine leere Liste. */
export async function hinweiseLesen(pool: pg.Pool, kennung: string, block: ModulBlock, log?: Meldung): Promise<ModulLeseErgebnis<readonly Hinweis[]>> {
  const hinweise = block.hinweise;
  if (hinweise === undefined) {
    return { ok: true, wert: [] };
  }
  return modulLesen(pool, kennung, () => hinweiseViewPruefen(pool, block), log, 'Hinweise konnten nicht gelesen werden', async (client) => {
    const ergebnis = await client.query<{ titel: string | null; text: string | null }>(
      `SELECT titel, text FROM cockpit.${escapeIdentifier(hinweise)} LIMIT ${String(HINWEISE_HOECHSTENS)}`,
    );
    return ergebnis.rows.map((zeile) => ({ titel: zeile.titel ?? '', text: zeile.text ?? '' }));
  });
}

/** Was die Karte der Übersicht braucht: der Hauptwert je Tag der letzten 30 Tage und die Summen zweier Monate. */
export interface KartenDaten {
  readonly tage: readonly TagesSummen[];
  readonly monat: number | null;
  readonly vormonat: number | null;
}

export async function kennzahlenKarteLesen(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  spannen: { readonly monat: Spanne; readonly vormonat: Spanne; readonly verlauf: Spanne },
  log?: Meldung,
): Promise<ModulLeseErgebnis<KartenDaten>> {
  const view = escapeIdentifier(block.view);
  return modulLesen(pool, kennung, () => kennzahlenViewPruefen(pool, block), log, 'Kennzahlen-Karte konnte nicht gelesen werden', async (client) => ({
    tage: await tageLesen(client, view, ['wert'], spannen.verlauf, undefined),
    monat: await summeLesen(client, view, spannen.monat, undefined),
    vormonat: await summeLesen(client, view, spannen.vormonat, undefined),
  }));
}
