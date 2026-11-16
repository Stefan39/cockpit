/**
 * Sicherheits-Header auf jeder Antwort (COPI-93). Das Cockpit setzt sie selbst, nicht der Proxy: so gelten sie hinter
 * Caddy (Box) genauso wie hinter Traefik (Coolify), und der Proxy-Block bleibt schlank.
 *
 *   * **HSTS** ein Jahr, ohne `includeSubDomains` und ohne `preload`: die Domain ist ein Parameter, und unter der
 *     Hauptdomain laufen andere Dienste, die das Cockpit nicht verbindlich auf HTTPS festlegen darf.
 *   * **CSP** nur eigene Quellen, keine Inline-Skripte und keine Inline-Stile. Die Seiten sind dafür gebaut: der
 *     Dark-Mode-Schalter kommt ohne Skript aus (`darstellung.ts`), das QR-SVG ohne `style` (`qr.ts`), Skripte und
 *     Stylesheet liegen als Dateien vor. Service Worker (`worker-src`) und SSE (`connect-src`) bleiben beim eigenen
 *     Ursprung; den Push-Dienst ruft der Browser selbst, nicht die Seite. `views-csp.test.ts` hält die Views sauber.
 *   * **Download eines Anhangs** (COPI-110): eine eigene, strengere CSP (`DOWNLOAD_CSP`). Setzt eine Route genau diese,
 *     bleibt sie stehen; jede andere CSP einer Route überschreibt der Haken mit der allgemeinen.
 *   * **Permissions-Policy** schaltet Geräte ab, die das Cockpit nie braucht. Passkeys (`publickey-credentials-*`)
 *     stehen nicht darin: ihr Standard ist schon „nur der eigene Ursprung", und ein Merkmal, das ein Browser nicht
 *     kennt, erzeugt dort eine Konsolenwarnung.
 */
import type { FastifyInstance } from 'fastify';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Die CSP eines ausgelieferten Anhangs (COPI-110): öffnet ihn ein Browser doch, läuft darin nichts. */
export const DOWNLOAD_CSP = "sandbox; default-src 'none'";

export const SICHERHEITS_KOPF: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=31536000',
  'content-security-policy': CSP,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/**
 * Hängt die Header an jede Antwort, die über `reply.send` geht — Seiten, API, Fehler, 404 und die Antworten des Tors.
 * `onSend` läuft für jede gesendete Antwort, gleich wo sie entsteht. Wer `reply.hijack()` nutzt (der Chat-Strom), umgeht
 * alle Haken und schreibt `SICHERHEITS_KOPF` deshalb selbst in `writeHead`.
 */
export function registriereSicherheitsHaken(app: FastifyInstance): void {
  app.addHook('onSend', (_request, reply, payload, fertig) => {
    const download = reply.getHeader('content-security-policy') === DOWNLOAD_CSP;
    reply.headers(SICHERHEITS_KOPF);
    if (download) {
      reply.header('content-security-policy', DOWNLOAD_CSP);
    }
    fertig(null, payload);
  });
}
