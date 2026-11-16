/**
 * `POST /intern/chat/antwort` (COPI-55): der Koordinator-Agent antwortet auf eine Frage im Assistenten-Kanal.
 *
 * Der Weg zurück zur Weiterleitung aus COPI-54: das Cockpit hat die Frage mit ihrer `nachricht_id` an den n8n-Webhook
 * geschickt, der Agentenlauf antwortet hierher. Der Endpunkt liegt auf dem einzigen öffentlich erreichbaren Dienst:
 *
 *   * **Recht `chat_antworten`** — ein eigener Zugang für den Koordinator (die Prüfung läuft vor dem Rumpf).
 *   * **Streng validiert** (`zod`, `strictObject`): `nachricht_id`, `text` (höchstens 4000 Zeichen, nicht leer),
 *     optional `dringend`. Unbekannte Felder sind ein Fehler; die Antwort nennt nur Feldnamen.
 *   * **Nur Fragen im Assistenten-Kanal:** eine unbekannte ID und jede Nachricht, die keine Frage eines Menschen im
 *     Assistenten-Kanal ist (auch eine im Team-Kanal), ergeben dieselbe `404` — die API verrät nichts über fremde Kanäle.
 *   * **Eine Antwort je Frage:** eine zweite ergibt `409 schon_beantwortet` (die Datenbank hält es fest, 0024), etwa
 *     wenn n8n denselben Lauf wiederholt.
 *   * **Der Text bleibt Text:** gespeichert wie gesendet, ausgegeben escaped, nie verlinkt (ADR 10).
 *
 * Eine gespeicherte Antwort geht an den Verteiler (`chat/ereignisse.ts`): dort hängen sich SSE und Push an.
 *
 * **Agenten-Kennung (COPI-113):** optional `agent` — welcher Agent antwortet. Damit steht die Antwort auf seiner
 * Detailseite (nur im eigenen Assistenten-Kanal des Betrachters).
 *
 * `POST /intern/chat/agenten` (COPI-113): ein Agent schreibt einem anderen (`von`, `an`, `text`). Derselbe Zugang wie
 * für Antworten (`chat_antworten`: „Agenten schreiben in den Chat"). Der Kanal der beiden entsteht beim ersten Mal;
 * Menschen lesen ihn auf den Detailseiten der Agenten nur mit. Kein Push, kein Strom: niemand wartet darauf.
 */
import * as z from 'zod';
import type { ChatEreignisse } from '../chat/ereignisse.js';
import { agentenKanal, INHALT_HOECHSTENS, koordinatorAntwortSpeichern, nachrichtAnlegen } from '../chat/nachricht-speicher.js';
import { antworten } from './antwort.js';
import { fehlerhafteFelder, KENNUNG } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

/** 4000 Zeichen zu je vier Byte, dazu das Beiwerk. */
export const ANTWORT_RUMPF_HOECHSTENS = 20 * 1024;

/** Gezählt in Code-Points wie `char_length`; nur Leerraum ist kein Text. */
const TEXT = z
  .string()
  .regex(/\S/)
  .refine((text) => Array.from(text).length <= INHALT_HOECHSTENS);

const ANTWORT_SCHEMA = z.strictObject({
  nachricht_id: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  text: TEXT,
  dringend: z.boolean().optional(),
  agent: z.string().regex(KENNUNG).optional(),
});

const AGENTEN_SCHEMA = z
  .strictObject({ von: z.string().regex(KENNUNG), an: z.string().regex(KENNUNG), text: TEXT })
  .refine((nachricht) => nachricht.von !== nachricht.an, { path: ['an'], error: 'an sich selbst' });

/** Zeilenenden wie im Formular des Chats. */
function zeilenenden(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function registriereChatAntwortRoute(
  router: InternerRouter,
  abhaengigkeiten: InternAbhaengigkeiten & { readonly chatEreignisse: ChatEreignisse },
): void {
  const { pool, chatEreignisse } = abhaengigkeiten;

  router.route({
    methode: 'POST',
    url: '/chat/antwort',
    scope: 'chat_antworten',
    bodyLimit: ANTWORT_RUMPF_HOECHSTENS,
    handler: async (request, reply) => {
      const geprueft = ANTWORT_SCHEMA.safeParse(request.body);
      if (!geprueft.success) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: fehlerhafteFelder(geprueft.error) });
      }
      const { nachricht_id: frageId, text, dringend, agent } = geprueft.data;

      const ergebnis = await koordinatorAntwortSpeichern(pool, frageId, zeilenenden(text), dringend ?? false, agent);
      if (!ergebnis.ok) {
        return ergebnis.grund === 'unbekannt'
          ? antworten(reply, 404, 'nicht_gefunden')
          : antworten(reply, 409, 'schon_beantwortet');
      }
      chatEreignisse.melden(ergebnis.nachricht);
      return reply.code(201).send({
        id: ergebnis.nachricht.id,
        nachricht_id: frageId,
        erstellt_am: ergebnis.nachricht.erstelltAm.toISOString(),
      });
    },
  });

  router.route({
    methode: 'POST',
    url: '/chat/agenten',
    scope: 'chat_antworten',
    bodyLimit: ANTWORT_RUMPF_HOECHSTENS,
    handler: async (request, reply) => {
      const geprueft = AGENTEN_SCHEMA.safeParse(request.body);
      if (!geprueft.success) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: fehlerhafteFelder(geprueft.error) });
      }
      const { von, an, text } = geprueft.data;
      const kanal = await agentenKanal(pool, von, an);
      const nachricht = await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'agent', absenderAgent: von, inhalt: zeilenenden(text) });
      return reply.code(201).send({ id: nachricht.id, kanal_id: kanal.id, erstellt_am: nachricht.erstelltAm.toISOString() });
    },
  });
}
