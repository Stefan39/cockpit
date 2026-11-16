/**
 * `GET /intern/pipeline/verbrauch?ticket=COPI-123` (COPI-182, JAC-768): der KI-Verbrauch der Pipeline für ein Ticket,
 * über alle Jobs summiert (Umsetzung, Nacharbeit, Reviews), Recht `pipeline_verwalten`. Der Koordinator schreibt ihn in den
 * Jira-Kommentar. Ein Ticket ohne Verbrauch ist `200` mit leerer Liste und Summen 0.
 */
import * as z from 'zod';
import { ticketVerbrauch, type VerbrauchSumme } from '../pipeline/verbrauch.js';
import { abfrageLesen } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

const ABFRAGE = z.strictObject({ ticket: z.string().min(1).max(200) });

function summeAlsJson(s: VerbrauchSumme) {
  return {
    laeufe: s.laeufe,
    input_tokens: s.inputTokens,
    output_tokens: s.outputTokens,
    cache_tokens: s.cacheTokens,
    cost_eur_notional: s.costEurNotional,
    cost_eur_real: s.costEurReal,
    duration_s: s.durationS,
  };
}

export function registrierePipelineVerbrauchRouten(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool } = abhaengigkeiten;

  router.route({
    methode: 'GET',
    url: '/pipeline/verbrauch',
    scope: 'pipeline_verwalten',
    handler: async (request, reply) => {
      const abfrage = abfrageLesen(ABFRAGE, request.query, reply);
      if (abfrage === undefined) {
        return reply;
      }
      const verbrauch = await ticketVerbrauch(pool, abfrage.ticket);
      return {
        ticket_key: verbrauch.ticketKey,
        jobs: verbrauch.jobs,
        gesamt: summeAlsJson(verbrauch.gesamt),
        je_werkzeug: verbrauch.jeWerkzeug.map((w) => ({ tool: w.tool, model: w.model, ...summeAlsJson(w) })),
      };
    },
  });
}
