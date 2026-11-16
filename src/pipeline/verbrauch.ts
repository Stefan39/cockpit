/**
 * Der KI-Verbrauch der Pipeline je Ticket (COPI-182, JAC-768): `cockpit.pipeline_usage` hält jeden Lauf eines
 * Werkzeugs einzeln, Folgejobs am selben Ticket (Nacharbeit, Reviews) stehen als eigene Zeilen. Hier die Summe.
 */
import type pg from 'pg';

/** Summen über mehrere Läufe. Kosten sind `null`, wenn keine Zeile einen Wert hatte (nicht 0: „unbekannt"). */
export interface VerbrauchSumme {
  readonly laeufe: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly costEurNotional: number | null;
  readonly costEurReal: number | null;
  readonly durationS: number | null;
}

export interface WerkzeugVerbrauch extends VerbrauchSumme {
  readonly tool: string;
  readonly model: string | null;
}

export interface TicketVerbrauch {
  readonly ticketKey: string;
  /** Die Zahl der verschiedenen Jobs, die Verbrauch gemeldet haben. */
  readonly jobs: number;
  readonly gesamt: VerbrauchSumme;
  readonly jeWerkzeug: readonly WerkzeugVerbrauch[];
}

interface SummenZeile {
  laeufe: string;
  input_tokens: string;
  output_tokens: string;
  cache_tokens: string;
  cost_eur_notional: string | null;
  cost_eur_real: string | null;
  duration_s: string | null;
}

const SUMMEN = `
  count(*) AS laeufe,
  coalesce(sum(input_tokens), 0) AS input_tokens,
  coalesce(sum(output_tokens), 0) AS output_tokens,
  coalesce(sum(cache_tokens), 0) AS cache_tokens,
  sum(cost_eur_notional) AS cost_eur_notional,
  sum(cost_eur_real) AS cost_eur_real,
  sum(duration_s) AS duration_s`;

function zahl(wert: string | null): number | null {
  return wert === null ? null : Number(wert);
}

function summe(zeile: SummenZeile): VerbrauchSumme {
  return {
    laeufe: Number(zeile.laeufe),
    inputTokens: Number(zeile.input_tokens),
    outputTokens: Number(zeile.output_tokens),
    cacheTokens: Number(zeile.cache_tokens),
    costEurNotional: zahl(zeile.cost_eur_notional),
    costEurReal: zahl(zeile.cost_eur_real),
    durationS: zahl(zeile.duration_s),
  };
}

/** Summiert alle Läufe des Tickets. Ein Ticket ohne Zeilen ist kein Fehler: leere Liste, Summen 0. */
export async function ticketVerbrauch(pool: pg.Pool, ticketKey: string): Promise<TicketVerbrauch> {
  // Gesamtzeile und Werkzeuggruppen in einer Anweisung: ein Snapshot, die Gesamtsumme passt zu den Einzelwerten.
  const ergebnis = await pool.query<SummenZeile & { jobs: string; tool: string | null; model: string | null; gesamt: boolean }>(
    `SELECT grouping(tool) = 1 AS gesamt, tool, model, count(DISTINCT job_id) AS jobs, ${SUMMEN}
       FROM cockpit.pipeline_usage WHERE ticket_key = $1
      GROUP BY GROUPING SETS ((tool, model), ())
      ORDER BY grouping(tool), tool, model NULLS FIRST`,
    [ticketKey],
  );
  const zeile = ergebnis.rows.find((r) => r.gesamt);
  const leer = zeile === undefined || Number(zeile.laeufe) === 0;
  const gesamt: VerbrauchSumme = leer
    ? { laeufe: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, costEurNotional: 0, costEurReal: 0, durationS: 0 }
    : summe(zeile);
  return {
    ticketKey,
    jobs: leer ? 0 : Number(zeile.jobs),
    gesamt,
    jeWerkzeug: ergebnis.rows.filter((r) => !r.gesamt && r.tool !== null).map((r) => ({ tool: r.tool as string, model: r.model, ...summe(r) })),
  };
}
