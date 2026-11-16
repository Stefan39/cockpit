/**
 * Den Betreuer-Zugriff auf ein Fachmodul setzen (COPI-134), aus dem Abschnitt „Betreuer-Zugriff" der Einstellungen.
 *
 *   * `POST /einstellungen/betreuer-zugriff` — Formular mit `kennung` und `stufe` (`aus`, `lesen`, `entscheiden`), dann
 *     zurück zu den Einstellungen (`303`). Ein unbekanntes, inaktives oder technisches Modul und eine unbekannte Stufe:
 *     zurück mit einem festen Hinweis, nichts geändert.
 *
 * **Wer:** nur das Recht `betreuer_zugriff_freigeben` — der Betriebs-Admin, ausdrücklich nicht der Betreuer
 * (`berechtigung.ts`); sonst die neutrale 404. **CSRF:** Herkunft Pflicht (`kontoMitHerkunft`). Zeile und Protokoll
 * schreibt `betreuerZugriffSetzen` in einer Transaktion.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { hatRecht, type ZugangLesen } from '../../auth/berechtigung.js';
import { betreuerZugriffSetzen, istBetreuerZugriff } from '../../module/betreuer-zugriff.js';
import { istModulKennung } from '../../module/block.js';
import { EINSTELLUNGEN_PFAD } from './einstellungen.js';
import { kontoMitHerkunft } from './konto-pruefen.js';

export const BETREUER_ZUGRIFF_PFAD = '/einstellungen/betreuer-zugriff';

export interface BetreuerZugriffAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly zugangLesen: ZugangLesen;
}

function zurueck(hinweis: 'gesetzt' | 'unveraendert' | 'abgewiesen'): string {
  return `${EINSTELLUNGEN_PFAD}?zugriff=${hinweis}#betreuer-zugriff-titel`;
}

export function registriereBetreuerZugriffRoute(app: FastifyInstance, abhaengigkeiten: BetreuerZugriffAbhaengigkeiten): void {
  const { pool, zugangLesen } = abhaengigkeiten;

  app.post<{ Body: { kennung?: unknown; stufe?: unknown } | undefined }>(BETREUER_ZUGRIFF_PFAD, async (request, reply) => {
    const konto = await kontoMitHerkunft(
      app,
      request,
      reply,
      zugangLesen,
      (zugang) => (hatRecht(zugang, 'betreuer_zugriff_freigeben') ? zugang.benutzerId : undefined),
      'Betreuer-Zugriff',
    );
    if (konto === undefined) {
      return reply;
    }
    const { kennung, stufe } = request.body ?? {};
    if (typeof kennung !== 'string' || !istModulKennung(kennung) || !istBetreuerZugriff(stufe)) {
      return reply.code(303).header('location', zurueck('abgewiesen')).header('cache-control', 'no-store').send();
    }
    const ergebnis = await betreuerZugriffSetzen(pool, { kennung, stufe, konto });
    if (!ergebnis.ok) {
      request.log.warn('Betreuer-Zugriff: abgewiesen (Modul)');
    }
    return reply
      .code(303)
      .header('location', zurueck(ergebnis.ok ? ergebnis.status : 'abgewiesen'))
      .header('cache-control', 'no-store')
      .send();
  });
}
