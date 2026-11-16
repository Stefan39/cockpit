/**
 * `POST /intern/wechselkurs` (COPI-99): der tägliche Lauf in n8n meldet den Referenzkurs der EZB, damit die
 * Auswertung des KI-Verbrauchs eine Summe in Euro zeigen kann. Das Cockpit ruft den Kurs nie selbst ab (ADR).
 *
 *   * **Recht `verbrauch_schreiben`** — dasselbe wie für den Verbrauch: der Kurs gehört zu dessen Auswertung, und
 *     derselbe Lauf meldet beides. Kein eigenes Recht, solange es keinen zweiten Melder gibt.
 *   * **Ein Kurs oder mehrere:** der Rumpf ist ein Kurs oder `{"kurse": [...]}` mit 1 bis 100 Tagen (zum Nachtragen).
 *     Mehrere gelten ganz oder gar nicht.
 *   * **Idempotent je Tag:** derselbe Tag ein zweites Mal ersetzt den Kurs. Zwei Kurse zum selben Tag in einer
 *     Meldung sind ein Fehler.
 *   * **`usd_je_eur` in der Schreibweise der EZB** — US-Dollar je 1 Euro (etwa 1,1712), nicht umgekehrt. Zwischen
 *     0,5 und 2; alles andere ist ein verrutschtes Komma oder ein falsches Währungspaar.
 *   * **`tag` ist ein echter Kalendertag**, höchstens der morgige (Zeitzonen) — ein Kurs für die Zukunft gilt nicht.
 *   * **Streng validiert** (`zod`, `strictObject`); die Antwort nennt nur Feldnamen, nie Werte.
 */
import * as z from 'zod';
import { kurseMelden } from '../verbrauch/wechselkurs-speicher.js';
import { antworten } from './antwort.js';
import { fehlerhafteFelder } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

const MAX_KURSE = 100;
const TAG_MS = 24 * 60 * 60 * 1000;

const KURS_SCHEMA = z.strictObject({
  tag: z.iso.date(),
  usd_je_eur: z.number().min(0.5).max(2),
  quelle: z.string().trim().min(1).max(100).optional(),
});

const KURSE_SCHEMA = z.strictObject({
  kurse: z
    .array(KURS_SCHEMA)
    .min(1)
    .max(MAX_KURSE)
    .refine((kurse) => new Set(kurse.map((kurs) => kurs.tag)).size === kurse.length, { error: 'Tage dürfen sich nicht wiederholen' }),
});

export function registriereWechselkursRoute(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool, jetzt } = abhaengigkeiten;

  router.route({
    methode: 'POST',
    url: '/wechselkurs',
    scope: 'verbrauch_schreiben',
    handler: async (request, reply) => {
      const zugang = request.internerZugang;
      if (zugang === null) {
        // Kann nicht eintreten (die Prüfung des Plugins lief vor diesem Handler); im Zweifel bleibt die Tür zu.
        return antworten(reply, 401, 'nicht_angemeldet', { 'www-authenticate': 'Bearer' });
      }

      const mehrere = typeof request.body === 'object' && request.body !== null && 'kurse' in request.body;
      const geprueft = mehrere ? KURSE_SCHEMA.safeParse(request.body) : KURS_SCHEMA.safeParse(request.body);
      if (!geprueft.success) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: fehlerhafteFelder(geprueft.error) });
      }
      const kurse = 'kurse' in geprueft.data ? geprueft.data.kurse : [geprueft.data];

      const zeitpunkt = jetzt();
      // Als Tag in UTC verglichen; „morgen" deckt jede Zeitzone des Melders ab.
      const spaetestens = new Date(zeitpunkt.getTime() + TAG_MS).toISOString().slice(0, 10);
      const zukunft = kurse.flatMap((kurs, stelle) => (kurs.tag > spaetestens ? [mehrere ? `kurse.${String(stelle)}.tag` : 'tag'] : []));
      if (zukunft.length > 0) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: zukunft });
      }

      const ergebnis = await kurseMelden(
        pool,
        kurse.map((kurs) => ({ tag: kurs.tag, usd_je_eur: kurs.usd_je_eur, quelle: kurs.quelle ?? 'EZB' })),
        { von: zugang.name, jetzt: zeitpunkt },
      );
      return reply.code(200).send({ kurse: kurse.length, neu: ergebnis.neu, ersetzt: ergebnis.ersetzt });
    },
  });
}
