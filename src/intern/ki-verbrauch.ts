/**
 * `POST /intern/verbrauch` (COPI-97): Werkzeuge und Agenten melden, welches KI-Modell mit wie vielen Tokens gearbeitet
 * hat — der Claude-Code-Hook, Cowork und der tägliche Import aus LiteLLM (n8n). Nicht zu verwechseln mit
 * `GET /intern/chat/verbrauch` (`verbrauch.ts`), dem Tageszähler des Chats.
 *
 *   * **Recht `verbrauch_schreiben`** — die Prüfung des Tokens läuft vor dem Rumpf (`zugang.ts`).
 *   * **Ein Eintrag oder ein Stapel:** der Rumpf ist entweder ein Eintrag oder `{"eintraege": [...]}` mit 1 bis 500
 *     Einträgen. Ein Stapel gilt ganz oder gar nicht.
 *   * **Idempotent über `schluessel`:** dieselbe Meldung ein zweites Mal ersetzt ihren Eintrag (mit allen Feldern),
 *     es entsteht kein zweiter. Zwei Einträge zum selben Schlüssel in einem Stapel sind ein Fehler — es bliebe offen,
 *     welcher gilt.
 *   * **Streng validiert** (`zod`, `strictObject`): ein unbekanntes Feld ist ein Fehler. Die Antwort nennt **nur
 *     Feldnamen**, nie Werte — auch nicht das Modell eines Eintrags ohne Preis; das steht im Log.
 *   * **`zeitpunkt` kommt vom Melder**, anders als sonst in dieser API: er liefert aus einem Puffer nach, und der
 *     Zeitpunkt des Einsatzes bestimmt den Preis. Er darf höchstens einen Tag in der Zukunft liegen (Uhrenfehler).
 *     Wer gemeldet hat und wann, setzt das Cockpit.
 *   * **Die Kosten rechnet das Cockpit** aus der Preistabelle, nie der Melder: ein Feld `kosten` ist ein unbekanntes
 *     Feld. Ein Eintrag ohne Preis wird trotzdem gespeichert, mit Kosten NULL; die Antwort zählt ihn in `ohne_preis`.
 *
 * Der Rumpf steht nicht im Log (Fastify loggt keine Rümpfe) und nicht in der Antwort.
 *
 * `GET /intern/verbrauch/tickets` (COPI-98): die Summen je Ticket für den täglichen Abgleich mit Jira — **Recht
 * `verbrauch_lesen`**, ein eigenes: wer meldet, muss nicht lesen können. `?seit=YYYY-MM-DD` wählt die Tickets mit
 * einem Einsatz an oder nach diesem Tag, `?projekt=JAC` ein Projekt; die Summen sind immer die Gesamtsummen des
 * Tickets. Höchstens 500 Tickets, `weitere` sagt, ob es mehr gibt.
 */
import * as z from 'zod';
import {
  VERBRAUCH_QUALITAETEN,
  VERBRAUCH_QUELLEN,
  VERBRAUCH_ZUORDNUNGEN,
  verbrauchMelden,
  type VerbrauchEintrag,
} from '../verbrauch/verbrauch-speicher.js';
import { ticketSummen } from '../verbrauch/ticket-summen.js';
import { antworten } from './antwort.js';
import { abfrageLesen, fehlerhafteFelder, KENNUNG } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

/** Ein Eintrag hat rund 500 Byte; 500 davon sind 250 KiB. */
export const VERBRAUCH_RUMPF_HOECHSTENS = 512 * 1024;

const MAX_EINTRAEGE = 500;

/** Wie weit `zeitpunkt` der Uhr des Cockpits voraus sein darf. */
const ZUKUNFT_HOECHSTENS_MS = 24 * 60 * 60 * 1000;

/** Wie die Bedingungen der Tabelle (Migration 0032). */
const SCHLUESSEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;
const MODELL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$/;
const TICKET = /^[A-Z][A-Z0-9]{1,19}-[0-9]{1,9}$/;
const JIRA_PROJEKT = /^[A-Z][A-Z0-9]{1,19}$/;

/** Ganze Zahl ab 0. `z.int()` weist alles jenseits von 2^53 − 1 ab — mehr Tokens meldet niemand. */
const TOKENS = z.int().min(0);

/**
 * `JAC-630` gehört zu `JAC`; ein anderes Projekt daneben ist ein Fehler im Melder, kein Wert zum Übernehmen. Ein Ticket,
 * das schon an seiner Form scheitert, meldet nur sich selbst.
 */
function projektPasst(ticket: string | null | undefined, projekt: string | null | undefined): boolean {
  return ticket == null || projekt == null || !TICKET.test(ticket) || ticket.startsWith(`${projekt}-`);
}

const EINTRAG_SCHEMA = z
  .strictObject({
    schluessel: z.string().regex(SCHLUESSEL),
    zeitpunkt: z.iso.datetime({ offset: true }),
    quelle: z.enum(VERBRAUCH_QUELLEN),
    modell: z.string().regex(MODELL),
    tokens_eingabe: TOKENS,
    tokens_ausgabe: TOKENS,
    tokens_cache_schreiben_5m: TOKENS,
    tokens_cache_schreiben_1h: TOKENS,
    tokens_cache_lesen: TOKENS,
    // `null` heißt dasselbe wie weggelassen: ein Melder, der kein Ticket kennt, darf das Feld leer mitschicken.
    ticket: z.string().regex(TICKET).nullish(),
    jira_projekt: z.string().regex(JIRA_PROJEKT).nullish(),
    sitzung: z.string().trim().min(1).max(200).nullish(),
    qualitaet: z.enum(VERBRAUCH_QUALITAETEN).optional(),
    zuordnung: z.enum(VERBRAUCH_ZUORDNUNGEN).optional(),
    subagent: z.boolean().optional(),
    // Welcher Agent den Einsatz hatte (COPI-113), für den Verbrauch auf seiner Detailseite.
    agent: z.string().regex(KENNUNG).nullish(),
  })
  .refine((eintrag) => projektPasst(eintrag.ticket, eintrag.jira_projekt), {
    path: ['jira_projekt'],
    error: 'das Ticket gehört zu einem anderen Projekt',
  });

const STAPEL_SCHEMA = z.strictObject({
  eintraege: z
    .array(EINTRAG_SCHEMA)
    .min(1)
    .max(MAX_EINTRAEGE)
    .refine((eintraege) => new Set(eintraege.map((eintrag) => eintrag.schluessel)).size === eintraege.length, {
      error: 'Schlüssel dürfen sich nicht wiederholen',
    }),
});

/** Wie viele Tickets `GET /intern/verbrauch/tickets` höchstens liefert. */
const MAX_TICKETS = 500;

const TICKETS_ABFRAGE = z.strictObject({
  seit: z.iso.date().optional(),
  projekt: z.string().regex(JIRA_PROJEKT).optional(),
});

type GepruefterEintrag = z.infer<typeof EINTRAG_SCHEMA>;

/** Ein Rumpf mit `eintraege` ist ein Stapel, jeder andere ein einzelner Eintrag — so nennt ein Fehler das richtige Feld. */
function istStapel(rumpf: unknown): boolean {
  return typeof rumpf === 'object' && rumpf !== null && 'eintraege' in rumpf;
}

function alsEintrag(eintrag: GepruefterEintrag): VerbrauchEintrag {
  const ticket = eintrag.ticket ?? null;
  return {
    schluessel: eintrag.schluessel,
    zeitpunkt: eintrag.zeitpunkt,
    quelle: eintrag.quelle,
    modell: eintrag.modell,
    ticket,
    // Ohne Angabe folgt das Projekt aus dem Ticket.
    jira_projekt: eintrag.jira_projekt ?? ticket?.slice(0, ticket.lastIndexOf('-')) ?? null,
    sitzung: eintrag.sitzung ?? null,
    qualitaet: eintrag.qualitaet ?? 'gemessen',
    zuordnung: eintrag.zuordnung ?? 'keine',
    subagent: eintrag.subagent ?? false,
    agent: eintrag.agent ?? null,
    tokens_eingabe: eintrag.tokens_eingabe,
    tokens_ausgabe: eintrag.tokens_ausgabe,
    tokens_cache_schreiben_5m: eintrag.tokens_cache_schreiben_5m,
    tokens_cache_schreiben_1h: eintrag.tokens_cache_schreiben_1h,
    tokens_cache_lesen: eintrag.tokens_cache_lesen,
  };
}

export function registriereKiVerbrauchRoute(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool, jetzt } = abhaengigkeiten;

  router.route({
    methode: 'POST',
    url: '/verbrauch',
    scope: 'verbrauch_schreiben',
    bodyLimit: VERBRAUCH_RUMPF_HOECHSTENS,
    handler: async (request, reply) => {
      const zugang = request.internerZugang;
      if (zugang === null) {
        // Kann nicht eintreten (die Prüfung des Plugins lief vor diesem Handler); im Zweifel bleibt die Tür zu.
        return antworten(reply, 401, 'nicht_angemeldet', { 'www-authenticate': 'Bearer' });
      }

      const stapel = istStapel(request.body);
      const geprueft = stapel ? STAPEL_SCHEMA.safeParse(request.body) : EINTRAG_SCHEMA.safeParse(request.body);
      if (!geprueft.success) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: fehlerhafteFelder(geprueft.error) });
      }
      const eintraege = 'eintraege' in geprueft.data ? geprueft.data.eintraege : [geprueft.data];

      const zeitpunkt = jetzt();
      const spaetestens = zeitpunkt.getTime() + ZUKUNFT_HOECHSTENS_MS;
      const zuFrueh = eintraege.flatMap((eintrag, stelle) => (Date.parse(eintrag.zeitpunkt) > spaetestens ? [stelle] : []));
      if (zuFrueh.length > 0) {
        const felder = zuFrueh.map((stelle) => (stapel ? `eintraege.${String(stelle)}.zeitpunkt` : 'zeitpunkt'));
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder });
      }

      const ergebnis = await verbrauchMelden(pool, eintraege.map(alsEintrag), { von: zugang.name, jetzt: zeitpunkt });
      if (ergebnis.modelleOhnePreis.length > 0) {
        // Die Warnung: der Eintrag steht, aber ohne Kosten, bis ein Preis nachgetragen und neu gerechnet ist.
        request.log.warn({ modelle: ergebnis.modelleOhnePreis, zugang: zugang.name }, 'KI-Verbrauch ohne Preis gespeichert');
      }
      return reply.code(200).send({
        eintraege: eintraege.length,
        neu: ergebnis.neu,
        ersetzt: ergebnis.ersetzt,
        ohne_preis: ergebnis.ohnePreis,
      });
    },
  });

  router.route({
    methode: 'GET',
    url: '/verbrauch/tickets',
    scope: 'verbrauch_lesen',
    handler: async (request, reply) => {
      const abfrage = abfrageLesen(TICKETS_ABFRAGE, request.query, reply);
      if (abfrage === undefined) {
        return reply;
      }
      const summen = await ticketSummen(pool, { seit: abfrage.seit, projekt: abfrage.projekt, hoechstens: MAX_TICKETS });
      return {
        tickets: summen.slice(0, MAX_TICKETS).map((summe) => ({
          ticket: summe.ticket,
          jira_projekt: summe.jiraProjekt,
          modelle: summe.modelle,
          einsaetze: summe.einsaetze,
          tokens_eingabe: summe.tokensEingabe,
          tokens_ausgabe: summe.tokensAusgabe,
          tokens_cache: summe.tokensCache,
          kosten_eur: summe.kostenEur,
          kosten_usd: summe.kostenUsd,
          geschaetzt: summe.geschaetzt,
          ohne_preis: summe.ohnePreis,
          ohne_kurs: summe.ohneKurs,
          letzter_tag: summe.letzterTag,
        })),
        weitere: summen.length > MAX_TICKETS,
      };
    },
  });
}
