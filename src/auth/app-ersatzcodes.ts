/**
 * Die Ersatzcodes der Authenticator-App entwerten (COPI-94).
 *
 * Ersatzcodes gibt es in zwei Tabellen: die von Better Auth (verschlüsselt in `twoFactor.backupCodes`, entstehen mit
 * TOTP) und die eigenen (`cockpit.ersatzcode`, COPI-26). „Neu erzeugen" auf `/sicherheit` schreibt nur noch eigene
 * und muss dafür die von Better Auth ungültig machen — sonst gälten die alten weiter, denn die Anmeldung prüft beide.
 * Better Auth bietet das nur mit Passwort (`generateBackupCodes`); dieses Plugin schreibt eine leere Liste, so
 * verschlüsselt, wie Better Auth sie selbst ablegt (`storeBackupCodes: "encrypted"`, der Standard).
 *
 * **Nur im Prozess erreichbar** (`createAuthEndpoint.serverOnly`, wie `sitzung-anlegen.ts`): kein HTTP-Pfad. Der
 * Endpunkt nimmt einem Konto Codes, er gibt keinem eine; ein Aufrufer muss trotzdem die frische Bestätigung
 * geprüft haben (`routes/sicherheit.ts`).
 */
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { symmetricEncrypt } from 'better-auth/crypto';
import * as z from 'zod';

export function appErsatzcodesPlugin() {
  return {
    id: 'cockpit-app-ersatzcodes',
    endpoints: {
      appErsatzcodesEntwerten: createAuthEndpoint.serverOnly(
        { method: 'POST', body: z.object({ benutzerId: z.string().min(1) }) },
        async (ctx) => {
          const leer = await symmetricEncrypt({ key: ctx.context.secretConfig, data: JSON.stringify([]) });
          await ctx.context.adapter.update({
            model: 'twoFactor',
            where: [{ field: 'userId', value: ctx.body.benutzerId }],
            update: { backupCodes: leer },
          });
          return ctx.json({ ok: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
