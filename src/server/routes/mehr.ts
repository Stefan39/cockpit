import type { FastifyInstance } from 'fastify';
import type { ZugangLesen } from '../../auth/berechtigung.js';
import { navigationFuerZugang } from '../navigation.js';

export interface MehrAbhaengigkeiten {
  /** Ohne Zugangsleser (keine Anmeldung eingerichtet) gibt es weder Rechte noch ein Abmelden. */
  readonly zugangLesen?: ZugangLesen;
}

/**
 * „Mehr" (COPI-43): der fünfte Eintrag der Navigation des Prototyps. Er sammelt, was nicht in die Leiste passt —
 * Agenten, Zeitplan, Einstellungen, Einladen (nur mit dem Recht) — und das Abmelden, das mobil sonst nirgends steht.
 * Welche Einträge es gibt, entscheidet `navigation()` mit derselben Regel wie die Routen.
 */
export function registerMehrRoute(app: FastifyInstance, abhaengigkeiten: MehrAbhaengigkeiten): void {
  const { zugangLesen } = abhaengigkeiten;

  app.get('/mehr', async (request, reply) => {
    const zugang = zugangLesen ? await zugangLesen(request) : undefined;
    const html = await app.render('mehr.eta', { titel: 'Mehr', nav: navigationFuerZugang('mehr', zugang) });
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
}
