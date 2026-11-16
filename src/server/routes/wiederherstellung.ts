/**
 * Zugang wiederherstellen (COPI-28): `/zugang-wiederherstellen/<token>`.
 *
 * Der Link kommt vom Server-Kommando `entsperren` (`src/auth/entsperrung.ts`) und wird
 * persönlich übergeben. Diese Route ist bewusst ohne Anmeldung erreichbar — der Besitz des
 * Tokens ist der Nachweis, wie bei Erststart und Einladung — und liegt in der
 * Anonym-Allowlist des Tors, nicht unter `/api/auth`.
 *
 * Ablauf wie bei der Einladung (siehe `einladung.ts`): erst prüfen, dann die Eingaben prüfen,
 * dann den Link mit einer einzelnen bedingten Anweisung entwerten und das Passwort setzen. Ein
 * Tippfehler verbrennt den Link nicht; gleichzeitige Anfragen lösen ihn höchstens einmal ein.
 * Was der Link nicht (mehr) öffnet — unbekannt, abgelaufen, verbraucht, entwertet durch einen
 * neueren —, antwortet mit derselben neutralen 404.
 *
 * Danach meldet die Anwendung das Konto mit dem neuen Passwort an und führt in die normale
 * Einrichtung des zweiten Faktors: das Konto hat keinen, und das Tor lässt bis dahin nur diese
 * Seite durch.
 */
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { cookiesUebernehmen, htmlSenden } from '../../auth/antwort.js';
import {
  wiederherstellungEinloesen,
  wiederherstellungPruefen,
} from '../../auth/entsperrung.js';
import { MINDEST_PASSWORTLAENGE, type CockpitAuth } from '../../auth/konfiguration.js';
import { passwortHashen } from '../../auth/passwort.js';
import {
  ANMELDEN_PFAD,
  ZUGANG_WIEDERHERSTELLEN_PFAD,
  ZWEI_FAKTOR_PFAD,
} from '../../auth/zwei-faktor-tor.js';
import { passwortFehler, text } from './formular.js';
import { nichtGefunden } from './neutral.js';

export interface WiederherstellungAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly auth: CockpitAuth;
  readonly jetzt: () => Date;
}

interface WiederherstellenFormular {
  readonly passwort?: unknown;
  readonly passwortWiederholung?: unknown;
}

interface TokenParams {
  readonly token: string;
}

export function registriereWiederherstellungRoute(
  app: FastifyInstance,
  abhaengigkeiten: WiederherstellungAbhaengigkeiten,
): void {
  const { pool, auth, jetzt } = abhaengigkeiten;

  async function formular(
    reply: FastifyReply,
    daten: { token: string; email: string; fehler?: string },
    status = 200,
  ): Promise<void> {
    const html = await app.render('zugang-wiederherstellen.eta', {
      titel: 'Zugang wiederherstellen',
      token: daten.token,
      email: daten.email,
      fehler: daten.fehler,
      mindestlaenge: MINDEST_PASSWORTLAENGE,
    });
    // Die Seite trägt den Link in ihrer Formularadresse und ein Passwortfeld: nicht zwischenspeichern.
    reply.header('cache-control', 'no-store');
    await htmlSenden(reply, html, status);
  }

  app.get(
    `${ZUGANG_WIEDERHERSTELLEN_PFAD}/:token`,
    async (request: FastifyRequest<{ Params: TokenParams }>, reply) => {
      const pruefung = await wiederherstellungPruefen(pool, request.params.token, jetzt());
      if (!pruefung.gueltig || pruefung.email === undefined) {
        return nichtGefunden(app, reply);
      }
      return formular(reply, { token: request.params.token, email: pruefung.email });
    },
  );

  app.post(
    `${ZUGANG_WIEDERHERSTELLEN_PFAD}/:token`,
    async (
      request: FastifyRequest<{ Params: TokenParams; Body: WiederherstellenFormular | undefined }>,
      reply,
    ) => {
      const token = request.params.token;
      const pruefung = await wiederherstellungPruefen(pool, token, jetzt());
      if (!pruefung.gueltig || pruefung.id === undefined || pruefung.email === undefined) {
        return nichtGefunden(app, reply);
      }

      const passwort = text(request.body?.passwort);
      const eingabefehler = passwortFehler(passwort, text(request.body?.passwortWiederholung));
      if (eingabefehler) {
        return formular(reply, { token, email: pruefung.email, fehler: eingabefehler }, 400);
      }

      // Ab hier ist der Link unwiderruflich verbraucht. Maßgeblich ist die Adresse aus der
      // Datenbank, nie ein Formularfeld.
      const passwortHash = await passwortHashen(passwort);
      const eingeloest = await wiederherstellungEinloesen(pool, pruefung.id, passwortHash, jetzt());
      if (eingeloest === undefined) {
        return nichtGefunden(app, reply);
      }

      try {
        const { headers, response } = await auth.api.signInEmail({
          body: { email: eingeloest.email, password: passwort },
          headers: fromNodeHeaders(request.headers),
          returnHeaders: true,
        });
        if ('twoFactorRedirect' in response) {
          // Kann nicht eintreten: das Konto hat nach dem Entsperren keinen Faktor. Im Zweifel
          // fail closed: keine Sitzung, die normale Anmeldung übernimmt.
          return reply.redirect(ANMELDEN_PFAD, 303);
        }
        cookiesUebernehmen(reply, headers);
        return reply.redirect(ZWEI_FAKTOR_PFAD, 303);
      } catch (fehler) {
        // Das Passwort ist gesetzt, nur die Anmeldung ist misslungen: die normale Anmeldeseite
        // funktioniert. Weder Passwort noch Token in den Log, und nicht das Fehlerobjekt.
        request.log.error(
          { grund: fehler instanceof Error ? fehler.message : 'unbekannt' },
          'Wiederherstellung: Anmeldung nach dem Setzen des Passworts fehlgeschlagen',
        );
        return formular(
          reply,
          {
            token,
            email: eingeloest.email,
            fehler: 'Das Passwort ist gesetzt. Bitte jetzt über die Anmeldeseite anmelden.',
          },
          500,
        );
      }
    },
  );
}
