/**
 * Die Abfragen der Meldungen (COPI-43): welche Befunde Wechsel sind, getrennt je Sicht.
 *
 * **Ein Wechsel** ist ein Befund, dessen Status oder Text sich gegenüber dem vorigen derselben Wache geändert hat
 * (`lag` über die Befunde einer Wache, nach `id`, also in der Reihenfolge des Eintreffens). Eine Wache, die alle fünf
 * Minuten dasselbe meldet, ergibt eine Meldung — die erste.
 *
 * **Die Trennung liegt in der Abfrage**, wie bei der Übersicht (COPI-37): die Kundenabfrage liest nur
 * kundensichtbare Befunde, ihren Klartext und den Anzeigenamen — keinen Rohbefund und keine Kennung, auch nicht für
 * die Suche. Auch der Wechsel wird dort nur unter den sichtbaren Befunden bestimmt: ein interner Befund dazwischen
 * ändert die Kundenliste nicht. Der Betreuer liest alle Befunde mit Rohbefund.
 *
 * Die Suche ist `ILIKE` mit einem Parameter; `%`, `_` und `\` darin gelten wörtlich. Die Bausteine unten sind feste
 * Zeichenketten — kein Wert aus einer Anfrage gelangt in das SQL.
 */
import type pg from 'pg';
import type { MeldungZeile } from './meldungen.js';
import { befundStatusAus, type BefundStatus } from './zustand.js';

export interface MeldungenAbfrage {
  readonly art: BefundStatus | undefined;
  readonly suche: string | undefined;
  /** Höchstens so viele, die neuesten. */
  readonly anzahl: number;
  /** Nur die Wachen dieses Agenten (COPI-113); ohne Angabe alle. */
  readonly agent?: string | undefined;
}

interface Sicht {
  /** Welcher Text: der Klartext (Kunde) oder der Rohbefund (Betreuer). */
  readonly text: 'b.text_kunde' | 'b.text_intern';
  /** Welche Befunde überhaupt: nur sichtbare (Kunde) oder alle. */
  readonly nur: string;
  readonly intern: string;
  /** Wie die Wache heißt: nur der Anzeigename (Kunde) oder, ohne ihn, die Kennung. */
  readonly name: string;
  /** Worin gesucht wird, außer im Text. */
  readonly sucheIn: readonly string[];
}

const KUNDE: Sicht = {
  text: 'b.text_kunde',
  nur: 'WHERE b.kundensichtbar',
  intern: 'false',
  name: 'w.anzeigename',
  sucheIn: ['w.anzeigename'],
};

const BETREUER: Sicht = {
  text: 'b.text_intern',
  nur: '',
  intern: 'NOT b.kundensichtbar',
  name: 'COALESCE(w.anzeigename, w.kennung)',
  sucheIn: ['w.anzeigename', 'w.kennung'],
};

function sql(sicht: Sicht): string {
  const suche = ['f.text', ...sicht.sucheIn].map((spalte) => `${spalte} ILIKE $2 ESCAPE '\\'`).join(' OR ');
  return `WITH folge AS (
            SELECT b.id, b.wache, b.status, ${sicht.text} AS text, b.gemeldet_am, ${sicht.intern} AS intern,
                   lag(b.status) OVER vorher AS status_vorher, lag(${sicht.text}) OVER vorher AS text_vorher
              FROM cockpit.befund b
              ${sicht.nur}
            WINDOW vorher AS (PARTITION BY b.wache ORDER BY b.id)
          )
          SELECT f.status, f.text, f.gemeldet_am, ${sicht.name} AS name, f.intern
            FROM folge f
            JOIN cockpit.wache w ON w.kennung = f.wache
           WHERE (f.status_vorher IS DISTINCT FROM f.status OR f.text_vorher IS DISTINCT FROM f.text)
             AND ($1::text IS NULL OR f.status = $1)
             AND ($2::text IS NULL OR ${suche})
             AND ($4::text IS NULL OR w.agent = $4)
           ORDER BY f.id DESC
           LIMIT $3`;
}

/** Die Suche als `ILIKE`-Muster, mit `%`, `_` und `\` wörtlich. */
function muster(suche: string | undefined): string | null {
  return suche === undefined ? null : `%${suche.replace(/[\\%_]/g, (zeichen) => `\\${zeichen}`)}%`;
}

async function lesen(pool: pg.Pool, sicht: Sicht, abfrage: MeldungenAbfrage): Promise<MeldungZeile[]> {
  const ergebnis = await pool.query<{ status: string; text: string; gemeldet_am: Date; name: string | null; intern: boolean }>(sql(sicht), [
    abfrage.art ?? null,
    muster(abfrage.suche),
    abfrage.anzahl,
    abfrage.agent ?? null,
  ]);
  return ergebnis.rows.map((zeile) => ({
    status: befundStatusAus(zeile.status),
    text: zeile.text,
    gemeldetAm: zeile.gemeldet_am,
    name: zeile.name ?? undefined,
    intern: zeile.intern,
  }));
}

export function kundenMeldungenLesen(pool: pg.Pool, abfrage: MeldungenAbfrage): Promise<MeldungZeile[]> {
  return lesen(pool, KUNDE, abfrage);
}

export function betreuerMeldungenLesen(pool: pg.Pool, abfrage: MeldungenAbfrage): Promise<MeldungZeile[]> {
  return lesen(pool, BETREUER, abfrage);
}
