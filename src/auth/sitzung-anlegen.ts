/**
 * Die Sitzung nach einem zweiten Faktor, den Better Auth nicht kennt (COPI-27).
 *
 * Better Auth legt die Sitzung im Codeschritt selbst an — aber nur nach TOTP oder
 * Ersatzcode, gegen seinen signierten `two_factor`-Cookie. Ein Passkey und ein
 * Ersatzcode aus `cockpit.ersatzcode` (COPI-26) sind ihm fremd. Nach einem solchen
 * Nachweis, den die Anwendung selbst geprüft hat, braucht sie trotzdem eine ganz
 * normale Sitzung: derselbe Cookie, dieselben Attribute, dieselbe Tabelle. Dieses
 * Plugin macht genau das und nichts sonst — es ruft Better Auths eigene Bausteine
 * (`internalAdapter.createSession`, `setSessionCookie`), statt Sitzung und Cookie
 * nachzubauen.
 *
 * **Der Endpunkt ist nur im Prozess erreichbar** (`createAuthEndpoint.serverOnly`, setzt
 * `metadata.SERVER_ONLY`; so definiert Better Auth auch `generateTOTP`): Better Calls
 * Router nimmt ihn nicht auf, es gibt keinen HTTP-Pfad. Das ist Absicht und
 * kein Detail — er legt für **jedes** Konto ohne weitere Prüfung eine Sitzung an. Wer
 * ihn aufruft, trägt die Verantwortung, dass der Nachweis geprüft ist; heute ist das
 * allein `routes/anmelden.ts` (`test/sitzung-anlegen.test.ts` prüft das per Quelltext-
 * Scan). Ein neuer Aufrufer ist ein Review-Thema.
 */
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { expireCookie, setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';

/** Name des Cookies, den Better Auth zwischen Passwort und Code setzt (`two_factor`). */
const ZWEI_FAKTOR_COOKIE = 'two_factor';

export function sitzungAnlegenPlugin() {
  return {
    id: 'cockpit-sitzung-anlegen',
    endpoints: {
      sitzungNachZweitemFaktor: createAuthEndpoint.serverOnly(
        { method: 'POST', body: z.object({ benutzerId: z.string().min(1) }) },
        async (ctx) => {
          const benutzer = await ctx.context.internalAdapter.findUserById(ctx.body.benutzerId);
          if (!benutzer) {
            throw ctx.error('UNAUTHORIZED', { message: 'Konto nicht gefunden' });
          }
          const sitzung = await ctx.context.internalAdapter.createSession(benutzer.id, false);
          await setSessionCookie(ctx, { session: sitzung, user: benutzer });
          // Der Cookie zwischen den Schritten hat damit ausgedient (bei einem Konto mit
          // TOTP hat Better Auth ihn gesetzt; ohne TOTP gibt es ihn nicht, das schadet nicht).
          expireCookie(ctx, ctx.context.createAuthCookie(ZWEI_FAKTOR_COOKIE));
          return ctx.json({ ok: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
