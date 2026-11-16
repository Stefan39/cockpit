/**
 * Der Update-Antrag (COPI-40, ADR 13.1): „Das Cockpit aktualisiert nichts. Es beantragt."
 *
 * Drei Formulare, alle aus den Einstellungen und nur für den Betreuer (Recht `update_beantragen`):
 *
 *   1. `POST /einstellungen/update` — der Ziel-Digest aus dem Feld. Das legt **nichts** an, sondern zeigt die
 *      Bestätigungsseite mit beiden Digests (von … auf …): ein Schritt gegen Fehlklicks.
 *   2. `POST /einstellungen/update/bestaetigen` — das Formular der Bestätigungsseite. Erst das schreibt die Zeile
 *      `cockpit.eingriff` (`beantragt`) samt Protokolleintrag und kehrt zu den Einstellungen zurück.
 *   3. `POST /einstellungen/update/zurueckziehen` — zieht einen Antrag zurück, der noch auf die Freigabe wartet.
 *
 * **Das ist alles.** Die Freigabe geschieht außerhalb des Cockpits (Stefans Meldekanal), die Ausführung übernimmt
 * der Admin-Agent. Das Cockpit bekommt dafür weder Docker-Socket noch SSH noch GHCR-Zugriff und benachrichtigt auch
 * niemanden: der Agent holt offene Anträge über die Agenten-API ab (COPI-41).
 *
 * **Wer:** Die Prüfung ist eine Funktion (`nurBetreuer`), die als `preHandler` vor jeder der drei Routen steht, und
 * wird im Handler an der Stelle, die etwas verändert, wiederholt — wie bei der Einladung. Wer das Recht nicht hat,
 * bekommt `403` und es entsteht nichts; die Tests prüfen das für jede Route einzeln. Anonyme erreichen die Routen
 * nie: das Tor schickt sie vorher zur Anmeldung.
 *
 * **CSRF**, zweifach: Die Herkunft ist Pflicht (`Origin` oder `Referer` muss die eigene Adresse sein,
 * `herkunftBelegt`) — strenger als bei der Anmeldung, denn unter `<kuerzel>.example.com` gilt jede Nachbar-
 * Subdomain für `SameSite` als „same site". Dazu trägt die Bestätigungsseite eine signierte Bestätigung, gebunden
 * an Konto, Ziel, laufenden Digest und zehn Minuten (`status/update-antrag.ts`).
 *
 * **Was geprüft wird:** die strenge Form des Ziel-Digests; dass das Cockpit seinen laufenden Digest kennt (ohne ihn
 * kein Rückweg, kein Antrag); dass das Ziel nicht schon läuft; dass es keinen offenen Antrag gibt (die Datenbank
 * hält das ohnehin fest, Migration 0018 — so scheitert auch ein doppelt abgeschicktes Formular).
 *
 * **„Update installieren" (COPI-140):** Schickt das Formular `quelle=wache` statt eines Ziels, nimmt der Server das Ziel,
 * das die Versions-Wache gerade meldet (`gemeldetesZielLesen`) — getippt wird nichts. Die Bestätigungsseite trägt die
 * Quelle weiter; beim Bestätigen wird das Ziel noch einmal gegen die Wache geprüft. Meldet sie inzwischen ein anderes,
 * gilt die Bestätigung nicht, und die Seite kommt mit dem neuen Ziel zurück (`409`). Meldet sie keins mehr, kein Antrag.
 * Das getippte Ziel bleibt als Notweg („Bestimmten Stand wählen"). Ein Modul, dessen Herkunft nicht unter
 * `module/<kennung>.cockpit.yaml` liegt, nimmt gar keinen Antrag an (`409`): der Admin-Agent könnte ihn nicht einspielen.
 *
 * **Freigabemodus (COPI-141):** Steht der Bereich auf `direkt`, ist das Bestätigen zugleich die Freigabe — der Antrag
 * steht sofort auf `freigegeben`, die Seite sagt das vorher und der Knopf heißt „Freigeben und installieren". Das gilt
 * nur für ein Ziel der Versions-Wache: der Notweg bleibt immer bei der Rückfrage (ein von Hand gewählter Stand, oft der
 * Weg zurück, bekommt eine zweite Prüfung; beim Image fehlte auch die Version für den Erfolgsbeleg). Die Bestätigungsseite
 * trägt den angekündigten Modus mit; gilt beim Bestätigen ein anderer, entsteht nichts, und sie kommt mit dem geltenden
 * zurück (`409`).
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hatRecht, type Zugang, type ZugangLesen } from '../../auth/berechtigung.js';
import { herkunftBelegt } from '../../auth/herkunft.js';
import { instanzLesen } from '../../status/instanz-speicher.js';
import { gemeldetesZielLesen } from '../../status/versionen-speicher.js';
import { istModulKennung } from '../../module/block.js';
import { antragModus, freigabeModusLesen, istAntragModus, type AntragModus, type FreigabeBereich } from '../../status/freigabe-modus.js';
import {
  modulStandLesen,
  modulUpdateBeantragen,
  offenerAntragVorhanden,
  updateBeantragen,
  updateZurueckziehen,
  type AntragErgebnis,
  type ModulStand,
} from '../../status/update-antrag-speicher.js';
import {
  bestaetigungAusstellen,
  bestaetigungPruefen,
  modulBestaetigungAusstellen,
  modulBestaetigungPruefen,
  zielCommitAus,
  zielDigestAus,
} from '../../status/update-antrag.js';
import { commitPasst, herkunftCommit, herkunftUnterModule, modulVersionsWache, VERSIONS_WACHE, type UpdateZiel } from '../../status/versionen.js';
import { navigationFuerZugang } from '../navigation.js';
import type { SymbolQuelle } from '../../pwa/symbol-speicher.js';
import type { Wartungsfenster } from '../../status/wartungsfenster.js';
import { EINSTELLUNGEN_PFAD, einstellungenSenden, type AntragsRueckmeldung } from './einstellungen.js';

export const UPDATE_PFAD = `${EINSTELLUNGEN_PFAD}/update`;
export const UPDATE_BESTAETIGEN_PFAD = `${UPDATE_PFAD}/bestaetigen`;
export const UPDATE_ZURUECKZIEHEN_PFAD = `${UPDATE_PFAD}/zurueckziehen`;
export const MODUL_UPDATE_PFAD = `${EINSTELLUNGEN_PFAD}/modul-update`;
export const MODUL_UPDATE_BESTAETIGEN_PFAD = `${MODUL_UPDATE_PFAD}/bestaetigen`;

export interface UpdateAntragAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly zugangLesen: ZugangLesen;
  readonly jetzt: () => Date;
  /** Für den Abschnitt „Erscheinungsbild" der Einstellungen (COPI-101), die nach einem Fehler wieder erscheinen. */
  readonly symbole?: SymbolQuelle;
  /** Das Wartungsfenster der automatischen Image-Updates (COPI-235): die Seite danach zeigt es wie die Einstellungen. */
  readonly wartungsfenster?: Wartungsfenster;
}

const FEHLER = {
  form: 'Bitte den vollständigen Digest angeben: sha256: und 64 Zeichen 0–9, a–f.',
  laeuftSchon: 'Dieser Digest läuft bereits.',
  offen: 'Es gibt schon einen offenen Antrag. Ein neuer geht erst, wenn er abgeschlossen oder zurückgezogen ist.',
  nichtZurueck: 'Dieser Antrag lässt sich nicht mehr zurückziehen: er ist schon freigegeben, gestartet oder abgeschlossen.',
  nummer: 'Unbekannte Antragsnummer.',
  keinRecht: 'Diese Aktion ist für dieses Konto nicht erlaubt.',
  bestaetigung: 'Die Bestätigung ist abgelaufen oder ungültig. Bitte den Antrag in den Einstellungen neu stellen.',
  gescheitert: 'Das hat nicht geklappt, es wurde nichts geändert. Bitte später noch einmal versuchen.',
  // COPI-115: mit Beispiel und dem häufigsten Fehler (die ganze Herkunftszeile eingefügt).
  commitForm: 'Bitte nur den Commit angeben, z. B. 8d41e07 (7–40 Zeichen 0–9, a–f) – nicht die ganze Herkunft.',
  modulUnbekannt: 'Dieses Modul ist nicht (mehr) aktiv.',
  ohneHerkunft: 'Dieses Modul wurde ohne Herkunft aus agent-blueprints eingespielt: ein Update lässt sich nicht beantragen.',
  commitLaeuftSchon: 'Dieser Commit ist bereits eingespielt.',
  nurKonsole: 'Die Herkunft dieses Moduls liegt nicht unter module/: ein Update geht nur per Server-Konsole (einspielen).',
  keinUpdate: 'Die Versions-Wache meldet kein Update mehr. Es wurde nichts beantragt.',
} as const;

/** Der Satz über der Bestätigung, wenn die Wache inzwischen ein anderes Ziel meldet (COPI-140). */
const ZIEL_GEAENDERT = 'Die Versions-Wache meldet inzwischen ein anderes Ziel. Bitte das neue Ziel prüfen und noch einmal bestätigen.';

/** Der Satz über der Bestätigung, wenn inzwischen ein anderer Freigabemodus gilt (COPI-141). */
const MODUS_GEAENDERT = 'Der Freigabemodus wurde inzwischen umgestellt. Bitte prüfen, wie dieser Antrag freigegeben wird, und noch einmal bestätigen.';

/** Der angekündigte Modus aus dem Formular; fehlt er oder ist er unbekannt, die Rückfrage (dann prüft der Speicher). */
function erwarteterModus(formular: { readonly modus?: unknown }): AntragModus {
  return istAntragModus(formular.modus) ? formular.modus : 'rueckfrage';
}

/** Wohin es nach einem gestellten Antrag geht: der Hinweis sagt, ob er schon freigegeben ist. */
function nachDemAntrag(modus: AntragModus, modul?: string): string {
  return `${EINSTELLUNGEN_PFAD}?antrag=${modus === 'direkt' ? 'freigegeben' : 'gestellt'}${modul === undefined ? '' : `&modul=${modul}`}`;
}

/** Ob das Formular vom Knopf „Update installieren" kommt: dann gilt das Ziel der Wache, nicht ein getipptes. */
function ausWache(formular: { readonly quelle?: unknown } | undefined): boolean {
  return formular?.quelle === 'wache';
}

/** Eine Antragsnummer: eine positive ganze Zahl, sicher darstellbar. */
const NUMMER = /^[1-9][0-9]{0,14}$/;

/** Höchstens so viel einer falschen Eingabe kommt zurück ins Feld. */
const EINGABE_HOECHSTENS = 200;

interface BeantragenFormular {
  readonly ziel?: unknown;
  /** `wache` beim Knopf „Update installieren" (COPI-140). */
  readonly quelle?: unknown;
}

interface BestaetigenFormular {
  readonly ziel?: unknown;
  readonly quelle?: unknown;
  /** Der Freigabemodus, den die Bestätigungsseite angekündigt hat (COPI-141). */
  readonly modus?: unknown;
  readonly bis?: unknown;
  readonly token?: unknown;
}

interface ModulFormular extends BestaetigenFormular {
  readonly modul?: unknown;
}

interface ZurueckziehenFormular {
  readonly id?: unknown;
}

/** Das Konto, das beantragen darf, oder `undefined`. */
function antragsteller(zugang: Zugang): string | undefined {
  return hatRecht(zugang, 'update_beantragen') ? zugang.benutzerId : undefined;
}

export function registriereUpdateAntragRouten(app: FastifyInstance, abhaengigkeiten: UpdateAntragAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt, symbole, wartungsfenster } = abhaengigkeiten;
  // Nur im Speicher dieses Prozesses: nach einem Neustart gilt keine alte Bestätigung mehr.
  const schluessel = randomBytes(32);

  async function hinweisSeite(reply: FastifyReply, zugang: Zugang, status: 403 | 500, text: string): Promise<FastifyReply> {
    const html = await app.render('update-hinweis.eta', {
      titel: status === 403 ? 'Nicht erlaubt' : 'Nicht gespeichert',
      nav: navigationFuerZugang('einstellungen', zugang),
      text,
    });
    return reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  }

  function verweigern(reply: FastifyReply, zugang: Zugang, text: string): Promise<FastifyReply> {
    return hinweisSeite(reply, zugang, 403, text);
  }

  /**
   * Ein Fehler der Datenbank beim Schreiben: die Transaktion ist zurückgenommen. Nach außen geht nur ein fester Satz,
   * in den Log nur die Meldung, nie das Fehlerobjekt.
   */
  function gescheitert(request: FastifyRequest, reply: FastifyReply, zugang: Zugang, fehler: unknown): Promise<FastifyReply> {
    request.log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Update-Antrag: Schreiben fehlgeschlagen');
    return hinweisSeite(reply, zugang, 500, FEHLER.gescheitert);
  }

  function einstellungen(reply: FastifyReply, zugang: Zugang, rueckmeldung: AntragsRueckmeldung, status: number): Promise<void> {
    return einstellungenSenden(app, reply, zugang, { pool, jetzt, ...(symbole ? { symbole } : {}), ...(wartungsfenster ? { wartungsfenster } : {}) }, rueckmeldung, status);
  }

  /** Die Bestätigungsseite des Cockpit-Antrags; mit `gemeldet` kommt sie vom Knopf und trägt die Quelle weiter. */
  async function bestaetigungSenden(
    reply: FastifyReply,
    zugang: Zugang,
    konto: string,
    antrag: { readonly ziel: string; readonly vorher: string; readonly gemeldet: UpdateZiel | undefined; readonly hinweis?: string },
  ): Promise<FastifyReply> {
    const { ziel, vorher, gemeldet } = antrag;
    const html = await app.render('update-bestaetigen.eta', {
      titel: 'Update beantragen',
      nav: navigationFuerZugang('einstellungen', zugang),
      vorher,
      ziel,
      version: gemeldet?.version,
      quelle: gemeldet === undefined ? undefined : 'wache',
      ...(await freigabeAnkuendigung('cockpit', gemeldet?.version !== undefined)),
      hinweis: antrag.hinweis,
      ...bestaetigungAusstellen(schluessel, { kontoId: konto, ziel, vorher }, jetzt()),
    });
    return reply.code(antrag.hinweis === undefined ? 200 : 409).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  }

  /**
   * Was die Bestätigungsseite über die Freigabe sagt (COPI-141): der Modus, der für diesen Antrag gälte — `direkt` nur
   * mit einem Ziel der Wache —, und ob der Notweg die eingestellte direkte Freigabe aussetzt.
   */
  async function freigabeAnkuendigung(bereich: FreigabeBereich, direktMoeglich: boolean): Promise<{ modus: AntragModus; notweg: boolean }> {
    const eingestellt = await freigabeModusLesen(pool, bereich);
    return { modus: antragModus(eingestellt, direktMoeglich), notweg: eingestellt !== 'rueckfrage' && !direktMoeglich };
  }

  /**
   * Stellt den Antrag und antwortet: zurück zu den Einstellungen (gestellt oder, bei `direkt`, freigegeben), bei einem
   * offenen Antrag mit Hinweis, bei inzwischen geändertem Freigabemodus noch einmal die Bestätigung (`nochmal`).
   */
  async function antragAusgang(
    request: FastifyRequest,
    reply: FastifyReply,
    zugang: Zugang,
    stellen: () => Promise<AntragErgebnis>,
    nochmal: () => Promise<FastifyReply>,
    modul?: string,
  ): Promise<FastifyReply | void> {
    let ergebnis: AntragErgebnis;
    try {
      ergebnis = await stellen();
    } catch (fehler) {
      return gescheitert(request, reply, zugang, fehler);
    }
    if (!ergebnis.ok) {
      return ergebnis.grund === 'modus' ? nochmal() : einstellungen(reply, zugang, { fehler: FEHLER.offen, ...(modul === undefined ? {} : { modul }) }, 409);
    }
    request.log.info({ eingriff: ergebnis.id, modul, modus: ergebnis.modus }, modul === undefined ? 'Update-Antrag gestellt' : 'Modul-Update-Antrag gestellt');
    return reply.redirect(nachDemAntrag(ergebnis.modus, modul), 303);
  }

  /** Der laufende Digest — der Weg zurück. Ohne ihn gibt es keinen Antrag. */
  async function laufenderDigest(): Promise<string | undefined> {
    return (await instanzLesen(pool))?.digest;
  }

  /** Die eine Zugangsprüfung dieses Bereichs (siehe Kopf). Gibt die Antwort zurück, damit Fastify abbricht. */
  async function nurBetreuer(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const zugang = await zugangLesen(request);
    const { origin, referer, host } = request.headers;
    if (antragsteller(zugang) !== undefined && herkunftBelegt(origin, referer, host)) {
      return undefined;
    }
    request.log.warn('Update-Antrag: Anfrage abgewiesen (Recht oder Herkunft)');
    return verweigern(reply, zugang, FEHLER.keinRecht);
  }

  /** Die zweite Prüfung im Handler: dasselbe Recht, frisch gelesen, und das Konto dazu. */
  async function betreuerKonto(request: FastifyRequest, reply: FastifyReply): Promise<{ zugang: Zugang; konto: string } | undefined> {
    const zugang = await zugangLesen(request);
    const konto = antragsteller(zugang);
    if (konto === undefined) {
      await verweigern(reply, zugang, FEHLER.keinRecht);
      return undefined;
    }
    return { zugang, konto };
  }

  /**
   * Betreuer und Modul eines Modul-Antrags (COPI-106), oder die Antwort, warum nicht: kein Recht, oder das Modul ist
   * unbekannt, inaktiv oder ohne Herkunft aus agent-blueprints (ohne sie kein Pfad und kein Weg zurück).
   */
  async function antragsModul(
    request: FastifyRequest<{ Body: ModulFormular | undefined }>,
    reply: FastifyReply,
  ): Promise<{ zugang: Zugang; konto: string; stand: ModulStand; herkunft: string; commit: string } | undefined> {
    const betreuer = await betreuerKonto(request, reply);
    if (betreuer === undefined) {
      return undefined;
    }
    const { zugang } = betreuer;
    const wert = request.body?.modul;
    const stand = typeof wert === 'string' && istModulKennung(wert) ? await modulStandLesen(pool, wert) : undefined;
    if (stand === undefined) {
      await einstellungen(reply, zugang, { fehler: FEHLER.modulUnbekannt }, 400);
      return undefined;
    }
    const commit = herkunftCommit(stand.herkunft);
    if (stand.herkunft === undefined || commit === undefined) {
      await einstellungen(reply, zugang, { fehler: FEHLER.ohneHerkunft, modul: stand.kennung }, 409);
      return undefined;
    }
    if (!herkunftUnterModule(stand.herkunft, stand.kennung)) {
      await einstellungen(reply, zugang, { fehler: FEHLER.nurKonsole, modul: stand.kennung }, 409);
      return undefined;
    }
    return { ...betreuer, stand, herkunft: stand.herkunft, commit };
  }

  /** Die Bestätigungsseite des Modul-Antrags, wie beim Cockpit (`bestaetigungSenden`). */
  async function modulBestaetigungSenden(
    reply: FastifyReply,
    modul: { readonly zugang: Zugang; readonly konto: string; readonly stand: ModulStand; readonly herkunft: string },
    antrag: { readonly ziel: string; readonly gemeldet: UpdateZiel | undefined; readonly hinweis?: string },
  ): Promise<FastifyReply> {
    const { zugang, konto, stand, herkunft } = modul;
    const daten = { kontoId: konto, modul: stand.kennung, ziel: antrag.ziel, herkunftVorher: herkunft };
    const html = await app.render('modul-update-bestaetigen.eta', {
      titel: 'Modul-Update beantragen',
      nav: navigationFuerZugang('einstellungen', zugang),
      modul: { kennung: stand.kennung, name: stand.menuename, version: stand.version },
      vorher: herkunft,
      ziel: antrag.ziel,
      quelle: antrag.gemeldet === undefined ? undefined : 'wache',
      ...(await freigabeAnkuendigung('module', antrag.gemeldet !== undefined)),
      hinweis: antrag.hinweis,
      ...modulBestaetigungAusstellen(schluessel, daten, jetzt()),
    });
    return reply.code(antrag.hinweis === undefined ? 200 : 409).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  }

  app.post<{ Body: BeantragenFormular | undefined }>(UPDATE_PFAD, { preHandler: nurBetreuer }, async (request, reply) => {
    const betreuer = await betreuerKonto(request, reply);
    if (betreuer === undefined) {
      return reply;
    }
    const { zugang, konto } = betreuer;
    const gemeldet = ausWache(request.body) ? await gemeldetesZielLesen(pool, VERSIONS_WACHE, 'cockpit') : undefined;
    if (ausWache(request.body) && gemeldet === undefined) {
      return einstellungen(reply, zugang, { fehler: FEHLER.keinUpdate }, 409);
    }
    const eingabe = gemeldet?.ziel ?? request.body?.ziel;
    const ziel = zielDigestAus(eingabe);
    if (ziel === undefined) {
      const feld = typeof eingabe === 'string' ? eingabe.trim().slice(0, EINGABE_HOECHSTENS) : '';
      return einstellungen(reply, zugang, { fehler: FEHLER.form, eingabe: feld }, 400);
    }
    const vorher = await laufenderDigest();
    if (vorher === undefined) {
      // Die Seite sagt es selbst: ohne laufenden Digest bietet sie keinen Antrag an.
      return einstellungen(reply, zugang, {}, 409);
    }
    if (ziel === vorher) {
      return einstellungen(reply, zugang, { fehler: FEHLER.laeuftSchon, eingabe: ziel }, 400);
    }
    if (await offenerAntragVorhanden(pool)) {
      return einstellungen(reply, zugang, { fehler: FEHLER.offen }, 409);
    }

    return bestaetigungSenden(reply, zugang, konto, { ziel, vorher, gemeldet });
  });

  app.post<{ Body: BestaetigenFormular | undefined }>(UPDATE_BESTAETIGEN_PFAD, { preHandler: nurBetreuer }, async (request, reply) => {
    const betreuer = await betreuerKonto(request, reply);
    if (betreuer === undefined) {
      return reply;
    }
    const { zugang, konto } = betreuer;
    const formular = request.body ?? {};
    const ziel = zielDigestAus(formular.ziel);
    if (ziel === undefined) {
      return einstellungen(reply, zugang, { fehler: FEHLER.form }, 400);
    }
    const vorher = await laufenderDigest();
    if (vorher === undefined) {
      return einstellungen(reply, zugang, {}, 409);
    }
    // Die Bestätigung beweist, dass Schritt 1 für genau dieses Ziel und diesen Rückweg lief — und dort ist ein
    // Ziel, das schon läuft, abgewiesen worden.
    if (!bestaetigungPruefen(schluessel, formular, { kontoId: konto, ziel, vorher }, jetzt())) {
      request.log.warn('Update-Antrag: Bestätigung ungültig oder abgelaufen');
      return verweigern(reply, zugang, FEHLER.bestaetigung);
    }
    const gemeldet = ausWache(formular) ? await gemeldetesZielLesen(pool, VERSIONS_WACHE, 'cockpit') : undefined;
    if (ausWache(formular)) {
      if (gemeldet === undefined) {
        return einstellungen(reply, zugang, { fehler: FEHLER.keinUpdate }, 409);
      }
      if (gemeldet.ziel !== ziel) {
        return bestaetigungSenden(reply, zugang, konto, { ziel: gemeldet.ziel, vorher, gemeldet, hinweis: ZIEL_GEAENDERT });
      }
    }

    const freigabe = { erwartet: erwarteterModus(formular), direktMoeglich: gemeldet !== undefined };
    return antragAusgang(
      request,
      reply,
      zugang,
      () => updateBeantragen(pool, { zielDigest: ziel, digestVorher: vorher, kontoId: konto, zielVersion: gemeldet?.version, freigabe }),
      () => bestaetigungSenden(reply, zugang, konto, { ziel, vorher, gemeldet, hinweis: MODUS_GEAENDERT }),
    );
  });

  app.post<{ Body: ZurueckziehenFormular | undefined }>(UPDATE_ZURUECKZIEHEN_PFAD, { preHandler: nurBetreuer }, async (request, reply) => {
    const betreuer = await betreuerKonto(request, reply);
    if (betreuer === undefined) {
      return reply;
    }
    const { zugang, konto } = betreuer;
    const nummer = request.body?.id;
    if (typeof nummer !== 'string' || !NUMMER.test(nummer)) {
      return einstellungen(reply, zugang, { fehler: FEHLER.nummer }, 400);
    }
    const id = Number(nummer);
    let zurueckgezogen: { readonly modul: string | undefined } | undefined;
    try {
      zurueckgezogen = await updateZurueckziehen(pool, id, konto);
    } catch (fehler) {
      return gescheitert(request, reply, zugang, fehler);
    }
    if (zurueckgezogen === undefined) {
      return einstellungen(reply, zugang, { fehler: FEHLER.nichtZurueck }, 409);
    }
    request.log.info({ eingriff: id }, 'Update-Antrag zurückgezogen');
    const modul = zurueckgezogen.modul === undefined ? '' : `&modul=${zurueckgezogen.modul}`;
    return reply.redirect(`${EINSTELLUNGEN_PFAD}?antrag=zurueckgezogen${modul}`, 303);
  });

  app.post<{ Body: ModulFormular | undefined }>(MODUL_UPDATE_PFAD, { preHandler: nurBetreuer }, async (request, reply) => {
    const modul = await antragsModul(request, reply);
    if (modul === undefined) {
      return reply;
    }
    const { zugang } = modul;
    const kennung = modul.stand.kennung;
    const gemeldet = ausWache(request.body) ? await gemeldetesZielLesen(pool, modulVersionsWache(kennung), 'modul') : undefined;
    if (ausWache(request.body) && gemeldet === undefined) {
      return einstellungen(reply, zugang, { fehler: FEHLER.keinUpdate, modul: kennung }, 409);
    }
    const eingabe = gemeldet?.ziel ?? request.body?.ziel;
    const ziel = zielCommitAus(eingabe);
    if (ziel === undefined) {
      const feld = typeof eingabe === 'string' ? eingabe.trim().slice(0, EINGABE_HOECHSTENS) : '';
      return einstellungen(reply, zugang, { fehler: FEHLER.commitForm, eingabe: feld, modul: kennung }, 400);
    }
    if (commitPasst(ziel, modul.commit)) {
      return einstellungen(reply, zugang, { fehler: FEHLER.commitLaeuftSchon, eingabe: ziel, modul: kennung }, 400);
    }
    if (await offenerAntragVorhanden(pool, kennung)) {
      return einstellungen(reply, zugang, { fehler: FEHLER.offen, modul: kennung }, 409);
    }

    return modulBestaetigungSenden(reply, modul, { ziel, gemeldet });
  });

  app.post<{ Body: ModulFormular | undefined }>(MODUL_UPDATE_BESTAETIGEN_PFAD, { preHandler: nurBetreuer }, async (request, reply) => {
    const modul = await antragsModul(request, reply);
    if (modul === undefined) {
      return reply;
    }
    const { zugang, konto } = modul;
    const formular = request.body ?? {};
    const kennung = modul.stand.kennung;
    const ziel = zielCommitAus(formular.ziel);
    if (ziel === undefined) {
      return einstellungen(reply, zugang, { fehler: FEHLER.commitForm, modul: kennung }, 400);
    }
    // Gebunden an die Herkunft von Schritt 1: hat sich das Modul inzwischen geändert, gilt die Bestätigung nicht mehr.
    const daten = { kontoId: konto, modul: kennung, ziel, herkunftVorher: modul.herkunft };
    if (!modulBestaetigungPruefen(schluessel, formular, daten, jetzt())) {
      request.log.warn('Modul-Update-Antrag: Bestätigung ungültig oder abgelaufen');
      return verweigern(reply, zugang, FEHLER.bestaetigung);
    }
    const gemeldet = ausWache(formular) ? await gemeldetesZielLesen(pool, modulVersionsWache(kennung), 'modul') : undefined;
    if (ausWache(formular)) {
      if (gemeldet === undefined) {
        return einstellungen(reply, zugang, { fehler: FEHLER.keinUpdate, modul: kennung }, 409);
      }
      if (!commitPasst(gemeldet.ziel, ziel)) {
        return modulBestaetigungSenden(reply, modul, { ziel: gemeldet.ziel, gemeldet, hinweis: ZIEL_GEAENDERT });
      }
    }

    const freigabe = { erwartet: erwarteterModus(formular), direktMoeglich: gemeldet !== undefined };
    return antragAusgang(
      request,
      reply,
      zugang,
      () => modulUpdateBeantragen(pool, { modul: kennung, zielCommit: ziel, herkunftVorher: modul.herkunft, kontoId: konto, freigabe }),
      () => modulBestaetigungSenden(reply, modul, { ziel, gemeldet, hinweis: MODUS_GEAENDERT }),
      kennung,
    );
  });
}
