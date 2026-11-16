/**
 * Push für dieses Gerät an- und abmelden (COPI-59). Das Skript der Einstellungen (`pwa.js`) meldet das Abo des
 * Browsers an; die Liste der Geräte in den Einstellungen entfernt eines ohne Skript.
 *
 *   * `POST /push/abo` — JSON, wie `PushSubscription.toJSON()` es liefert: `endpoint` (https), `keys.p256dh`,
 *     `keys.auth`. Legt das Abo für das angemeldete Konto an (`201`).
 *   * `POST /push/abmelden` — JSON `{ endpoint }`: meldet das eigene Abo dieses Geräts ab (`204`).
 *   * `POST /push/geraete/:id/entfernen` — Formular der Geräteliste: meldet ein eigenes Abo ab, zurück zu den
 *     Einstellungen (`303`). Ein fremdes oder unbekanntes: dieselbe neutrale 404.
 *   * `POST /push/test` — Formular der Einstellungen (COPI-116): ein Test-Push an alle eigenen Geräte, zurück zu den
 *     Einstellungen mit dem Ergebnis (`?push=test` oder `?push=test-fehler`). Höchstens einer je Konto und 30 Sekunden.
 *
 * **Wer:** Recht `chat_nutzen` (Push gibt es für den Chat) und Push auf der Instanz eingerichtet; sonst die neutrale 404.
 * **CSRF:** Herkunft Pflicht (`herkunftBelegt`). Die JSON-Routen nehmen dazu nur `application/json` an — das schickt
 * kein fremdes Formular ohne Vorabanfrage.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import * as z from 'zod';
import { hatRecht, type ZugangLesen } from '../../auth/berechtigung.js';
import { anAbosZustellen, type ZustellAbhaengigkeiten } from '../../chat/push.js';
import { aboAbmelden, aboSpeichern } from '../../chat/push-speicher.js';
import { EINSTELLUNGEN_PFAD } from './einstellungen.js';
import { kontoMitHerkunft } from './konto-pruefen.js';
import { nichtGefunden } from './neutral.js';

export interface PushRoutenAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly zugangLesen: ZugangLesen;
  /** Hat die Instanz ein VAPID-Paar? Ohne es antworten die Routen mit der neutralen 404. */
  readonly eingerichtet: boolean;
  /** Für den Test-Push (COPI-116); nur mit VAPID-Paar. */
  readonly zustellung?: ZustellAbhaengigkeiten;
}

/** Der Rumpf des Test-Push: wie jeder andere nur ein Hinweis. */
export const TEST_RUMPF = JSON.stringify({ titel: 'Cockpit', text: 'Test-Push: Benachrichtigungen kommen auf diesem Gerät an.', ziel: 'posteingang' });

/** Abstand zwischen zwei Test-Pushes eines Kontos. */
export const TEST_ABSTAND_MS = 30_000;

/** Wie die Datenbank es verlangt (`push_abo_endpoint_https`, `push_abo_schluessel_form`, Migration 0024). */
const ENDPOINT = z.string().max(2048).regex(/^https:\/\//);

const ABO = z.strictObject({
  endpoint: ENDPOINT,
  // `PushSubscription.toJSON()` schickt dieses Feld mit; das Cockpit braucht es nicht.
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  }),
});

const ABMELDEN = z.strictObject({ endpoint: ENDPOINT });

/** Eine Nummer aus der Adresse. */
const NUMMER = /^[1-9][0-9]{0,14}$/;

export function registrierePushRouten(app: FastifyInstance, abhaengigkeiten: PushRoutenAbhaengigkeiten): void {
  const { pool, zugangLesen, eingerichtet, zustellung } = abhaengigkeiten;
  /** Wann ein Konto zuletzt einen Test-Push bekam — nur im Speicher dieses Prozesses. */
  const letzterTest = new Map<string, number>();

  /** Das Konto, wenn es Push nutzen darf und die Anfrage aus dem Cockpit kommt; sonst ist die Antwort schon gesendet. */
  function pruefen(request: Parameters<ZugangLesen>[0], reply: FastifyReply): Promise<string | undefined> {
    return kontoMitHerkunft(app, request, reply, zugangLesen, (zugang) => (eingerichtet && hatRecht(zugang, 'chat_nutzen') ? zugang.benutzerId : undefined), 'Push');
  }

  /**
   * Die gemeinsame Prüfung der JSON-Routen: Konto und Herkunft, dann nur `application/json`, dann das Schema. Liefert
   * Konto und Daten, oder `undefined` — dann ist die Antwort schon gesendet.
   */
  async function jsonLesen<T>(
    request: Parameters<ZugangLesen>[0],
    reply: FastifyReply,
    schema: z.ZodType<T>,
  ): Promise<{ konto: string; daten: T } | undefined> {
    const konto = await pruefen(request, reply);
    if (konto === undefined) {
      return undefined;
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      await reply.code(415).header('cache-control', 'no-store').send({ fehler: 'nur_json' });
      return undefined;
    }
    const geprueft = schema.safeParse(request.body);
    if (!geprueft.success) {
      await reply.code(400).header('cache-control', 'no-store').send({ fehler: 'ungueltige_anfrage' });
      return undefined;
    }
    return { konto, daten: geprueft.data };
  }

  app.post('/push/abo', async (request, reply) => {
    const gelesen = await jsonLesen(request, reply, ABO);
    if (gelesen === undefined) {
      return reply;
    }
    const { konto, daten } = gelesen;
    const id = await aboSpeichern(pool, konto, { endpoint: daten.endpoint, p256dh: daten.keys.p256dh, auth: daten.keys.auth });
    return reply.code(201).header('cache-control', 'no-store').send({ id });
  });

  app.post('/push/abmelden', async (request, reply) => {
    const gelesen = await jsonLesen(request, reply, ABMELDEN);
    if (gelesen === undefined) {
      return reply;
    }
    await aboAbmelden(pool, gelesen.konto, { endpoint: gelesen.daten.endpoint });
    return reply.code(204).header('cache-control', 'no-store').send();
  });

  app.post<{ Params: { id: string } }>('/push/geraete/:id/entfernen', async (request, reply) => {
    const konto = await pruefen(request, reply);
    if (konto === undefined) {
      return reply;
    }
    if (!NUMMER.test(request.params.id) || !(await aboAbmelden(pool, konto, { id: Number(request.params.id) }))) {
      return nichtGefunden(app, reply);
    }
    return reply.code(303).header('location', `${EINSTELLUNGEN_PFAD}?push=entfernt`).header('cache-control', 'no-store').send();
  });

  app.post('/push/test', async (request, reply) => {
    const konto = await pruefen(request, reply);
    if (konto === undefined) {
      return reply;
    }
    if (zustellung === undefined) {
      return nichtGefunden(app, reply);
    }
    const jetzt = Date.now();
    const zuletzt = letzterTest.get(konto);
    let angenommen = 0;
    if (zuletzt === undefined || jetzt - zuletzt >= TEST_ABSTAND_MS) {
      letzterTest.set(konto, jetzt);
      angenommen = await anAbosZustellen(zustellung, konto, TEST_RUMPF, 'normal');
    }
    const ergebnis = angenommen > 0 ? 'test' : 'test-fehler';
    return reply.code(303).header('location', `${EINSTELLUNGEN_PFAD}?push=${ergebnis}`).header('cache-control', 'no-store').send();
  });
}
