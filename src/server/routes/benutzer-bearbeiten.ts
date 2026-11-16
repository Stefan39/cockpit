/**
 * Konten bearbeiten (COPI-46, Stefans Entscheidungen vom 22.09.2026): Name ändern, Rolle ändern, Konto entfernen,
 * zweiten Faktor zurücksetzen — aus der Seite Benutzer, je Konto.
 *
 *   1. `GET /benutzer/:id` — die Seite des Kontos mit genau den Aktionen, die dieser Zugang daran hat.
 *   2. `POST /benutzer/:id/aendern` — eine Aktion mit ihrem Wert. Das ändert **nichts**, sondern zeigt die
 *      Bestätigungsseite: ein Schritt gegen Fehlklicks und der Träger der signierten Bestätigung.
 *   3. `POST /benutzer/:id/bestaetigen` — das Formular der Bestätigungsseite. Erst das führt aus.
 *
 * **Wer an wem was**, steht an einer Stelle: `auth/benutzer-bearbeiten.ts` (man bearbeitet nur Konten mit niedrigerer
 * Rolle; den Betreuer und sich selbst nie). Gefragt wird dreimal: auf der Seite (welche Formulare), vor der Bestätigung
 * und bei der Ausführung — dort an der gesperrten Zeile, in derselben Transaktion (`benutzer-bearbeiten-speicher.ts`).
 *
 * **Was jede Aktion zusätzlich verlangt:**
 *
 *   * **Frische Anmeldung:** die Sitzung ist höchstens 15 Minuten alt. Sonst zeigt die Seite keine Formulare, sondern
 *     „bitte neu anmelden", und ein POST ändert nichts (`403`). Eine übernommene Sitzung ist selten frisch.
 *   * **Herkunft** (`Origin` oder `Referer` ist die eigene Adresse) und die **signierte Bestätigung** (Zweck, Handelnder,
 *     Ziel, Aktion, Wert, zehn Minuten; `auth/bestaetigung.ts`) — wie beim Update-Antrag (COPI-40).
 *
 * **Was nicht verraten wird:** Ohne das Recht `benutzer_bearbeiten`, zu einem unbekannten Konto und zu einem, an dem
 * dieser Zugang nichts darf, antwortet jede Route mit derselben neutralen 404. Welche Konten es gibt, zeigt die Seite
 * Benutzer — nur, wer sie sehen darf.
 *
 * **Zurücksetzen** zeigt den Link zur Wiederherstellung **genau einmal**, auf der Antwortseite (`no-store`), zur
 * persönlichen Übergabe. Er steht nirgends im Log.
 *
 * **E-Mail ändern** (COPI-47) beantragt nur: die Mail an die neue Adresse trägt den Link, der sie gültig macht
 * (`/email-bestaetigen/<token>`), die bisherige Adresse bekommt einen Hinweis. Ohne Mailversand und feste Basis-URL gibt
 * es die Aktion nicht. Geht die Mail an die neue Adresse nicht raus, wird der Antrag verworfen.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hatRecht, istVergebbareRolle, ROLLEN_NAMEN, type Zugang, type ZugangLesen } from '../../auth/berechtigung.js';
import { bestaetigungAusstellen, bestaetigungPruefen } from '../../auth/bestaetigung.js';
import {
  erlaubteAktionen,
  frischAngemeldet,
  istBearbeitenAktion,
  vergebbareRollenFuer,
  type BearbeitenAktion,
  type BearbeitenZiel,
} from '../../auth/benutzer-bearbeiten.js';
import {
  faktorZuruecksetzen,
  kontoEntfernen,
  nameAendern,
  rolleAendern,
  type BearbeitenErgebnis,
  type Handelnder,
} from '../../auth/benutzer-bearbeiten-speicher.js';
import { benutzerListe, type KontoDaten } from '../../auth/benutzer-liste.js';
import { kontenLesen } from '../../auth/benutzer-liste-speicher.js';
import { WIEDERHERSTELLUNG_GUELTIGKEIT_MS, type Entsperrung } from '../../auth/entsperrung.js';
import {
  adresseBelegt,
  EMAIL_AENDERUNG_GUELTIGKEIT_MS,
  emailAenderungBeantragen,
  offeneAenderungLesen,
  offeneAenderungVerwerfen,
  type AdresseBelegt,
} from '../../auth/email-aenderung.js';
import { emailNormalisieren } from '../../auth/einladung-speicher.js';
import { herkunftBelegt } from '../../auth/herkunft.js';
import { EMAIL_BESTAETIGEN_PFAD } from '../../auth/zwei-faktor-tor.js';
import { adressBestaetigungMailBauen, adressHinweisMailBauen } from '../../mail/email-aenderung-mail.js';
import type { Mailversand } from '../../mail/versand.js';
import { inText } from '../../status/zustand.js';
import { navigationFuerZugang } from '../navigation.js';
import { BENUTZER_PFAD } from './benutzer.js';
import { emailPlausibel, namePruefen } from './formular.js';
import { nichtGefunden } from './neutral.js';

export interface BenutzerBearbeitenAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly zugangLesen: ZugangLesen;
  readonly jetzt: () => Date;
  /** Für den Link zur Wiederherstellung; ohne ihn steht nur der Pfad da (Entwicklung). Die Adressänderung braucht ihn. */
  readonly basisUrl?: string;
  /** Ohne Mailversand lässt sich keine Adresse ändern (COPI-47): die Aktion erscheint dann nicht. */
  readonly versand?: Mailversand;
}

/** Der Zweck in der signierten Bestätigung: eine für etwas anderes gilt hier nicht. */
const ZWECK = 'benutzer-bearbeiten';

/** Eine Konto-ID, wie Better Auth sie vergibt; alles andere ist kein Konto. */
const KONTO_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Wie die Seite nach einer Änderung zurückmeldet, was geschah. */
const ERLEDIGT: Readonly<Record<string, string>> = {
  name: 'Der Name ist geändert.',
  rolle: 'Die Rolle ist geändert.',
  email: 'Die Bestätigungsmail an die neue Adresse ist verschickt. Die Adresse gilt, sobald sie dort bestätigt ist.',
  'email-ohne-hinweis':
    'Die Bestätigungsmail an die neue Adresse ist verschickt. Der Hinweis an die bisherige Adresse ließ sich nicht verschicken.',
};

/** Die gültige Länge einer Adresse (RFC 5321). */
const ADRESSE_HOECHSTENS = 254;

/** Warum eine Adresse nicht geht, in Betriebssprache. */
const BELEGT: Readonly<Record<AdresseBelegt, string>> = {
  gleich: 'Das ist schon die Adresse dieses Kontos.',
  konto: 'Für diese Adresse gibt es bereits ein Konto.',
  einladung: 'An diese Adresse ist eine Einladung offen.',
  aenderung: 'Diese Adresse ist bereits für ein anderes Konto beantragt.',
};

const FEHLER = {
  frisch: 'Zum Bearbeiten von Konten bitte neu anmelden: die Anmeldung ist älter als 15 Minuten.',
  herkunft: 'Die Anfrage kam nicht von dieser Seite. Es wurde nichts geändert.',
  bestaetigung: 'Die Bestätigung ist abgelaufen oder ungültig. Es wurde nichts geändert; bitte noch einmal von vorn.',
  verboten: 'Diese Änderung ist an diesem Konto (nicht mehr) erlaubt. Es wurde nichts geändert.',
  gescheitert: 'Das hat nicht geklappt, es wurde nichts geändert. Bitte später noch einmal versuchen.',
  mail: 'Die Bestätigungsmail an die neue Adresse ließ sich nicht verschicken. Die Adresse bleibt, wie sie ist; bitte später noch einmal versuchen.',
  adresse: 'Bitte eine gültige E-Mail-Adresse angeben.',
} as const;

interface Formular {
  readonly aktion?: unknown;
  readonly wert?: unknown;
  readonly bis?: unknown;
  readonly token?: unknown;
}

/** Eine Aktion samt Wert, geprüft: der Name gekürzt und in der erlaubten Länge, die Rolle vergebbar. */
interface Vorhaben {
  readonly aktion: BearbeitenAktion;
  readonly wert: string;
}

type Pruefung = { readonly ok: true; readonly vorhaben: Vorhaben } | { readonly ok: false; readonly fehler: string };

/**
 * Was diese Aktion mit diesem Wert an diesem Ziel wäre — oder warum nicht. `aktionen`: was dieser Zugang an diesem Ziel
 * darf, soweit die Instanz es kann (ohne Mailversand keine Adressänderung).
 */
function vorhabenPruefen(zugang: Zugang, ziel: BearbeitenZiel, aktionen: readonly BearbeitenAktion[], formular: Formular): Pruefung | undefined {
  const { aktion } = formular;
  if (!istBearbeitenAktion(aktion) || !aktionen.includes(aktion)) {
    return undefined;
  }
  const roh = typeof formular.wert === 'string' ? formular.wert : '';
  if (aktion === 'email') {
    const adresse = emailNormalisieren(roh);
    return emailPlausibel(adresse) && adresse.length <= ADRESSE_HOECHSTENS
      ? { ok: true, vorhaben: { aktion, wert: adresse } }
      : { ok: false, fehler: FEHLER.adresse };
  }
  if (aktion === 'name') {
    const name = roh.trim();
    const fehler = namePruefen(name);
    return fehler === undefined ? { ok: true, vorhaben: { aktion, wert: name } } : { ok: false, fehler };
  }
  if (aktion === 'rolle') {
    const rollen: readonly string[] = vergebbareRollenFuer(zugang, ziel);
    return rollen.includes(roh) ? { ok: true, vorhaben: { aktion, wert: roh } } : undefined;
  }
  return { ok: true, vorhaben: { aktion, wert: '' } };
}

/** Darf dieser Zugang dieses Vorhaben an diesem Ziel — so, wie das Ziel gerade in der Datenbank steht? */
function nochErlaubt(zugang: Zugang, vorhaben: Vorhaben): (ziel: BearbeitenZiel) => boolean {
  return (ziel) =>
    erlaubteAktionen(zugang, ziel).includes(vorhaben.aktion) &&
    (vorhaben.aktion !== 'rolle' || (vergebbareRollenFuer(zugang, ziel) as readonly string[]).includes(vorhaben.wert));
}

function rollenName(wert: string): string {
  return istVergebbareRolle(wert) ? ROLLEN_NAMEN[wert] : wert;
}

export function registriereBenutzerBearbeitenRouten(app: FastifyInstance, abhaengigkeiten: BenutzerBearbeitenAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt, basisUrl, versand } = abhaengigkeiten;
  // Nur im Speicher dieses Prozesses: nach einem Neustart gilt keine alte Bestätigung mehr.
  const schluessel = randomBytes(32);
  const emailMoeglich = versand !== undefined && basisUrl !== undefined;

  /** Was dieser Zugang an diesem Konto tun darf, soweit die Instanz es kann. */
  function aktionen(zugang: Zugang, ziel: BearbeitenZiel): readonly BearbeitenAktion[] {
    return erlaubteAktionen(zugang, ziel).filter((aktion) => aktion !== 'email' || emailMoeglich);
  }

  function html(reply: FastifyReply, inhalt: string, status = 200): FastifyReply {
    return reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(inhalt);
  }

  async function hinweis(reply: FastifyReply, zugang: Zugang, status: 403 | 500 | 502, text: string, zurueck: string): Promise<FastifyReply> {
    const seite = await app.render('benutzer-hinweis.eta', {
      titel: status === 403 ? 'Nicht geändert' : 'Nicht gespeichert',
      nav: navigationFuerZugang('benutzer', zugang),
      text,
      zurueck,
    });
    return html(reply, seite, status);
  }

  /**
   * Das Konto aus der Adresse, wenn dieser Zugang daran etwas darf — sonst `undefined`, und die neutrale 404 ist schon
   * gesendet. Ohne das Recht, mit einer Kennung, die keine ist, zu einem unbekannten Konto: dieselbe Antwort.
   */
  async function zielKonto(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<{ zugang: Zugang; konto: KontoDaten } | undefined> {
    const zugang = await zugangLesen(request);
    const { id } = request.params;
    const konto = hatRecht(zugang, 'benutzer_bearbeiten') && KONTO_ID.test(id) ? (await kontenLesen(pool, id))[0] : undefined;
    if (konto === undefined || erlaubteAktionen(zugang, konto).length === 0) {
      request.log.warn('Benutzer bearbeiten: Zugriff ohne Berechtigung abgewiesen');
      await nichtGefunden(app, reply);
      return undefined;
    }
    return { zugang, konto };
  }

  /** Die Prüfungen jedes POST nach dem Ziel: Herkunft und frische Anmeldung. `false`: die Antwort ist gesendet. */
  async function postErlaubt(request: FastifyRequest, reply: FastifyReply, zugang: Zugang, zurueck: string): Promise<boolean> {
    const { origin, referer, host } = request.headers;
    if (!herkunftBelegt(origin, referer, host)) {
      request.log.warn('Benutzer bearbeiten: fremde Herkunft abgewiesen');
      await hinweis(reply, zugang, 403, FEHLER.herkunft, zurueck);
      return false;
    }
    if (!frischAngemeldet(zugang, jetzt())) {
      await hinweis(reply, zugang, 403, FEHLER.frisch, zurueck);
      return false;
    }
    return true;
  }

  /** Der gemeinsame Anfang beider POST: Ziel, Herkunft, frische Anmeldung. `undefined`: die Antwort ist gesendet. */
  async function postBeginnen(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<{ zugang: Zugang; konto: KontoDaten; pfad: string } | undefined> {
    const ziel = await zielKonto(request, reply);
    if (ziel === undefined) {
      return undefined;
    }
    const pfad = `${BENUTZER_PFAD}/${ziel.konto.id}`;
    return (await postErlaubt(request, reply, ziel.zugang, pfad)) ? { ...ziel, pfad } : undefined;
  }

  async function kontoSeite(reply: FastifyReply, zugang: Zugang, konto: KontoDaten, meldung: { fehler?: string; erledigt?: string }, status = 200) {
    const zeitpunkt = jetzt();
    const [zeile] = benutzerListe({ konten: [konto], einladungen: [], selbstId: zugang.benutzerId }, zeitpunkt).konten;
    const offen = await offeneAenderungLesen(pool, konto.id, zeitpunkt);
    const seite = await app.render('benutzer-bearbeiten.eta', {
      titel: 'Konto bearbeiten',
      nav: navigationFuerZugang('benutzer', zugang),
      pfad: `${BENUTZER_PFAD}/${konto.id}`,
      konto: zeile,
      aktionen: aktionen(zugang, konto),
      rollen: vergebbareRollenFuer(zugang, konto).map((rolle) => ({ wert: rolle, name: ROLLEN_NAMEN[rolle] })),
      frisch: frischAngemeldet(zugang, zeitpunkt),
      // Eine beantragte, noch nicht bestätigte Adresse (COPI-47).
      offeneAdresse:
        offen === undefined
          ? undefined
          : { email: offen.neueEmail, ablauf: `läuft ab ${inText(Math.max(0, Math.floor((offen.ablaufAm.getTime() - zeitpunkt.getTime()) / 1000)))}` },
      ...meldung,
    });
    return html(reply, seite, status);
  }

  app.get<{ Params: { id: string }; Querystring: { erledigt?: string } }>(`${BENUTZER_PFAD}/:id`, async (request, reply) => {
    const ziel = await zielKonto(request, reply);
    if (ziel === undefined) {
      return reply;
    }
    const erledigt = request.query.erledigt;
    const text = erledigt === undefined ? undefined : ERLEDIGT[erledigt];
    return kontoSeite(reply, ziel.zugang, ziel.konto, text === undefined ? {} : { erledigt: text });
  });

  app.post<{ Params: { id: string }; Body: Formular | undefined }>(`${BENUTZER_PFAD}/:id/aendern`, async (request, reply) => {
    const beginn = await postBeginnen(request, reply);
    if (beginn === undefined) {
      return reply;
    }
    const { zugang, konto, pfad } = beginn;
    const pruefung = vorhabenPruefen(zugang, konto, aktionen(zugang, konto), request.body ?? {});
    if (pruefung === undefined) {
      return hinweis(reply, zugang, 403, FEHLER.verboten, pfad);
    }
    if (!pruefung.ok) {
      return kontoSeite(reply, zugang, konto, { fehler: pruefung.fehler }, 400);
    }
    const { vorhaben } = pruefung;
    // Eine belegte Adresse gleich hier sagen, nicht erst nach der Bestätigung (die Ausführung prüft noch einmal).
    const belegt = vorhaben.aktion === 'email' ? await adresseBelegt(pool, konto.id, vorhaben.wert, jetzt()) : undefined;
    if (belegt !== undefined) {
      return kontoSeite(reply, zugang, konto, { fehler: BELEGT[belegt] }, 400);
    }
    const felder = bestaetigungAusstellen(schluessel, ZWECK, [zugang.benutzerId ?? '', konto.id, vorhaben.aktion, vorhaben.wert], jetzt());
    const seite = await app.render('benutzer-bestaetigen.eta', {
      titel: 'Bitte bestätigen',
      nav: navigationFuerZugang('benutzer', zugang),
      pfad,
      aktion: vorhaben.aktion,
      wert: vorhaben.wert,
      konto: { name: konto.name, email: konto.email, rolle: rollenName(konto.rolle) },
      neueRolle: vorhaben.aktion === 'rolle' ? rollenName(vorhaben.wert) : undefined,
      ...felder,
    });
    return html(reply, seite);
  });

  app.post<{ Params: { id: string }; Body: Formular | undefined }>(`${BENUTZER_PFAD}/:id/bestaetigen`, async (request, reply) => {
    const beginn = await postBeginnen(request, reply);
    if (beginn === undefined) {
      return reply;
    }
    const { zugang, konto, pfad } = beginn;
    const formular = request.body ?? {};
    const pruefung = vorhabenPruefen(zugang, konto, aktionen(zugang, konto), formular);
    const akteur = zugang.benutzerId;
    if (pruefung === undefined || !pruefung.ok || akteur === undefined) {
      return hinweis(reply, zugang, 403, FEHLER.verboten, pfad);
    }
    const { vorhaben } = pruefung;
    if (!bestaetigungPruefen(schluessel, formular, ZWECK, [akteur, konto.id, vorhaben.aktion, vorhaben.wert], jetzt())) {
      request.log.warn('Benutzer bearbeiten: Bestätigung ungültig oder abgelaufen');
      return hinweis(reply, zugang, 403, FEHLER.bestaetigung, pfad);
    }

    const handelnder: Handelnder = { id: akteur, erlaubt: nochErlaubt(zugang, vorhaben) };
    if (vorhaben.aktion === 'email') {
      return emailBeantragen(request, reply, { zugang, konto, pfad }, vorhaben.wert, handelnder);
    }
    const ergebnis = await schreiben(request, reply, { zugang, konto, pfad }, () => ausfuehren(vorhaben, konto.id, handelnder));
    if (ergebnis === undefined) {
      return reply;
    }
    request.log.info({ aktion: vorhaben.aktion }, 'Benutzer bearbeiten: ausgeführt');

    if (vorhaben.aktion === 'entfernen') {
      return reply.redirect(`${BENUTZER_PFAD}?entfernt=1`, 303);
    }
    if (ergebnis.wert !== undefined) {
      // Nur das Zurücksetzen bringt etwas zurück: den Link, der jetzt einmal gezeigt wird.
      const { token } = ergebnis.wert;
      const seite = await app.render('benutzer-zurueckgesetzt.eta', {
        titel: 'Zweiter Faktor zurückgesetzt',
        nav: navigationFuerZugang('benutzer', zugang),
        pfad,
        name: konto.name,
        link: `${basisUrl ?? ''}/zugang-wiederherstellen/${token}`,
        // Gerade ausgestellt: die volle Gültigkeit, nicht die abgerundete Restzeit („in 2 Stunden" bei 2:59).
        gueltigStunden: WIEDERHERSTELLUNG_GUELTIGKEIT_MS / 3_600_000,
      });
      return html(reply, seite);
    }
    return reply.redirect(`${pfad}?erledigt=${vorhaben.aktion}`, 303);
  });

  /**
   * Führt eine Änderung aus. `undefined`: sie ging nicht — ein Fehler der Datenbank (500, nach außen ein fester Satz, im
   * Log nur die Meldung), ein unbekanntes Konto (404) oder eine nicht (mehr) erlaubte Änderung (403) —, und die Antwort
   * ist gesendet.
   */
  async function schreiben<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    ziel: { zugang: Zugang; konto: KontoDaten; pfad: string },
    arbeit: () => Promise<BearbeitenErgebnis<T>>,
  ): Promise<{ readonly wert: T } | undefined> {
    let ergebnis: BearbeitenErgebnis<T>;
    try {
      ergebnis = await arbeit();
    } catch (fehler) {
      request.log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Benutzer bearbeiten: Schreiben fehlgeschlagen');
      await hinweis(reply, ziel.zugang, 500, FEHLER.gescheitert, ziel.pfad);
      return undefined;
    }
    if (!ergebnis.ok) {
      await nichtAusgefuehrt(reply, ziel.zugang, ergebnis.grund, ziel.pfad);
      return undefined;
    }
    return { wert: ergebnis.wert };
  }

  /** Unbekannt: die neutrale 404; verboten (inzwischen): der Hinweis. Es hat sich nichts geändert. */
  async function nichtAusgefuehrt(reply: FastifyReply, zugang: Zugang, grund: 'unbekannt' | 'verboten', pfad: string): Promise<FastifyReply> {
    if (grund === 'unbekannt') {
      await nichtGefunden(app, reply);
      return reply;
    }
    return hinweis(reply, zugang, 403, FEHLER.verboten, pfad);
  }

  /**
   * Die Adressänderung (COPI-47): Antrag an der gesperrten Zeile, dann die Mail an die neue Adresse mit dem Link, dann der
   * Hinweis an die bisherige. Geht die erste Mail nicht raus, wird der Antrag verworfen; geht nur der Hinweis nicht raus,
   * gilt der Antrag, und die Seite sagt es. Weder Token noch Adressen stehen im Log.
   */
  async function emailBeantragen(
    request: FastifyRequest,
    reply: FastifyReply,
    ziel: { zugang: Zugang; konto: KontoDaten; pfad: string },
    adresse: string,
    handelnder: Handelnder,
  ): Promise<FastifyReply> {
    const { zugang, konto, pfad } = ziel;
    if (versand === undefined || basisUrl === undefined) {
      return hinweis(reply, zugang, 403, FEHLER.verboten, pfad);
    }
    const ergebnis = await schreiben(request, reply, ziel, () => emailAenderungBeantragen(pool, konto.id, adresse, handelnder, jetzt()));
    if (ergebnis === undefined) {
      return reply;
    }
    const antrag = ergebnis.wert;
    if (antrag.art === 'belegt') {
      return kontoSeite(reply, zugang, konto, { fehler: BELEGT[antrag.grund] }, 409);
    }
    try {
      const inhalt = adressBestaetigungMailBauen({
        url: `${basisUrl}${EMAIL_BESTAETIGEN_PFAD}/${antrag.token}`,
        gueltigStunden: EMAIL_AENDERUNG_GUELTIGKEIT_MS / 3_600_000,
      });
      await versand.senden({ an: adresse, ...inhalt });
    } catch (fehler) {
      request.log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Adressänderung: Bestätigungsmail nicht verschickt');
      await offeneAenderungVerwerfen(pool, konto.id);
      return hinweis(reply, zugang, 502, FEHLER.mail, pfad);
    }
    let erledigt = 'email';
    try {
      await versand.senden({ an: antrag.bisherige, ...adressHinweisMailBauen() });
    } catch (fehler) {
      request.log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Adressänderung: Hinweis an die bisherige Adresse nicht verschickt');
      erledigt = 'email-ohne-hinweis';
    }
    request.log.info({ aktion: 'email' }, 'Benutzer bearbeiten: ausgeführt');
    return reply.redirect(`${pfad}?erledigt=${erledigt}`, 303);
  }

  function ausfuehren(vorhaben: Vorhaben, zielId: string, handelnder: Handelnder): Promise<BearbeitenErgebnis<Entsperrung | undefined>> {
    switch (vorhaben.aktion) {
      case 'name':
        return nameAendern(pool, zielId, vorhaben.wert, handelnder);
      case 'rolle':
        return istVergebbareRolle(vorhaben.wert)
          ? rolleAendern(pool, zielId, vorhaben.wert, handelnder)
          : Promise.resolve({ ok: false, grund: 'verboten' });
      case 'entfernen':
        return kontoEntfernen(pool, zielId, handelnder);
      case 'zuruecksetzen':
        return faktorZuruecksetzen(pool, zielId, handelnder, jetzt());
      case 'email':
        // Läuft über `emailBeantragen`; hierher kommt sie nie.
        return Promise.resolve({ ok: false, grund: 'verboten' });
    }
  }
}
