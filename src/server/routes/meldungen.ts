import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { hatRecht, type ZugangLesen } from '../../auth/berechtigung.js';
import { betreuerMeldungenLesen, kundenMeldungenLesen } from '../../status/meldungen-speicher.js';
import { filterAus, filterChips, meldungenAnsicht } from '../../status/meldungen.js';
import { standText } from '../../chat/ansicht.js';
import { navigationFuerZugang } from '../navigation.js';
import { mitFrischemPosteingang } from '../../posteingang/lesen.js';
import { QUELLE_MELDUNGEN } from '../../posteingang/posteingang.js';
import { standSetzen } from '../../posteingang/posteingang-speicher.js';

export interface MeldungenAbhaengigkeiten {
  /** Ohne Datenbank zeigt die Seite den Leerzustand (Tests und Entwicklung ohne Datenbank). */
  readonly pool?: pg.Pool;
  /** Ohne Zugangsleser (keine Anmeldung eingerichtet) gilt die Kundensicht. */
  readonly zugangLesen?: ZugangLesen;
  readonly jetzt: () => Date;
}

/** Wie viele Meldungen die Seite zeigt: die neuesten. Blättern kommt, wenn es gebraucht wird. */
const MELDUNGEN_JE_SEITE = 50;

/**
 * Die Seite „Meldungen" (COPI-43, Prototyp): Suche, Filter (Alle, Warnung, Fehler, Info) und die Liste der Wechsel.
 * Ohne Skript: die Filter sind Links, die Suche ist ein GET-Formular.
 *
 * **Zwei Sichten**, wie die Übersicht: der Betreuer (Recht `rohbefunde_sehen`) sieht jeden Wechsel mit Rohbefund,
 * alle anderen nur kundensichtbare mit ihrem Klartext. Die Trennung liegt in der Abfrage (`meldungen-speicher.ts`).
 * Die Seite ist rollenabhängig und deshalb `no-store`.
 *
 * **Gelesen (COPI-112):** Wer die Seite ansieht, hat die Meldungen bis jetzt gelesen — das Badge im Kopf zählt danach
 * nur noch neuere.
 */
export function registerMeldungenRoute(app: FastifyInstance, abhaengigkeiten: MeldungenAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt } = abhaengigkeiten;

  app.get<{ Querystring: { art?: unknown; q?: unknown } }>('/meldungen', async (request, reply) => {
    const zugang = zugangLesen ? await zugangLesen(request) : undefined;
    const betreuer = zugang !== undefined && hatRecht(zugang, 'rohbefunde_sehen');
    const filter = filterAus(request.query);
    const abfrage = { art: filter.art, suche: filter.suche, anzahl: MELDUNGEN_JE_SEITE };
    const zeilen = pool ? await (betreuer ? betreuerMeldungenLesen : kundenMeldungenLesen)(pool, abfrage) : [];
    let navZugang = zugang;
    if (pool && zugang?.posteingang !== undefined && zugang.benutzerId !== undefined) {
      try {
        await standSetzen(pool, zugang.benutzerId, QUELLE_MELDUNGEN, jetzt());
        navZugang = await mitFrischemPosteingang(pool, zugang, jetzt(), request.log);
      } catch (fehler) {
        request.log.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Posteingang: Meldungen nicht als gelesen markiert');
      }
    }

    const html = await app.render('meldungen.eta', {
      titel: 'Meldungen',
      nav: navigationFuerZugang('meldungen', navZugang),
      filter,
      chips: filterChips(filter),
      gefiltert: filter.art !== undefined || filter.suche !== undefined,
      meldungen: meldungenAnsicht(zeilen, jetzt()),
      // Sichtbarer Stand der Seite, die sich selbst neu lädt (COPI-105).
      stand: standText(jetzt()),
    });
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
}
