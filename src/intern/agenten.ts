/**
 * `PUT /intern/agenten` (COPI-38): der Admin-Agent liefert das Inventar der Agenten — Kennung, Rolle, Version,
 * Grenzen, Zeitplan. Das Cockpit liest nie YAML und fragt GHCR nie selbst (Architektur-Vorschlag 4, 13.1): es
 * zeigt, was ihm gemeldet wurde (`src/status/agenten-speicher.ts`). Der Endpunkt liegt auf dem einzigen
 * öffentlich erreichbaren Dienst, deshalb gilt hier:
 *
 *   * **Recht `agenten_schreiben`** — die Prüfung des Tokens läuft vor dem Rumpf (`zugang.ts`). Ein Token nur
 *     für Befunde darf kein Inventar ersetzen.
 *   * **PUT ersetzt das ganze Inventar.** Wer in der Liste fehlt, fällt heraus; eine leere Liste leert es. Deshalb
 *     ist eine abgewiesene Meldung besonders heikel: sie lässt den Bestand **unangetastet** (alles oder nichts,
 *     eine Transaktion). `grenzen` und `zeitplan` dürfen fehlen und gelten dann als leer.
 *   * **Streng validiert** (`zod`, `strictObject`): ein unbekanntes Feld ist ein Fehler, nicht ein
 *     stillschweigend verworfener Wert. Die Antwort nennt **nur Feldnamen** (`agenten.2.zeitplan.0.name`), nie
 *     Werte — und nach `grenzen` gar keinen Namen mehr, denn dort sind die Schlüssel Inhalt.
 *   * **Größe begrenzt:** höchstens 512 KiB Rumpf, 30 Agenten, je Agent 20 Grenzen und 20 Takte, Texte mit
 *     Zeichengrenzen. Ein Inventar, das darüber hinausgeht, ist kein Inventar eines Betriebs mehr.
 *   * **Der Zeitpunkt kommt vom Server**, nie aus dem Rumpf.
 *   * **`rolle`, `grenzen` und `zeitplan` sind Klartext für den Kunden.** Das Inventar kennt keine Sichtbarkeit
 *     je Agent; jedes angemeldete Konto sieht diese Felder auf den Seiten Agenten und Zeitplan. Kennung und
 *     Version sieht nur der Betreuer.
 *   * Texte werden **verbatim** gespeichert (nur an den Rändern gekürzt). Maskieren ist Sache der Ausgabe.
 *   * Das Cockpit rechnet nichts aus dem Zeitplan: `wann` ist Freitext („täglich 07:00"), kein Cron.
 *
 * Der Rumpf steht nicht im Log (Fastify loggt keine Rümpfe) und nicht in der Antwort.
 *
 * `POST /intern/agenten/ereignis` (COPI-114): ein Agent meldet, was er getan hat — für das Protokoll seiner Detailseite.
 * Dasselbe Recht `agenten_schreiben` (kein neues Recht, keine weitere Kopie der Scope-Bedingung in den Migrationen).
 * `{ agent, stufe: info|warnung|fehler, titel? (≤ 80), text (≤ 500), text_kunde?, kundensichtbar?, zeitpunkt? }`; sichtbar nur mit
 * Klartext (wie beim Befund). `zeitpunkt` höchstens fünf Minuten in der Zukunft und höchstens sieben Tage zurück, ohne
 * Angabe jetzt. Höchstens 50 Ereignisse je Agent und Stunde, darüber `429` (`ereignis-speicher.ts`).
 */
import * as z from 'zod';
import { EREIGNIS_STUFEN, ereignisMelden } from '../agenten/ereignis-speicher.js';
import { inventarErsetzen } from '../status/agenten-speicher.js';
import { antworten } from './antwort.js';
import { fehlerhafteFelder, KENNUNG } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

/** Größter Rumpf. Alle Grenzen ausgereizt sind es etwa 280 000 Zeichen; darüber ist es kein Inventar mehr. */
export const AGENTEN_RUMPF_HOECHSTENS = 512 * 1024;

const MAX_AGENTEN = 30;
const MAX_GRENZEN = 20;
const MAX_TAKTE = 20;

/** Was ein Agent darf, als Text, Zahl oder Ja/Nein. */
const GRENZ_WERT = z.union([z.string().trim().min(1).max(200), z.number(), z.boolean()]);

const TAKT_SCHEMA = z.strictObject({
  name: z.string().trim().min(1).max(80),
  wann: z.string().trim().min(1).max(120),
});

const AGENT_SCHEMA = z.strictObject({
  kennung: z.string().regex(KENNUNG),
  rolle: z.string().trim().min(1).max(100),
  version: z.string().trim().min(1).max(64),
  grenzen: z
    .record(z.string().min(1).max(60), GRENZ_WERT)
    .refine((grenzen) => Object.keys(grenzen).length <= MAX_GRENZEN, { error: `höchstens ${String(MAX_GRENZEN)} Grenzen` })
    .optional(),
  zeitplan: z.array(TAKT_SCHEMA).max(MAX_TAKTE).optional(),
});

const INVENTAR_SCHEMA = z.strictObject({
  agenten: z
    .array(AGENT_SCHEMA)
    .max(MAX_AGENTEN)
    // Zwei Einträge zur selben Kennung ließen offen, welcher gilt.
    .refine((agenten) => new Set(agenten.map((agent) => agent.kennung)).size === agenten.length, {
      error: 'Kennungen dürfen sich nicht wiederholen',
    }),
});

/** Höchstens so weit zurück darf ein gemeldeter Zeitpunkt liegen, höchstens so weit voraus. */
const EREIGNIS_ZURUECK_MS = 7 * 86_400_000;
const EREIGNIS_VORAUS_MS = 5 * 60_000;

const EREIGNIS_SCHEMA = z
  .strictObject({
    agent: z.string().regex(KENNUNG),
    stufe: z.enum(EREIGNIS_STUFEN),
    titel: z.string().trim().min(1).max(80).optional(),
    text: z.string().trim().min(1).max(500),
    text_kunde: z.string().trim().min(1).max(500).optional(),
    kundensichtbar: z.boolean().optional(),
    zeitpunkt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((ereignis) => ereignis.kundensichtbar !== true || ereignis.text_kunde !== undefined, {
    // Ohne Klartext hätte ein sichtbares Ereignis nichts, was man dem Kunden zeigen dürfte.
    path: ['text_kunde'],
    error: 'kundensichtbar braucht einen Klartext',
  });

export function registriereAgentenRoute(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool, jetzt } = abhaengigkeiten;

  router.route({
    methode: 'PUT',
    url: '/agenten',
    scope: 'agenten_schreiben',
    bodyLimit: AGENTEN_RUMPF_HOECHSTENS,
    handler: async (request, reply) => {
      if (request.internerZugang === null) {
        // Kann nicht eintreten (die Prüfung des Plugins lief vor diesem Handler); im Zweifel bleibt die Tür zu.
        return antworten(reply, 401, 'nicht_angemeldet', { 'www-authenticate': 'Bearer' });
      }

      const geprueft = INVENTAR_SCHEMA.safeParse(request.body);
      if (!geprueft.success) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: fehlerhafteFelder(geprueft.error) });
      }

      const ergebnis = await inventarErsetzen(
        pool,
        geprueft.data.agenten.map((agent) => ({
          kennung: agent.kennung,
          rolle: agent.rolle,
          version: agent.version,
          grenzen: agent.grenzen ?? {},
          zeitplan: agent.zeitplan ?? [],
        })),
        jetzt(),
      );
      return reply.code(200).send({ agenten: ergebnis.agenten, entfernt: ergebnis.entfernt });
    },
  });

  router.route({
    methode: 'POST',
    url: '/agenten/ereignis',
    scope: 'agenten_schreiben',
    bodyLimit: 8 * 1024,
    handler: async (request, reply) => {
      const zugang = request.internerZugang;
      if (zugang === null) {
        return antworten(reply, 401, 'nicht_angemeldet', { 'www-authenticate': 'Bearer' });
      }
      const geprueft = EREIGNIS_SCHEMA.safeParse(request.body);
      if (!geprueft.success) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: fehlerhafteFelder(geprueft.error) });
      }
      const ereignis = geprueft.data;
      const jetztWert = jetzt();
      const zeitpunkt = ereignis.zeitpunkt === undefined ? jetztWert : new Date(ereignis.zeitpunkt);
      if (zeitpunkt.getTime() > jetztWert.getTime() + EREIGNIS_VORAUS_MS || zeitpunkt.getTime() < jetztWert.getTime() - EREIGNIS_ZURUECK_MS) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: ['zeitpunkt'] });
      }
      const ergebnis = await ereignisMelden(pool, {
        agent: ereignis.agent,
        stufe: ereignis.stufe,
        titel: ereignis.titel,
        text: ereignis.text,
        textKunde: ereignis.text_kunde,
        kundensichtbar: ereignis.kundensichtbar ?? false,
        zeitpunkt,
        quelle: zugang.name,
      });
      if (!ergebnis.ok) {
        return antworten(reply, 429, 'zu_viele_ereignisse', { 'retry-after': '3600' });
      }
      return reply.code(201).send({ id: ergebnis.id, zeitpunkt: zeitpunkt.toISOString() });
    },
  });
}
