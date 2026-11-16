/**
 * Einrichtung des zweiten Faktors: TOTP (COPI-10) auf dieser Seite, der Passkey
 * (COPI-26) über `routes/passkey.ts` — die Seite bietet beides an.
 *
 * TOTP ist zweistufig, weil Better Auth für das Aktivieren das Passwort verlangt:
 *   1. Passwort bestätigen  -> `enableTwoFactor` liefert TOTP-URI + Ersatzcodes
 *   2. Code aus der App     -> `verifyTOTP` schaltet den Faktor scharf
 * Erst nach Schritt 2 lässt die zentrale Weiche den Zugang wieder frei.
 *
 * **Nur für Konten ohne aktiven zweiten Faktor**, wie die Passkey-Einrichtung: das Tor lässt `/zwei-faktor` auch mit
 * aktivem Faktor durch, und Better Auth weist nur ein schon geprüftes TOTP ab. Ohne diese Prüfung ließe sich mit
 * Sitzung und Passwort allein eine Authenticator-App neben einen Passkey hängen (COPI-94). Ein weiterer Faktor
 * entsteht nur über `/sicherheit`, mit einer frischen Bestätigung durch einen vorhandenen.
 */
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { cookiesUebernehmen, htmlSenden } from '../../auth/antwort.js';
import type { CockpitAuth } from '../../auth/konfiguration.js';
import { protokollNotieren } from '../../auth/protokoll.js';
import { qrCodeSvg } from '../../auth/qr.js';
import { zweiterFaktorAktiv } from '../../auth/zweiter-faktor.js';
import {
  ABMELDEN_PFAD,
  ANMELDEN_PFAD,
  ZWEI_FAKTOR_PFAD,
} from '../../auth/zwei-faktor-tor.js';

export interface ZweiFaktorAbhaengigkeiten {
  readonly auth: CockpitAuth;
  /** Für den Zustand „zweiter Faktor aktiv" (COPI-25) und das Protokoll (COPI-23). */
  readonly pool: pg.Pool;
  /**
   * Ob die Passkey-Routen registriert sind (sie brauchen die feste Basis-URL). Nur
   * dann zeigt die Seite den Passkey an; ohne Routen wäre der Knopf ein toter Link.
   */
  readonly passkeyAngeboten?: boolean;
}

interface PasswortFormular {
  readonly passwort?: unknown;
}

interface CodeFormular {
  readonly code?: unknown;
}

function text(wert: unknown): string {
  return typeof wert === 'string' ? wert.trim() : '';
}

/** Liest das `secret` aus einer `otpauth://`-URI für die manuelle Eingabe. */
export function geheimnisAusUri(totpUri: string): string {
  try {
    return new URL(totpUri).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

export function registriereZweiFaktorRouten(
  app: FastifyInstance,
  abhaengigkeiten: ZweiFaktorAbhaengigkeiten,
): void {
  const { auth, pool } = abhaengigkeiten;
  const passkeyAngeboten = abhaengigkeiten.passkeyAngeboten === true;

  async function sitzungHolen(request: FastifyRequest) {
    return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  }

  async function passwortSeite(
    reply: FastifyReply,
    fehler?: string,
    status = 200,
  ): Promise<void> {
    const html = await app.render('zwei-faktor.eta', {
      titel: 'Zweiten Faktor einrichten',
      fehler,
      passkeyAngeboten,
    });
    await htmlSenden(reply, html, status);
  }

  app.get(ZWEI_FAKTOR_PFAD, async (request, reply) => {
    const sitzung = await sitzungHolen(request);
    if (!sitzung) {
      return reply.redirect('/', 303);
    }
    if (await zweiterFaktorAktiv(pool, sitzung.user.id)) {
      return reply.redirect('/', 303);
    }
    return passwortSeite(reply);
  });

  app.post(
    `${ZWEI_FAKTOR_PFAD}/einrichten`,
    async (request: FastifyRequest<{ Body: PasswortFormular }>, reply) => {
      const sitzung = await sitzungHolen(request);
      if (!sitzung || (await zweiterFaktorAktiv(pool, sitzung.user.id))) {
        return reply.redirect('/', 303);
      }
      const passwort = text(request.body.passwort);
      if (passwort.length === 0) {
        return passwortSeite(reply, 'Bitte das Passwort eingeben.', 400);
      }
      try {
        const { headers, response } = await auth.api.enableTwoFactor({
          body: { password: passwort, method: 'totp' },
          headers: fromNodeHeaders(request.headers),
          returnHeaders: true,
        });
        cookiesUebernehmen(reply, headers);
        if (!('totpURI' in response)) {
          // Kann nur eintreten, wenn jemand die Methode umstellt — in diesem
          // Ticket ist ausschließlich TOTP vorgesehen.
          request.log.error('2FA: unerwartete Antwort ohne TOTP-URI');
          return passwortSeite(reply, 'Einrichtung nicht möglich.', 500);
        }
        const html = await app.render('zwei-faktor-code.eta', {
          titel: 'Zweiten Faktor bestätigen',
          // Hauptweg ist der serverseitig erzeugte QR-Code (COPI-15). Geheimnis
          // und Adresse stehen zusätzlich in zwei schreibgeschützten Feldern
          // zum Kopieren (COPI-16), aber nirgends sonst auf der Seite.
          qrSvg: qrCodeSvg(response.totpURI, 'QR-Code für die Authenticator-App'),
          geheimnis: geheimnisAusUri(response.totpURI),
          totpUri: response.totpURI,
          ersatzcodes: response.backupCodes ?? [],
        });
        // Die Seite trägt Geheimnis und Ersatzcodes: nie zwischenspeichern und
        // nicht über die Zurück-Taste erneut anzeigen lassen.
        reply.header('cache-control', 'no-store');
        return htmlSenden(reply, html);
      } catch (fehler) {
        // Nur die Meldung, nie das Fehlerobjekt: die Anfrage trug ein
        // Passwort, das über angehängte Daten im Log landen könnte.
        request.log.warn(
          { grund: fehler instanceof Error ? fehler.message : 'unbekannt' },
          '2FA: Aktivierung abgelehnt',
        );
        return passwortSeite(reply, 'Das Passwort ist nicht korrekt.', 400);
      }
    },
  );

  app.post(
    `${ZWEI_FAKTOR_PFAD}/pruefen`,
    async (request: FastifyRequest<{ Body: CodeFormular }>, reply) => {
      const sitzung = await sitzungHolen(request);
      if (!sitzung) {
        return reply.redirect('/', 303);
      }
      if (await zweiterFaktorAktiv(pool, sitzung.user.id)) {
        return reply.redirect('/', 303);
      }
      const code = text(request.body.code);
      try {
        const { headers } = await auth.api.verifyTOTP({
          body: { code },
          headers: fromNodeHeaders(request.headers),
          returnHeaders: true,
        });
        cookiesUebernehmen(reply, headers);
        await protokollNotieren(pool, request.log, {
          art: 'zweiter_faktor_eingerichtet',
          akteur: sitzung.user.id,
          einzelheiten: { faktor: 'totp' },
        });
        return reply.redirect('/', 303);
      } catch (fehler) {
        request.log.warn(
          { grund: fehler instanceof Error ? fehler.message : 'unbekannt' },
          '2FA: Code abgelehnt',
        );
        return passwortSeite(
          reply,
          'Der Code war nicht korrekt. Bitte die Einrichtung erneut starten.',
          400,
        );
      }
    },
  );

  app.post(ABMELDEN_PFAD, async (request, reply) => {
    // Vor dem Abmelden lesen: danach gibt es die Sitzung nicht mehr. Ohne Sitzung
    // (abgelaufen, oder ein Klick auf „Abbrechen") gibt es nichts festzuhalten.
    const sitzung = await sitzungHolen(request);
    const { headers } = await auth.api.signOut({
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });
    cookiesUebernehmen(reply, headers);
    if (sitzung) {
      await protokollNotieren(pool, request.log, { art: 'abmeldung', akteur: sitzung.user.id });
    }
    // Seit COPI-13 ist `/` ohne Sitzung nicht mehr erreichbar; das Ziel ist
    // deshalb direkt die Anmeldeseite statt eines zweiten Umwegs über `/`.
    return reply.redirect(ANMELDEN_PFAD, 303);
  });
}
