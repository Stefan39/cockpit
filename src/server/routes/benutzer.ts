import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { hatRecht, type ZugangLesen } from '../../auth/berechtigung.js';
import { erlaubteAktionen } from '../../auth/benutzer-bearbeiten.js';
import { benutzerListe } from '../../auth/benutzer-liste.js';
import { benutzerDatenLesen } from '../../auth/benutzer-liste-speicher.js';
import { navigationFuerZugang } from '../navigation.js';
import { nichtGefunden } from './neutral.js';

export const BENUTZER_PFAD = '/benutzer';

export interface BenutzerSeiteAbhaengigkeiten {
  /** Ohne Datenbank zeigt die Seite leere Listen (Tests und Entwicklung ohne Datenbank). */
  readonly pool?: pg.Pool;
  /** Ohne Zugangsleser (keine Anmeldung eingerichtet) hat niemand das Recht: die Seite bleibt zu. */
  readonly zugangLesen?: ZugangLesen;
  readonly jetzt: () => Date;
}

/**
 * Die Seite **Benutzer** (COPI-45, ADR Abschnitt 5): alle Konten mit Rolle und Stand des zweiten Faktors, dazu die
 * offenen Einladungen. Nur lesend.
 *
 * **Nur mit dem Recht `benutzer_sehen`** (Betreuer, Betriebs-Admin). Wer es nicht hat — der Mitarbeiter, ein Konto
 * mit unbekannter Rolle —, bekommt die neutrale 404 wie bei „Einladen": die Seite verrät nicht, dass es sie gibt. Vorher
 * steht das Tor: ohne Sitzung zur Anmeldung, ohne zweiten Faktor zu dessen Einrichtung.
 *
 * Die Rolle kommt aus der Datenbank (`zugangLesen`), nicht aus der Sitzung: eine Herabstufung wirkt sofort. Die Seite
 * zeigt Adressen und ist deshalb `no-store`.
 */
export function registerBenutzerRoute(app: FastifyInstance, abhaengigkeiten: BenutzerSeiteAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt } = abhaengigkeiten;

  app.get<{ Querystring: { entfernt?: string } }>(BENUTZER_PFAD, async (request, reply) => {
    const zugang = zugangLesen ? await zugangLesen(request) : undefined;
    if (zugang === undefined || !hatRecht(zugang, 'benutzer_sehen')) {
      // Ohne Kennung im Log, wie bei der Einladung.
      request.log.warn('Benutzer: Zugriff ohne Berechtigung abgewiesen');
      return nichtGefunden(app, reply);
    }

    const zeitpunkt = jetzt();
    const daten = pool ? await benutzerDatenLesen(pool, zeitpunkt) : { konten: [], einladungen: [] };
    const html = await app.render('benutzer.eta', {
      titel: 'Benutzer',
      nav: navigationFuerZugang('benutzer', zugang),
      liste: benutzerListe(
        { ...daten, selbstId: zugang.benutzerId, bearbeitbar: (konto) => erlaubteAktionen(zugang, konto).length > 0 },
        zeitpunkt,
      ),
      einladen: hatRecht(zugang, 'einladen'),
      // Nach dem Entfernen eines Kontos (COPI-46) kommt man hierher zurück.
      erledigt: request.query.entfernt === '1' ? 'Das Konto ist entfernt.' : undefined,
    });
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
}
