/**
 * Anmeldung mit zweitem Faktor (COPI-13).
 *
 * Zwei Schritte, zwei Seiten:
 *
 *   1. `GET/POST /anmelden` — E-Mail und Passwort über `auth.api.signInEmail`.
 *      Hat das Konto einen zweiten Faktor, entsteht hier **keine** Sitzung:
 *      Better Auth löscht die eben angelegte wieder und setzt stattdessen
 *      seinen signierten `two_factor`-Cookie (`twoFactorRedirect: true`).
 *   2. `GET/POST /anmelden/code` — TOTP-Code **oder** Ersatzcode, oder der Passkey
 *      (`/anmelden/passkey/*`, COPI-27). Erst hier entsteht die Sitzung.
 *
 * Ob ein zweiter Schritt nötig ist, entscheidet nicht allein Better Auth
 * (`twoFactorRedirect`, das kennt nur TOTP), sondern `zweiter_faktor_aktiv` (COPI-25):
 * Hat das Konto **irgendeinen** aktiven Faktor, entsteht nach dem Passwort keine Sitzung.
 * Bei einem Konto nur mit Passkey beendet die Anwendung die von Better Auth eben
 * angelegte Sitzung selbst — der Browser bekommt sie nie zu sehen.
 *
 * Bewusst kein `next`- oder Rücksprung-Parameter: ein Ziel aus der Anfrage
 * wäre eine offene Weiterleitung. Nach der Anmeldung geht es immer auf `/`.
 *
 * Was hier **nicht** entschieden wird: wer welche Seite sehen darf. Das macht
 * das zentrale Tor (`src/auth/zwei-faktor-tor.ts`). Diese Routen kennen nur
 * ihren eigenen Ablauf.
 *
 * Alle abweisenden Antworten dieser Datei sind absichtlich gleich: derselbe
 * Text, derselbe Status — für falsches Passwort, unbekannte Adresse und
 * laufende Sperre. Sonst wäre die Antwort selbst die Auskunft darüber, ob es
 * ein Konto gibt oder ob es gerade gesperrt ist.
 */
import { isAPIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { cookieKopfAus, cookiesUebernehmen, htmlSenden } from '../../auth/antwort.js';
import { CLIENT_IP_KOPF, IP_UNBEKANNT } from '../../auth/client-ip.js';
import { emailNormalisieren } from '../../auth/einladung-speicher.js';
import { ersatzcodeEinloesen } from '../../auth/ersatzcode.js';
import { herkunftErlaubt } from '../../auth/herkunft.js';
import { kontoVerfallen } from '../../auth/konto-verfall.js';
import { passkeyKonfiguration } from '../../auth/passkey.js';
import {
  anmeldungOptionen,
  anmeldungPruefen,
  anmeldungsAntwortLesen,
  passkeyVorhanden,
} from '../../auth/passkey-anmeldung.js';
import { protokollNotieren, type Einzelheiten, type Ereignis } from '../../auth/protokoll.js';
import { SITZUNGS_COOKIE_NAME, type CockpitAuth } from '../../auth/konfiguration.js';
import {
  ANMELDEVORGANG_COOKIE_NAME,
  anmeldevorgaengeAufraeumen,
  anmeldevorgangAnlegen,
  anmeldevorgangCookie,
  anmeldevorgangCookieLoeschen,
  anmeldevorgangLesen,
  anmeldevorgangVerbrauchen,
  benutzerIdZuEmail,
  cookieLesen,
} from '../../auth/anmeldevorgang.js';
import {
  sperrePruefen,
  versuchReservieren,
  zaehlerAufraeumen,
  zaehlerGutschreiben,
  zaehlerZuruecksetzen,
  type Reservierung,
} from '../../auth/ratenbegrenzung.js';
import { zweiterFaktorAktiv } from '../../auth/zweiter-faktor.js';
import { ANMELDEN_PFAD, ZWEI_FAKTOR_PFAD } from '../../auth/zwei-faktor-tor.js';
import { text } from './formular.js';
import { passkeySkriptLesen, skriptAusliefern } from './passkey-skript.js';

export const ANMELDEN_CODE_PFAD = `${ANMELDEN_PFAD}/code`;
export const ANMELDEN_PASSKEY_PFAD = `${ANMELDEN_PFAD}/passkey`;

/** Eine Meldung für jeden abgelehnten Passwortschritt — ohne Unterschied. */
const PASSWORT_ABGELEHNT = 'E-Mail-Adresse oder Passwort stimmen nicht.';
/** Eine Meldung für jeden abgelehnten Codeschritt — ohne Unterschied. */
const CODE_ABGELEHNT = 'Der Code stimmt nicht.';

/**
 * Der Hinweis im Log, wenn die Prüfung eines TOTP-Codes oder Ersatzcodes selbst gescheitert ist
 * (COPI-32). Er nennt weder Schlüssel noch Geheimnis noch Code.
 */
const GEHEIMNIS_HINWEIS =
  'Die Prüfung ist selbst gescheitert, das war kein falscher Code. Meist passt BETTER_AUTH_SECRET nicht mehr ' +
  'zu den gespeicherten Schlüsseln (Neustart der Entwicklung ohne festes Geheimnis?). Siehe README, „Auth-Geheimnis".';

/** Sechs Ziffern sind ein TOTP-Code, alles andere wird als Ersatzcode geprüft. */
const TOTP_FORM = /^\d{6}$/;

export interface AnmeldenAbhaengigkeiten {
  readonly auth: CockpitAuth;
  readonly pool: pg.Pool;
  /** Zeitquelle der eigenen Zähler und Vorgänge — in Tests verschiebbar. */
  readonly jetzt: () => Date;
  /**
   * Die feste Basis-URL (rpID und Herkunft des Passkeys, ADR 13.3). Ohne sie gibt es die
   * Passkey-Routen nicht und die Codeseite bietet keinen Passkey an; TOTP und Ersatzcode
   * bleiben.
   */
  readonly basisUrl?: string;
}

interface AnmeldeFormular {
  readonly email?: unknown;
  readonly passwort?: unknown;
}

interface CodeFormular {
  readonly code?: unknown;
}

interface PasskeyFormular {
  readonly antwort?: unknown;
}

/** Der laufende Anmeldevorgang einer Anfrage: Klartext-Token und Konto. */
interface Vorgang {
  readonly token: string;
  readonly benutzerId: string;
}

export function registriereAnmeldenRouten(
  app: FastifyInstance,
  abhaengigkeiten: AnmeldenAbhaengigkeiten,
): void {
  const { auth, pool, jetzt, basisUrl } = abhaengigkeiten;
  // Beim Start: eine unbrauchbare Basis-URL soll hier auffallen, nicht beim ersten Passkey.
  const passkeyKonfig = basisUrl === undefined ? undefined : passkeyKonfiguration(basisUrl);

  async function anmeldeSeite(
    reply: FastifyReply,
    fehler?: string,
    status = 200,
  ): Promise<void> {
    const html = await app.render('anmelden.eta', { titel: 'Anmelden', fehler });
    // Die Seite trägt ein Passwortfeld: nicht zwischenspeichern.
    reply.header('cache-control', 'no-store');
    await htmlSenden(reply, html, status);
  }

  async function codeSeite(
    reply: FastifyReply,
    benutzerId: string,
    fehler?: string,
    status = 200,
  ): Promise<void> {
    // Was die Seite anbietet, hängt am Konto: den Passkey nur, wenn es einen hat. Die Seite
    // ist erst nach dem richtigen Passwort erreichbar, das verrät also nichts Neues.
    const passkeyAngeboten = passkeyKonfig !== undefined && (await passkeyVorhanden(pool, benutzerId));
    const html = await app.render('anmelden-code.eta', {
      titel: 'Zweiter Faktor',
      fehler,
      passkeyAngeboten,
    });
    reply.header('cache-control', 'no-store');
    await htmlSenden(reply, html, status);
  }

  /**
   * Fremde Herkunft: nichts tun, nichts zählen, keine Auskunft. Bewusst ohne
   * HTML-Seite — hierher kommt kein Mensch, sondern ein fremdes Formular.
   */
  function herkunftPruefen(request: FastifyRequest, reply: FastifyReply): boolean {
    if (herkunftErlaubt(request.headers.origin, request.headers.referer, request.headers.host)) {
      return true;
    }
    request.log.warn('Anmeldung: Formular von fremder Herkunft abgewiesen');
    void reply.code(403).send({ fehler: 'ungültige Herkunft' });
    return false;
  }

  /**
   * Abgelaufene Zähler abräumen, wenn gerade eine Sperre entstanden ist.
   *
   * `neuGesperrt` ist je Sperre genau einmal wahr, die Löschanweisung läuft also
   * nicht bei jedem der vielen abgewiesenen Versuche danach. Ohne diesen
   * Auslöser könnte jemand mit Fehlversuchen auf immer neue Adressen beliebig
   * viele Zeilen anhäufen, wenn sich nie jemand erfolgreich anmeldet.
   */
  async function aufraeumenFallsNeuGesperrt(
    nun: Date,
    stand: Reservierung,
  ): Promise<void> {
    if (stand.neuGesperrt) {
      await zaehlerAufraeumen(pool, nun);
    }
  }

  async function protokollieren(request: FastifyRequest, ereignis: Ereignis): Promise<void> {
    await protokollNotieren(pool, request.log, ereignis);
  }

  /**
   * Hält eine eben gesetzte Sperre fest (COPI-23) — nur, wenn sie ein **bekanntes
   * Konto** trifft. Für unbekannte Adressen und für IPs bleibt das Protokoll
   * leer: Es wäre sonst Auskunft über Adressen, es würde eine IP enthalten, und
   * ein Angreifer könnte die Tabelle mit erfundenen Adressen füllen, die sich
   * nie wieder abräumen lässt. Je Sperre gibt es höchstens einen Eintrag
   * (`neuGesperrt` ist je Sperre genau einmal wahr), je Konto also höchstens
   * einen je 15 Minuten.
   */
  async function sperreFesthalten(
    request: FastifyRequest,
    stand: Reservierung,
    sperre: 'passwort-email' | 'code-konto',
    konto: () => Promise<string | undefined>,
  ): Promise<void> {
    if (!stand.neuGesperrt) {
      return;
    }
    const ziel = await konto();
    if (ziel !== undefined) {
      await protokollieren(request, {
        art: 'sperre_ausgeloest',
        akteur: 'system',
        ziel,
        einzelheiten: { sperre },
      });
    }
  }

  function clientIp(request: FastifyRequest): string {
    const wert = request.headers[CLIENT_IP_KOPF];
    return typeof wert === 'string' && wert.length > 0 ? wert : IP_UNBEKANNT;
  }

  async function vorgangLesen(request: FastifyRequest): Promise<Vorgang | undefined> {
    const token = cookieLesen(request.headers.cookie, ANMELDEVORGANG_COOKIE_NAME);
    if (token === undefined) {
      return undefined;
    }
    const benutzerId = await anmeldevorgangLesen(pool, token, jetzt());
    return benutzerId === undefined ? undefined : { token, benutzerId };
  }

  /** Kein oder abgelaufener Vorgang: von vorn, ohne weitere Auskunft. */
  function vonVornAnfangen(reply: FastifyReply): FastifyReply {
    reply.header('set-cookie', anmeldevorgangCookieLoeschen());
    return reply.redirect(ANMELDEN_PFAD, 303);
  }

  /**
   * Der gemeinsame Anfang jedes Versuchs im zweiten Schritt — TOTP, Ersatzcode und
   * Passkey haben dieselbe Grenze: Herkunft, Vorgang, Sperre, und dann **erst reservieren,
   * dann prüfen**, sonst liefen gleichzeitige Anfragen mit demselben Zwischenzustand
   * gemeinsam durch die Grenze. Ein Zähler je Konto für alle drei.
   *
   * Liefert Vorgang und Eingabe, wenn der Versuch laufen darf (er ist dann reserviert).
   * Sonst ist die Antwort schon gegeben, und die Route hört auf. Fehlt die Eingabe
   * (`undefined`: leer oder von falscher Form), verbraucht das kein Budget — geraten wird
   * damit nichts.
   */
  async function versuchBeginnen<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    eingabe: T | undefined,
  ): Promise<{ readonly vorgang: Vorgang; readonly eingabe: T } | undefined> {
    if (!herkunftPruefen(request, reply)) {
      return undefined;
    }
    const vorgang = await vorgangLesen(request);
    if (vorgang === undefined) {
      vonVornAnfangen(reply);
      return undefined;
    }
    const nun = jetzt();
    if (
      eingabe === undefined ||
      (await sperrePruefen(pool, 'code-konto', vorgang.benutzerId, nun))
    ) {
      await codeSeite(reply, vorgang.benutzerId, CODE_ABGELEHNT, 400);
      return undefined;
    }
    const standCode = await versuchReservieren(pool, 'code-konto', vorgang.benutzerId, nun);
    await aufraeumenFallsNeuGesperrt(nun, standCode);
    await sperreFesthalten(request, standCode, 'code-konto', () =>
      Promise.resolve(vorgang.benutzerId),
    );
    if (!standCode.erlaubt) {
      await codeSeite(reply, vorgang.benutzerId, CODE_ABGELEHNT, 400);
      return undefined;
    }
    return { vorgang, eingabe };
  }

  /**
   * Die Sitzung nach einem Nachweis, den Better Auth nicht selbst geprüft hat (Passkey,
   * Ersatzcode aus der eigenen Tabelle). Nur nach einem geprüften Nachweis aufrufen; siehe
   * `sitzung-anlegen.ts`.
   */
  async function sitzungAnlegen(request: FastifyRequest, benutzerId: string): Promise<Headers> {
    const { headers } = await auth.api.sitzungNachZweitemFaktor({
      body: { benutzerId },
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });
    return headers;
  }

  /** Der Nachweis gilt: Vorgang verbrauchen, Zähler zurücksetzen, Sitzung an den Browser, Protokoll. */
  async function zweitenSchrittAbschliessen(
    request: FastifyRequest,
    reply: FastifyReply,
    vorgang: Vorgang,
    sitzungsKopf: Headers,
    faktor: 'totp' | 'ersatzcode' | 'passkey',
  ): Promise<FastifyReply> {
    const nun = jetzt();
    await anmeldevorgangVerbrauchen(pool, vorgang.token);
    await zaehlerZuruecksetzen(pool, 'code-konto', vorgang.benutzerId);
    cookiesUebernehmen(reply, sitzungsKopf);
    reply.header('set-cookie', anmeldevorgangCookieLoeschen());
    // Aufräumen genau hier: eine abgeschlossene Anmeldung ist selten genug
    // für eine Löschanweisung und häufig genug, damit nichts liegen bleibt.
    await anmeldevorgaengeAufraeumen(pool, nun);
    await zaehlerAufraeumen(pool, nun);
    if (faktor === 'ersatzcode') {
      await protokollieren(request, { art: 'ersatzcode_verwendet', akteur: vorgang.benutzerId });
    }
    await protokollieren(request, {
      art: 'anmeldung_erfolgreich',
      akteur: vorgang.benutzerId,
      einzelheiten: { schritt: 'code', faktor },
    });
    return reply.redirect('/', 303);
  }

  /**
   * Der Nachweis gilt nicht: immer dieselbe Antwort, keine Sitzung. Der Grund steht nur im
   * Log, nie in der Antwort. Die Reservierung bleibt stehen — sie ist dieser Fehlversuch.
   *
   * `technisch` (COPI-32): die Prüfung hat nicht „falscher Code" gesagt, sondern ist selbst
   * gescheitert. Bei TOTP und dessen Ersatzcodes heißt das fast immer: der gespeicherte Schlüssel
   * lässt sich nicht entschlüsseln, weil `BETTER_AUTH_SECRET` nicht mehr das von damals ist
   * (Better Auth: `invalid tag`). Der Log sagt es, damit niemand nach einem falschen Code sucht;
   * die Antwort bleibt dieselbe wie bei einem falschen Code.
   */
  async function zweitenSchrittAblehnen(
    request: FastifyRequest,
    reply: FastifyReply,
    vorgang: Vorgang,
    einzelheiten: Einzelheiten,
    grund: string,
    technisch = false,
  ): Promise<void> {
    // Wieder nur die Meldung: die Anfrage trug einen Code oder eine Signatur.
    request.log.warn(
      { grund, ...(technisch ? { hinweis: GEHEIMNIS_HINWEIS } : {}) },
      'Anmeldung: Codeschritt abgelehnt',
    );
    await protokollieren(request, {
      art: 'anmeldung_fehlgeschlagen',
      akteur: 'system',
      ziel: vorgang.benutzerId,
      einzelheiten,
    });
    await codeSeite(reply, vorgang.benutzerId, CODE_ABGELEHNT, 400);
  }

  /** Der Anmeldevorgang beginnt: kein Sitzungs-Cookie, nur der Vorgang (und ggf. der von Better Auth). */
  async function zweitenSchrittStarten(
    reply: FastifyReply,
    benutzerId: string,
    nun: Date,
    betterAuthKopf?: Headers,
  ): Promise<FastifyReply> {
    const token = await anmeldevorgangAnlegen(pool, benutzerId, nun);
    if (betterAuthKopf !== undefined) {
      cookiesUebernehmen(reply, betterAuthKopf);
    }
    reply.header('set-cookie', anmeldevorgangCookie(token));
    return reply.redirect(ANMELDEN_CODE_PFAD, 303);
  }

  app.get(ANMELDEN_PFAD, async (request, reply) => {
    // Wer schon angemeldet ist, braucht das Formular nicht. Ohne Sitzungs-
    // Cookie wird die Datenbank gar nicht erst gefragt.
    if (request.headers.cookie?.includes(SITZUNGS_COOKIE_NAME) === true) {
      const sitzung = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (sitzung) {
        return reply.redirect('/', 303);
      }
    }
    return anmeldeSeite(reply);
  });

  app.post(
    ANMELDEN_PFAD,
    async (request: FastifyRequest<{ Body: AnmeldeFormular }>, reply) => {
      if (!herkunftPruefen(request, reply)) {
        return reply;
      }
      const email = emailNormalisieren(text(request.body.email));
      const passwort = text(request.body.passwort);
      if (email.length === 0 || passwort.length === 0) {
        // Leere Eingabe verbraucht kein Budget — geraten wird damit nichts.
        return anmeldeSeite(reply, PASSWORT_ABGELEHNT, 400);
      }

      const ip = clientIp(request);
      const nun = jetzt();
      const gesperrt =
        (await sperrePruefen(pool, 'passwort-email', email, nun)) ||
        (await sperrePruefen(pool, 'passwort-ip', ip, nun));
      if (gesperrt) {
        // Billiger Kurzschluss bei laufender Sperre — er entscheidet aber nicht
        // allein, das tun die Reservierungen unten.
        //
        // Dieselbe Antwort wie bei falschen Daten, auch bei richtigem Passwort.
        // Bewusst ohne Passwortprüfung, also messbar schneller als ein
        // Fehlversuch (gemessen: ~0,6 ms gegen ~15 ms für Argon2id). Damit ist
        // von außen erkennbar, dass eine Adresse gerade gesperrt ist — aber
        // nicht, ob es zu ihr ein Konto gibt, denn gesperrt werden unbekannte
        // Adressen genauso. Die Gegenrichtung (zum Angleichen auch hier
        // Argon2id rechnen) wäre schlechter: sie machte jede gesperrte Adresse
        // zu einem Hebel, mit dem sich beliebig CPU-Zeit anfordern lässt.
        return anmeldeSeite(reply, PASSWORT_ABGELEHNT, 400);
      }

      // Erst reservieren, dann prüfen. Nur so greift die Grenze auch bei
      // gleichzeitigen Anfragen (siehe ratenbegrenzung.ts).
      const standEmail = await versuchReservieren(pool, 'passwort-email', email, nun);
      await aufraeumenFallsNeuGesperrt(nun, standEmail);
      await sperreFesthalten(request, standEmail, 'passwort-email', () =>
        benutzerIdZuEmail(pool, email),
      );
      if (!standEmail.erlaubt) {
        return anmeldeSeite(reply, PASSWORT_ABGELEHNT, 400);
      }
      const standIp = await versuchReservieren(pool, 'passwort-ip', ip, nun);
      await aufraeumenFallsNeuGesperrt(nun, standIp);
      if (!standIp.erlaubt) {
        // Der zweite Zähler weist ab, geprüft wurde also nichts. Die
        // Reservierung der Adresse wird gutgeschrieben: sonst zählte eine
        // ausgeschöpfte IP fremde Adressen leer und sperrte Kolleginnen aus,
        // ohne dass je ein Passwort geprüft wurde.
        await zaehlerGutschreiben(pool, 'passwort-email', email);
        return anmeldeSeite(reply, PASSWORT_ABGELEHNT, 400);
      }

      if (await kontoVerfallen(pool, email, nun)) {
        // Konto wurde nie aktiviert und ist älter als 72 Stunden. Die
        // Reservierung bleibt stehen — dieser Versuch zählt gegen das
        // Budget, spart aber die Passwortprüfung.
        return anmeldeSeite(reply, PASSWORT_ABGELEHNT, 400);
      }

      let ergebnis;
      try {
        ergebnis = await auth.api.signInEmail({
          body: { email, password: passwort },
          headers: fromNodeHeaders(request.headers),
          returnHeaders: true,
        });
      } catch (fehler) {
        // Nur die Meldung, nie das Fehlerobjekt: die Anfrage trug ein Passwort,
        // das über angehängte Daten im Log landen könnte. Auch keine Adresse.
        // Die Reservierung bleibt stehen — sie *ist* dieser Fehlversuch.
        request.log.warn(
          { grund: fehler instanceof Error ? fehler.message : 'unbekannt' },
          'Anmeldung: Passwortschritt abgelehnt',
        );
        // Nur für ein bekanntes Konto ein Eintrag (die Suche läuft für jede
        // Adresse, damit der Ablauf sich nicht unterscheidet). Eine unbekannte
        // Adresse hinterlässt nichts: sonst gäbe das Protokoll Auskunft über
        // Adressen und wüchse mit jedem erfundenen Versuch.
        const bekannt = await benutzerIdZuEmail(pool, email);
        if (bekannt !== undefined) {
          await protokollieren(request, {
            art: 'anmeldung_fehlgeschlagen',
            akteur: 'system',
            ziel: bekannt,
            einzelheiten: { schritt: 'passwort' },
          });
        }
        return anmeldeSeite(reply, PASSWORT_ABGELEHNT, 400);
      }

      await zaehlerZuruecksetzen(pool, 'passwort-email', email);
      // Eine rechtmäßige Anmeldung soll das IP-Budget nicht verbrauchen.
      await zaehlerGutschreiben(pool, 'passwort-ip', ip);

      if (!('twoFactorRedirect' in ergebnis.response)) {
        const kontoId = ergebnis.response.user.id;
        if (await zweiterFaktorAktiv(pool, kontoId)) {
          // Better Auth kennt nur TOTP. Ein aktiver Faktor ohne `twoFactorRedirect` ist ein
          // Passkey (COPI-26): Better Auth hat trotzdem eine Sitzung angelegt. Sie endet hier,
          // bevor der Browser sie sieht — mit dem Passwort allein gäbe es sonst eine volle
          // Sitzung, und der Passkey wäre kein zweiter Faktor.
          await auth.api.signOut({
            headers: new Headers({ cookie: cookieKopfAus(ergebnis.headers) }),
          });
          return zweitenSchrittStarten(reply, kontoId, nun);
        }
        // Konto ohne zweiten Faktor: Better Auth hat eine Sitzung angelegt, und
        // das zentrale Tor führt sie zur Einrichtung. Ein Konto ohne zweiten
        // Faktor erreicht damit nichts außer dieser Seite.
        cookiesUebernehmen(reply, ergebnis.headers);
        // Eine Sitzung ist entstanden (auch wenn das Tor sie zur Einrichtung
        // führt): das ist eine Anmeldung. Mit zweitem Faktor zählt erst der Code.
        await protokollieren(request, {
          art: 'anmeldung_erfolgreich',
          akteur: kontoId,
          einzelheiten: { schritt: 'passwort' },
        });
        return reply.redirect(ZWEI_FAKTOR_PFAD, 303);
      }

      const benutzerId = await benutzerIdZuEmail(pool, email);
      if (benutzerId === undefined) {
        // Kann nicht eintreten: das Passwort war eben noch richtig.
        request.log.error('Anmeldung: Konto nach erfolgreichem Passwort nicht gefunden');
        return anmeldeSeite(reply, PASSWORT_ABGELEHNT, 400);
      }
      // Konto mit TOTP: Better Auths `two_factor`-Cookie kommt zum Vorgang dazu.
      return zweitenSchrittStarten(reply, benutzerId, nun, ergebnis.headers);
    },
  );

  app.get(ANMELDEN_CODE_PFAD, async (request, reply) => {
    const vorgang = await vorgangLesen(request);
    if (vorgang === undefined) {
      return reply.redirect(ANMELDEN_PFAD, 303);
    }
    return codeSeite(reply, vorgang.benutzerId);
  });

  app.post(
    ANMELDEN_CODE_PFAD,
    async (request: FastifyRequest<{ Body: CodeFormular }>, reply) => {
      const code = text(request.body.code);
      const versuch = await versuchBeginnen(request, reply, code.length > 0 ? code : undefined);
      if (versuch === undefined) {
        return reply;
      }
      const { vorgang } = versuch;

      // Nach der Form des Eingegebenen entscheiden, welcher Nachweis geprüft
      // wird. Beides zu versuchen würde bei jedem Tippfehler zwei Fehlversuche
      // erzeugen — auch in der Zählung von Better Auth.
      const kopf = fromNodeHeaders(request.headers);
      const istTotp = TOTP_FORM.test(code);
      try {
        let sitzungsKopf: Headers;
        if (istTotp) {
          sitzungsKopf = await betterAuthNachweis(
            vorgang,
            await auth.api.verifyTOTP({ body: { code }, headers: kopf, returnHeaders: true }),
          );
        } else if (await ersatzcodeEinloesen(pool, vorgang.benutzerId, code)) {
          // Ein Code aus der eigenen Tabelle (Konto mit Passkey, COPI-26): Better Auth
          // kennt ihn nicht, die Sitzung legt die Anwendung an.
          sitzungsKopf = await sitzungAnlegen(request, vorgang.benutzerId);
        } else {
          sitzungsKopf = await betterAuthNachweis(
            vorgang,
            await auth.api.verifyBackupCode({ body: { code }, headers: kopf, returnHeaders: true }),
          );
        }
        return await zweitenSchrittAbschliessen(
          request,
          reply,
          vorgang,
          sitzungsKopf,
          istTotp ? 'totp' : 'ersatzcode',
        );
      } catch (fehler) {
        await zweitenSchrittAblehnen(
          request,
          reply,
          vorgang,
          { schritt: 'code' },
          fehler instanceof Error ? fehler.message : 'unbekannt',
          // Ein falscher Code kommt von Better Auth als APIError; alles andere ist die Prüfung selbst.
          !isAPIError(fehler),
        );
        return reply;
      }
    },
  );

  /** Vorgang und Better-Auth-Nachweis müssen zum selben Konto gehören; sonst fail closed. */
  function betterAuthNachweis(
    vorgang: Vorgang,
    ergebnis: { readonly headers: Headers; readonly response: { readonly user: { readonly id: string } } },
  ): Promise<Headers> {
    if (ergebnis.response.user.id !== vorgang.benutzerId) {
      // Erreichbar nur, wenn jemand Cookies mischt.
      return Promise.reject(new Error('Anmeldevorgang und Nachweis passen nicht zusammen'));
    }
    return Promise.resolve(ergebnis.headers);
  }

  if (passkeyKonfig !== undefined) {
    const skript = passkeySkriptLesen();
    skriptAusliefern(app, `${ANMELDEN_PASSKEY_PFAD}/skript.js`, skript);

    app.post(`${ANMELDEN_PASSKEY_PFAD}/optionen`, async (request, reply) => {
      if (!herkunftPruefen(request, reply)) {
        return reply;
      }
      const vorgang = await vorgangLesen(request);
      if (vorgang === undefined) {
        return vonVornAnfangen(reply);
      }
      // Optionen zu holen ist kein Versuch und zählt nicht; geprüft (und gezählt) wird erst die Antwort.
      const optionen = await anmeldungOptionen(pool, passkeyKonfig, vorgang.token, vorgang.benutzerId, jetzt());
      reply.header('cache-control', 'no-store');
      if (optionen === undefined) {
        return reply.code(400).send({ fehler: 'Der Passkey konnte nicht verwendet werden.' });
      }
      return reply.send(optionen);
    });

    app.post(
      `${ANMELDEN_PASSKEY_PFAD}/pruefen`,
      async (request: FastifyRequest<{ Body: PasskeyFormular | undefined }>, reply) => {
        const versuch = await versuchBeginnen(
          request,
          reply,
          anmeldungsAntwortLesen(text(request.body?.antwort)),
        );
        if (versuch === undefined) {
          return reply;
        }
        const { vorgang, eingabe } = versuch;
        try {
          const ergebnis = await anmeldungPruefen(
            pool,
            passkeyKonfig,
            vorgang.token,
            vorgang.benutzerId,
            eingabe,
            jetzt(),
          );
          if (!ergebnis.ok) {
            // Ein zurückgegangener Zähler ist möglicherweise ein kopierter Passkey: der
            // Eintrag unterscheidet sich vom Tippfehler, die Antwort nicht.
            await zweitenSchrittAblehnen(
              request,
              reply,
              vorgang,
              { schritt: ergebnis.grund === 'zaehler' ? 'passkey_zaehler' : 'code', faktor: 'passkey' },
              ergebnis.grund,
            );
            return reply;
          }
          const sitzungsKopf = await sitzungAnlegen(request, vorgang.benutzerId);
          return await zweitenSchrittAbschliessen(request, reply, vorgang, sitzungsKopf, 'passkey');
        } catch (fehler) {
          await zweitenSchrittAblehnen(
            request,
            reply,
            vorgang,
            { schritt: 'code', faktor: 'passkey' },
            fehler instanceof Error ? fehler.message : 'unbekannt',
          );
          return reply;
        }
      },
    );
  }
}
