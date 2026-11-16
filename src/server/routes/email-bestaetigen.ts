/**
 * Eine neue E-Mail-Adresse bestätigen (COPI-47): `/email-bestaetigen/<token>`, der Link aus der Mail an die neue Adresse.
 *
 * Ohne Anmeldung erreichbar — der Besitz des Links ist der Nachweis, dass das Postfach der Person gehört, wie bei
 * Einladung und Wiederherstellung — und deshalb in der Anonym-Allowlist des Tors.
 *
 *   * `GET` zeigt nur, **welche** Adresse bestätigt wird, und einen Knopf. Es ändert nichts: Mailprogramme und
 *     Virenscanner öffnen Links in Mails oft von selbst, und das soll keine Adresse umstellen.
 *   * `POST` (der Knopf) prüft die Herkunft und löst den Link ein — eine bedingte Anweisung, höchstens einmal.
 *
 * Was der Link nicht (mehr) öffnet — kaputt, unbekannt, abgelaufen, schon eingelöst, durch einen neueren Antrag
 * entwertet —, antwortet mit derselben neutralen 404. Hat die Adresse inzwischen ein anderes Konto, ändert sich nichts,
 * und die Seite sagt es.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { htmlSenden } from '../../auth/antwort.js';
import { emailLinkEinloesen, emailLinkPruefen } from '../../auth/email-aenderung.js';
import { herkunftBelegt } from '../../auth/herkunft.js';
import { EMAIL_BESTAETIGEN_PFAD } from '../../auth/zwei-faktor-tor.js';
import { nichtGefunden } from './neutral.js';

export interface EmailBestaetigenAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly jetzt: () => Date;
}

/** Ein Einmal-Token (32 Byte base64url); alles andere fragt die Datenbank gar nicht erst. */
const TOKEN_FORM = /^[A-Za-z0-9_-]{43}$/;

const FEHLER = {
  herkunft: 'Die Anfrage kam nicht von dieser Seite. Bitte den Link aus der Mail noch einmal öffnen.',
  belegt: 'Diese Adresse gehört inzwischen zu einem anderen Konto. Es wurde nichts geändert.',
} as const;

export function registriereEmailBestaetigenRouten(app: FastifyInstance, abhaengigkeiten: EmailBestaetigenAbhaengigkeiten): void {
  const { pool, jetzt } = abhaengigkeiten;

  async function seite(reply: FastifyReply, vorlage: string, daten: Record<string, unknown>, status = 200): Promise<void> {
    const html = await app.render(vorlage, { titel: 'E-Mail-Adresse bestätigen', ...daten });
    // Die Seite trägt den Link in ihrer Formularadresse: nicht zwischenspeichern.
    reply.header('cache-control', 'no-store');
    await htmlSenden(reply, html, status);
  }

  app.get<{ Params: { token: string } }>(`${EMAIL_BESTAETIGEN_PFAD}/:token`, async (request, reply) => {
    const { token } = request.params;
    const pruefung = TOKEN_FORM.test(token) ? await emailLinkPruefen(pool, token, jetzt()) : { gueltig: false };
    if (!pruefung.gueltig || pruefung.neueEmail === undefined) {
      return nichtGefunden(app, reply);
    }
    return seite(reply, 'email-bestaetigen.eta', { token, email: pruefung.neueEmail });
  });

  app.post<{ Params: { token: string } }>(`${EMAIL_BESTAETIGEN_PFAD}/:token`, async (request, reply) => {
    const { token } = request.params;
    const pruefung = TOKEN_FORM.test(token) ? await emailLinkPruefen(pool, token, jetzt()) : { gueltig: false };
    if (!pruefung.gueltig || pruefung.id === undefined || pruefung.neueEmail === undefined) {
      return nichtGefunden(app, reply);
    }
    const { origin, referer, host } = request.headers;
    if (!herkunftBelegt(origin, referer, host)) {
      return seite(reply, 'email-bestaetigen.eta', { token, email: pruefung.neueEmail, fehler: FEHLER.herkunft }, 403);
    }
    const ergebnis = await emailLinkEinloesen(pool, pruefung.id, jetzt());
    if (ergebnis.art === 'ungueltig') {
      return nichtGefunden(app, reply);
    }
    if (ergebnis.art === 'belegt') {
      return seite(reply, 'email-bestaetigen.eta', { token, email: pruefung.neueEmail, fehler: FEHLER.belegt }, 409);
    }
    request.log.info('Adressänderung: neue Adresse bestätigt');
    return seite(reply, 'email-bestaetigt.eta', { email: ergebnis.neueEmail });
  });
}
