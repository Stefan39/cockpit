/**
 * Passkey einrichten (COPI-26) — die Routen unter `/zwei-faktor/passkey/*`.
 *
 * Kein roher Better-Auth-Endpunkt: die Zeremonie läuft im Prozess über
 * `src/auth/passkey.ts`, die Allowlist unter `/api/auth` (COPI-20) bleibt, wie sie
 * ist. Alle Pfade liegen unter `/zwei-faktor` und damit hinter dem zentralen Tor:
 * ohne Sitzung leitet es auf die Anmeldung um, mit Sitzung ohne Faktor lässt es sie
 * durch.
 *
 *   POST /optionen   Passwort bestätigen, Optionen für das Gerät (JSON)
 *   POST /pruefen    Antwort des Geräts prüfen, Passkey anlegen, Ersatzcodes zeigen
 *   GET  /skript.js  das Browser-Skript, vom eigenen Ursprung
 *
 * **Nur für Konten ohne aktiven zweiten Faktor** (die erzwungene Einrichtung). Mit
 * Sitzung und Passwort allein einen Passkey neben einen vorhandenen Faktor zu hängen,
 * würde ihn umgehen: das geht nur auf `/sicherheit` (COPI-94), nach einer frischen
 * Bestätigung durch den vorhandenen Faktor.
 */
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { htmlSenden } from '../../auth/antwort.js';
import type { CockpitAuth } from '../../auth/konfiguration.js';
import {
  passkeyKonfiguration,
  registrierungAbschliessen,
  registrierungBeginnen,
  registrierungsAntwortLesen,
} from '../../auth/passkey.js';
import { zweiterFaktorAktiv } from '../../auth/zweiter-faktor.js';
import { ANMELDEN_PFAD, ZWEI_FAKTOR_PFAD } from '../../auth/zwei-faktor-tor.js';
import { text } from './formular.js';
import { passkeySkriptLesen, skriptAusliefern } from './passkey-skript.js';

export const PASSKEY_PFAD = `${ZWEI_FAKTOR_PFAD}/passkey`;

export interface PasskeyAbhaengigkeiten {
  readonly auth: CockpitAuth;
  readonly pool: pg.Pool;
  /** Die feste Basis-URL: aus ihr kommen rpID und erwartete Herkunft. */
  readonly basisUrl: string;
  readonly jetzt: () => Date;
}

interface PasswortFormular {
  readonly passwort?: unknown;
}

interface PruefFormular {
  readonly antwort?: unknown;
  readonly name?: unknown;
}

const FEHLER_EINRICHTUNG =
  'Der Passkey konnte nicht eingerichtet werden. Bitte erneut versuchen oder die Authenticator-App verwenden.';

export function registrierePasskeyRoutes(
  app: FastifyInstance,
  abhaengigkeiten: PasskeyAbhaengigkeiten,
): void {
  const { auth, pool, basisUrl, jetzt } = abhaengigkeiten;
  // Beim Start: eine unbrauchbare Basis-URL soll hier auffallen, nicht beim ersten Passkey.
  const konfiguration = passkeyKonfiguration(basisUrl);
  const skript = passkeySkriptLesen();

  async function sitzungHolen(request: FastifyRequest) {
    return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  }

  type Sitzung = NonNullable<Awaited<ReturnType<typeof sitzungHolen>>>;

  /**
   * Die Sitzung eines Kontos, das noch einrichten darf. Sonst ist die Antwort hier schon
   * gegeben — ohne Sitzung die Umleitung auf die Anmeldung (das Tor kommt dem zuvor, das
   * ist der zweite Riegel), bei aktivem Faktor die, die die Route dafür vorsieht — und
   * die Route hört auf.
   */
  async function einrichtendeSitzung(
    request: FastifyRequest,
    reply: FastifyReply,
    wennAktiv: (reply: FastifyReply) => FastifyReply,
  ): Promise<Sitzung | undefined> {
    const sitzung = await sitzungHolen(request);
    if (!sitzung) {
      void reply.redirect(ANMELDEN_PFAD, 303);
      return undefined;
    }
    if (await zweiterFaktorAktiv(pool, sitzung.user.id)) {
      wennAktiv(reply);
      return undefined;
    }
    return sitzung;
  }

  function nichtErreichbar(reply: FastifyReply): FastifyReply {
    return reply
      .header('cache-control', 'no-store')
      .code(403)
      .send({ fehler: 'Der zweite Faktor ist bereits eingerichtet.' });
  }

  function jsonFehler(reply: FastifyReply, meldung: string): FastifyReply {
    return reply.header('cache-control', 'no-store').code(400).send({ fehler: meldung });
  }

  skriptAusliefern(app, `${PASSKEY_PFAD}/skript.js`, skript);

  app.post(
    `${PASSKEY_PFAD}/optionen`,
    async (request: FastifyRequest<{ Body: PasswortFormular | undefined }>, reply) => {
      const sitzung = await einrichtendeSitzung(request, reply, nichtErreichbar);
      if (!sitzung) {
        return reply;
      }
      const passwort = text(request.body?.passwort);
      if (passwort.length === 0) {
        return jsonFehler(reply, 'Bitte das Passwort eingeben.');
      }
      try {
        // Im Prozess, kein HTTP-Pfad: dieselbe Passwortprüfung, die Better Auth für die
        // TOTP-Einrichtung verlangt. Ohne sie könnte eine gestohlene Sitzung ohne Faktor
        // einen eigenen Passkey als ersten Faktor eintragen.
        await auth.api.verifyPassword({
          body: { password: passwort },
          headers: fromNodeHeaders(request.headers),
        });
      } catch (fehler) {
        // Nur die Meldung, nie das Fehlerobjekt: die Anfrage trug ein Passwort.
        request.log.warn(
          { grund: fehler instanceof Error ? fehler.message : 'unbekannt' },
          'Passkey: Passwort abgelehnt',
        );
        return jsonFehler(reply, 'Das Passwort ist nicht korrekt.');
      }
      const optionen = await registrierungBeginnen(
        pool,
        konfiguration,
        { id: sitzung.user.id, email: sitzung.user.email },
        jetzt(),
      );
      return reply.header('cache-control', 'no-store').send(optionen);
    },
  );

  app.post(
    `${PASSKEY_PFAD}/pruefen`,
    async (request: FastifyRequest<{ Body: PruefFormular | undefined }>, reply) => {
      const sitzung = await einrichtendeSitzung(request, reply, (antwort) =>
        antwort.redirect('/', 303),
      );
      if (!sitzung) {
        return reply;
      }

      async function fehlerSeite(): Promise<void> {
        const html = await app.render('zwei-faktor.eta', {
          titel: 'Zweiten Faktor einrichten',
          fehler: FEHLER_EINRICHTUNG,
          passkeyAngeboten: true,
        });
        reply.header('cache-control', 'no-store');
        await htmlSenden(reply, html, 400);
      }

      const antwort = registrierungsAntwortLesen(text(request.body?.antwort));
      if (antwort === undefined) {
        return fehlerSeite();
      }
      const ergebnis = await registrierungAbschliessen(
        pool,
        konfiguration,
        sitzung.user.id,
        antwort,
        text(request.body?.name),
        jetzt(),
      );
      if (!ergebnis.ok) {
        if (ergebnis.grund === 'schon_aktiv') {
          return reply.redirect('/', 303);
        }
        // Der Grund steht im Log, nie in der Antwort: die Meldung soll keinem
        // erzählen, woran eine gefälschte Antwort gescheitert ist.
        request.log.warn({ grund: ergebnis.grund }, 'Passkey: Registrierung abgelehnt');
        return fehlerSeite();
      }

      const html = await app.render('passkey-fertig.eta', {
        titel: 'Passkey eingerichtet',
        ersatzcodes: ergebnis.ersatzcodes,
      });
      // Die Seite trägt die Ersatzcodes, die es nur ein einziges Mal gibt.
      reply.header('cache-control', 'no-store');
      return htmlSenden(reply, html);
    },
  );
}
