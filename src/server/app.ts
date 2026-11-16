import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import fastifyEtag from '@fastify/etag';
import fastifyFormbody from '@fastify/formbody';
import { Eta } from 'eta';
import type pg from 'pg';
import { registerHealthRoute } from './routes/health.js';
import { registriereDarstellungsHaken, registriereDarstellungsRoute } from './darstellung.js';
import { registriereSicherheitsHaken } from './sicherheit.js';
import { registriereAssetsRoute } from './routes/assets.js';
import { registerUebersichtRoute } from './routes/uebersicht.js';
import { registerAgentenRoutes } from './routes/agenten.js';
import { registerModulAnhangRoutes } from './routes/modul-anhaenge.js';
import { registerModulRoutes } from './routes/module.js';
import { registerBenutzerRoute } from './routes/benutzer.js';
import { ChatEreignisse } from '../chat/ereignisse.js';
import { kanalBesitzer, pushAnhaengen, WEB_PUSH, type PushKonfiguration, type Versender } from '../chat/push.js';
import { POSTEINGANG_PUSH_TAKT_MS, posteingangPushStarten, posteingangStandFesthalten } from '../posteingang/push.js';
import { TAGESLIMIT_STANDARD } from '../chat/tageslimit.js';
import type { KoordinatorKonfiguration } from '../chat/koordinator.js';
import { AKZENT, registriereAppDateien } from './routes/app-dateien.js';
import { registriereChatRouten } from './routes/chat.js';
import { registrierePushRouten } from './routes/push.js';
import { registriereBetreuerZugriffRoute } from './routes/betreuer-zugriff.js';
import { registriereFreigabeModusRoute } from './routes/freigabe-modus.js';
import { registriereErscheinungsbildRouten } from './routes/erscheinungsbild.js';
import { SymbolQuelle } from '../pwa/symbol-speicher.js';
import { registriereBenutzerBearbeitenRouten } from './routes/benutzer-bearbeiten.js';
import { registriereEmailBestaetigenRouten } from './routes/email-bestaetigen.js';
import { registerEinstellungenRoute } from './routes/einstellungen.js';
import { registriereUpdateAntragRouten } from './routes/update-antrag.js';
import { registerMehrRoute } from './routes/mehr.js';
import { abrufMitZwischenspeicher, type RepowacheKonfiguration } from '../freigaben/repowache.js';
import { zugangLesenMitFreigaben } from '../freigaben/zugang.js';
import { registriereFreigabenRouten } from './routes/freigaben.js';
import { registerMeldungenRoute } from './routes/meldungen.js';
import { zugangLesenMitPosteingang } from '../posteingang/lesen.js';
import { registrierePosteingangRouten } from './routes/posteingang.js';
import { registerAgentDetailRoute } from './routes/agent-detail.js';
import { registriereErststartRoute } from './routes/erststart.js';
import {
  registriereEinladungEinloesenRoute,
  registriereEinladungRouten,
} from './routes/einladung.js';
import { registriereZweiFaktorRouten } from './routes/zwei-faktor.js';
import { registriereWiederherstellungRoute } from './routes/wiederherstellung.js';
import { registrierePasskeyRoutes } from './routes/passkey.js';
import { registriereAnmeldenRouten } from './routes/anmelden.js';
import { registriereSicherheitRouten } from './routes/sicherheit.js';
import { registriereErweiterungen, zugangLesenMitErweiterungen, type Erweiterung } from './erweiterungen.js';
import { registriereClientIp } from '../auth/client-ip.js';
import { registriereInternApi, type InterneRoutenErgaenzer } from '../intern/zugang.js';
import { registrierePipelineApi } from '../pipeline/api.js';
import type { PipelineKonfiguration } from '../pipeline/signatur.js';
import { ASSETS_ORDNER, assetsLaden, type Assets } from '../assets/manifest.js';
import { AUTH_BASIS_PFAD, type CockpitAuth } from '../auth/konfiguration.js';
import { sitzungLeserBauen } from '../auth/sitzung.js';
import { zugangLeserBauen, type ZugangLesen } from '../auth/berechtigung.js';
import { zugangLesenMitModulen } from '../module/sichtbarkeit.js';
import { anzeigeVersion } from '../status/instanz.js';
import { zugangLesenMitUpdateHinweis } from '../status/update-hinweis.js';
import type { Mailversand } from '../mail/versand.js';
import {
  registriereZweiFaktorTor,
  type SitzungLesen,
} from '../auth/zwei-faktor-tor.js';
import type { CockpitEnv } from './env.js';
import { loggerEinstellung } from './logging.js';

const hierDatei = fileURLToPath(import.meta.url);
const hierOrdner = path.dirname(hierDatei);

/**
 * Alles, was die Anwendung von außen bekommt. In Produktion setzt
 * `index.ts` beides; Tests reichen Ersatz-Implementierungen herein oder
 * lassen sie weg, wenn eine Route keine Authentifizierung braucht.
 */
export interface AppAbhaengigkeiten {
  readonly auth?: CockpitAuth;
  readonly pool?: pg.Pool;
  /**
   * Mailversand. Fehlt er (keine SMTP-Konfiguration), wird die
   * Einladungsroute gar nicht erst registriert — lieber keine Route als eine,
   * die den Versand still verschluckt.
   */
  readonly versand?: Mailversand;
  /**
   * Der Ordner mit dem Ergebnis von `npm run assets` (Stylesheet, Schriften, Manifest).
   * Ohne Angabe `assets/gebaut`. Fehlt der Build, startet die Anwendung nicht.
   */
  readonly assetsOrdner?: string;
  /** Öffentliche Basis-URL — nur für absolute Links in Mails nötig. */
  readonly basisUrl?: string;
  /** Überschreibt die Sitzungsabfrage der 2FA-Weiche (für Tests). */
  readonly sitzungLesen?: SitzungLesen;
  /** Überschreibt die Zugangsabfrage der Einladungsroute (für Tests). */
  readonly zugangLesen?: ZugangLesen;
  /**
   * Zeitquelle für Zähler und Anmeldevorgänge der Anmeldung. In Tests
   * verschiebbar, damit Sperren ablaufen können, ohne zu warten.
   */
  readonly jetzt?: () => Date;
  /**
   * Nur für Tests: ein Strom, in den der Log geschrieben wird, damit ein Test prüfen kann,
   * was darin steht (etwa dass kein Token im Klartext vorkommt). Ohne ihn ist der Log in
   * Tests aus.
   */
  readonly logStrom?: NodeJS.WritableStream;
  /**
   * Nur für Tests: wird für **jede** registrierte Route aufgerufen (Fastifys `onRoute`),
   * auch für die, die Plugins und spätere Tickets ergänzen. Der Routen-Test (COPI-29)
   * sammelt so alle Routen ein und prüft, dass jede hinter dem Tor liegt; er darf die
   * Optionen der Route auch verändern (etwa einen Haken voranstellen), um zu messen, ob
   * eine Anfrage den Handler erreicht. Der Haken hängt vor allen Routen und ist ohne
   * Angabe nicht vorhanden.
   */
  readonly routenSammler?: (route: RouteOptions) => void;
  /** Name der Instanz (`COCKPIT_INSTANZ_NAME`, COPI-43): steht in jeder Seite unter der Wortmarke. */
  readonly instanzName?: string;
  /** Der Webhook des Koordinator-Agenten (COPI-54). Ohne ihn sagt der Assistenten-Kanal, dass keiner angebunden ist. */
  readonly koordinator?: KoordinatorKonfiguration;
  /** Das Geheimnis der Pipeline-API (COPI-145). Ohne es ist jede Anfrage an `/pipeline` 401. */
  readonly pipeline?: PipelineKonfiguration;
  /** Die Repo-Wache der Freigabe-Inbox (COPI-139). Ohne sie ist das Modul ausgeblendet: keine Route, kein Eintrag. */
  readonly repowache?: RepowacheKonfiguration;
  /** Nur für Tests: statt `fetch` für die Weiterleitung an den Koordinator und den Abruf der Repo-Wache. */
  readonly holen?: typeof fetch;
  /** Nur für Tests: der Verteiler neuer Nachrichten, um mitzuhören. Ohne Angabe legt die App ihren eigenen an. */
  readonly chatEreignisse?: ChatEreignisse;
  /** Nur für Tests: Abstand des Heartbeats im Chat-Stream. */
  readonly chatPulsMs?: number;
  /** Nachrichten an den Assistenten je Konto und Tag (COPI-57); ohne Angabe 50. */
  readonly chatTageslimit?: number;
  /** Web Push (COPI-59); ohne ihn gibt es keinen Push. */
  readonly push?: PushKonfiguration;
  /** Nur für Tests: statt `web-push` an einen Fake-Push-Dienst. */
  readonly pushVersender?: Versender;
  /**
   * Takt des Posteingang-Push (COPI-116) in Millisekunden. Ohne Angabe eine Minute — außer in Tests: dort läuft er nur,
   * wenn ein Test ihn ausdrücklich setzt; sonst prüfen die Tests den einzelnen Lauf direkt.
   */
  readonly posteingangPushTaktMs?: number;
  /**
   * Nur für Tests: legt zusätzliche Routen unter `/intern` an — über denselben Router wie die
   * echten, also mit Token- und Rechteprüfung. Die Agenten-API selbst braucht die Datenbank (`pool`).
   */
  readonly interneRoutenErgaenzen?: InterneRoutenErgaenzer;
  /**
   * Erweiterungen (COPI-193): je Plugin mit Routen (nur `GET`/`HEAD`) und höchstens einem Navigationseintrag, siehe
   * `erweiterungen.ts`. Ohne Angabe (das Kundenimage) gibt es keine zusätzliche Route und keinen zusätzlichen Eintrag.
   */
  readonly erweiterungen?: readonly Erweiterung[];
}

const OHNE_SITZUNG: SitzungLesen = () =>
  Promise.resolve({ sitzungVorhanden: false, zweiterFaktorAktiv: false });

/**
 * Hängt die Better-Auth-Endpunkte unter `/api/auth/*` ein.
 *
 * Fastify hat den Rumpf zu diesem Zeitpunkt bereits geparst, deshalb wird für
 * Better Auth eine neue `Request` gebaut (so auch in der Better-Auth-Doku).
 * Abweichend von der Doku werden `Set-Cookie`-Kopfzeilen über
 * `getSetCookie()` einzeln übernommen — `headers.forEach` fasst mehrere
 * Cookies zu einer kommagetrennten Zeile zusammen und zerlegt damit Cookies
 * mit `Expires`-Datum.
 */
function registriereAuthEndpunkte(app: FastifyInstance, auth: CockpitAuth): void {
  app.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASIS_PFAD}/*`,
    handler: async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host ?? 'cockpit'}`);
      const headers = new Headers();
      for (const [name, wert] of Object.entries(request.headers)) {
        if (typeof wert === 'string') {
          headers.set(name, wert);
        }
      }

      const hatKoerper = request.method !== 'GET' && request.body !== undefined;
      if (hatKoerper) {
        headers.set('content-type', 'application/json');
      }

      const anfrage = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(hatKoerper ? { body: JSON.stringify(request.body) } : {}),
      });

      const antwort = await auth.handler(anfrage);

      reply.code(antwort.status);
      antwort.headers.forEach((wert, name) => {
        if (name.toLowerCase() !== 'set-cookie') {
          reply.header(name, wert);
        }
      });
      const cookies = antwort.headers.getSetCookie();
      if (cookies.length > 0) {
        reply.header('set-cookie', cookies);
      }
      return reply.send(antwort.body ? await antwort.text() : null);
    },
  });
}

/**
 * Baut die Fastify-Instanz auf, registriert aber startet sie nicht — trennt
 * "Anwendung bauen" von "Anwendung starten", damit Tests den Server ohne
 * echten Port aufbauen können.
 */
export function buildApp(
  env: Pick<CockpitEnv, 'nodeEnv'> & Partial<Pick<CockpitEnv, 'imageVersion' | 'wartungsfenster'>>,
  abhaengigkeiten: AppAbhaengigkeiten = {},
): FastifyInstance {
  const app = Fastify({
    logger: loggerEinstellung(env.nodeEnv, abhaengigkeiten.logStrom),
    // Über dem Standard (100): eine Modul-Zeilen-`id` (COPI-78) darf bis zu 200 Zeichen lang sein und soll dafür
    // die eigene, neutrale 404 der Route sehen, nicht Fastifys „414 URI Too Long" vom Router.
    maxParamLength: 300,
  });

  // Zuerst: ein Haken für Routen wirkt nur auf Routen, die danach registriert werden.
  if (abhaengigkeiten.routenSammler) {
    app.addHook('onRoute', abhaengigkeiten.routenSammler);
  }

  const eta = new Eta({
    views: path.join(hierOrdner, '..', '..', 'views'),
    cache: env.nodeEnv === 'production',
  });

  // Beim Start gelesen: ohne gebaute Assets gibt es keine gestaltete Seite, also auch keinen Start.
  // Außerhalb von Produktion wird bei jeder Anfrage neu gelesen, damit `npm run assets:watch`
  // genügt und kein Neustart nötig ist; in Produktion ändert sich das Image nie.
  const assetsOrdner = abhaengigkeiten.assetsOrdner ?? ASSETS_ORDNER;
  const assetsFest = assetsLaden(assetsOrdner);
  const assets = (): Assets => (env.nodeEnv === 'production' ? assetsFest : assetsLaden(assetsOrdner));

  // Das Stylesheet setzt die Anwendung, nicht die Route: eine Seite kann es nicht vergessen und
  // nicht überschreiben.
  // Die laufende Version für die Anzeige „Cockpit v…" (COPI-84): wie der Instanzname global, nicht in jeder Route.
  const cockpitVersion = anzeigeVersion(env.imageVersion);
  // Das App-Symbol der Instanz (COPI-101): jede Seite verweist auf die Dateien mit dem Hash des aktuellen Satzes.
  const symbole = new SymbolQuelle(abhaengigkeiten.pool, (grund) => {
    app.log.error({ grund }, 'App-Symbol: Lesen gescheitert, es gilt der Standard');
  });
  app.decorate('render', async (template: string, data: Record<string, unknown> = {}) =>
    eta.renderAsync(template, {
      ...data,
      stylesheet: assets().stylesheet,
      instanz: abhaengigkeiten.instanzName,
      cockpitVersion,
      themaFarbe: AKZENT,
      symbolHash: (await symbole.aktuell()).satz.hash,
    }),
  );

  // Sicherheits-Header auf jeder Antwort (COPI-93).
  registriereSicherheitsHaken(app);
  // Vor dem ETag: es soll die Seite mit der Wahl des Schalters beschreiben (COPI-43).
  registriereDarstellungsHaken(app);
  void app.register(fastifyEtag);
  void app.register(fastifyFormbody);

  const { auth, pool } = abhaengigkeiten;

  // Zuerst die Client-IP: Tor, Routen und Better Auth sollen dieselbe sehen.
  registriereClientIp(app);

  // Genau ein zentrales Tor für Sitzungspflicht und zweiten Faktor — vor allen Routen.
  // Ohne Datenbank gibt es keine Sitzung, die das Tor lesen könnte: der zweite Faktor
  // kommt aus der Datenbank (COPI-25). Im Zweifel bleibt das Tor zu.
  const sitzungLesen =
    abhaengigkeiten.sitzungLesen ??
    (auth && pool ? sitzungLeserBauen(auth, pool) : OHNE_SITZUNG);
  registriereZweiFaktorTor(app, sitzungLesen);

  const jetzt = abhaengigkeiten.jetzt ?? (() => new Date());
  // Ein Verteiler neuer Nachrichten je Prozess (COPI-55): Chat-Seite und Agenten-API melden, SSE und Push hören zu.
  const chatTageslimit = abhaengigkeiten.chatTageslimit ?? TAGESLIMIT_STANDARD;
  const chatEreignisse =
    abhaengigkeiten.chatEreignisse ??
    new ChatEreignisse((grund) => {
      app.log.error({ grund: grund instanceof Error ? grund.message : 'unbekannt' }, 'Chat: Abonnent gescheitert');
    });
  // Wer die Seite ansieht, bestimmt die Sicht der Übersicht (Rohbefunde nur für den Betreuer, COPI-37).
  // Nur der selbst gebaute Zugangsleser bekommt `moduleSichtbar` ergänzt (COPI-78): ein von außen gereichter
  // (die meisten Tests) bleibt unverändert, damit er nicht ungefragt eine zusätzliche Abfrage der Modul-
  // Registry auslöst. Ebenso `updateVerfuegbar` (COPI-84, nur mit `technik_sehen`) und der Posteingang (COPI-112).
  const zugangLesenKern =
    abhaengigkeiten.zugangLesen ??
    (auth && pool
      ? zugangLesenMitPosteingang(zugangLesenMitUpdateHinweis(zugangLesenMitModulen(zugangLeserBauen(auth, pool), pool), pool, jetzt), pool, jetzt)
      : undefined);
  // Die Einträge der Erweiterungen (COPI-193) kommen an jeden Zugangsleser, auch an einen von außen gereichten.
  const erweiterungen = abhaengigkeiten.erweiterungen ?? [];
  const zugangLesenErweitert =
    zugangLesenKern && erweiterungen.length > 0 ? zugangLesenMitErweiterungen(zugangLesenKern, erweiterungen) : zugangLesenKern;
  // Die Freigabe-Inbox (COPI-139): Zahl der offenen Entwürfe in der Navigation, nur bei konfigurierter Repo-Wache.
  const repowacheAbruf = abhaengigkeiten.repowache
    ? abrufMitZwischenspeicher(abhaengigkeiten.repowache, jetzt, abhaengigkeiten.holen ? { holen: abhaengigkeiten.holen } : {})
    : undefined;
  const zugangLesen =
    zugangLesenErweitert && repowacheAbruf ? zugangLesenMitFreigaben(zugangLesenErweitert, repowacheAbruf) : zugangLesenErweitert;

  // Was die angemeldeten Seiten brauchen: Uhr, Datenbank und Zugang, soweit vorhanden.
  const seiten = {
    jetzt,
    symbole,
    ...(env.wartungsfenster ? { wartungsfenster: env.wartungsfenster } : {}),
    ...(abhaengigkeiten.push ? { pushOeffentlich: abhaengigkeiten.push.oeffentlich } : {}),
    ...(pool ? { pool } : {}),
    ...(zugangLesen ? { zugangLesen } : {}),
  };

  registerHealthRoute(app);
  registriereDarstellungsRoute(app);
  registriereAssetsRoute(app, assets);
  registriereAppDateien(app, abhaengigkeiten.instanzName, symbole);
  registerUebersichtRoute(app, seiten);
  registerAgentenRoutes(app, seiten);
  registerAgentDetailRoute(app, seiten);
  registerModulRoutes(app, seiten);
  registerModulAnhangRoutes(app, seiten);
  registerBenutzerRoute(app, seiten);
  // Einstellungen zeigen seit COPI-94 die zweiten Faktoren; deren Ersatzcodes der App zählt Better Auth.
  registerEinstellungenRoute(app, { ...seiten, ...(auth && pool ? { auth } : {}) });
  // Der Update-Antrag (COPI-40) braucht die Datenbank und das Konto dahinter: ohne beides keine Route, lieber
  // keine als eine, die niemanden prüfen kann.
  if (pool && zugangLesen) {
    registriereUpdateAntragRouten(app, { pool, zugangLesen, jetzt, symbole, ...(env.wartungsfenster ? { wartungsfenster: env.wartungsfenster } : {}) });
    // Das App-Symbol (COPI-101): ebenso nur mit Datenbank und Konto dahinter.
    registriereErscheinungsbildRouten(app, { pool, zugangLesen, symbole });
    // Der Betreuer-Zugriff auf Fachmodule (COPI-134): nur der Betriebs-Admin setzt ihn.
    registriereBetreuerZugriffRoute(app, { pool, zugangLesen });
    registriereFreigabeModusRoute(app, { pool, zugangLesen });
    // Der Posteingang im Kopf (COPI-112): Stück fürs Nachladen und „Alle als gelesen".
    registrierePosteingangRouten(app, { pool, zugangLesen, jetzt });
    // Der Chat (COPI-53): ebenso nur mit Datenbank und Konto dahinter.
    registriereChatRouten(app, {
      pool,
      zugangLesen,
      jetzt,
      chatEreignisse,
      tageslimit: chatTageslimit,
      ...(abhaengigkeiten.chatPulsMs ? { pulsMs: abhaengigkeiten.chatPulsMs } : {}),
      ...(abhaengigkeiten.koordinator ? { koordinator: abhaengigkeiten.koordinator } : {}),
      ...(abhaengigkeiten.holen ? { holen: abhaengigkeiten.holen } : {}),
    });
    // Web Push (COPI-59): die Routen immer (ohne VAPID-Paar die neutrale 404), die Zustellung nur mit Paar.
    const zustellung = abhaengigkeiten.push
      ? { pool, konfiguration: abhaengigkeiten.push, versender: abhaengigkeiten.pushVersender ?? WEB_PUSH, log: app.log }
      : undefined;
    registrierePushRouten(app, { pool, zugangLesen, eingerichtet: zustellung !== undefined, ...(zustellung ? { zustellung } : {}) });
    if (zustellung) {
      // Nach einem Sofort-Push den Posteingang festhalten, damit der Takt ihn nicht noch einmal meldet (COPI-116).
      pushAnhaengen(chatEreignisse, pool, zustellung.konfiguration, zustellung.versender, app.log, async (nachricht) => {
        const besitzer = await kanalBesitzer(pool, nachricht.kanalId);
        if (besitzer !== undefined) {
          await posteingangStandFesthalten(zustellung, besitzer, jetzt());
        }
      });
      const takt = abhaengigkeiten.posteingangPushTaktMs ?? (env.nodeEnv === 'test' ? undefined : POSTEINGANG_PUSH_TAKT_MS);
      if (takt !== undefined) {
        const anhalten = posteingangPushStarten(zustellung, jetzt, takt);
        app.addHook('onClose', async () => {
          anhalten();
        });
      }
    }
    // Konten bearbeiten (COPI-46): ebenso nur mit Datenbank und Konto dahinter.
    registriereBenutzerBearbeitenRouten(app, {
      pool,
      zugangLesen,
      jetzt,
      ...(abhaengigkeiten.basisUrl ? { basisUrl: abhaengigkeiten.basisUrl } : {}),
      ...(abhaengigkeiten.versand ? { versand: abhaengigkeiten.versand } : {}),
    });
  }
  registerMehrRoute(app, zugangLesen ? { zugangLesen } : {});
  // Die Erweiterungen (COPI-193): gekapselt, nach dem Tor; ohne Liste geschieht nichts.
  registriereErweiterungen(app, erweiterungen, zugangLesen);
  registerMeldungenRoute(app, seiten);
  if (zugangLesen && repowacheAbruf) {
    registriereFreigabenRouten(app, {
      zugangLesen,
      abruf: repowacheAbruf,
      jetzt,
      ...(abhaengigkeiten.repowache ? { repowache: abhaengigkeiten.repowache } : {}),
      ...(abhaengigkeiten.holen ? { holen: abhaengigkeiten.holen } : {}),
    });
  }

  // Eine neue E-Mail-Adresse bestätigen (COPI-47): ohne Anmeldung, der Link ist der Nachweis; braucht nur die Datenbank.
  if (pool) {
    registriereEmailBestaetigenRouten(app, { pool, jetzt });
  }

  // Die Agenten-API (COPI-35) braucht die Datenbank: ohne sie gäbe es kein Token, das sich prüfen
  // ließe. Lieber keine Route als eine ohne Prüfung. Sie hängt nicht an `auth`: sie kennt keine Konten.
  if (pool) {
    registriereInternApi(app, { pool, jetzt, chatEreignisse, chatTageslimit }, abhaengigkeiten.interneRoutenErgaenzen);
    // Die Pipeline-API für den Runner (COPI-145): immer eingehängt, damit der Präfix nie auf eine andere Route fällt;
    // ohne Geheimnis nimmt sie keine Anfrage an.
    registrierePipelineApi(app, { pool, jetzt, konfiguration: abhaengigkeiten.pipeline });
  }

  if (auth) {
    registriereAuthEndpunkte(app, auth);
    if (pool) {
      const { versand, basisUrl } = abhaengigkeiten;
      registriereZweiFaktorRouten(app, { auth, pool, passkeyAngeboten: basisUrl !== undefined });
      // Der Passkey braucht die feste Basis-URL (rpID und Herkunft, ADR 13.3): ohne sie
      // keine Route, lieber keine als eine mit geratener Herkunft.
      if (basisUrl !== undefined) {
        registrierePasskeyRoutes(app, { auth, pool, basisUrl, jetzt });
      }
      registriereAnmeldenRouten(app, { auth, pool, jetzt, ...(basisUrl !== undefined ? { basisUrl } : {}) });
      // Anmeldung & Sicherheit (COPI-94): weitere Faktoren, nur nach frischer Bestätigung. Passkeys nur mit Basis-URL.
      registriereSicherheitRouten(app, {
        auth,
        pool,
        jetzt,
        zugangLesen: zugangLesen ?? zugangLeserBauen(auth, pool),
        ...(basisUrl !== undefined ? { basisUrl } : {}),
        ...(versand ? { versand } : {}),
      });
      registriereErststartRoute(app, { pool, auth });
      registriereEinladungEinloesenRoute(app, { pool, auth });
      registriereWiederherstellungRoute(app, { pool, auth, jetzt });

      if (versand && basisUrl) {
        registriereEinladungRouten(app, {
          pool,
          versand,
          basisUrl,
          zugangLesen: zugangLesen ?? zugangLeserBauen(auth, pool),
        });
      }
    }
  }

  return app;
}
