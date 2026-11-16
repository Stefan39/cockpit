/**
 * Client-IP hinter dem Proxy (COPI-13).
 *
 * Betriebsannahme aus `docker/compose.fragment.yaml`: der Cockpit-Dienst hat
 * **keinen** `ports`-Eintrag und ist ausschließlich über Caddy erreichbar
 * (`docker/Caddyfile.fragment`, `reverse_proxy cockpit:3000`). Caddy setzt
 * `X-Forwarded-For` selbst. Gemessen (Caddy 2.11.4, einfaches `reverse_proxy`):
 * ein vom Client mitgeschickter Wert wird **ersetzt**, hier kommt nur die
 * Adresse der Gegenstelle an. Mit `trusted_proxies` hängte Caddy sie stattdessen
 * **rechts** an. Deshalb gilt in beiden Fällen:
 *
 *   **Vertrauenswürdig ist genau der rechte Eintrag** — alles links davon hat
 *   der Client selbst geschrieben.
 *
 * Genau deshalb wird `trustProxy` in Fastify **nicht** eingeschaltet:
 * `request.ip` liefert dann den linken, also vom Client gewählten Wert. Ohne
 * `trustProxy` liefert `request.ip` die Adresse des Proxys — dann teilen sich
 * alle Nutzer einen IP-Zähler, und ein einzelner Angreifer sperrt die ganze
 * Instanz aus. Beides ist falsch; darum diese eigene, geprüfte Auswertung.
 *
 * Better Auth bekommt dieselbe Adresse: ein Haken setzt sie als interne
 * Kopfzeile `x-cockpit-client-ip`, und `advanced.ipAddress.ipAddressHeaders`
 * in `konfiguration.ts` liest genau diese. Eine von außen mitgeschickte
 * Kopfzeile dieses Namens wird dabei überschrieben, nie ergänzt.
 *
 * Grenze der Annahme: wird das Cockpit einmal ohne Proxy direkt ins Netz
 * gestellt, kann ein Client sich mit einem selbst gesetzten `X-Forwarded-For`
 * beliebige IP-Kennungen verschaffen und den IP-Zähler umgehen. Der Zähler je
 * E-Mail-Adresse greift davon unabhängig weiter; er ist die eigentliche Grenze.
 */
import type { FastifyInstance } from 'fastify';

/** Kopfzeile, die der Proxy setzt. */
export const WEITERGELEITET_KOPF = 'x-forwarded-for';

/** Interne Kopfzeile mit der ermittelten Adresse — nur prozessintern gesetzt. */
export const CLIENT_IP_KOPF = 'x-cockpit-client-ip';

/**
 * Kennung, wenn sich keine Adresse ermitteln lässt. Bewusst ein fester Wert
 * statt „nicht zählen": alle unbekannten Herkünfte teilen dann einen Zähler,
 * statt gar nicht begrenzt zu werden.
 */
export const IP_UNBEKANNT = 'unbekannt';

export function clientIpErmitteln(
  weitergeleitet: string | undefined,
  entfernteAdresse: string | undefined,
): string {
  const eintraege = (weitergeleitet ?? '')
    .split(',')
    .map((eintrag) => eintrag.trim())
    .filter((eintrag) => eintrag.length > 0);
  return eintraege[eintraege.length - 1] ?? entfernteAdresse ?? IP_UNBEKANNT;
}

/**
 * Hängt die Ermittlung als erster Haken ein, damit jede Route und auch die
 * Better-Auth-Endpunkte dieselbe Adresse sehen.
 */
export function registriereClientIp(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, fertig) => {
    const weitergeleitet = request.headers[WEITERGELEITET_KOPF];
    request.headers[CLIENT_IP_KOPF] = clientIpErmitteln(
      typeof weitergeleitet === 'string' ? weitergeleitet : weitergeleitet?.join(','),
      request.socket.remoteAddress,
    );
    fertig();
  });
}
