/**
 * Den Freigabemodus für Updates umschalten (COPI-141), aus dem Abschnitt „Versionen" der Einstellungen.
 *
 *   * `POST /einstellungen/freigabe` — Formular mit `bereich` (`cockpit`, `module`) und `modus` (`rueckfrage`,
 *     `direkt`, `automatisch` seit COPI-142). Zurück auf die Rückfrage gilt sofort. Auf `direkt` und `automatisch` zeigt
 *     der erste Schritt eine Bestätigungsseite (außer der Modus gilt schon); erst ihr Formular (`bestaetigt=ja`) schaltet
 *     um. Danach zurück zu den Einstellungen (`303`) mit festem Hinweis.
 *
 * **Wer:** nur das Recht `update_beantragen` — der Betreuer, der auch beantragt; sonst die neutrale 404. **CSRF:**
 * Herkunft Pflicht (`kontoMitHerkunft`). Zeile und Protokoll (alt → neu) schreibt `freigabeModusSetzen` in einer
 * Transaktion.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { hatRecht, type ZugangLesen } from '../../auth/berechtigung.js';
import { FREIGABE_BEREICH_TEXT, FREIGABE_TEXT, freigabeModusLesen, freigabeModusSetzen, istFreigabeBereich, istFreigabeModus } from '../../status/freigabe-modus.js';
import { navigationFuerZugang } from '../navigation.js';
import { EINSTELLUNGEN_PFAD } from './einstellungen.js';
import { kontoMitHerkunft } from './konto-pruefen.js';

export const FREIGABE_PFAD = `${EINSTELLUNGEN_PFAD}/freigabe`;

export interface FreigabeModusAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly zugangLesen: ZugangLesen;
}

function zurueck(hinweis: 'gesetzt' | 'unveraendert' | 'abgewiesen'): string {
  return `${EINSTELLUNGEN_PFAD}?freigabe=${hinweis}#freigabe-titel`;
}

export function registriereFreigabeModusRoute(app: FastifyInstance, abhaengigkeiten: FreigabeModusAbhaengigkeiten): void {
  const { pool, zugangLesen } = abhaengigkeiten;

  app.post<{ Body: { bereich?: unknown; modus?: unknown; bestaetigt?: unknown } | undefined }>(FREIGABE_PFAD, async (request, reply) => {
    const konto = await kontoMitHerkunft(
      app,
      request,
      reply,
      zugangLesen,
      (zugang) => (hatRecht(zugang, 'update_beantragen') ? zugang.benutzerId : undefined),
      'Freigabemodus',
    );
    if (konto === undefined) {
      return reply;
    }
    const { bereich, modus, bestaetigt } = request.body ?? {};
    if (!istFreigabeBereich(bereich) || !istFreigabeModus(modus)) {
      return reply.code(303).header('location', zurueck('abgewiesen')).header('cache-control', 'no-store').send();
    }
    if (modus !== 'rueckfrage' && bestaetigt !== 'ja' && (await freigabeModusLesen(pool, bereich)) !== modus) {
      const html = await app.render('freigabe-bestaetigen.eta', {
        titel: FREIGABE_TEXT[modus],
        nav: navigationFuerZugang('einstellungen', await zugangLesen(request)),
        bereich,
        name: FREIGABE_BEREICH_TEXT[bereich],
        modus,
      });
      return reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
    }
    const ergebnis = await freigabeModusSetzen(pool, { bereich, modus, konto });
    request.log.info({ bereich, modus, ergebnis }, 'Freigabemodus');
    return reply.code(303).header('location', zurueck(ergebnis)).header('cache-control', 'no-store').send();
  });
}
