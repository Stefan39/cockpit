/**
 * `GET /intern/chat/verbrauch` (COPI-57): der Verbrauch des Chats je Tag für die Budget-Wache des Admin-Agenten
 * (ADR 6: „Tageslimit je Benutzer, fließt in dieselbe Budget-Wache").
 *
 * **Recht `zustand_lesen`**, wie der Zustand. Nur Summen: Nachrichten, schreibende Konten und wie viele davon am Limit
 * waren — keine Kennung, kein Name, kein Inhalt. `?tage=` (1–31, ohne Angabe 7) sagt, wie weit zurück.
 */
import * as z from 'zod';
import { berlinerTag } from '../chat/tageslimit.js';
import { verbrauchJeTag } from '../chat/verbrauch-speicher.js';
import { abfrageLesen } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

const TAG_MS = 24 * 60 * 60 * 1000;

const ABFRAGE = z.strictObject({
  tage: z.coerce.number().int().min(1).max(31).optional(),
});

export function registriereVerbrauchRoute(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten & { readonly chatTageslimit: number }): void {
  const { pool, jetzt, chatTageslimit } = abhaengigkeiten;

  router.route({
    methode: 'GET',
    url: '/chat/verbrauch',
    scope: 'zustand_lesen',
    handler: async (request, reply) => {
      const abfrage = abfrageLesen(ABFRAGE, request.query, reply);
      if (abfrage === undefined) {
        return reply;
      }
      const tage = abfrage.tage ?? 7;
      const zeitpunkt = jetzt();
      // Mittags gerechnet: so trifft der Tag vor n Tagen auch über eine Umstellung der Sommerzeit den richtigen.
      const heute = berlinerTag(zeitpunkt);
      const ab = berlinerTag(new Date(Date.parse(`${heute}T12:00:00Z`) - (tage - 1) * TAG_MS));
      const verbrauch = await verbrauchJeTag(pool, ab, chatTageslimit);
      return {
        limit: chatTageslimit,
        heute,
        tage: verbrauch.map((eintrag) => ({
          tag: eintrag.tag,
          nachrichten: eintrag.nachrichten,
          benutzer: eintrag.benutzer,
          am_limit: eintrag.amLimit,
        })),
      };
    },
  });
}
