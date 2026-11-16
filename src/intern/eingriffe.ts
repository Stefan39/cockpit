/**
 * Die Eingriffe für den Admin-Agenten (COPI-41, ADR 13.1 und 14.1): lesen und weiterschalten. Das Cockpit aktualisiert
 * nichts selbst — es hält fest, was der Agent nach Stefans Freigabe außerhalb des Cockpits tut, und erkennt selbst, ob
 * es gelungen ist.
 *
 *   * `GET /intern/eingriffe` — die jüngsten zuerst, höchstens 50. `?status=` filtert nach einem Status der Kette, nach
 *     `offen` (beantragt, freigegeben, laeuft) oder nach `haengt` (länger als 15 Minuten in `laeuft`). So fragen die
 *     Wachen des Agenten auch dann nach einem Fehlschlag, wenn die Seite „Versionen" niemand ansieht — oder das Cockpit
 *     nach einem misslungenen Update gar keine Seite mehr zeigt.
 *   * `GET /intern/eingriffe/:id` — ein Eingriff.
 *   * `POST /intern/eingriffe/:id/status` — ein Übergang, genau einer von dreien:
 *       * `{"status": "freigegeben", "ziel_digest": "sha256:…", "ziel_version": "1.4.0"}` — die Freigabe lautet auf
 *         Vorgangs-ID (die Adresse) und Ziel-Digest; das Cockpit prüft, dass der Digest zur Zeile passt. **Ob Stefan
 *         wirklich freigegeben hat, prüft der Agent**, außerhalb des Cockpits. Die Version gehört zum Erfolgsbeleg.
 *       * `{"status": "laeuft"}` — **bevor** der Agent das Image zieht und startet. Nur eine laufende Zeile kann das
 *         neue Cockpit beim Start als erledigt bestätigen.
 *       * `{"status": "freigegeben", "ziel_commit": "8d41e07"}` — die Freigabe eines Modul-Updates (COPI-106), auf den
 *         Ziel-Commit genau wie beantragt. Eine Freigabe der falschen Art passt nie (`ziel_passt_nicht`).
 *       * `{"status": "fehlgeschlagen", "grund": "Fachmigration 0005 fehlt"}` — `grund` ist freiwillig, Klartext,
 *         höchstens 300 Zeichen; die Einstellungen zeigen ihn beim letzten Antrag.
 *
 *     `erledigt` gibt es hier nicht: das setzt nur das Cockpit selbst, wenn es sich mit Ziel-Digest und Ziel-Version
 *     meldet (`src/status/instanz-speicher.ts`), beim Modul, wenn die Registry die Version aus dem Ziel-Commit aktiviert
 *     (`src/module/modul-speicher.ts`). Ein Agent kann sich nicht selbst Erfolg bescheinigen.
 *
 * Antworten auf einen Übergang: 200 mit dem Eingriff; 404, wenn es ihn nicht gibt; 409 `status_passt_nicht` (mit dem
 * aktuellen Status), wenn die Zeile nicht dort steht, woher der Übergang führt — ein doppelter Wechsel ebenso wie eine
 * verbotene Kante; 409 `ziel_passt_nicht`, wenn die Freigabe auf einen anderen Digest lautet. Scheitert etwas, ändert
 * sich nichts.
 *
 * **`freigabe_modus` (COPI-141):** `rueckfrage` — der Agent holt Stefans Freigabe ein, wie bisher; `direkt` — die
 * Bestätigung des Betreuers im Cockpit war die Freigabe, die Zeile steht schon auf `freigegeben`, der Agent führt ohne
 * Rückfrage aus. Bis er `laeuft` meldet, kann der Betreuer einen solchen Antrag noch zurückziehen (dann `409`).
 * `automatisch: true` (COPI-142) heißt: das Cockpit hat den Antrag selbst gestellt; für den Agenten ist er ein direkter.
 *
 * Alles verlangt das Recht `eingriff_verwalten`. `beantragt_von` (die Konto-ID des Betreuers) geht nicht hinaus: der
 * Agent braucht sie nicht.
 */
import type { FastifyReply } from 'fastify';
import * as z from 'zod';
import { eingriffeLesen, eingriffLesen, eingriffWeiterschalten, type Eingriff, type Uebergang } from '../status/eingriff-speicher.js';
import {
  EINGRIFF_STATUS,
  FEHLER_GRUND_HOECHSTENS,
  ZIEL_COMMIT_FORM,
  ZIEL_VERSION_FORM,
  ZIEL_VERSION_HOECHSTENS,
} from '../status/eingriff.js';
import { DIGEST_FORM } from '../status/instanz.js';
import { antworten } from './antwort.js';
import { fehlerhafteFelder } from './eingabe.js';
import { zugangKennung } from './token-speicher.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

/** Ein Übergang ist ein kleines Objekt; mehr ist kein Übergang. */
const UEBERGANG_RUMPF_HOECHSTENS = 4 * 1024;

const FILTER_SCHEMA = z.strictObject({
  status: z.enum([...EINGRIFF_STATUS, 'offen', 'haengt']).optional(),
});

/** Die Nummer eines Eingriffs in der Adresse: eine positive ganze Zahl ohne Vorzeichen, führende Null oder Exponent. */
const NUMMER_SCHEMA = z.strictObject({
  id: z
    .string()
    .regex(/^[1-9][0-9]{0,14}$/)
    .transform(Number),
});

/**
 * Genau drei Übergänge. Jedes andere Ziel — auch `erledigt` — ist eine ungültige Anfrage mit dem Feld `status`; jedes
 * zusätzliche Feld ebenso: ein Tippfehler soll auffallen, nicht verschluckt werden.
 */
const UEBERGANG_SCHEMA = z.discriminatedUnion('status', [
  // Beim Image Ziel-Digest und Ziel-Version, beim Modul-Update (COPI-106) nur der Ziel-Commit — genau eins von beiden.
  z
    .strictObject({
      status: z.literal('freigegeben'),
      ziel_digest: z.string().regex(DIGEST_FORM).optional(),
      ziel_version: z.string().max(ZIEL_VERSION_HOECHSTENS).regex(ZIEL_VERSION_FORM).optional(),
      ziel_commit: z.string().regex(ZIEL_COMMIT_FORM).optional(),
    })
    .superRefine((daten, kontext) => {
      // Mit Commit stört jedes Feld des Images; ohne Commit fehlt, was vom Image nicht da ist.
      const mitCommit = daten.ziel_commit !== undefined;
      for (const feld of ['ziel_digest', 'ziel_version'] as const) {
        if ((daten[feld] !== undefined) === mitCommit) {
          kontext.addIssue({ code: 'custom', path: [feld], message: 'Ziel-Digest mit Ziel-Version oder Ziel-Commit' });
        }
      }
    }),
  z.strictObject({ status: z.literal('laeuft') }),
  z.strictObject({ status: z.literal('fehlgeschlagen'), grund: z.string().trim().min(1).max(FEHLER_GRUND_HOECHSTENS).optional() }),
]);

function zeit(wert: Date | undefined): string | null {
  return wert === undefined ? null : wert.toISOString();
}

/** Der Eingriff als JSON, in den Namen der Datenbank. */
function alsJson(eingriff: Eingriff): Record<string, unknown> {
  return {
    id: eingriff.id,
    art: eingriff.art,
    status: eingriff.status,
    haengt: eingriff.haengt,
    ziel_digest: eingriff.zielDigest ?? null,
    ziel_version: eingriff.zielVersion ?? null,
    digest_vorher: eingriff.digestVorher ?? null,
    modul: eingriff.modulKennung ?? null,
    ziel_commit: eingriff.zielCommit ?? null,
    herkunft_vorher: eingriff.herkunftVorher ?? null,
    grund: eingriff.fehlerGrund ?? null,
    freigabe_modus: eingriff.freigabeModus,
    automatisch: eingriff.automatisch,
    beantragt_am: eingriff.beantragtAm.toISOString(),
    freigegeben_am: zeit(eingriff.freigegebenAm),
    laeuft_seit: zeit(eingriff.laeuftSeit),
    abgeschlossen_am: zeit(eingriff.abgeschlossenAm),
  };
}

function ungueltig(reply: FastifyReply, fehler: z.ZodError): FastifyReply {
  return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: fehlerhafteFelder(fehler) });
}

function nichtGefunden(reply: FastifyReply): FastifyReply {
  return antworten(reply, 404, 'nicht_gefunden');
}

function uebergangAus(daten: z.infer<typeof UEBERGANG_SCHEMA>): Uebergang {
  if (daten.status === 'freigegeben') {
    // Die Prüfung oben lässt nur eine der beiden Formen durch.
    return daten.ziel_commit !== undefined
      ? { nach: 'freigegeben', zielCommit: daten.ziel_commit }
      : { nach: 'freigegeben', zielDigest: daten.ziel_digest ?? '', zielVersion: daten.ziel_version ?? '' };
  }
  return daten.status === 'fehlgeschlagen' ? { nach: 'fehlgeschlagen', grund: daten.grund } : { nach: daten.status };
}

export function registriereEingriffRouten(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool, jetzt } = abhaengigkeiten;

  router.route({
    methode: 'GET',
    url: '/eingriffe',
    scope: 'eingriff_verwalten',
    handler: async (request, reply) => {
      const filter = FILTER_SCHEMA.safeParse(request.query);
      if (!filter.success) {
        return ungueltig(reply, filter.error);
      }
      const eingriffe = await eingriffeLesen(pool, filter.data.status, jetzt());
      return reply.code(200).send({ eingriffe: eingriffe.map(alsJson) });
    },
  });

  router.route({
    methode: 'GET',
    url: '/eingriffe/:id',
    scope: 'eingriff_verwalten',
    handler: async (request, reply) => {
      const nummer = NUMMER_SCHEMA.safeParse(request.params);
      if (!nummer.success) {
        return ungueltig(reply, nummer.error);
      }
      const eingriff = await eingriffLesen(pool, nummer.data.id, jetzt());
      return eingriff === undefined ? nichtGefunden(reply) : reply.code(200).send({ eingriff: alsJson(eingriff) });
    },
  });

  router.route({
    methode: 'POST',
    url: '/eingriffe/:id/status',
    scope: 'eingriff_verwalten',
    bodyLimit: UEBERGANG_RUMPF_HOECHSTENS,
    handler: async (request, reply) => {
      const zugang = request.internerZugang;
      if (zugang === null) {
        // Kann nicht eintreten (die Prüfung des Plugins lief vor diesem Handler); im Zweifel bleibt die Tür zu.
        return antworten(reply, 401, 'nicht_angemeldet', { 'www-authenticate': 'Bearer' });
      }
      const nummer = NUMMER_SCHEMA.safeParse(request.params);
      if (!nummer.success) {
        return ungueltig(reply, nummer.error);
      }
      const geprueft = UEBERGANG_SCHEMA.safeParse(request.body);
      if (!geprueft.success) {
        return ungueltig(reply, geprueft.error);
      }

      const id = nummer.data.id;
      const ergebnis = await eingriffWeiterschalten(pool, id, uebergangAus(geprueft.data), zugangKennung(zugang.id), jetzt());
      if (ergebnis.ok) {
        request.log.info({ eingriff: id, status: ergebnis.eingriff.status }, 'Eingriff weitergeschaltet');
        return reply.code(200).send({ eingriff: alsJson(ergebnis.eingriff) });
      }
      if (ergebnis.grund === 'unbekannt') {
        return nichtGefunden(reply);
      }
      if (ergebnis.grund === 'status') {
        return antworten(reply, 409, 'status_passt_nicht', {}, { status: ergebnis.status });
      }
      return antworten(reply, 409, 'ziel_passt_nicht');
    },
  });
}
