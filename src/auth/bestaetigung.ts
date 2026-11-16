/**
 * Die signierte Bestätigung einer Aktion aus zwei Schritten (COPI-40, allgemein seit COPI-46) — reine Funktionen, der
 * Zeitpunkt ist ein Parameter.
 *
 * Eine Aktion mit Folgen (Update beantragen, Konto bearbeiten) geht in zwei Schritten: das erste Formular zeigt eine
 * Bestätigungsseite, erst deren Formular führt aus. Die Bestätigungsseite trägt einen HMAC-SHA-256 über den **Zweck**
 * (welche Aktion), den **Inhalt** (wer, woran, mit welchem Wert) und den **Ablauf**:
 *
 *   * ein fremdes Formular kennt ihn nicht (CSRF, zusätzlich zur Herkunftsprüfung);
 *   * ein nachträglich geänderter Wert, ein anderes Konto oder eine andere Aktion passt nicht mehr;
 *   * nach zehn Minuten ist er verfallen, und ein Ablauf, der weiter reicht als die Gültigkeit, gilt nicht.
 *
 * Der Schlüssel lebt nur im Speicher des Prozesses (die Route erzeugt ihn beim Start): nach einem Neustart beginnt man
 * eben neu. Das Format ist unverändert seit COPI-40 — `JSON.stringify([zweck, ...inhalt, bis])` —, damit trennt JSON
 * die Felder, und keines kann in ein anderes „überlaufen".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** So lange gilt eine Bestätigung. */
export const BESTAETIGUNG_GUELTIG_MS = 10 * 60_000;

/** Was das Formular der Bestätigungsseite trägt. */
export interface BestaetigungsFelder {
  readonly bis: string;
  readonly token: string;
}

/** Nur Ziffern: kein Vorzeichen, kein Exponent, nichts, was `Number()` sonst noch gelten ließe. */
const ZEITPUNKT = /^[0-9]{1,15}$/;

/** Ein SHA-256 in Base64url ohne Auffüllung. */
const TOKEN_FORM = /^[A-Za-z0-9_-]{43}$/;

function signieren(schluessel: Uint8Array, zweck: string, inhalt: readonly string[], bis: number): Buffer {
  return createHmac('sha256', schluessel)
    .update(JSON.stringify([zweck, ...inhalt, bis]))
    .digest();
}

export function bestaetigungAusstellen(
  schluessel: Uint8Array,
  zweck: string,
  inhalt: readonly string[],
  jetzt: Date,
): BestaetigungsFelder {
  const bis = jetzt.getTime() + BESTAETIGUNG_GUELTIG_MS;
  return { bis: String(bis), token: signieren(schluessel, zweck, inhalt, bis).toString('base64url') };
}

/** Gilt die Bestätigung aus dem Formular für genau diesen Zweck und Inhalt, jetzt? Alles, was nicht genau passt: nein. */
export function bestaetigungPruefen(
  schluessel: Uint8Array,
  felder: { readonly bis?: unknown; readonly token?: unknown },
  zweck: string,
  inhalt: readonly string[],
  jetzt: Date,
): boolean {
  const { bis, token } = felder;
  if (typeof bis !== 'string' || !ZEITPUNKT.test(bis) || typeof token !== 'string' || !TOKEN_FORM.test(token)) {
    return false;
  }
  const ablauf = Number(bis);
  const rest = ablauf - jetzt.getTime();
  if (rest <= 0 || rest > BESTAETIGUNG_GUELTIG_MS) {
    return false;
  }
  return timingSafeEqual(Buffer.from(token, 'base64url'), signieren(schluessel, zweck, inhalt, ablauf));
}
