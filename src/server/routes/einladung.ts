/**
 * E-Mail-Einladung (COPI-11, Architektur-Vorschlag Abschnitt 7 und 13.2).
 *
 * Zwei getrennte Hälften in einer Datei, weil sie dieselbe Tabelle und
 * dieselben Begriffe teilen:
 *
 *   1. `registriereEinladungRouten` — das Formular „Nutzer einladen".
 *      Erreichbar für angemeldete Konten mit aktivem zweitem Faktor, die
 *      überhaupt jemanden einladen dürfen (Betreuer, Betriebs-Admin). Welche
 *      Rollen sie vergeben dürfen, entscheidet `einladbareRollen`
 *      (`src/auth/berechtigung.ts`): der Betreuer Betriebs-Admins und
 *      Mitarbeiter, der Betriebs-Admin nur Mitarbeiter. Die Bedingung wird über
 *      genau einen `preHandler` vor **beiden** Routen erzwungen — keine Route
 *      dieses Bereichs prüft für sich selbst, damit keine vergessen werden
 *      kann. Ein Rollenwert, den der Einladende nicht vergeben darf (auch ein
 *      von Hand manipulierter), wird wie „kein Zugang" mit der neutralen 404
 *      beantwortet.
 *
 *   2. `registriereEinladungEinloesenRoute` — `/einladung/<token>`: Name und
 *      Passwort, Konto mit der Rolle, die die Einladung trägt. Diese Hälfte ist
 *      bewusst ohne Anmeldung erreichbar; der Besitz des Tokens ist der
 *      Nachweis. Die Rolle kommt aus der Datenbank, nie aus dem Formular.
 *
 * Ablauf beim Einlösen wie beim Erststart (siehe `erststart.ts`): erst
 * prüfen, dann Eingaben prüfen, dann die Einladung mit einer einzelnen
 * bedingten UPDATE-Anweisung entwerten und erst danach das Konto anlegen.
 * Damit kann eine Einladung auch bei gleichzeitigen Anfragen höchstens
 * einmal wirken („fail closed"); ein Tippfehler verbrennt sie nicht.
 *
 * Nach der Kontoanlage greift die zentrale 2FA-Weiche aus COPI-10 von selbst:
 * das neue Konto hat eine Sitzung, aber noch keinen zweiten Faktor, und wird
 * damit von jeder anderen Route auf die Einrichtungsseite umgeleitet. Die
 * Weiche musste dafür nicht angefasst werden — sie lässt Anfragen ohne
 * Sitzung ohnehin durch, und `/einladung/<token>` wird ohne Sitzung
 * aufgerufen.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { cookiesUebernehmen, htmlSenden } from '../../auth/antwort.js';
import { mitBenutzerAnlage } from '../../auth/benutzer-anlage.js';
import { MINDEST_PASSWORTLAENGE, type CockpitAuth } from '../../auth/konfiguration.js';
import {
  darfEinladen,
  einladbareRollen,
  istVergebbareRolle,
  ROLLE_DEFAULT,
  ROLLEN_NAMEN,
  type VergebbareRolle,
  type ZugangLesen,
} from '../../auth/berechtigung.js';
import { EINLADUNG_GUELTIGKEIT_MS } from '../../auth/einladung-token.js';
import { kontoAngelegtNotieren } from '../../auth/protokoll.js';
import {
  einladungAnlegen,
  einladungEinloesen,
  einladungPruefen,
  emailNormalisieren,
  kontoVorhanden,
  rolleSetzen,
} from '../../auth/einladung-speicher.js';
import { ZWEI_FAKTOR_PFAD } from '../../auth/zwei-faktor-tor.js';
import { einladungsMailBauen } from '../../mail/einladung-mail.js';
import type { Mailversand } from '../../mail/versand.js';
import { navigation } from '../navigation.js';
import { emailPlausibel, namePruefen, passwortFehler, text } from './formular.js';
import { nichtGefunden } from './neutral.js';

export const EINLADUNG_PFAD = '/einladung';

const GUELTIG_STUNDEN = EINLADUNG_GUELTIGKEIT_MS / (60 * 60 * 1000);


export interface EinladungAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly versand: Mailversand;
  readonly zugangLesen: ZugangLesen;
  /** Öffentliche Basis-URL — die Einlöse-Adresse muss absolut sein. */
  readonly basisUrl: string;
}

export interface EinloesenAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly auth: CockpitAuth;
}

interface EinladungFormular {
  readonly email?: unknown;
  readonly rolle?: unknown;
}

interface EinloesenFormular {
  readonly name?: unknown;
  readonly passwort?: unknown;
  readonly passwortWiederholung?: unknown;
}

interface TokenParams {
  readonly token: string;
}

export function registriereEinladungRouten(
  app: FastifyInstance,
  abhaengigkeiten: EinladungAbhaengigkeiten,
): void {
  const { pool, versand, zugangLesen, basisUrl } = abhaengigkeiten;

  async function formularZeigen(
    reply: FastifyReply,
    rollen: readonly VergebbareRolle[],
    daten: { fehler?: string; erfolgFuer?: string; erfolgRolle?: VergebbareRolle },
    status = 200,
  ): Promise<void> {
    const html = await app.render('einladung.eta', {
      titel: 'Nutzer einladen',
      // Das Formular wird nur nach der Zugangsprüfung gezeigt: angemeldet und einladen dürfen ist hier gegeben. Wer
      // einladen darf, darf auch die Benutzer sehen und chatten (Betreuer, Betriebs-Admin; `berechtigung.test.ts` hält
      // das fest). Das Kennzeichen ungelesener Nachrichten fehlt hier: die Seite liest ihren Zugang nicht dafür.
      nav: navigation('einladung', { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 }),
      fehler: daten.fehler,
      erfolgFuer: daten.erfolgFuer,
      erfolgRolle: daten.erfolgRolle ? ROLLEN_NAMEN[daten.erfolgRolle] : undefined,
      gueltigStunden: GUELTIG_STUNDEN,
      // Nur, was der Einladende vergeben darf; Mitarbeiter ist vorausgewählt (kleinstes Recht).
      rollen: rollen.map((rolle) => ({
        wert: rolle,
        name: ROLLEN_NAMEN[rolle],
        vorgabe: rolle === ROLLE_DEFAULT,
      })),
    });
    await htmlSenden(reply, html, status);
  }

  /**
   * Die eine Zugangsprüfung dieses Bereichs. Sie läuft als `preHandler` vor
   * GET und POST.
   *
   * Wichtig: ein asynchroner Fastify-Haken bricht die Anfrage nur dann ab,
   * wenn er die Antwort **zurückgibt**. Ohne das `return reply` liefe der
   * eigentliche Handler nach der 404 weiter — deshalb steht es hier und wird
   * von einem Test abgesichert, der nach dem abgewiesenen Versuch prüft, dass
   * keine Einladung entstanden ist.
   */
  async function nurEinladende(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const zugang = await zugangLesen(request);
    if (einladbareRollen(zugang).length > 0) {
      return undefined;
    }
    // Bewusst ohne Kennung im Log: abgewiesen wird hier auch jeder
    // unangemeldete Zugriff, der sonst nur Rauschen erzeugen würde.
    request.log.warn('Einladung: Zugriff ohne Berechtigung abgewiesen');
    await nichtGefunden(app, reply);
    return reply;
  }

  app.get(EINLADUNG_PFAD, { preHandler: nurEinladende }, async (request, reply) => {
    const rollen = einladbareRollen(await zugangLesen(request));
    if (rollen.length === 0) {
      return nichtGefunden(app, reply);
    }
    return formularZeigen(reply, rollen, {});
  });

  app.post<{ Body: EinladungFormular }>(
    EINLADUNG_PFAD,
    { preHandler: nurEinladende },
    async (request, reply) => {
      // Zweite Prüfung derselben zentralen Regel, unmittelbar an der Stelle,
      // die etwas verändert. Sie kostet eine Abfrage und schließt das Fenster
      // zwischen Haken und Handler (z. B. zwischenzeitlich entzogene Rolle).
      const zugang = await zugangLesen(request);
      const rollen = einladbareRollen(zugang);
      if (rollen.length === 0) {
        return nichtGefunden(app, reply);
      }

      // Ohne Angabe gilt das kleinste Recht. Ein Wert, den dieser Einladende
      // nicht vergeben darf — auch `betreuer` oder ein erfundener —, führt zur
      // neutralen 404 wie fehlende Berechtigung: das Formular bietet ihn nie an,
      // er kommt also nur von Hand.
      const gewuenscht = text(request.body.rolle);
      const rolle = gewuenscht === '' ? ROLLE_DEFAULT : gewuenscht;
      if (!istVergebbareRolle(rolle) || !darfEinladen(zugang, rolle)) {
        request.log.warn('Einladung: nicht erlaubte Rolle abgewiesen');
        return nichtGefunden(app, reply);
      }

      const email = emailNormalisieren(text(request.body.email));
      if (!emailPlausibel(email)) {
        return formularZeigen(
          reply,
          rollen,
          { fehler: 'Bitte eine gültige E-Mail-Adresse angeben.' },
          400,
        );
      }
      if (await kontoVorhanden(pool, email)) {
        return formularZeigen(
          reply,
          rollen,
          { fehler: 'Für diese Adresse gibt es bereits einen Zugang.' },
          400,
        );
      }

      const token = await einladungAnlegen(pool, email, zugang.benutzerId, rolle);
      try {
        // Der Klartext-Token existiert nur in dieser Variablen und in der
        // Mail — er wird weder gespeichert noch protokolliert.
        const inhalt = einladungsMailBauen({
          einladungsUrl: `${basisUrl}${EINLADUNG_PFAD}/${token.token}`,
          gueltigStunden: GUELTIG_STUNDEN,
        });
        await versand.senden({
          an: email,
          betreff: inhalt.betreff,
          text: inhalt.text,
          html: inhalt.html,
        });
      } catch (fehler) {
        // Nur die Meldung, nie das Fehlerobjekt: es könnte Empfänger oder
        // Inhalt der Nachricht mitführen. Die angelegte Einladung bleibt
        // stehen und verfällt nach Ablauf von selbst — ohne die Mail kennt
        // niemand ihr Token.
        request.log.error(
          { grund: fehler instanceof Error ? fehler.message : 'unbekannt' },
          'Einladung: Versand fehlgeschlagen',
        );
        return formularZeigen(
          reply,
          rollen,
          { fehler: 'Die Einladung konnte nicht verschickt werden.' },
          502,
        );
      }
      return formularZeigen(reply, rollen, { erfolgFuer: email, erfolgRolle: rolle });
    },
  );
}

export function registriereEinladungEinloesenRoute(
  app: FastifyInstance,
  abhaengigkeiten: EinloesenAbhaengigkeiten,
): void {
  const { pool, auth } = abhaengigkeiten;

  async function einloesenFormular(
    reply: FastifyReply,
    daten: { token: string; email: string; name?: string; fehler?: string },
    status = 200,
  ): Promise<void> {
    const html = await app.render('einladung-einloesen.eta', {
      titel: 'Zugang einrichten',
      token: daten.token,
      email: daten.email,
      name: daten.name ?? '',
      fehler: daten.fehler,
      mindestlaenge: MINDEST_PASSWORTLAENGE,
    });
    await htmlSenden(reply, html, status);
  }

  app.get(
    `${EINLADUNG_PFAD}/:token`,
    async (request: FastifyRequest<{ Params: TokenParams }>, reply) => {
      const pruefung = await einladungPruefen(pool, request.params.token);
      if (!pruefung.gueltig || !pruefung.email) {
        return nichtGefunden(app, reply);
      }
      return einloesenFormular(reply, {
        token: request.params.token,
        email: pruefung.email,
      });
    },
  );

  app.post(
    `${EINLADUNG_PFAD}/:token`,
    async (
      request: FastifyRequest<{ Params: TokenParams; Body: EinloesenFormular }>,
      reply,
    ) => {
      const token = request.params.token;
      const pruefung = await einladungPruefen(pool, token);
      if (!pruefung.gueltig || !pruefung.id || !pruefung.email) {
        return nichtGefunden(app, reply);
      }

      const name = text(request.body.name);
      const passwort = text(request.body.passwort);
      const eingabefehler =
        namePruefen(name) ?? passwortFehler(passwort, text(request.body.passwortWiederholung));
      if (eingabefehler) {
        return einloesenFormular(
          reply,
          { token, email: pruefung.email, name, fehler: eingabefehler },
          400,
        );
      }
      // Ein zwischenzeitlich angelegtes Konto würde die Kontoanlage unten
      // scheitern lassen — hier abgefangen, damit die Einladung dabei nicht
      // verbrannt wird.
      if (await kontoVorhanden(pool, pruefung.email)) {
        return einloesenFormular(
          reply,
          {
            token,
            email: pruefung.email,
            name,
            fehler: 'Für diese Adresse gibt es bereits einen Zugang.',
          },
          400,
        );
      }

      // Ab hier ist die Einladung unwiderruflich verbraucht. Maßgeblich ist
      // die Adresse aus der Datenbank, nie ein Formularfeld.
      const eingeloest = await einladungEinloesen(pool, pruefung.id);
      if (!eingeloest) {
        return nichtGefunden(app, reply);
      }
      const { email, rolle } = eingeloest;

      try {
        const { headers, response } = await mitBenutzerAnlage(() =>
          auth.api.signUpEmail({
            body: { email, password: passwort, name },
            returnHeaders: true,
          }),
        );
        // Die Rolle der Einladung, aus der Datenbank: nie ein Formularfeld,
        // und nie `betreuer` (die Einladung kennt sie nicht).
        await rolleSetzen(pool, response.user.id, rolle);
        await kontoAngelegtNotieren(pool, request.log, {
          weg: 'einladung',
          kontoId: response.user.id,
          rolle,
        });
        cookiesUebernehmen(reply, headers);
        return reply.redirect(ZWEI_FAKTOR_PFAD, 303);
      } catch (fehler) {
        // Weder Passwort noch Token in den Log — und auch nicht das
        // Fehlerobjekt, das die Eingaben mitführen könnte.
        request.log.error(
          { grund: fehler instanceof Error ? fehler.message : 'unbekannt' },
          'Einladung: Kontoanlage fehlgeschlagen',
        );
        const html = await app.render('einladung-fehler.eta', {
          titel: 'Einrichtung fehlgeschlagen',
        });
        return htmlSenden(reply, html, 500);
      }
    },
  );
}
