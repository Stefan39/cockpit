/**
 * Der Schalter „Dark Mode" (COPI-43, Prototyp) — ohne Skript, damit eine strenge Content-Security-Policy möglich
 * bleibt.
 *
 *   * `POST /darstellung` (ein Formular mit `darstellung` = `hell` | `dunkel` und `zurueck`) merkt sich die Wahl ein
 *     Jahr lang in einem Cookie und kehrt zur Seite zurück. `darstellung` = `auto` („Wie System", COPI-117) vergisst
 *     die Wahl wieder (das Cookie läuft sofort ab): ohne diesen Weg wäre die Seite nach einem Klick ein Jahr fest.
 *   * Ein `onSend`-Haken setzt die Wahl als `data-theme` auf `<html>` jeder HTML-Seite; die Farben wählt dann das CSS
 *     (`color-scheme`, `light-dark()`, `assets/css/input.css`). Ohne Wahl folgt die Seite dem Gerät.
 *
 * Die Wahl hängt am Browser, nicht am Konto — sie ist kein Geheimnis und kein Recht. Das Cookie ist trotzdem
 * host-only (`__Host-`), `HttpOnly` (kein Skript liest es) und `SameSite=Lax`. In die Seite kommt nie der rohe Wert,
 * nur einer der beiden bekannten. Das Rücksprungziel hat eine feste Form (eine eigene Seite ohne Anfrage), sonst geht
 * es zur Übersicht: das Formular kann nirgendwohin weiterleiten.
 */
import type { FastifyInstance } from 'fastify';

export const DARSTELLUNG_COOKIE = '__Host-darstellung';

export const DARSTELLUNGEN = ['hell', 'dunkel'] as const;

export type Darstellung = (typeof DARSTELLUNGEN)[number];

/** „Wie System": keine eigene Wahl, die Seite folgt dem Gerät (COPI-117). Wird nie gespeichert, nur vergessen. */
const WIE_SYSTEM = 'auto';

const EIN_JAHR_SEKUNDEN = 365 * 86_400;

/** Eine eigene Seite: `/` oder `/<kleinbuchstaben-und-bindestriche>`, ohne Anfrage und ohne Pfadtricks. */
const EIGENE_SEITE = /^\/(?:[a-z-]+)?$/;

function istDarstellung(wert: unknown): wert is Darstellung {
  return typeof wert === 'string' && (DARSTELLUNGEN as readonly string[]).includes(wert);
}

/** Die Wahl aus dem Cookie-Kopf; alles andere als ein bekannter Wert ist keine Wahl. */
export function darstellungAusCookie(kopf: string | undefined): Darstellung | undefined {
  for (const teil of (kopf ?? '').split(';')) {
    const gleich = teil.indexOf('=');
    if (gleich > 0 && teil.slice(0, gleich).trim() === DARSTELLUNG_COOKIE) {
      const wert = teil.slice(gleich + 1).trim();
      return istDarstellung(wert) ? wert : undefined;
    }
  }
  return undefined;
}

/** Wohin der Schalter zurückkehrt: eine eigene Seite, sonst die Übersicht. */
export function zurueckPfad(wert: unknown): string {
  return typeof wert === 'string' && EIGENE_SEITE.test(wert) ? wert : '/';
}

/**
 * Der Haken, der die Wahl in jede HTML-Seite schreibt. Er muss **vor** `@fastify/etag` hängen, damit das ETag die
 * Seite mit `data-theme` beschreibt — sonst bekäme ein Browser nach dem Umschalten ein 304 für die alte.
 */
export function registriereDarstellungsHaken(app: FastifyInstance): void {
  app.addHook('onSend', (request, reply, payload, fertig) => {
    if (typeof payload !== 'string' || !String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      fertig(null, payload);
      return;
    }
    reply.header('vary', 'cookie');
    const darstellung = darstellungAusCookie(request.headers.cookie);
    fertig(null, darstellung === undefined ? payload : payload.replace('<html lang="de">', `<html lang="de" data-theme="${darstellung}">`));
  });
}

interface SchalterFormular {
  readonly darstellung?: unknown;
  readonly zurueck?: unknown;
}

function darstellungsCookie(wert: string, maxAlter: number): string {
  return `${DARSTELLUNG_COOKIE}=${wert}; Max-Age=${String(maxAlter)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function registriereDarstellungsRoute(app: FastifyInstance): void {
  app.post<{ Body: SchalterFormular | undefined }>('/darstellung', async (request, reply) => {
    const darstellung = request.body?.darstellung;
    if (istDarstellung(darstellung)) {
      reply.header('set-cookie', darstellungsCookie(darstellung, EIN_JAHR_SEKUNDEN));
    } else if (darstellung === WIE_SYSTEM) {
      reply.header('set-cookie', darstellungsCookie('', 0));
    }
    return reply.redirect(zurueckPfad(request.body?.zurueck), 303);
  });
}
