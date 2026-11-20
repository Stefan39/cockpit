/**
 * Aufwand und Merkmale je Ticket (COPI-254): Grundlage der Kalkulation (`kalkulation.ts`). Der Aufwand kommt aus der
 * Zeiterfassung oder von Hand, die Merkmale (Aufgabentyp, Stack, geänderte Zeilen) vom Koordinator.
 */
import type pg from 'pg';

export const AUFWAND_QUELLEN = ['zeiterfassung', 'manuell'] as const;
export type AufwandQuelle = (typeof AUFWAND_QUELLEN)[number];

export const AUFGABENTYPEN = ['bugfix', 'feature', 'skript', 'wordpress-plugin', 'datenkonvertierung', 'doku'] as const;
export type Aufgabentyp = (typeof AUFGABENTYPEN)[number];

export interface AufwandEintrag {
  readonly ticketKey: string;
  readonly quelle: AufwandQuelle;
  readonly externId: string;
  /** Kalendertag, `YYYY-MM-DD`. */
  readonly tag: string;
  readonly minuten: number;
}

export interface AufwandErgebnis {
  readonly angelegt: number;
  readonly geaendert: number;
  readonly unveraendert: number;
}

/**
 * Meldet Aufwandseinträge in **einer** Anweisung (ganz oder gar nicht). Dieselbe (`quelle`, `extern_id`) überschreibt
 * Ticket, Tag und Minuten; stimmt alles überein, bleibt die Zeile unberührt. Die Einträge einer Meldung müssen sich
 * in (`quelle`, `extern_id`) unterscheiden — das prüft der Aufrufer, die Datenbank würde sonst die ganze Meldung abweisen.
 */
export async function aufwandMelden(pool: pg.Pool, eintraege: readonly AufwandEintrag[], jetzt: Date): Promise<AufwandErgebnis> {
  const ergebnis = await pool.query<{ angelegt: boolean }>(
    `INSERT INTO cockpit.pipeline_aufwand AS a (ticket_key, quelle, extern_id, tag, minuten, created_at, updated_at)
     SELECT t, q, x, d::date, m, $6, $6
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[]) AS v (t, q, x, d, m)
     ON CONFLICT (quelle, extern_id) DO UPDATE
        SET ticket_key = EXCLUDED.ticket_key, tag = EXCLUDED.tag, minuten = EXCLUDED.minuten, updated_at = EXCLUDED.updated_at
      WHERE (a.ticket_key, a.tag, a.minuten) IS DISTINCT FROM (EXCLUDED.ticket_key, EXCLUDED.tag, EXCLUDED.minuten)
  RETURNING (xmax = 0) AS angelegt`,
    [
      eintraege.map((e) => e.ticketKey),
      eintraege.map((e) => e.quelle),
      eintraege.map((e) => e.externId),
      eintraege.map((e) => e.tag),
      eintraege.map((e) => e.minuten),
      jetzt,
    ],
  );
  const angelegt = ergebnis.rows.filter((z) => z.angelegt).length;
  const geaendert = ergebnis.rows.length - angelegt;
  return { angelegt, geaendert, unveraendert: eintraege.length - ergebnis.rows.length };
}

/** Die Felder einer Merkmal-Meldung; was fehlt (`undefined`), bleibt, wie es ist. `null` leert Typ und Zeilen. */
export interface MerkmalMeldung {
  readonly ticketKey: string;
  readonly aufgabentyp?: Aufgabentyp | null;
  readonly stack?: readonly string[];
  readonly geaenderteZeilen?: number | null;
}

export interface TicketMerkmal {
  readonly ticketKey: string;
  readonly aufgabentyp: Aufgabentyp | null;
  readonly stack: readonly string[];
  readonly geaenderteZeilen: number | null;
}

interface MerkmalZeile {
  ticket_key: string;
  aufgabentyp: Aufgabentyp | null;
  stack: string[];
  geaenderte_zeilen: number | null;
}

/** Legt die Merkmale eines Tickets an oder ergänzt sie; liefert den gespeicherten Stand. */
export async function merkmalSpeichern(pool: pg.Pool, meldung: MerkmalMeldung, jetzt: Date): Promise<TicketMerkmal> {
  const ergebnis = await pool.query<MerkmalZeile>(
    `INSERT INTO cockpit.pipeline_ticket_merkmal AS m (ticket_key, aufgabentyp, stack, geaenderte_zeilen, updated_at)
     VALUES ($1, $3, $5, $7, $8)
     ON CONFLICT (ticket_key) DO UPDATE
        SET aufgabentyp = CASE WHEN $2 THEN EXCLUDED.aufgabentyp ELSE m.aufgabentyp END,
            stack = CASE WHEN $4 THEN EXCLUDED.stack ELSE m.stack END,
            geaenderte_zeilen = CASE WHEN $6 THEN EXCLUDED.geaenderte_zeilen ELSE m.geaenderte_zeilen END,
            updated_at = EXCLUDED.updated_at
  RETURNING ticket_key, aufgabentyp, stack, geaenderte_zeilen`,
    [
      meldung.ticketKey,
      meldung.aufgabentyp !== undefined,
      meldung.aufgabentyp ?? null,
      meldung.stack !== undefined,
      meldung.stack ?? [],
      meldung.geaenderteZeilen !== undefined,
      meldung.geaenderteZeilen ?? null,
      jetzt,
    ],
  );
  const z = ergebnis.rows[0] as MerkmalZeile;
  return { ticketKey: z.ticket_key, aufgabentyp: z.aufgabentyp, stack: z.stack, geaenderteZeilen: z.geaenderte_zeilen };
}
