/**
 * Der Zugang zur Agenten-API (COPI-35): `/intern/*`, maschinell mit einem Bearer-Token.
 *
 * Die Agenten-API liegt auf dem einzigen öffentlich erreichbaren Dienst, **ohne Sitzung und ohne
 * zweiten Faktor** — das Tor (`auth/zwei-faktor-tor.ts`) lässt den Präfix durch, ohne eine Sitzung zu
 * lesen. Deshalb sitzt die Prüfung hier, und zwar so, dass sie sich nicht vergessen lässt:
 *
 *   * Ein **Haken für das ganze Plugin** prüft das Token. Jede Route unter `/intern` läuft durch ihn,
 *     auch ein Pfad, den es nicht gibt (eigener „nicht gefunden"-Handler): ohne Token 401, egal ob es
 *     die Route gibt. Sonst ließe sich an 401 gegen 404 ablesen, welche Routen es gibt.
 *   * Routen entstehen nur über `InternerRouter.route` und **müssen** ein Recht nennen (`scope`, oder
 *     `null` für „jedes gültige Token"). Eine Route ohne Angabe gibt es nicht.
 *
 * **Antworten** sind knapp und verraten nichts: fehlendes, kaputtes, unbekanntes und widerrufenes Token
 * bekommen dieselbe 401, Byte für Byte. Das Token wird nur aus der `Authorization`-Kopfzeile gelesen
 * (nie aus der Adresse), erst danach wird der Rumpf gelesen (der Haken läuft vor dem Parsen), und es
 * steht weder im Log noch in einer Antwort noch im Protokoll.
 *
 * **Begrenzung** (`ratenbegrenzung.ts`): je Client-IP höchstens 20 gescheiterte Versuche in 15 Minuten
 * (wer die Prüfung besteht, bekommt seine Reservierung zurück), je Zugang höchstens 300 Anfragen in der
 * Minute. Beides im Arbeitsspeicher; die Begründung steht dort.
 *
 * **Protokoll:** ein widerrufener Zugang und ein fehlendes Recht sind ein Zeichen für ein
 * durchgesickertes Token oder einen Fehler im Agenten und kommen ins Protokoll — je Zugang und Grund
 * höchstens einmal je Stunde. Ein fehlendes oder unbekanntes Token nicht: das Protokoll lässt sich nicht
 * bereinigen (COPI-23), und dieser Endpunkt ist offen erreichbar.
 *
 * **Fällt die Datenbank aus,** antwortet die API mit 503 ohne Fehlertext und lässt niemanden durch.
 *
 * **Nur JSON** (COPI-36): das Plugin kennt keinen anderen Inhaltstyp — kein Formular, kein Text —, und
 * ein Fehler bei der Bearbeitung wird zu einer knappen JSON-Antwort ohne Text der Datenbank (`400`, `413`,
 * `415`, `500`). Der Fehlertext gelangt weder in die Antwort noch in den Log.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type pg from 'pg';
import { CLIENT_IP_KOPF, IP_UNBEKANNT } from '../auth/client-ip.js';
import { tokenHashen } from '../auth/einmal-token.js';
import { protokollNotieren } from '../auth/protokoll.js';
import { INTERN_PFAD } from '../auth/zwei-faktor-tor.js';
import { antworten } from './antwort.js';
import { registriereAgentenRoute } from './agenten.js';
import { registriereBefundRoute } from './befund.js';
import type { ChatEreignisse } from '../chat/ereignisse.js';
import { registriereChatAntwortRoute } from './chat.js';
import { registriereEingriffRouten } from './eingriffe.js';
import { registriereKiVerbrauchRoute } from './ki-verbrauch.js';
import { registrierePipelineRouten } from './pipeline.js';
import { registrierePipelineVerbrauchRouten } from './pipeline-verbrauch.js';
import { registriereVerbrauchRoute } from './verbrauch.js';
import { registriereVorgangRoute } from './vorgaenge.js';
import { registriereWechselkursRoute } from './wechselkurs.js';
import { registriereZustandRoute } from './zustand.js';
import { FensterZaehler } from './ratenbegrenzung.js';
import { apiTokenSuchen, zugangKennung, type ApiTokenZeile } from './token-speicher.js';
import { tokenAusKopf, type ApiScope } from './token.js';

/** Gescheiterte Versuche je Client-IP im Fenster, bevor die Adresse gebremst wird. */
const IP_FEHLVERSUCHE = 20;
const IP_FENSTER_MS = 15 * 60 * 1000;
/** Anfragen je Zugang und Minute. Ein Agent meldet alle paar Minuten; das hier fängt eine Endlosschleife ab. */
const TOKEN_ANFRAGEN = 300;
const TOKEN_FENSTER_MS = 60 * 1000;
/** Wie oft derselbe Zugang mit demselben Grund höchstens ins Protokoll kommt. */
const PROTOKOLL_ABSTAND_MS = 60 * 60 * 1000;

/** Der Zugang, dessen Token die Anfrage bestanden hat. */
export interface InternerZugang {
  readonly id: number;
  readonly name: string;
  readonly scopes: readonly ApiScope[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Gesetzt von der Prüfung unter `/intern`; sonst `null`. */
    internerZugang: InternerZugang | null;
  }
}

export interface InterneRoute {
  readonly methode: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Pfad unterhalb von `/intern`, mit führendem Schrägstrich (`/befund`). */
  readonly url: string;
  /**
   * Das Recht, das der Zugang braucht. `null` heißt: jedes gültige Token genügt. Eine Pflichtangabe,
   * damit sich eine Route nicht aus Versehen ohne Rechteprüfung einschleicht.
   */
  readonly scope: ApiScope | null;
  /** Größter erlaubter Rumpf in Byte; ohne Angabe gilt die Grenze der Anwendung. */
  readonly bodyLimit?: number;
  readonly handler: RouteHandlerMethod;
}

/** Der einzige Weg, eine Route unter `/intern` anzulegen. */
export interface InternerRouter {
  route(route: InterneRoute): void;
}

export type InterneRoutenErgaenzer = (router: InternerRouter) => void;

export interface InternAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly jetzt: () => Date;
  /** Neue Nachrichten im Chat (COPI-55): die Antwort des Koordinators geht dorthin. */
  readonly chatEreignisse: ChatEreignisse;
  /** Nachrichten an den Assistenten je Konto und Tag (COPI-57). */
  readonly chatTageslimit: number;
}

function nichtAngemeldet(reply: FastifyReply): FastifyReply {
  return antworten(reply, 401, 'nicht_angemeldet', { 'www-authenticate': 'Bearer' });
}

function zuVieleAnfragen(reply: FastifyReply, sekunden: number): FastifyReply {
  return antworten(reply, 429, 'zu_viele_anfragen', { 'retry-after': String(sekunden) });
}

/** Der Fehlercode einer Datenbankstörung — nie die Meldung: sie kann Adressen der Infrastruktur nennen. */
function fehlerCode(fehler: unknown): string {
  if (typeof fehler === 'object' && fehler !== null && 'code' in fehler) {
    return String((fehler as { code: unknown }).code);
  }
  return 'unbekannt';
}

/** Der HTTP-Status, den Fastify einem Fehler mitgibt (Rumpf zu groß, falscher Inhaltstyp, kaputtes JSON). */
function fehlerStatus(fehler: unknown): number | undefined {
  if (typeof fehler === 'object' && fehler !== null && 'statusCode' in fehler && typeof fehler.statusCode === 'number') {
    return fehler.statusCode;
  }
  return undefined;
}

/** Was zu einem Fehler ins Log darf: Code und Name der verletzten Regel, nie Meldung oder Werte. */
function fehlerMerkmale(fehler: unknown): { code: string; constraint?: string } {
  const merkmale = { code: fehlerCode(fehler) };
  if (typeof fehler === 'object' && fehler !== null && 'constraint' in fehler && typeof fehler.constraint === 'string') {
    return { ...merkmale, constraint: fehler.constraint };
  }
  return merkmale;
}

/**
 * Jeder Fehler wird zu einer knappen JSON-Antwort. Der Text eines Fehlers (er kann Werte aus der Eingabe oder Adressen
 * der Infrastruktur nennen) verlässt den Prozess nie. Gemeinsam mit der Pipeline-API (COPI-145); dort wird eine
 * falsche Signatur, die erst beim Lesen des Rumpfs auffällt, als Fehler mit Status 401 gemeldet (`unberechtigt`).
 */
export function knappeFehlerEinrichten(
  instanz: FastifyInstance,
  name: string,
  unberechtigt?: (reply: FastifyReply) => FastifyReply,
): void {
  instanz.setErrorHandler((fehler, request, reply) => {
    const status = fehlerStatus(fehler);
    if (status === 401 && unberechtigt !== undefined) {
      return unberechtigt(reply);
    }
    if (status === 413) {
      return antworten(reply, 413, 'zu_gross');
    }
    if (status === 415) {
      return antworten(reply, 415, 'inhaltstyp_nicht_unterstuetzt');
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return antworten(reply, 400, 'ungueltige_anfrage');
    }
    request.log.error(fehlerMerkmale(fehler), `${name}: Fehler bei der Bearbeitung`);
    return antworten(reply, 500, 'interner_fehler');
  });
}

export function clientIp(request: FastifyRequest): string {
  const wert = request.headers[CLIENT_IP_KOPF];
  return (Array.isArray(wert) ? wert[0] : wert) ?? IP_UNBEKANNT;
}

/** Hängt die Agenten-API unter `/intern` ein. */
export function registriereInternApi(
  app: FastifyInstance,
  abhaengigkeiten: InternAbhaengigkeiten,
  ergaenzen?: InterneRoutenErgaenzer,
): void {
  const { pool, jetzt } = abhaengigkeiten;
  const ipZaehler = new FensterZaehler(IP_FEHLVERSUCHE, IP_FENSTER_MS);
  const tokenZaehler = new FensterZaehler(TOKEN_ANFRAGEN, TOKEN_FENSTER_MS);
  const zuletztProtokolliert = new Map<string, number>();

  /** Hält eine Ablehnung im Protokoll fest, höchstens einmal je Stunde für Zugang und Grund. */
  async function ablehnungNotieren(
    request: FastifyRequest,
    zugang: Pick<ApiTokenZeile, 'id'>,
    grund: 'widerrufen' | 'scope',
    scope?: ApiScope,
  ): Promise<void> {
    const schluessel = `${String(zugang.id)}:${grund}:${scope ?? ''}`;
    const jetztMs = jetzt().getTime();
    const zuletzt = zuletztProtokolliert.get(schluessel);
    if (zuletzt !== undefined && jetztMs - zuletzt < PROTOKOLL_ABSTAND_MS) {
      return;
    }
    zuletztProtokolliert.set(schluessel, jetztMs);
    await protokollNotieren(pool, request.log, {
      art: 'api_zugriff_abgelehnt',
      akteur: zugangKennung(zugang.id),
      einzelheiten: { token_id: zugang.id, grund, ...(scope === undefined ? {} : { scope }) },
    });
  }

  /** Der Haken für das ganze Plugin: ohne gültiges Token kommt nichts durch. */
  async function tokenPruefen(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const ip = clientIp(request);

    // Reservieren, dann prüfen: gezählt wird, bevor geprüft wird. Wer besteht, bekommt es zurück.
    const reservierung = ipZaehler.reservieren(ip, jetzt().getTime());
    if (!reservierung.erlaubt) {
      return zuVieleAnfragen(reply, reservierung.wiederNachSekunden);
    }

    const token = tokenAusKopf(request.headers.authorization);
    if (token === undefined) {
      return nichtAngemeldet(reply);
    }

    let zugang: ApiTokenZeile | undefined;
    try {
      zugang = await apiTokenSuchen(pool, tokenHashen(token));
    } catch (fehler) {
      // Eine Störung der Datenbank ist nicht die Schuld des Clients: die Reservierung geht zurück.
      ipZaehler.gutschreiben(ip);
      request.log.error({ code: fehlerCode(fehler) }, 'Agenten-API: Datenbank nicht erreichbar');
      return antworten(reply, 503, 'nicht_verfuegbar');
    }

    if (zugang === undefined) {
      return nichtAngemeldet(reply);
    }
    if (zugang.widerrufenAm !== undefined) {
      // Für den Aufrufer nicht von „unbekannt" zu unterscheiden, für den Betreiber schon.
      await ablehnungNotieren(request, zugang, 'widerrufen');
      return nichtAngemeldet(reply);
    }

    ipZaehler.gutschreiben(ip);
    const rate = tokenZaehler.reservieren(String(zugang.id), jetzt().getTime());
    if (!rate.erlaubt) {
      return zuVieleAnfragen(reply, rate.wiederNachSekunden);
    }

    // Jede Antwort der Agenten-API ist `no-store` — auch die künftiger Routen, ohne dass sie daran denken müssen.
    void reply.header('cache-control', 'no-store');
    request.internerZugang = { id: zugang.id, name: zugang.name, scopes: zugang.scopes };
    return undefined;
  }

  /** Der Haken einer Route: der Zugang muss das Recht haben. Läuft nach `tokenPruefen`. */
  function rechtPruefen(erforderlich: ApiScope) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
      const zugang = request.internerZugang;
      if (zugang === null) {
        // Kann nicht eintreten (der Haken des Plugins lief vor diesem); im Zweifel bleibt die Tür zu.
        return nichtAngemeldet(reply);
      }
      if (zugang.scopes.includes(erforderlich)) {
        return undefined;
      }
      await ablehnungNotieren(request, zugang, 'scope', erforderlich);
      return antworten(reply, 403, 'nicht_erlaubt');
    };
  }

  void app.register(
    async (intern) => {
      intern.decorateRequest('internerZugang', null);
      intern.addHook('onRequest', tokenPruefen);

      // Nur JSON. Die Anwendung kennt sonst auch Formulare und Text; die Agenten-API nicht, und ein
      // anderer Inhaltstyp ist eine 415, keine Auslegung. Die Grenzen gegen Prototype-Poisoning bleiben.
      intern.removeAllContentTypeParsers();
      intern.addContentTypeParser('application/json', { parseAs: 'string' }, intern.getDefaultJsonParser('error', 'error'));

      knappeFehlerEinrichten(intern, 'Agenten-API');

      // Auch ein Pfad, den es nicht gibt, verlangt zuerst das Token (der Haken oben läuft im
      // Kontext dieses Handlers mit).
      intern.setNotFoundHandler((_request, reply) => antworten(reply, 404, 'nicht_gefunden'));

      const router: InternerRouter = {
        route(route) {
          intern.route({
            method: route.methode,
            url: route.url,
            ...(route.scope === null ? {} : { onRequest: [rechtPruefen(route.scope)] }),
            ...(route.bodyLimit === undefined ? {} : { bodyLimit: route.bodyLimit }),
            handler: route.handler,
          });
        },
      };

      // Prüfung der Verbindung und des Tokens: ein Agent kann so nach dem Anlegen des Zugangs sehen,
      // ob Adresse, Token und Rechte stimmen, ohne etwas zu schreiben.
      router.route({
        methode: 'GET',
        url: '/ping',
        scope: null,
        handler: (request) => {
          const zugang = request.internerZugang;
          return { status: 'ok', name: zugang?.name, scopes: zugang?.scopes };
        },
      });

      registriereBefundRoute(router, abhaengigkeiten);
      registriereAgentenRoute(router, abhaengigkeiten);
      registriereEingriffRouten(router, abhaengigkeiten);
      registriereChatAntwortRoute(router, abhaengigkeiten);
      registriereZustandRoute(router, abhaengigkeiten);
      registriereVerbrauchRoute(router, abhaengigkeiten);
      registriereVorgangRoute(router, abhaengigkeiten);
      registriereKiVerbrauchRoute(router, abhaengigkeiten);
      registriereWechselkursRoute(router, abhaengigkeiten);
      registrierePipelineRouten(router, abhaengigkeiten);
      registrierePipelineVerbrauchRouten(router, abhaengigkeiten);

      ergaenzen?.(router);
    },
    { prefix: INTERN_PFAD },
  );
}
