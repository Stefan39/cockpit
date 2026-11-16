/**
 * Die frische Bestätigung durch einen vorhandenen Faktor (COPI-94) — reine Funktionen, der Zeitpunkt ist ein Parameter.
 *
 * Wer auf `/sicherheit` einen Faktor hinzufügt, entfernt oder neue Ersatzcodes erzeugt, bestätigt vorher mit einem
 * Faktor, den das Konto schon hat: Passkey, Code der Authenticator-App oder Ersatzcode — nie mit dem Passwort allein.
 * Eine gestohlene Sitzung (samt Passwort) reicht so nicht, um sich einen eigenen Faktor einzurichten.
 *
 * Die Bestätigung ist ein Cookie mit einem HMAC aus `bestaetigung.ts` (Zweck `faktor-bestaetigt`): er bindet sie an
 * **diese Sitzung** (deren ID), das Konto und den Faktor und läuft nach zehn Minuten ab. Eine andere Sitzung, ein
 * anderes Konto oder ein geänderter Wert passen nicht. Der Schlüssel lebt nur im Prozess (Neustart: neu bestätigen).
 * Das Cookie ist `__Host-` (host-only, `Secure`, `Path=/`), `HttpOnly` und `SameSite=Strict`: es geht nie mit einer
 * Anfrage von einer anderen Seite mit, auch nicht von einer Nachbar-Subdomain.
 *
 * Was es nicht ersetzt: die Herkunftsprüfung jedes Formulars und die Regeln in `faktoren.ts` (nie der letzte Faktor).
 */
import { bestaetigungAusstellen, bestaetigungPruefen, BESTAETIGUNG_GUELTIG_MS } from './bestaetigung.js';

export const FAKTOR_BESTAETIGT_COOKIE = '__Host-faktor-bestaetigt';

const ZWECK = 'faktor-bestaetigt';

export const BESTAETIGTE_FAKTOREN = ['passkey', 'totp', 'ersatzcode'] as const;

export type BestaetigterFaktor = (typeof BESTAETIGTE_FAKTOREN)[number];

export interface Bestaetigung {
  readonly faktor: BestaetigterFaktor;
  /** Bis wann Änderungen ohne neue Bestätigung möglich sind. */
  readonly bis: Date;
}

/** Wessen Bestätigung: die Sitzung und ihr Konto. */
export interface Sitzungsbezug {
  readonly sitzungId: string;
  readonly benutzerId: string;
}

function istFaktor(wert: string): wert is BestaetigterFaktor {
  return (BESTAETIGTE_FAKTOREN as readonly string[]).includes(wert);
}

function cookieZeile(wert: string, maxAlterSekunden: number): string {
  return `${FAKTOR_BESTAETIGT_COOKIE}=${wert}; Max-Age=${String(maxAlterSekunden)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/** Die `set-cookie`-Zeile nach einer gelungenen Bestätigung. */
export function bestaetigungsCookie(
  schluessel: Uint8Array,
  bezug: Sitzungsbezug,
  faktor: BestaetigterFaktor,
  jetzt: Date,
): string {
  const { bis, token } = bestaetigungAusstellen(schluessel, ZWECK, [bezug.sitzungId, bezug.benutzerId, faktor], jetzt);
  return cookieZeile(`${faktor}.${bis}.${token}`, BESTAETIGUNG_GUELTIG_MS / 1000);
}

/** Die Bestätigung aus dem Cookie-Kopf, wenn sie für diese Sitzung und dieses Konto jetzt gilt; sonst `undefined`. */
export function bestaetigungLesen(
  schluessel: Uint8Array,
  cookieKopf: string | undefined,
  bezug: Sitzungsbezug,
  jetzt: Date,
): Bestaetigung | undefined {
  for (const teil of (cookieKopf ?? '').split(';')) {
    const gleich = teil.indexOf('=');
    if (gleich > 0 && teil.slice(0, gleich).trim() === FAKTOR_BESTAETIGT_COOKIE) {
      const [faktor, bis, token, ...rest] = teil.slice(gleich + 1).trim().split('.');
      if (faktor === undefined || !istFaktor(faktor) || rest.length > 0) {
        return undefined;
      }
      const gilt = bestaetigungPruefen(schluessel, { bis, token }, ZWECK, [bezug.sitzungId, bezug.benutzerId, faktor], jetzt);
      return gilt ? { faktor, bis: new Date(Number(bis)) } : undefined;
    }
  }
  return undefined;
}
