/**
 * Anmeldung & Sicherheit (COPI-94): die zweiten Faktoren des eigenen Kontos verwalten — einen weiteren Passkey (etwa
 * auf dem iPhone neben dem iMac), die Authenticator-App daneben, einen Faktor entfernen, neue Ersatzcodes.
 *
 *   GET  /sicherheit                              Übersicht
 *   GET  /sicherheit/bestaetigen?weiter=…         frische Bestätigung: Passkey oder Code
 *   POST /sicherheit/bestaetigen/passkey/optionen  Optionen für das Gerät (JSON)
 *   POST /sicherheit/bestaetigen/passkey          Antwort des Geräts prüfen
 *   POST /sicherheit/bestaetigen/code             Code der App oder Ersatzcode prüfen
 *   GET  /sicherheit/passkey                      weiteren Passkey anlegen (Seite)
 *   POST /sicherheit/passkey/optionen             Optionen für das Gerät (JSON)
 *   POST /sicherheit/passkey/pruefen              Antwort prüfen, Passkey anlegen
 *   GET|POST /sicherheit/passkey/<id>/entfernen    Rückfrage | entfernen
 *   GET|POST /sicherheit/totp                     Passwort | QR-Code der App
 *   POST /sicherheit/totp/pruefen                 Code der App prüfen, App aktiv
 *   GET|POST /sicherheit/totp/entfernen           Rückfrage | entfernen
 *   GET|POST /sicherheit/ersatzcodes              Rückfrage | neue Codes (einmal sichtbar)
 *   GET  /sicherheit/skript.js                    das Passkey-Skript
 *
 * **Die Sicherheitsgrenzen:**
 *
 *   * Alles liegt hinter dem Tor: nur mit Sitzung **und** aktivem zweiten Faktor (COPI-10). Ein Konto ohne Faktor
 *     richtet ihn weiterhin unter `/zwei-faktor` ein, und dort nur ohne Faktor.
 *   * Jede Änderung verlangt eine **frische Bestätigung** durch einen vorhandenen Faktor (`faktor-bestaetigung.ts`),
 *     nie das Passwort allein. Seiten und Formulare prüfen sie beide: wer sie nicht hat, landet auf
 *     `/sicherheit/bestaetigen` und kommt danach genau dorthin zurück (`weiter`, nur feste Pfade dieser Seite).
 *   * Fehlversuche bei der Bestätigung zählen auf dasselbe Konto-Budget wie der Codeschritt der Anmeldung
 *     (`code-konto`, 5 je 15 Minuten): Better Auth begrenzt die Prüfung eines TOTP-Codes mit Sitzung nicht.
 *   * Jedes Formular verlangt die eigene Herkunft (`herkunftBelegt`), wie der Update-Antrag.
 *   * Nie der letzte Faktor, nie physisch löschen, Protokoll in derselben Transaktion: `faktoren.ts`.
 *   * Nach jeder Änderung eine Hinweis-Mail an die eigene Adresse (`faktor-mail.ts`), wenn Mail eingerichtet ist.
 */
import { randomBytes } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { cookiesUebernehmen, htmlSenden } from '../../auth/antwort.js';
import type { ZugangLesen } from '../../auth/berechtigung.js';
import { ersatzcodeEinloesen } from '../../auth/ersatzcode.js';
import {
  bestaetigungLesen,
  bestaetigungsCookie,
  type Bestaetigung,
  type BestaetigterFaktor,
} from '../../auth/faktor-bestaetigung.js';
import {
  ersatzcodesErneuern,
  faktorEntfernen,
  faktorenLesen,
  verlaufLesen,
  type Faktoren,
  type VerlaufEintrag,
  type ZuEntfernen,
} from '../../auth/faktoren.js';
import { herkunftBelegt } from '../../auth/herkunft.js';
import type { CockpitAuth } from '../../auth/konfiguration.js';
import { anmeldungsAntwortLesen, bestaetigungOptionen, bestaetigungPruefen } from '../../auth/passkey-anmeldung.js';
import {
  passkeyKonfiguration,
  registrierungBeginnen,
  registrierungsAntwortLesen,
  weiterenPasskeyAbschliessen,
  type PasskeyKonfiguration,
} from '../../auth/passkey.js';
import { protokollNotieren, type Ereignis } from '../../auth/protokoll.js';
import { qrCodeSvg } from '../../auth/qr.js';
import { sperrePruefen, versuchReservieren, zaehlerZuruecksetzen } from '../../auth/ratenbegrenzung.js';
import { datumText, zeitText } from '../../chat/ansicht.js';
import { faktorMailBauen, type FaktorAenderung } from '../../mail/faktor-mail.js';
import type { Mailversand } from '../../mail/versand.js';
import { navigationFuerZugang } from '../navigation.js';
import { text } from './formular.js';
import { passkeySkriptLesen, skriptAusliefern } from './passkey-skript.js';
import { geheimnisAusUri } from './zwei-faktor.js';

export const SICHERHEIT_PFAD = '/sicherheit';

export interface SicherheitAbhaengigkeiten {
  readonly auth: CockpitAuth;
  readonly pool: pg.Pool;
  readonly zugangLesen: ZugangLesen;
  readonly jetzt: () => Date;
  /** Ohne feste Basis-URL keine Passkeys (rpID und Herkunft, ADR 13.3): dann nur App und Ersatzcodes. */
  readonly basisUrl?: string;
  /** Ohne Mailversand keine Hinweis-Mail; die Änderung gilt trotzdem. */
  readonly versand?: Mailversand;
}

/** Wohin es nach der Bestätigung geht: nur die Seiten hier, die eine verlangen. Alles andere: die Übersicht. */
const WEITER = /^\/sicherheit(?:\/passkey(?:\/[A-Za-z0-9_-]{1,512}\/entfernen)?|\/totp(?:\/entfernen)?|\/ersatzcodes)?$/;

/** Eine Passkey-Kennung (base64url, wie sie die Bibliothek speichert) als Pfadstück. */
const PASSKEY_ID = /^[A-Za-z0-9_-]{1,512}$/;

/** Sechs Ziffern: ein Code der App. Alles andere wird als Ersatzcode versucht. */
const TOTP_FORM = /^\d{6}$/;

const FAKTOR_TEXT: Readonly<Record<BestaetigterFaktor, string>> = {
  passkey: 'einem Passkey',
  totp: 'einem Code aus der Authenticator-App',
  ersatzcode: 'einem Ersatzcode',
};

/** Rückmeldungen in der Adresse: nur feste Texte, nie ein Wert aus ihr. */
const HINWEISE: Readonly<Record<string, string>> = {
  'passkey-hinzugefuegt': 'Passkey hinzugefügt. An Ihre E-Mail-Adresse ging ein Hinweis.',
  'passkey-entfernt': 'Passkey entfernt. An Ihre E-Mail-Adresse ging ein Hinweis.',
  'totp-hinzugefuegt': 'Authenticator-App eingerichtet. An Ihre E-Mail-Adresse ging ein Hinweis.',
  'totp-entfernt': 'Authenticator-App entfernt. An Ihre E-Mail-Adresse ging ein Hinweis.',
};

const FEHLER_LETZTER = 'Das ist der letzte zweite Faktor dieses Kontos. Bitte erst einen weiteren einrichten.';
const FEHLER_BESTAETIGUNG = 'Die Bestätigung ist nicht gelungen. Bitte erneut versuchen – nach mehreren Fehlversuchen ist sie 15 Minuten gesperrt.';
const FEHLER_PASSKEY = 'Der Passkey konnte nicht angelegt werden. Bitte erneut versuchen.';

const ANLASS: Readonly<Record<string, string>> = {
  '/sicherheit/passkey': 'Sie möchten einen Passkey hinzufügen.',
  '/sicherheit/totp': 'Sie möchten die Authenticator-App einrichten.',
  '/sicherheit/totp/entfernen': 'Sie möchten die Authenticator-App entfernen.',
  '/sicherheit/ersatzcodes': 'Sie möchten neue Ersatzcodes erzeugen.',
};

function anlass(weiter: string): string {
  return ANLASS[weiter] ?? (weiter.endsWith('/entfernen') ? 'Sie möchten einen Passkey entfernen.' : 'Sie möchten Ihre zweiten Faktoren ändern.');
}

const VERLAUF_TEXT: Readonly<Record<VerlaufEintrag['art'], string>> = {
  zweiter_faktor_eingerichtet: 'Zweiter Faktor eingerichtet',
  zweiter_faktor_hinzugefuegt: 'hinzugefügt',
  zweiter_faktor_entfernt: 'entfernt',
  ersatzcodes_erneuert: 'Ersatzcodes neu erzeugt',
  ersatzcode_verwendet: 'Ersatzcode verwendet',
};

/** „Passkey hinzugefügt", „Authenticator-App entfernt", „Zweiter Faktor eingerichtet (Passkey)" … */
export function verlaufText(eintrag: VerlaufEintrag): string {
  const faktor = eintrag.faktor === 'passkey' ? 'Passkey' : eintrag.faktor === 'totp' ? 'Authenticator-App' : undefined;
  const grund = VERLAUF_TEXT[eintrag.art];
  if (eintrag.art === 'zweiter_faktor_hinzugefuegt' || eintrag.art === 'zweiter_faktor_entfernt') {
    return `${faktor ?? 'Zweiter Faktor'} ${grund}`;
  }
  return eintrag.art === 'zweiter_faktor_eingerichtet' && faktor !== undefined ? `${grund} (${faktor})` : grund;
}

export function registriereSicherheitRouten(app: FastifyInstance, abhaengigkeiten: SicherheitAbhaengigkeiten): void {
  const { auth, pool, zugangLesen, jetzt, versand } = abhaengigkeiten;
  // Beim Start: eine unbrauchbare Basis-URL soll hier auffallen, nicht beim ersten Passkey.
  const konfiguration: PasskeyKonfiguration | undefined =
    abhaengigkeiten.basisUrl === undefined ? undefined : passkeyKonfiguration(abhaengigkeiten.basisUrl);
  // Nur im Speicher des Prozesses: nach einem Neustart bestätigt man eben neu.
  const schluessel = randomBytes(32);

  async function sitzungHolen(request: FastifyRequest) {
    return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  }

  type Sitzung = NonNullable<Awaited<ReturnType<typeof sitzungHolen>>>;

  interface Kontext {
    readonly sitzung: Sitzung;
    readonly benutzerId: string;
    readonly bestaetigung: Bestaetigung | undefined;
  }

  async function kontextLesen(request: FastifyRequest): Promise<Kontext | undefined> {
    const sitzung = await sitzungHolen(request);
    if (!sitzung) {
      return undefined;
    }
    const bezug = { sitzungId: sitzung.session.id, benutzerId: sitzung.user.id };
    return {
      sitzung,
      benutzerId: sitzung.user.id,
      bestaetigung: bestaetigungLesen(schluessel, request.headers.cookie, bezug, jetzt()),
    };
  }

  function bestaetigtText(bestaetigung: Bestaetigung): string {
    return `Bestätigt mit ${FAKTOR_TEXT[bestaetigung.faktor]}. Änderungen sind bis ${zeitText(bestaetigung.bis, bestaetigung.bis)} Uhr möglich, danach fragt das Cockpit erneut.`;
  }

  async function seite(request: FastifyRequest, reply: FastifyReply, datei: string, titel: string, daten: object, status = 200): Promise<void> {
    const zugang = await zugangLesen(request);
    const html = await app.render(datei, { titel, nav: navigationFuerZugang('sicherheit', zugang), ...daten });
    reply.header('cache-control', 'no-store');
    await htmlSenden(reply, html, status);
  }

  /**
   * Der Anfang jeder Seite und jedes Formulars, das ändert: Sitzung, bei einem Formular die Herkunft, und die frische
   * Bestätigung. Fehlt sie, geht es zur Bestätigung (Formular: zurück zur Seite, deren Formular es ist). Sonst ist die
   * Antwort schon gegeben, und die Route hört auf.
   */
  async function bestaetigtOderUmleiten(
    request: FastifyRequest,
    reply: FastifyReply,
    weiter: string,
    formular: boolean,
  ): Promise<(Kontext & { readonly bestaetigung: Bestaetigung }) | undefined> {
    if (formular && !herkunftBelegt(request.headers.origin, request.headers.referer, request.headers.host)) {
      void reply.code(403).header('cache-control', 'no-store').send();
      return undefined;
    }
    const kontext = await kontextLesen(request);
    if (kontext === undefined) {
      void reply.redirect('/anmelden', 303);
      return undefined;
    }
    if (kontext.bestaetigung === undefined) {
      void reply.redirect(`${SICHERHEIT_PFAD}/bestaetigen?weiter=${encodeURIComponent(weiter)}`, 303);
      return undefined;
    }
    return { ...kontext, bestaetigung: kontext.bestaetigung };
  }

  /** Wie oben, für die JSON-Optionen des Skripts: statt einer Umleitung eine Meldung, die das Skript anzeigt. */
  async function bestaetigtFuerSkript(request: FastifyRequest, reply: FastifyReply): Promise<Kontext | undefined> {
    if (!herkunftBelegt(request.headers.origin, request.headers.referer, request.headers.host)) {
      void reply.code(403).header('cache-control', 'no-store').send({ fehler: 'Anfrage abgelehnt.' });
      return undefined;
    }
    const kontext = await kontextLesen(request);
    if (kontext?.bestaetigung === undefined) {
      void reply.code(403).header('cache-control', 'no-store').send({ fehler: 'Die Bestätigung ist abgelaufen. Bitte die Seite neu laden.' });
      return undefined;
    }
    return kontext;
  }

  async function protokollieren(request: FastifyRequest, ereignis: Ereignis): Promise<void> {
    await protokollNotieren(pool, request.log, ereignis);
  }

  /** Die Hinweis-Mail an die eigene Adresse. Scheitert sie, gilt die Änderung trotzdem; das Log sagt es laut. */
  async function hinweisMail(request: FastifyRequest, kontext: Kontext, aenderung: FaktorAenderung): Promise<void> {
    if (versand === undefined) {
      return;
    }
    try {
      await versand.senden({ an: kontext.sitzung.user.email, ...faktorMailBauen(aenderung, jetzt()) });
    } catch (fehler) {
      request.log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Sicherheit: Hinweis-Mail nicht verschickt');
    }
  }

  function weiterLesen(wert: unknown): string {
    return typeof wert === 'string' && WEITER.test(wert) ? wert : SICHERHEIT_PFAD;
  }

  // --- Übersicht ---------------------------------------------------------------------------------------------------

  app.get<{ Querystring: { hinweis?: unknown; fehler?: unknown } }>(SICHERHEIT_PFAD, async (request, reply) => {
    const kontext = await kontextLesen(request);
    if (kontext === undefined) {
      return reply.redirect('/anmelden', 303);
    }
    const faktoren = await faktorenLesen(pool, auth, kontext.benutzerId);
    const verlauf = await verlaufLesen(pool, kontext.benutzerId);
    const { hinweis } = request.query;
    const nun = jetzt();
    return seite(request, reply, 'sicherheit.eta', 'Anmeldung & Sicherheit', {
      bestaetigt: kontext.bestaetigung === undefined ? undefined : bestaetigtText(kontext.bestaetigung),
      hinweis: typeof hinweis === 'string' && Object.hasOwn(HINWEISE, hinweis) ? HINWEISE[hinweis] : undefined,
      fehler: request.query.fehler === 'letzter' ? FEHLER_LETZTER : undefined,
      passkeys: faktoren.passkeys.map((passkey) => ({ id: passkey.id, name: passkey.name, angelegt: datumText(passkey.angelegtAm) })),
      passkeyMoeglich: konfiguration !== undefined,
      einziger: faktorAnzahl(faktoren) <= 1,
      totp: faktoren.totp,
      ersatzcodes: faktoren.ersatzcodes,
      verlauf: verlauf.map((eintrag) => ({ zeit: zeitText(eintrag.zeitpunkt, nun), text: verlaufText(eintrag) })),
    });
  });

  // --- Frische Bestätigung -----------------------------------------------------------------------------------------

  async function bestaetigenSeite(request: FastifyRequest, reply: FastifyReply, kontext: Kontext, weiter: string, fehler?: string): Promise<void> {
    const faktoren = await faktorenLesen(pool, auth, kontext.benutzerId);
    return seite(
      request,
      reply,
      'sicherheit-bestaetigen.eta',
      'Bestätigen',
      { weiter, anlass: anlass(weiter), passkeyMoeglich: konfiguration !== undefined && faktoren.passkeys.length > 0, fehler },
      fehler === undefined ? 200 : 400,
    );
  }

  app.get<{ Querystring: { weiter?: unknown } }>(`${SICHERHEIT_PFAD}/bestaetigen`, async (request, reply) => {
    const kontext = await kontextLesen(request);
    if (kontext === undefined) {
      return reply.redirect('/anmelden', 303);
    }
    return bestaetigenSeite(request, reply, kontext, weiterLesen(request.query.weiter));
  });

  /**
   * Der gemeinsame Anfang jedes Bestätigungsversuchs, wie im Codeschritt der Anmeldung: Herkunft, Sitzung, Sperre,
   * und dann **erst reservieren, dann prüfen** — sonst liefen gleichzeitige Versuche gemeinsam durch die Grenze.
   */
  async function versuchBeginnen(request: FastifyRequest, reply: FastifyReply, weiter: string): Promise<Kontext | undefined> {
    if (!herkunftBelegt(request.headers.origin, request.headers.referer, request.headers.host)) {
      void reply.code(403).header('cache-control', 'no-store').send();
      return undefined;
    }
    const kontext = await kontextLesen(request);
    if (kontext === undefined) {
      void reply.redirect('/anmelden', 303);
      return undefined;
    }
    const nun = jetzt();
    if (await sperrePruefen(pool, 'code-konto', kontext.benutzerId, nun)) {
      await bestaetigenSeite(request, reply, kontext, weiter, FEHLER_BESTAETIGUNG);
      return undefined;
    }
    const stand = await versuchReservieren(pool, 'code-konto', kontext.benutzerId, nun);
    if (stand.neuGesperrt) {
      await protokollieren(request, { art: 'sperre_ausgeloest', akteur: 'system', ziel: kontext.benutzerId, einzelheiten: { sperre: 'code-konto' } });
    }
    if (!stand.erlaubt) {
      await bestaetigenSeite(request, reply, kontext, weiter, FEHLER_BESTAETIGUNG);
      return undefined;
    }
    return kontext;
  }

  /** Der Nachweis gilt: Zähler zurück, Bestätigung als Cookie, Protokoll, weiter. */
  async function bestaetigt(request: FastifyRequest, reply: FastifyReply, kontext: Kontext, faktor: BestaetigterFaktor, weiter: string): Promise<FastifyReply> {
    await zaehlerZuruecksetzen(pool, 'code-konto', kontext.benutzerId);
    reply.header('set-cookie', bestaetigungsCookie(schluessel, { sitzungId: kontext.sitzung.session.id, benutzerId: kontext.benutzerId }, faktor, jetzt()));
    if (faktor === 'ersatzcode') {
      await protokollieren(request, { art: 'ersatzcode_verwendet', akteur: kontext.benutzerId });
    }
    await protokollieren(request, { art: 'faktor_bestaetigt', akteur: kontext.benutzerId, einzelheiten: { faktor } });
    return reply.redirect(weiter, 303);
  }

  app.post<{ Body: { code?: unknown; weiter?: unknown } | undefined }>(`${SICHERHEIT_PFAD}/bestaetigen/code`, async (request, reply) => {
    const weiter = weiterLesen(request.body?.weiter);
    const kontext = await versuchBeginnen(request, reply, weiter);
    if (kontext === undefined) {
      return reply;
    }
    const code = text(request.body?.code);
    const faktor = await codePruefen(request, kontext, code);
    if (faktor === undefined) {
      request.log.warn('Sicherheit: Bestätigung mit Code abgelehnt');
      await bestaetigenSeite(request, reply, kontext, weiter, FEHLER_BESTAETIGUNG);
      return reply;
    }
    return bestaetigt(request, reply, kontext, faktor, weiter);
  });

  /**
   * Welcher Faktor den Code bestätigt, oder keiner. Nach der Form entschieden, wie bei der Anmeldung: sechs Ziffern
   * sind ein Code der App (nur mit geprüfter App), alles andere ein Ersatzcode — erst aus der eigenen Tabelle, dann
   * einer der App. Better Auth prüft mit Sitzung, ohne eine neue anzulegen.
   */
  async function codePruefen(request: FastifyRequest, kontext: Kontext, code: string): Promise<BestaetigterFaktor | undefined> {
    if (code.length === 0) {
      return undefined;
    }
    const headers = fromNodeHeaders(request.headers);
    const { totp } = await faktorenLesen(pool, auth, kontext.benutzerId);
    try {
      if (TOTP_FORM.test(code)) {
        if (!totp) {
          return undefined;
        }
        await auth.api.verifyTOTP({ body: { code }, headers });
        return 'totp';
      }
      if (await ersatzcodeEinloesen(pool, kontext.benutzerId, code)) {
        return 'ersatzcode';
      }
      if (!totp) {
        return undefined;
      }
      await auth.api.verifyBackupCode({ body: { code, disableSession: true }, headers });
      return 'ersatzcode';
    } catch {
      // Ein falscher Code kommt von Better Auth als Fehler.
      return undefined;
    }
  }

  // --- Weiteren Passkey anlegen und mit einem vorhandenen bestätigen (nur mit fester Basis-URL) ---------------------

  if (konfiguration !== undefined) {
    skriptAusliefern(app, `${SICHERHEIT_PFAD}/skript.js`, passkeySkriptLesen());

    app.post(`${SICHERHEIT_PFAD}/bestaetigen/passkey/optionen`, async (request, reply) => {
      if (!herkunftBelegt(request.headers.origin, request.headers.referer, request.headers.host)) {
        return reply.code(403).header('cache-control', 'no-store').send({ fehler: 'Anfrage abgelehnt.' });
      }
      const kontext = await kontextLesen(request);
      if (kontext === undefined) {
        return reply.redirect('/anmelden', 303);
      }
      if (await sperrePruefen(pool, 'code-konto', kontext.benutzerId, jetzt())) {
        return reply.code(429).header('cache-control', 'no-store').send({ fehler: FEHLER_BESTAETIGUNG });
      }
      const optionen = await bestaetigungOptionen(pool, konfiguration, kontext.benutzerId, jetzt());
      if (optionen === undefined) {
        return reply.code(400).header('cache-control', 'no-store').send({ fehler: 'Für dieses Konto ist kein Passkey eingerichtet.' });
      }
      return reply.header('cache-control', 'no-store').send(optionen);
    });

    app.post<{ Body: { antwort?: unknown; weiter?: unknown } | undefined }>(`${SICHERHEIT_PFAD}/bestaetigen/passkey`, async (request, reply) => {
      const weiter = weiterLesen(request.body?.weiter);
      const kontext = await versuchBeginnen(request, reply, weiter);
      if (kontext === undefined) {
        return reply;
      }
      const antwort = anmeldungsAntwortLesen(text(request.body?.antwort));
      const ergebnis = antwort === undefined ? undefined : await bestaetigungPruefen(pool, konfiguration, kontext.benutzerId, antwort, jetzt());
      if (ergebnis?.ok !== true) {
        // Der Grund steht im Log, nie in der Antwort; ein zurückgegangener Zähler kann ein kopierter Passkey sein.
        request.log.warn({ grund: ergebnis?.grund ?? 'form' }, 'Sicherheit: Bestätigung mit Passkey abgelehnt');
        await bestaetigenSeite(request, reply, kontext, weiter, FEHLER_BESTAETIGUNG);
        return reply;
      }
      return bestaetigt(request, reply, kontext, 'passkey', weiter);
    });

    app.get(`${SICHERHEIT_PFAD}/passkey`, async (request, reply) => {
      const kontext = await bestaetigtOderUmleiten(request, reply, `${SICHERHEIT_PFAD}/passkey`, false);
      if (kontext === undefined) {
        return reply;
      }
      return seite(request, reply, 'sicherheit-passkey.eta', 'Passkey hinzufügen', { bestaetigt: bestaetigtText(kontext.bestaetigung) });
    });

    app.post(`${SICHERHEIT_PFAD}/passkey/optionen`, async (request, reply) => {
      const kontext = await bestaetigtFuerSkript(request, reply);
      if (kontext === undefined) {
        return reply;
      }
      const optionen = await registrierungBeginnen(
        pool,
        konfiguration,
        { id: kontext.benutzerId, email: kontext.sitzung.user.email },
        jetzt(),
      );
      return reply.header('cache-control', 'no-store').send(optionen);
    });

    app.post<{ Body: { antwort?: unknown; name?: unknown } | undefined }>(`${SICHERHEIT_PFAD}/passkey/pruefen`, async (request, reply) => {
      const kontext = await bestaetigtOderUmleiten(request, reply, `${SICHERHEIT_PFAD}/passkey`, true);
      if (kontext === undefined) {
        return reply;
      }
      const antwort = registrierungsAntwortLesen(text(request.body?.antwort));
      const ergebnis =
        antwort === undefined
          ? undefined
          : await weiterenPasskeyAbschliessen(pool, konfiguration, kontext.benutzerId, antwort, text(request.body?.name), jetzt());
      if (ergebnis?.ok !== true) {
        request.log.warn({ grund: ergebnis?.grund ?? 'form' }, 'Sicherheit: weiterer Passkey abgelehnt');
        return seite(request, reply, 'sicherheit-passkey.eta', 'Passkey hinzufügen', { bestaetigt: bestaetigtText(kontext.bestaetigung), fehler: FEHLER_PASSKEY }, 400);
      }
      await hinweisMail(request, kontext, { art: 'passkey_hinzugefuegt', name: ergebnis.name });
      return reply.redirect(`${SICHERHEIT_PFAD}?hinweis=passkey-hinzugefuegt`, 303);
    });
  }

  // --- Entfernen ---------------------------------------------------------------------------------------------------

  /** Rückfrage und Ausführung für einen Faktor; `ziel` beschreibt ihn, `pfad` ist die Adresse beider Schritte. */
  function entfernenRouten(
    pfad: string,
    ziel: (params: Record<string, string>) => ZuEntfernen | undefined,
    frage: (faktoren: Faktoren, ziel: ZuEntfernen) => { readonly frage: string; readonly saetze: readonly string[] } | undefined,
  ): void {
    app.get<{ Params: Record<string, string> }>(pfad, async (request, reply) => {
      const was = ziel(request.params);
      const hier = ohneAnfrage(request.url);
      const kontext = await bestaetigtOderUmleiten(request, reply, hier, false);
      if (kontext === undefined) {
        return reply;
      }
      const faktoren = await faktorenLesen(pool, auth, kontext.benutzerId);
      const inhalt = was === undefined ? undefined : frage(faktoren, was);
      if (inhalt === undefined) {
        return reply.redirect(SICHERHEIT_PFAD, 303);
      }
      if (faktorAnzahl(faktoren) <= 1) {
        return reply.redirect(`${SICHERHEIT_PFAD}?fehler=letzter`, 303);
      }
      return seite(request, reply, 'sicherheit-frage.eta', 'Entfernen', {
        bestaetigt: bestaetigtText(kontext.bestaetigung),
        ...inhalt,
        aktion: hier,
        knopf: 'Entfernen',
        gefahr: true,
      });
    });

    app.post<{ Params: Record<string, string> }>(pfad, async (request, reply) => {
      const was = ziel(request.params);
      const kontext = await bestaetigtOderUmleiten(request, reply, ohneAnfrage(request.url), true);
      if (kontext === undefined) {
        return reply;
      }
      if (was === undefined) {
        return reply.redirect(SICHERHEIT_PFAD, 303);
      }
      const ergebnis = await faktorEntfernen(pool, kontext.benutzerId, was);
      if (!ergebnis.ok) {
        return reply.redirect(ergebnis.grund === 'letzter' ? `${SICHERHEIT_PFAD}?fehler=letzter` : SICHERHEIT_PFAD, 303);
      }
      if (was.art === 'passkey') {
        await hinweisMail(request, kontext, { art: 'passkey_entfernt', name: ergebnis.name ?? 'Passkey' });
        return reply.redirect(`${SICHERHEIT_PFAD}?hinweis=passkey-entfernt`, 303);
      }
      await hinweisMail(request, kontext, { art: 'totp_entfernt' });
      // Waren die Codes der App die einzigen (ein Konto, das mit der App begann), stünde der Zugang jetzt ohne
      // Ersatzcodes da: dann gleich zehn neue, einmal sichtbar.
      if ((await faktorenLesen(pool, auth, kontext.benutzerId)).ersatzcodes === 0) {
        return ersatzcodesZeigen(request, reply, kontext);
      }
      return reply.redirect(`${SICHERHEIT_PFAD}?hinweis=totp-entfernt`, 303);
    });
  }

  entfernenRouten(
    `${SICHERHEIT_PFAD}/passkey/:id/entfernen`,
    (params) => (PASSKEY_ID.test(params.id ?? '') ? { art: 'passkey', id: params.id ?? '' } : undefined),
    (faktoren, was) => {
      const passkey = was.art === 'passkey' ? faktoren.passkeys.find((eintrag) => eintrag.id === was.id) : undefined;
      if (passkey === undefined) {
        return undefined;
      }
      const uebrige = faktoren.passkeys.filter((eintrag) => eintrag.id !== passkey.id).map((eintrag) => `„${eintrag.name}“`);
      const bleibt = [...uebrige, ...(faktoren.totp ? ['die Authenticator-App'] : [])].join(', ');
      return {
        frage: `Passkey „${passkey.name}“ entfernen?`,
        saetze: [
          `Danach meldet sich dieses Gerät nicht mehr mit diesem Passkey an. Ihr Zugang bleibt über ${bleibt} und die Ersatzcodes erreichbar.`,
          'Der Eintrag wird nicht gelöscht, sondern als entfernt archiviert – ohne den Schlüssel. Sie bekommen eine Hinweis-Mail.',
        ],
      };
    },
  );

  entfernenRouten(
    `${SICHERHEIT_PFAD}/totp/entfernen`,
    () => ({ art: 'totp' }),
    (faktoren) =>
      faktoren.totp
        ? {
            frage: 'Authenticator-App entfernen?',
            saetze: [
              faktoren.eigeneErsatzcodes > 0
                ? 'Danach gelten die Codes aus der App nicht mehr. Ihr Zugang bleibt über Ihre Passkeys und die Ersatzcodes erreichbar.'
                : 'Danach gelten die Codes aus der App nicht mehr. Mit ihr fallen ihre Ersatzcodes weg: das Cockpit zeigt Ihnen danach zehn neue, einmal.',
              'Die Einrichtung wird nicht gelöscht, sondern ohne das Geheimnis archiviert. Sie bekommen eine Hinweis-Mail.',
            ],
          }
        : undefined,
  );

  // --- Authenticator-App neben dem Passkey ---------------------------------------------------------------------------

  app.get(`${SICHERHEIT_PFAD}/totp`, async (request, reply) => {
    const kontext = await bestaetigtOderUmleiten(request, reply, `${SICHERHEIT_PFAD}/totp`, false);
    if (kontext === undefined) {
      return reply;
    }
    if ((await faktorenLesen(pool, auth, kontext.benutzerId)).totp) {
      return reply.redirect(SICHERHEIT_PFAD, 303);
    }
    return seite(request, reply, 'sicherheit-totp.eta', 'Authenticator-App einrichten', { bestaetigt: bestaetigtText(kontext.bestaetigung) });
  });

  app.post<{ Body: { passwort?: unknown } | undefined }>(`${SICHERHEIT_PFAD}/totp`, async (request, reply) => {
    const kontext = await bestaetigtOderUmleiten(request, reply, `${SICHERHEIT_PFAD}/totp`, true);
    if (kontext === undefined) {
      return reply;
    }
    if ((await faktorenLesen(pool, auth, kontext.benutzerId)).totp) {
      return reply.redirect(SICHERHEIT_PFAD, 303);
    }
    const daten = { bestaetigt: bestaetigtText(kontext.bestaetigung) };
    let eingerichtet;
    try {
      eingerichtet = await auth.api.enableTwoFactor({
        body: { password: text(request.body?.passwort), method: 'totp' },
        headers: fromNodeHeaders(request.headers),
        returnHeaders: true,
      });
    } catch (fehler) {
      // Nur die Meldung, nie das Fehlerobjekt: die Anfrage trug ein Passwort.
      request.log.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Sicherheit: App-Einrichtung abgelehnt');
      return seite(request, reply, 'sicherheit-totp.eta', 'Authenticator-App einrichten', { ...daten, fehler: 'Das Passwort ist nicht korrekt.' }, 400);
    }
    const { headers, response } = eingerichtet;
    cookiesUebernehmen(reply, headers);
    if (!('totpURI' in response)) {
      request.log.error('Sicherheit: unerwartete Antwort ohne TOTP-URI');
      return seite(request, reply, 'sicherheit-totp.eta', 'Authenticator-App einrichten', { ...daten, fehler: 'Einrichtung nicht möglich.' }, 500);
    }
    // Die Codes, die Better Auth dabei erzeugt, sieht niemand: die bisherigen Ersatzcodes gelten weiter. Scheitert das,
    // bricht die Anfrage mit 500 ab, und die halb eingerichtete App bleibt ungeprüft (kein Faktor).
    await auth.api.appErsatzcodesEntwerten({ body: { benutzerId: kontext.benutzerId } });
    const html = await app.render('zwei-faktor-code.eta', {
      titel: 'Authenticator-App bestätigen',
      qrSvg: qrCodeSvg(response.totpURI, 'QR-Code für die Authenticator-App'),
      geheimnis: geheimnisAusUri(response.totpURI),
      totpUri: response.totpURI,
      ersatzcodes: [],
      aktion: `${SICHERHEIT_PFAD}/totp/pruefen`,
    });
    reply.header('cache-control', 'no-store');
    return htmlSenden(reply, html);
  });

  app.post<{ Body: { code?: unknown } | undefined }>(`${SICHERHEIT_PFAD}/totp/pruefen`, async (request, reply) => {
    const kontext = await bestaetigtOderUmleiten(request, reply, `${SICHERHEIT_PFAD}/totp`, true);
    if (kontext === undefined) {
      return reply;
    }
    if ((await faktorenLesen(pool, auth, kontext.benutzerId)).totp) {
      return reply.redirect(SICHERHEIT_PFAD, 303);
    }
    try {
      // Better Auth schaltet die App scharf und ersetzt dabei die Sitzung: die neue kommt hier mit an den Browser.
      // Die Bestätigung hing an der alten Sitzung und gilt damit nicht mehr — gewollt, die Änderung ist getan.
      const { headers } = await auth.api.verifyTOTP({
        body: { code: text(request.body?.code) },
        headers: fromNodeHeaders(request.headers),
        returnHeaders: true,
      });
      cookiesUebernehmen(reply, headers);
    } catch (fehler) {
      request.log.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Sicherheit: App-Code abgelehnt');
      return seite(
        request,
        reply,
        'sicherheit-totp.eta',
        'Authenticator-App einrichten',
        { bestaetigt: bestaetigtText(kontext.bestaetigung), fehler: 'Der Code war nicht korrekt. Bitte die Einrichtung erneut starten.' },
        400,
      );
    }
    await protokollieren(request, { art: 'zweiter_faktor_hinzugefuegt', akteur: kontext.benutzerId, einzelheiten: { faktor: 'totp' } });
    await hinweisMail(request, kontext, { art: 'totp_hinzugefuegt' });
    return reply.redirect(`${SICHERHEIT_PFAD}?hinweis=totp-hinzugefuegt`, 303);
  });

  // --- Ersatzcodes neu erzeugen --------------------------------------------------------------------------------------

  app.get(`${SICHERHEIT_PFAD}/ersatzcodes`, async (request, reply) => {
    const kontext = await bestaetigtOderUmleiten(request, reply, `${SICHERHEIT_PFAD}/ersatzcodes`, false);
    if (kontext === undefined) {
      return reply;
    }
    return seite(request, reply, 'sicherheit-frage.eta', 'Neue Ersatzcodes', {
      bestaetigt: bestaetigtText(kontext.bestaetigung),
      frage: 'Zehn neue Ersatzcodes erzeugen?',
      saetze: ['Alle bisherigen Ersatzcodes gelten danach nicht mehr – auch die, die Sie noch nicht verwendet haben. Die neuen zeigt das Cockpit genau einmal.'],
      aktion: `${SICHERHEIT_PFAD}/ersatzcodes`,
      knopf: 'Neu erzeugen',
      gefahr: false,
    });
  });

  app.post(`${SICHERHEIT_PFAD}/ersatzcodes`, async (request, reply) => {
    const kontext = await bestaetigtOderUmleiten(request, reply, `${SICHERHEIT_PFAD}/ersatzcodes`, true);
    if (kontext === undefined) {
      return reply;
    }
    return ersatzcodesZeigen(request, reply, kontext);
  });

  /** Zehn neue Ersatzcodes, Hinweis-Mail, und die Seite, die sie einmal zeigt (`seite` setzt `no-store`). */
  async function ersatzcodesZeigen(request: FastifyRequest, reply: FastifyReply, kontext: Kontext): Promise<void> {
    const ersatzcodes = await ersatzcodesErneuern(pool, auth, kontext.benutzerId);
    await hinweisMail(request, kontext, { art: 'ersatzcodes_erneuert' });
    return seite(request, reply, 'sicherheit-codes.eta', 'Neue Ersatzcodes', { ersatzcodes });
  }
}

/** Der Pfad einer Anfrage ohne `?…`: das Ziel der Rückfrage und der Rücksprung nach der Bestätigung. */
function ohneAnfrage(url: string): string {
  return url.split('?')[0] ?? url;
}

/** Wie viele zweite Faktoren das Konto hat: Passkeys und eine geprüfte App. Ersatzcodes zählen nicht. */
function faktorAnzahl(faktoren: Faktoren): number {
  return faktoren.passkeys.length + (faktoren.totp ? 1 : 0);
}
