/**
 * Die Kalkulation je Ticket (COPI-254), rein lesend: erfasster Aufwand (`pipeline_aufwand`), Pauschalen für die Wege, die
 * nicht in der Zeiterfassung stehen (Freigabe, Eskalation), Review- und Nacharbeitsrunden, Ergebnis und KI-Kosten —
 * die Zahlen, mit denen sich später ein Preis für ein Ticket ähnlicher Art schätzen lässt.
 *
 * Wie gezählt wird:
 *
 *   * **Freigaben:** Ereignisse `merge.approval_requested` aller Jobs des Tickets (`freigaben.ts`).
 *   * **Eskalationen:** Statuswechsel eines Jobs nach `parked` — Ereignis `status` mit `data.nach = 'parked'`
 *     (`queue.ts`, `statusNotieren`: abgelaufene Leases und fehlgeschlagene Abschlüsse über `max_attempts`).
 *   * **Ergebnis** mit Vorrang: `merge.erledigt` mit `data.grund = 'gemergt'` → `gemergt`; mit `geschlossen` → `abgebrochen`;
 *     sonst ein Job, der jetzt `parked` ist → `eskaliert`; sonst `offen`.
 *   * **KI-Kosten:** rechnerisch (`cost_eur_notional`) über alle Läufe, real (`cost_eur_real`) nur bei `billing = 'api'`
 *     (`verbrauch.ts`); `null`, wenn keine Zeile einen Wert hat.
 *
 * Ein Ticket gehört zur Auswertung, sobald es in `pipeline_job`, `pipeline_aufwand` oder `pipeline_ticket_merkmal` steht.
 */
import type pg from 'pg';
import type { Aufgabentyp } from './aufwand.js';

export const PAUSCHALE_FREIGABE_VARIABLE = 'COCKPIT_PIPELINE_PAUSCHALE_FREIGABE_MIN';
export const PAUSCHALE_ESKALATION_VARIABLE = 'COCKPIT_PIPELINE_PAUSCHALE_ESKALATION_MIN';
const STANDARD_FREIGABE_MIN = 5;
const STANDARD_ESKALATION_MIN = 15;
const PAUSCHALE_HOECHSTENS = 240;

/** Minuten, die je Freigabe und je Eskalation zusätzlich zum erfassten Aufwand angesetzt werden. */
export interface Pauschalen {
  readonly freigabeMin: number;
  readonly eskalationMin: number;
}

function ganzeMinuten(wert: string | undefined, standard: number): number {
  if (wert === undefined || !/^\d{1,3}$/.test(wert.trim())) {
    return standard;
  }
  const zahl = Number(wert.trim());
  return zahl <= PAUSCHALE_HOECHSTENS ? zahl : standard;
}

/** Liest die Pauschalen aus der Umgebung; nur ganze Zahlen von 0 bis 240, alles andere ergibt den Standard (5 und 15). */
export function pauschalenAus(umgebung: Readonly<Record<string, string | undefined>>): Pauschalen {
  return {
    freigabeMin: ganzeMinuten(umgebung[PAUSCHALE_FREIGABE_VARIABLE], STANDARD_FREIGABE_MIN),
    eskalationMin: ganzeMinuten(umgebung[PAUSCHALE_ESKALATION_VARIABLE], STANDARD_ESKALATION_MIN),
  };
}

export type TicketErgebnis = 'gemergt' | 'abgebrochen' | 'eskaliert' | 'offen';

export interface TicketKalkulation {
  readonly ticketKey: string;
  readonly aufgabentyp: Aufgabentyp | null;
  readonly stack: readonly string[];
  readonly geaenderteZeilen: number | null;
  readonly minutenErfasst: number;
  readonly freigaben: number;
  readonly eskalationen: number;
  readonly minutenPauschale: number;
  readonly minutenGesamt: number;
  readonly reviewRunden: number;
  readonly nacharbeitRunden: number;
  readonly ergebnis: TicketErgebnis;
  readonly costEurNotional: number | null;
  readonly costEurReal: number | null;
}

interface KalkulationsZeile {
  ticket_key: string;
  aufgabentyp: Aufgabentyp | null;
  stack: string[];
  geaenderte_zeilen: number | null;
  minuten_erfasst: number;
  freigaben: number;
  eskalationen: number;
  review_runden: number;
  nacharbeit_runden: number;
  ergebnis: TicketErgebnis;
  cost_eur_notional: string | null;
  cost_eur_real: string | null;
}

/** Eine Anweisung, je Quelle eine Gruppierung nach Ticket (kein N+1). Die Pauschalen rechnet `ticketKalkulation` darauf. */
const ABFRAGE = `
  WITH tickets AS (
    SELECT ticket_key FROM cockpit.pipeline_job
    UNION SELECT ticket_key FROM cockpit.pipeline_aufwand
    UNION SELECT ticket_key FROM cockpit.pipeline_ticket_merkmal
  ), aufwand AS (
    SELECT ticket_key, sum(minuten)::int AS minuten FROM cockpit.pipeline_aufwand GROUP BY ticket_key
  ), jobs AS (
    SELECT ticket_key,
           (count(*) FILTER (WHERE kind LIKE 'review:%'))::int AS review_runden,
           (count(*) FILTER (WHERE kind = 'rework'))::int AS nacharbeit_runden,
           coalesce(bool_or(status = 'parked'), false) AS geparkt
      FROM cockpit.pipeline_job GROUP BY ticket_key
  ), ereignisse AS (
    SELECT j.ticket_key,
           (count(*) FILTER (WHERE e.type = 'merge.approval_requested'))::int AS freigaben,
           (count(*) FILTER (WHERE e.type = 'status' AND e.data->>'nach' = 'parked'))::int AS eskalationen,
           coalesce(bool_or(e.type = 'merge.erledigt' AND e.data->>'grund' = 'gemergt'), false) AS gemergt,
           coalesce(bool_or(e.type = 'merge.erledigt' AND e.data->>'grund' = 'geschlossen'), false) AS geschlossen
      FROM cockpit.pipeline_job_event e JOIN cockpit.pipeline_job j ON j.id = e.job_id
     GROUP BY j.ticket_key
  ), kosten AS (
    SELECT ticket_key, sum(cost_eur_notional) AS notional, sum(cost_eur_real) FILTER (WHERE billing = 'api') AS echt
      FROM cockpit.pipeline_usage GROUP BY ticket_key
  )
  SELECT t.ticket_key, m.aufgabentyp, coalesce(m.stack, ARRAY[]::text[]) AS stack, m.geaenderte_zeilen,
         coalesce(a.minuten, 0) AS minuten_erfasst,
         coalesce(e.freigaben, 0) AS freigaben,
         coalesce(e.eskalationen, 0) AS eskalationen,
         coalesce(j.review_runden, 0) AS review_runden,
         coalesce(j.nacharbeit_runden, 0) AS nacharbeit_runden,
         CASE WHEN coalesce(e.gemergt, false) THEN 'gemergt'
              WHEN coalesce(e.geschlossen, false) THEN 'abgebrochen'
              WHEN coalesce(j.geparkt, false) THEN 'eskaliert'
              ELSE 'offen' END AS ergebnis,
         k.notional AS cost_eur_notional, k.echt AS cost_eur_real
    FROM tickets t
    LEFT JOIN cockpit.pipeline_ticket_merkmal m ON m.ticket_key = t.ticket_key
    LEFT JOIN aufwand a ON a.ticket_key = t.ticket_key
    LEFT JOIN jobs j ON j.ticket_key = t.ticket_key
    LEFT JOIN ereignisse e ON e.ticket_key = t.ticket_key
    LEFT JOIN kosten k ON k.ticket_key = t.ticket_key
   ORDER BY t.ticket_key COLLATE "C"`;

function zahl(wert: string | null): number | null {
  return wert === null ? null : Number(wert);
}

/** Die Kalkulation aller Tickets, sortiert nach `ticket_key`. */
export async function ticketKalkulation(pool: pg.Pool, pauschalen: Pauschalen): Promise<TicketKalkulation[]> {
  const ergebnis = await pool.query<KalkulationsZeile>(ABFRAGE);
  return ergebnis.rows.map((z) => {
    const minutenPauschale = z.freigaben * pauschalen.freigabeMin + z.eskalationen * pauschalen.eskalationMin;
    return {
      ticketKey: z.ticket_key,
      aufgabentyp: z.aufgabentyp,
      stack: z.stack,
      geaenderteZeilen: z.geaenderte_zeilen,
      minutenErfasst: z.minuten_erfasst,
      freigaben: z.freigaben,
      eskalationen: z.eskalationen,
      minutenPauschale,
      minutenGesamt: z.minuten_erfasst + minutenPauschale,
      reviewRunden: z.review_runden,
      nacharbeitRunden: z.nacharbeit_runden,
      ergebnis: z.ergebnis,
      costEurNotional: zahl(z.cost_eur_notional),
      costEurReal: zahl(z.cost_eur_real),
    };
  });
}
