/**
 * Erststart-Bootstrap (Architektur-Vorschlag Abschnitt 13.2).
 *
 * Ablauf einer Anmeldung über `/erststart/<token>`:
 *   1. Token prüfen (Hash-Vergleich, Ablauf, „noch kein Benutzer") — ohne es
 *      zu entwerten, sonst wäre schon das Anzeigen des Formulars ein Verbrauch.
 *   2. Eingaben prüfen. Tippfehler dürfen das einmalige Token nicht verbrennen,
 *      deshalb passiert das **vor** dem Einlösen.
 *   3. Token einlösen und Konto anlegen — siehe Hinweis zur Transaktion unten.
 *
 * Zur Transaktionsanforderung: Better Auth bringt seine eigene Verbindung aus
 * dem Pool mit, eine gemeinsame SQL-Transaktion über Bibliotheksgrenzen hinweg
 * ist über die öffentliche API nicht erreichbar. Stattdessen wird das Token
 * **zuerst** mit einer einzelnen bedingten UPDATE-Anweisung eingelöst und erst
 * danach das Konto angelegt. Das Verfahren ist damit „fail closed": ein Token
 * kann nie zweimal wirken, auch nicht bei gleichzeitigen Anfragen. Scheitert
 * die Kontoanlage danach, bleibt das Token verbraucht — der Betreiber startet
 * das Cockpit neu und bekommt ein frisches Token auf stdout.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { mitBenutzerAnlage } from '../../auth/benutzer-anlage.js';
import { cookiesUebernehmen, htmlSenden } from '../../auth/antwort.js';
import { MINDEST_PASSWORTLAENGE, type CockpitAuth } from '../../auth/konfiguration.js';
import { ROLLE_BETREUER } from '../../auth/berechtigung.js';
import { rolleSetzen } from '../../auth/einladung-speicher.js';
import { kontoAngelegtNotieren } from '../../auth/protokoll.js';
import {
  tokenEinloesen,
  tokenPruefen,
  unfertigesKontoEntfernen,
} from '../../auth/erststart-speicher.js';
import { ZWEI_FAKTOR_PFAD } from '../../auth/zwei-faktor-tor.js';
import { emailPlausibel, passwortFehler, text } from './formular.js';

export interface ErststartAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly auth: CockpitAuth;
}

interface ErststartParams {
  readonly token: string;
}

interface ErststartFormular {
  readonly email?: unknown;
  readonly passwort?: unknown;
  readonly passwortWiederholung?: unknown;
}

/**
 * Die einzelnen Regeln stehen seit COPI-11 in `formular.ts` — dieselbe
 * Passwortregel gilt auch für das Einlösen einer Einladung.
 */
export function eingabenPruefen(formular: {
  email: string;
  passwort: string;
  passwortWiederholung: string;
}): string | undefined {
  if (!emailPlausibel(formular.email)) {
    return 'Bitte eine gültige E-Mail-Adresse angeben.';
  }
  return passwortFehler(formular.passwort, formular.passwortWiederholung);
}

export function registriereErststartRoute(
  app: FastifyInstance,
  abhaengigkeiten: ErststartAbhaengigkeiten,
): void {
  const { pool, auth } = abhaengigkeiten;

  /** Neutrale Antwort — verrät nicht, ob es ein Token gibt oder gab. */
  async function nichtGefunden(reply: FastifyReply): Promise<void> {
    const html = await app.render('nicht-gefunden.eta', { titel: 'Nicht gefunden' });
    await htmlSenden(reply, html, 404);
  }

  async function formularZeigen(
    reply: FastifyReply,
    token: string,
    fehler?: string,
    status = 200,
  ): Promise<void> {
    const html = await app.render('erststart.eta', {
      titel: 'Cockpit einrichten',
      token,
      fehler,
      mindestlaenge: MINDEST_PASSWORTLAENGE,
    });
    await htmlSenden(reply, html, status);
  }

  app.get(
    '/erststart/:token',
    async (request: FastifyRequest<{ Params: ErststartParams }>, reply) => {
      const pruefung = await tokenPruefen(pool, request.params.token);
      if (!pruefung.gueltig) {
        return nichtGefunden(reply);
      }
      return formularZeigen(reply, request.params.token);
    },
  );

  /**
   * Das Erststart-Konto ist der Betreuer (ADR 13.2, COPI-22): die eine Rolle mit
   * vollständigen Rechten, in der Datenbank auf ein Konto begrenzt. Better Auth
   * legt das Konto mit dem Spalten-Default an, die Rolle folgt unmittelbar
   * danach. Scheitert sie, wird das Konto zurückgenommen — sonst bliebe ein Konto
   * ohne Betreuerrolle stehen, das niemanden einladen kann, und der Erststart
   * ließe sich erst nach 72 Stunden wiederholen. Der Fehler geht weiter nach oben
   * (Fehlerseite), das Token bleibt wie immer verbraucht.
   */
  async function betreuerVergeben(request: FastifyRequest, benutzerId: string): Promise<void> {
    try {
      await rolleSetzen(pool, benutzerId, ROLLE_BETREUER);
    } catch (fehler) {
      await unfertigesKontoEntfernen(pool, benutzerId).catch((rueckfehler: unknown) => {
        request.log.error(
          { grund: rueckfehler instanceof Error ? rueckfehler.message : 'unbekannt' },
          'Erststart: Konto ohne Rolle konnte nicht zurückgenommen werden (der Verfall räumt es nach 72 Stunden)',
        );
      });
      throw fehler;
    }
  }

  app.post(
    '/erststart/:token',
    async (
      request: FastifyRequest<{ Params: ErststartParams; Body: ErststartFormular }>,
      reply,
    ) => {
      const token = request.params.token;
      const pruefung = await tokenPruefen(pool, token);
      if (!pruefung.gueltig || !pruefung.id) {
        return nichtGefunden(reply);
      }

      const email = text(request.body.email);
      const passwort = text(request.body.passwort);
      const passwortWiederholung = text(request.body.passwortWiederholung);
      const eingabefehler = eingabenPruefen({ email, passwort, passwortWiederholung });
      if (eingabefehler) {
        return formularZeigen(reply, token, eingabefehler, 400);
      }

      // Ab hier ist das Token unwiderruflich verbraucht.
      const eingeloest = await tokenEinloesen(pool, pruefung.id);
      if (!eingeloest) {
        return nichtGefunden(reply);
      }

      try {
        const { headers, response } = await mitBenutzerAnlage(() =>
          auth.api.signUpEmail({
            body: {
              email,
              password: passwort,
              name: email.split('@')[0] ?? email,
            },
            returnHeaders: true,
          }),
        );
        await betreuerVergeben(request, response.user.id);
        // Erst nach der Rolle: ein zurückgenommenes Konto hinterlässt keinen Eintrag.
        await kontoAngelegtNotieren(pool, request.log, {
          weg: 'erststart',
          kontoId: response.user.id,
          rolle: ROLLE_BETREUER,
        });
        cookiesUebernehmen(reply, headers);
        return reply.redirect(ZWEI_FAKTOR_PFAD, 303);
      } catch (fehler) {
        // Weder Passwort noch Token in den Log — und auch nicht das
        // Fehlerobjekt, das die Eingaben mitführen könnte.
        request.log.error(
          { grund: fehler instanceof Error ? fehler.message : 'unbekannt' },
          'Erststart: Kontoanlage fehlgeschlagen',
        );
        const html = await app.render('erststart-fehler.eta', {
          titel: 'Einrichtung fehlgeschlagen',
        });
        return htmlSenden(reply, html, 500);
      }
    },
  );
}
