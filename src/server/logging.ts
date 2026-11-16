/**
 * Der Log der Anwendung (COPI-28): Token im Pfad gehören nicht hinein.
 *
 * `/erststart/<token>`, `/einladung/<token>` und `/zugang-wiederherstellen/<token>`
 * tragen ein Einmal-Token im Pfad. Fastify schreibt die Adresse jeder Anfrage in den
 * Log; wer ihn liest — auf dem Server, in einem Log-Sammler, in einem Support-Ausschnitt —
 * hätte sonst ein gültiges Token (Erststart 24 Stunden, sonst 3). Deshalb geht die
 * Adresse nur maskiert hinein: nach dem Präfix steht `<token>`.
 *
 * Maskiert wird lieber zu viel als zu wenig, wie beim Tor (`pfadVarianten`): auch andere
 * Schreibweisen, die noch zur Route führen könnten (Groß-/Kleinschreibung,
 * Prozent-Kodierung, doppelte Schrägstriche, `..`), und der ganze Rest des Pfades samt
 * Abfrage. Passwörter stehen nie im Log: Fastify loggt keine Rümpfe, und die Routen
 * loggen nur Meldungen, nie Eingaben.
 */
import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import type { CockpitEnv } from './env.js';

/** Pfade, hinter denen ein Token folgt. */
const TOKEN_PRAEFIX = /^\/(erststart|einladung|zugang-wiederherstellen)\/[^/]/;

/**
 * Die Agenten-API (COPI-35). Ihr Token steht nur in der `Authorization`-Kopfzeile, die Fastify nicht
 * loggt — aber die Adresse samt Abfrage geht in den Log. Hängt ein Client das Token versehentlich an
 * (`?token=…`), stünde es dort. Unter `/intern` geht deshalb nur der Pfad hinein.
 */
const INTERN_PRAEFIX = /^\/intern(\/|$)/;

/** Alle Schreibweisen, in denen der Pfad noch auf ein Token-Präfix zeigen könnte. */
function pfadKandidaten(pfad: string): string[] {
  const kompakt = pfad.replace(/\/{2,}/g, '/');
  const kandidaten = new Set([kompakt.toLowerCase()]);
  try {
    kandidaten.add(new URL(decodeURIComponent(kompakt), 'http://cockpit.invalid').pathname.toLowerCase());
  } catch {
    // Ungültige Kodierung — die rohe Schreibweise genügt.
  }
  return [...kandidaten];
}

/** Die Adresse, wie sie in den Log darf: mit maskiertem Token, sonst unverändert. */
export function urlOhneToken(url: string): string {
  const pfad = url.split('?')[0] ?? '';
  for (const kandidat of pfadKandidaten(pfad)) {
    const treffer = TOKEN_PRAEFIX.exec(kandidat);
    if (treffer) {
      return `/${treffer[1] ?? ''}/<token>`;
    }
    if (INTERN_PRAEFIX.test(kandidat)) {
      return pfad;
    }
  }
  return url;
}

/** Wie Fastifys eigene Darstellung einer Anfrage, nur mit maskierter Adresse. */
function anfrageDarstellen(request: FastifyRequest) {
  return {
    method: request.method,
    url: urlOhneToken(request.url),
    host: request.headers.host ?? '',
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort ?? 0,
  };
}

/**
 * Die Logger-Einstellung für Fastify. In Tests aus, außer ein Test reicht einen Strom herein
 * und prüft, was hineingeschrieben wird (`logStrom`).
 */
export function loggerEinstellung(
  nodeEnv: CockpitEnv['nodeEnv'],
  logStrom?: NodeJS.WritableStream,
): NonNullable<FastifyServerOptions['logger']> {
  const serializers = { req: anfrageDarstellen };
  if (logStrom) {
    return { level: 'info', stream: logStrom, serializers };
  }
  return nodeEnv === 'test' ? false : { serializers };
}
