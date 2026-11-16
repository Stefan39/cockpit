/**
 * Web Push für den Chat (COPI-59, ADR 2/6: Web Push mit VAPID, kein eigener Push-Server, ntfy verworfen).
 *
 *   * **Schlüssel:** das VAPID-Paar erzeugt `vapid-erzeugen` (CLI) einmal; es steht in der Umgebung der Instanz
 *     (`COCKPIT_VAPID_PUBLIC_KEY`, `COCKPIT_VAPID_PRIVATE_KEY`, Zugangsdatenblatt), nie in der Datenbank — so steht
 *     der private Schlüssel in keinem Dump. Beide oder keiner; ohne sie gibt es auf der Instanz keinen Push.
 *   * **Wann:** bei jeder Antwort des Koordinators und bei jeder dringenden Nachricht, an den Besitzer des Kanals —
 *     sofort. Neue Einträge im Posteingang meldet seit COPI-116 der Takt in `posteingang/push.ts`.
 *   * **Was:** nur ein kurzer Hinweis und der Weg zu `/chat` — **nie der Text der Nachricht**. Der Push-Dienst
 *     (Google, Apple, Mozilla) sieht nichts vom Inhalt, und auf einem gesperrten Bildschirm steht nichts Vertrauliches.
 *   * **Abgelaufene Abos** (404/410) werden abgemeldet, nicht gelöscht. Ins Log kommt nur der Host des Dienstes, nie
 *     der Endpoint: er ist die Adresse eines Geräts.
 *
 * Verschlüsselung (RFC 8291) und Signatur (RFC 8292) übernimmt `web-push`, statt sie hier nachzubauen.
 */
import webpush from 'web-push';
import type pg from 'pg';
import type { ChatEreignisse } from './ereignisse.js';
import type { Nachricht } from './nachricht-speicher.js';
import { aboErreicht, aboUngueltig, aktiveAbos } from './push-speicher.js';

export interface PushKonfiguration {
  readonly oeffentlich: string;
  readonly privat: string;
  /** `mailto:` oder `https:` — wie der Push-Dienst den Absender erreicht (RFC 8292). */
  readonly kontakt: string;
}

export interface PushUmgebung {
  readonly vapidOeffentlich: string | undefined;
  readonly vapidPrivat: string | undefined;
  readonly vapidKontakt: string | undefined;
}

/** Ein öffentlicher VAPID-Schlüssel: 65 Byte (P-256, unkomprimiert), base64url ohne Auffüllung. */
const OEFFENTLICH = /^[A-Za-z0-9_-]{87}$/;
/** Ein privater: 32 Byte. */
const PRIVAT = /^[A-Za-z0-9_-]{43}$/;

/**
 * Die Konfiguration aus der Umgebung. Ohne beide Schlüssel kein Push (`undefined`). Nur einer, ein Schlüssel in falscher
 * Form oder ein Kontakt ohne `mailto:`/`https:` halten den Start an. Ohne Kontakt gilt die Adresse des Cockpits, wenn
 * sie `https` ist, sonst eine lokale.
 */
export function pushAusUmgebung(umgebung: PushUmgebung, basisUrl: string | undefined): PushKonfiguration | undefined {
  const oeffentlich = umgebung.vapidOeffentlich?.trim() ?? '';
  const privat = umgebung.vapidPrivat?.trim() ?? '';
  if (oeffentlich === '' && privat === '') {
    return undefined;
  }
  if (oeffentlich === '' || privat === '') {
    throw new Error('COCKPIT_VAPID_PUBLIC_KEY und COCKPIT_VAPID_PRIVATE_KEY gehören zusammen: bitte beide setzen oder keinen.');
  }
  if (!OEFFENTLICH.test(oeffentlich) || !PRIVAT.test(privat)) {
    throw new Error('Die VAPID-Schlüssel haben nicht die Form, die `vapid-erzeugen` ausgibt.');
  }
  const kontakt = umgebung.vapidKontakt?.trim() || (basisUrl?.startsWith('https://') ? basisUrl : 'mailto:cockpit@localhost');
  if (!/^(mailto:|https:\/\/)/.test(kontakt)) {
    throw new Error('COCKPIT_VAPID_KONTAKT muss mit mailto: oder https:// beginnen.');
  }
  return { oeffentlich, privat, kontakt };
}

/** Ein neues VAPID-Paar für `vapid-erzeugen`. */
export function vapidErzeugen(): { readonly oeffentlich: string; readonly privat: string } {
  const paar = webpush.generateVAPIDKeys();
  return { oeffentlich: paar.publicKey, privat: paar.privateKey };
}

/** Schickt eine Nachricht an ein Abo; wirft bei einer Antwort außer 2xx einen Fehler mit `statusCode`. */
export type Versender = (
  abo: { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } },
  rumpf: string,
  optionen: webpush.RequestOptions,
) => Promise<unknown>;

export const WEB_PUSH: Versender = (abo, rumpf, optionen) =>
  webpush.sendNotification({ endpoint: abo.endpoint, keys: { p256dh: abo.keys.p256dh, auth: abo.keys.auth } }, rumpf, optionen);

/** Wie lange ein Push-Dienst eine Nachricht aufhebt, wenn das Gerät gerade nicht erreichbar ist. */
export const LEBENSDAUER_SEKUNDEN = 24 * 60 * 60;

/** Soll diese Nachricht einen Push auslösen? Antworten des Koordinators und alles Dringende. */
export function loestPushAus(nachricht: Nachricht): boolean {
  return nachricht.absenderArt === 'agent' || nachricht.dringend;
}

/** Der Rumpf eines Push: nur ein Hinweis — nie der Text der Nachricht. Die Adresse steht im Service Worker fest. */
export function pushRumpf(nachricht: Nachricht): string {
  return JSON.stringify({
    titel: 'Cockpit',
    text: nachricht.dringend ? 'Dringende Nachricht im Chat' : 'Neue Antwort des Assistenten',
    ziel: 'chat',
  });
}

/** Wie das Gerät in der Liste heißt: abgeleitet aus dem Push-Dienst, ohne dass dafür etwas gespeichert wird. */
export function geraetName(endpoint: string): string {
  let host: string;
  try {
    host = new URL(endpoint).host;
  } catch {
    return 'Unbekanntes Gerät';
  }
  if (host.endsWith('push.apple.com')) {
    return 'iPhone, iPad oder Mac (Safari)';
  }
  if (host.endsWith('googleapis.com')) {
    return 'Chrome, Edge oder Android';
  }
  if (host.endsWith('mozilla.com')) {
    return 'Firefox';
  }
  if (host.endsWith('notify.windows.com')) {
    return 'Windows';
  }
  return 'Anderer Browser';
}

function hostVon(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unbekannt';
  }
}

function statusVon(fehler: unknown): number | undefined {
  return typeof fehler === 'object' && fehler !== null && 'statusCode' in fehler && typeof fehler.statusCode === 'number'
    ? fehler.statusCode
    : undefined;
}

export interface PushLog {
  warn(objekt: object, meldung: string): void;
}

/** Was eine Zustellung braucht. */
export interface ZustellAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly konfiguration: PushKonfiguration;
  readonly versender: Versender;
  readonly log: PushLog;
}

/** Der Besitzer eines Assistenten-Kanals — nur ihm gilt der Push einer Nachricht dort. */
export async function kanalBesitzer(pool: pg.Pool, kanalId: number): Promise<string | undefined> {
  const besitzer = await pool.query<{ besitzer_id: string }>(`SELECT besitzer_id FROM cockpit.kanal WHERE id = $1 AND art = 'assistent'`, [kanalId]);
  return besitzer.rows[0]?.besitzer_id;
}

/**
 * Stellt den Push zu einer Nachricht zu: an jedes aktive Abo des Kanalbesitzers. Wirft nie; jedes Abo für sich.
 * Liefert, wie viele Geräte der Dienst angenommen hat (für Tests und Log).
 */
export async function pushZustellen(
  pool: pg.Pool,
  konfiguration: PushKonfiguration,
  nachricht: Nachricht,
  versender: Versender,
  log: PushLog,
): Promise<number> {
  if (!loestPushAus(nachricht)) {
    return 0;
  }
  const benutzerId = await kanalBesitzer(pool, nachricht.kanalId);
  if (benutzerId === undefined) {
    return 0;
  }
  return anAbosZustellen({ pool, konfiguration, versender, log }, benutzerId, pushRumpf(nachricht), nachricht.dringend ? 'high' : 'normal');
}

/**
 * Ein Rumpf an jedes aktive Abo eines Kontos (COPI-59; seit COPI-116 auch für den Posteingang und den Test-Push). Wirft
 * nie; jedes Abo für sich, abgelaufene (404/410) werden abgemeldet. Liefert, wie viele Geräte der Dienst angenommen hat.
 */
export async function anAbosZustellen(
  abhaengigkeiten: ZustellAbhaengigkeiten,
  benutzerId: string,
  rumpf: string,
  urgency: 'high' | 'normal',
): Promise<number> {
  const { pool, konfiguration, versender, log } = abhaengigkeiten;
  let angenommen = 0;
  for (const abo of await aktiveAbos(pool, benutzerId)) {
    try {
      await versender({ endpoint: abo.endpoint, keys: { p256dh: abo.p256dh, auth: abo.auth } }, rumpf, {
        vapidDetails: { subject: konfiguration.kontakt, publicKey: konfiguration.oeffentlich, privateKey: konfiguration.privat },
        TTL: LEBENSDAUER_SEKUNDEN,
        urgency,
        timeout: 5000,
      });
      await aboErreicht(pool, abo.id);
      angenommen++;
    } catch (fehler) {
      const status = statusVon(fehler);
      if (status === 404 || status === 410) {
        await aboUngueltig(pool, abo.id);
      } else {
        log.warn({ dienst: hostVon(abo.endpoint), status: status ?? 'netz' }, 'Push nicht zugestellt');
      }
    }
  }
  return angenommen;
}

/** Hängt die Zustellung an den Verteiler: jede neue Nachricht, die einen Push auslöst, geht an die Geräte. */
export function pushAnhaengen(
  ereignisse: ChatEreignisse,
  pool: pg.Pool,
  konfiguration: PushKonfiguration,
  versender: Versender,
  log: PushLog & { error(objekt: object, meldung: string): void },
  /** Nach einem zugestellten Push, mit der Nachricht (COPI-116: den Stand des Posteingangs festhalten). */
  nachher?: (nachricht: Nachricht) => Promise<void>,
): () => void {
  return ereignisse.abonnieren((nachricht) => {
    if (!loestPushAus(nachricht)) {
      return;
    }
    pushZustellen(pool, konfiguration, nachricht, versender, log)
      .then(async (angenommen) => {
        if (angenommen > 0 && nachher !== undefined) {
          await nachher(nachricht);
        }
      })
      .catch((fehler: unknown) => {
        log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Push: Zustellung gescheitert');
      });
  });
}
