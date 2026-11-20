/**
 * Aufwand und Merkmale je Ticket (COPI-254), Recht `pipeline_verwalten`, Meldung durch den Koordinator (n8n):
 *
 *   * `POST /intern/pipeline/aufwand` — Aufwandseinträge der Zeiterfassung (oder von Hand). Der Rumpf ist ein Eintrag
 *     `{ticket_key, quelle, extern_id, tag, minuten}` oder `{"eintraege": [...]}` mit 1 bis 200 Einträgen; mehrere gelten
 *     ganz oder gar nicht. Dieselbe (`quelle`, `extern_id`) überschreibt den Eintrag (die Zeiterfassung kann ihn nachträglich
 *     ändern), `minuten = 0` nimmt ihn aus der Summe. Antwort `{angelegt, geaendert, unveraendert}`.
 *   * `POST /intern/pipeline/merkmal` — Aufgabentyp, Stack und geänderte Zeilen eines Tickets; nicht genannte Felder bleiben,
 *     `aufgabentyp: null` leert den Typ. Antwort ist der gespeicherte Stand.
 *
 * Streng validiert (`zod`, `strictObject`); die Antwort nennt nur Feldnamen, nie Werte. `tag` ist ein echter Kalendertag,
 * höchstens der morgige (Zeitzonen).
 */
import * as z from 'zod';
import { AUFGABENTYPEN, AUFWAND_QUELLEN, aufwandMelden, merkmalSpeichern } from '../pipeline/aufwand.js';
import { antworten } from './antwort.js';
import { abfrageLesen } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

const MAX_EINTRAEGE = 200;
const TAG_MS = 24 * 60 * 60 * 1000;
const STACK_MARKE = /^[a-z0-9][a-z0-9.+#-]{0,39}$/;

const TICKET = z.string().min(1).max(200);

const EINTRAG = z.strictObject({
  ticket_key: TICKET,
  quelle: z.enum(AUFWAND_QUELLEN),
  extern_id: z.string().min(1).max(200),
  tag: z.iso.date(),
  minuten: z.int().min(0).max(1440),
});

const EINTRAEGE = z.strictObject({
  eintraege: z
    .array(EINTRAG)
    .min(1)
    .max(MAX_EINTRAEGE)
    .refine((eintraege) => new Set(eintraege.map((e) => `${e.quelle}\u0000${e.extern_id}`)).size === eintraege.length, {
      error: 'Einträge dürfen sich nicht wiederholen',
    }),
});

const MERKMAL = z
  .strictObject({
    ticket_key: TICKET,
    aufgabentyp: z.enum(AUFGABENTYPEN).nullable().optional(),
    stack: z.array(z.string().regex(STACK_MARKE)).max(10).optional(),
    geaenderte_zeilen: z.int().min(0).max(2_000_000_000).optional(),
  })
  .refine((m) => m.aufgabentyp !== undefined || m.stack !== undefined || m.geaenderte_zeilen !== undefined, {
    error: 'mindestens ein Merkmal nötig',
  });

export function registrierePipelineAufwandRouten(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool, jetzt } = abhaengigkeiten;

  router.route({
    methode: 'POST',
    url: '/pipeline/aufwand',
    scope: 'pipeline_verwalten',
    handler: async (request, reply) => {
      const mehrere = typeof request.body === 'object' && request.body !== null && 'eintraege' in request.body;
      // Ein Schema je Form (nicht `z.union`): so nennt der Fehler das Feld im Eintrag, nicht den Rumpf.
      const eingabe = mehrere ? abfrageLesen(EINTRAEGE, request.body, reply) : abfrageLesen(EINTRAG, request.body, reply);
      if (eingabe === undefined) {
        return reply;
      }
      const eintraege = 'eintraege' in eingabe ? eingabe.eintraege : [eingabe];

      const zeitpunkt = jetzt();
      // Als Tag in UTC verglichen; „morgen" deckt jede Zeitzone des Melders ab.
      const spaetestens = new Date(zeitpunkt.getTime() + TAG_MS).toISOString().slice(0, 10);
      const zukunft = eintraege.flatMap((e, stelle) => (e.tag > spaetestens ? [mehrere ? `eintraege.${String(stelle)}.tag` : 'tag'] : []));
      if (zukunft.length > 0) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: zukunft });
      }

      const ergebnis = await aufwandMelden(
        pool,
        eintraege.map((e) => ({ ticketKey: e.ticket_key, quelle: e.quelle, externId: e.extern_id, tag: e.tag, minuten: e.minuten })),
        zeitpunkt,
      );
      return reply.code(200).send(ergebnis);
    },
  });

  router.route({
    methode: 'POST',
    url: '/pipeline/merkmal',
    scope: 'pipeline_verwalten',
    handler: async (request, reply) => {
      const eingabe = abfrageLesen(MERKMAL, request.body, reply);
      if (eingabe === undefined) {
        return reply;
      }
      const stand = await merkmalSpeichern(
        pool,
        {
          ticketKey: eingabe.ticket_key,
          ...(eingabe.aufgabentyp !== undefined && { aufgabentyp: eingabe.aufgabentyp }),
          ...(eingabe.stack !== undefined && { stack: eingabe.stack }),
          ...(eingabe.geaenderte_zeilen !== undefined && { geaenderteZeilen: eingabe.geaenderte_zeilen }),
        },
        jetzt(),
      );
      return reply.code(200).send({
        ticket_key: stand.ticketKey,
        aufgabentyp: stand.aufgabentyp,
        stack: stand.stack,
        geaenderte_zeilen: stand.geaenderteZeilen,
      });
    },
  });
}
