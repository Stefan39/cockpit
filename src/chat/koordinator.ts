/**
 * Die Weiterleitung an den Koordinator-Agenten (COPI-54, ADR 6): „Cockpit speichert Nachricht, ruft n8n-Webhook,
 * antwortet dem Browser sofort; Antwort kommt asynchron per SSE/Push zurück … Ausbleibende Antwort wird nach Frist
 * sichtbar."
 *
 *   * **Was geht hinaus:** Nachrichten-ID, Kanal, Konto (ID, Rolle, Name), Text, Zeitpunkt. Nie Zugangsdaten, nie
 *     Sitzungsdaten, nie ein Token.
 *   * **Signatur:** HMAC-SHA256 mit dem gemeinsamen Geheimnis über `<zeitpunkt>.<rumpf>`, in `x-cockpit-signatur`
 *     (`sha256=<hex>`), den Zeitpunkt (Unix-Sekunden) in `x-cockpit-zeitpunkt`. So kann n8n Fremdaufrufe und alte
 *     Wiederholungen abweisen. Der Vertrag steht in `docs/koordinator-api.md` (COPI-61).
 *   * **Warten:** Das Cockpit wartet nur auf die Quittung des Webhooks (höchstens `ZEITLIMIT_MS`), nie auf den
 *     Agentenlauf — der dauert oft länger als 30 Sekunden, und das übersteht keine Mobilfunkverbindung.
 *   * **Frist:** Ob eine Antwort ausbleibt, ist eine reine Funktion über den Verlauf (`antwortStand`), berechnet beim
 *     Anzeigen — kein Scheduler, nichts läuft im Hintergrund.
 */
import { createHmac } from 'node:crypto';
import type { Nachricht } from './nachricht-speicher.js';

/** So lange wartet das Cockpit höchstens auf die Quittung des Webhooks. */
export const ZEITLIMIT_MS = 5000;

/** Wie lange eine Antwort ausbleiben darf, bis der Verlauf es sagt — ohne Angabe in der Umgebung. */
export const FRIST_STANDARD_SEKUNDEN = 120;

/** Das gemeinsame Geheimnis muss mindestens so lang sein (wie `BETTER_AUTH_SECRET`). */
export const GEHEIMNIS_MINDESTENS = 32;

export interface KoordinatorKonfiguration {
  readonly url: string;
  readonly geheimnis: string;
  readonly fristMs: number;
}

/** Was aus der Umgebung kommt (`env.ts`). */
export interface KoordinatorUmgebung {
  readonly koordinatorUrl: string | undefined;
  readonly koordinatorGeheimnis: string | undefined;
  readonly koordinatorFristSekunden: number | undefined;
}

/**
 * Die Konfiguration aus der Umgebung. Ohne URL und Geheimnis gibt es keinen Koordinator (`undefined`) — der Chat sagt
 * das dann. Nur eines von beiden, eine URL ohne http(s) oder ein zu kurzes Geheimnis sind ein Fehler beim Start:
 * eine halbe Konfiguration soll auffallen, nicht still einen Chat ohne Antworten liefern.
 */
export function koordinatorAusUmgebung(umgebung: KoordinatorUmgebung): KoordinatorKonfiguration | undefined {
  const url = umgebung.koordinatorUrl?.trim() ?? '';
  const geheimnis = umgebung.koordinatorGeheimnis ?? '';
  if (url === '' && geheimnis === '') {
    return undefined;
  }
  if (url === '' || geheimnis === '') {
    throw new Error('COCKPIT_KOORDINATOR_URL und COCKPIT_KOORDINATOR_SECRET gehören zusammen: bitte beide setzen oder keins.');
  }
  let adresse: URL;
  try {
    adresse = new URL(url);
  } catch {
    throw new Error('COCKPIT_KOORDINATOR_URL ist keine gültige Adresse.');
  }
  if (adresse.protocol !== 'https:' && adresse.protocol !== 'http:') {
    throw new Error('COCKPIT_KOORDINATOR_URL muss mit http:// oder https:// beginnen.');
  }
  if (geheimnis.length < GEHEIMNIS_MINDESTENS) {
    throw new Error(`COCKPIT_KOORDINATOR_SECRET muss mindestens ${String(GEHEIMNIS_MINDESTENS)} Zeichen lang sein.`);
  }
  return { url, geheimnis, fristMs: (umgebung.koordinatorFristSekunden ?? FRIST_STANDARD_SEKUNDEN) * 1000 };
}

/** Die Signatur eines Rumpfs zu einem Zeitpunkt (Unix-Sekunden): `sha256=<hex>`. */
export function signatur(geheimnis: string, zeitpunkt: number, rumpf: string): string {
  return `sha256=${createHmac('sha256', geheimnis).update(`${String(zeitpunkt)}.${rumpf}`).digest('hex')}`;
}

/** Eine Nachricht, wie sie an den Koordinator geht. */
export interface Auftrag {
  readonly nachrichtId: number;
  readonly benutzer: { readonly id: string; readonly rolle: string; readonly name: string | undefined };
  readonly text: string;
  readonly zeitpunkt: Date;
}

export type Weiterleitung =
  | { readonly ok: true }
  | { readonly ok: false; readonly grund: 'zeitlimit' | 'netz' }
  | { readonly ok: false; readonly grund: 'status'; readonly status: number };

/** Der Rumpf, wie er gesendet wird — und wie ihn der Vertrag beschreibt. */
export function rumpfBauen(auftrag: Auftrag): string {
  return JSON.stringify({
    nachricht_id: auftrag.nachrichtId,
    kanal: 'assistent',
    benutzer: { id: auftrag.benutzer.id, rolle: auftrag.benutzer.rolle, name: auftrag.benutzer.name ?? null },
    text: auftrag.text,
    zeitpunkt: auftrag.zeitpunkt.toISOString(),
  });
}

/**
 * Leitet eine Nachricht an den Webhook weiter. Wirft nie: jedes Scheitern kommt als Ergebnis zurück, damit der
 * Aufrufer es im Verlauf sichtbar machen kann. Eine Antwort mit 2xx gilt als angenommen — mehr sagt der Webhook nicht.
 */
export async function weiterleiten(
  konfiguration: KoordinatorKonfiguration,
  auftrag: Auftrag,
  jetzt: Date,
  optionen: { readonly holen?: typeof fetch; readonly zeitlimitMs?: number } = {},
): Promise<Weiterleitung> {
  const holen = optionen.holen ?? fetch;
  const rumpf = rumpfBauen(auftrag);
  const zeitpunkt = Math.floor(jetzt.getTime() / 1000);
  try {
    const antwort = await holen(konfiguration.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cockpit-zeitpunkt': String(zeitpunkt),
        'x-cockpit-signatur': signatur(konfiguration.geheimnis, zeitpunkt, rumpf),
      },
      body: rumpf,
      redirect: 'error',
      signal: AbortSignal.timeout(optionen.zeitlimitMs ?? ZEITLIMIT_MS),
    });
    // Der Rumpf der Quittung interessiert nicht; verworfen wird er trotzdem ausdrücklich, damit die Verbindung frei wird.
    await antwort.body?.cancel();
    return antwort.ok ? { ok: true } : { ok: false, grund: 'status', status: antwort.status };
  } catch (fehler) {
    const zeitlimit = fehler instanceof Error && (fehler.name === 'TimeoutError' || fehler.name === 'AbortError');
    return { ok: false, grund: zeitlimit ? 'zeitlimit' : 'netz' };
  }
}

/** Ob auf die letzte Frage eine Antwort aussteht: noch in der Frist (`wartet`) oder schon darüber (`ueberfaellig`). */
export type AntwortStand = 'wartet' | 'ueberfaellig';

/**
 * Der Stand der Antwort im Assistenten-Kanal, aus der jüngsten Seite des Verlaufs: Ist die letzte Nachricht eine Frage
 * des Menschen, steht die Antwort aus — Koordinator und Cockpit antworten beide mit einer Nachricht danach. Sonst
 * `undefined`.
 */
export function antwortStand(verlauf: readonly Nachricht[], jetzt: Date, fristMs: number): AntwortStand | undefined {
  const letzte = verlauf.at(-1);
  if (letzte?.absenderArt !== 'mensch' || letzte.geloeschtAm !== undefined) {
    return undefined;
  }
  return jetzt.getTime() - letzte.erstelltAm.getTime() < fristMs ? 'wartet' : 'ueberfaellig';
}
