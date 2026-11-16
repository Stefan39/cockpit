/**
 * `POST /intern/befund` (COPI-36): der Admin-Agent meldet einen Befund einer Wache.
 *
 * Das Cockpit prüft nichts selbst (Architektur-Vorschlag 4) — es nimmt an, was gemeldet wird, und setzt
 * dabei den Herzschlag der Wache (`src/status/befund-speicher.ts`). Der Endpunkt liegt auf dem einzigen
 * öffentlich erreichbaren Dienst, deshalb gilt hier:
 *
 *   * **Recht `befund_schreiben`** — die Prüfung des Tokens läuft vor dem Rumpf (`zugang.ts`).
 *   * **Streng validiert** (`zod`, `strictObject`): ein unbekanntes Feld ist ein Fehler, nicht ein
 *     stillschweigend verworfener Wert. So fällt ein Tippfehler wie `kundensichtbar_` auf, statt einen
 *     Befund zu verstecken. Die Antwort nennt **nur Feldnamen**, nie Werte.
 *   * **Größe begrenzt:** höchstens 32 KiB Rumpf, der Rohbefund höchstens 4000 Zeichen, der Klartext
 *     höchstens 500.
 *   * **Die Quelle lässt sich nicht fälschen:** sie ist der Name des Zugangs, nie eine Angabe im Rumpf.
 *     Ebenso der Zeitpunkt (vom Server) und die Nummer.
 *   * **`anzeigename`** (optional, höchstens 60 Zeichen): wie die Wache dem Kunden heißt. Er gehört zur
 *     Wache, nicht zum Befund — ein Befund ohne Namen lässt ihn stehen (COPI-37).
 *   * **`kundensichtbar` ist ohne ausdrückliche Angabe falsch** (Architektur-Vorschlag 4 und 10) und
 *     nur mit Klartext möglich: der Kunde sieht nie den Rohbefund.
 *   * **`messwert`** (optional, COPI-83): ein Hauptmesswert `{wert, einheit, max?, warnung?}`, ebenso streng —
 *     ein unbekanntes Feld darin nennt sich als `messwert.<name>`. Für den Kunden zählt er nur über einen
 *     kundensichtbaren Befund.
 *   * **`update`** (optional, COPI-140): das neuere Ziel einer Versions-Wache (`version-cockpit`, `version-modul-<kennung>`),
 *     nur an einem gelben Befund und nur an der passenden Wache. `art` `cockpit`: `ziel` ein Digest, `version` Pflicht;
 *     `art` `modul`: `ziel` ein voller Commit, ohne `version`. Ein ungültiges `update` weist den ganzen Befund ab (400, wie
 *     jeder andere Fehler dieser API), gespeichert wird dann nichts. Dieselbe Form prüft die Datenbank (Migration 0049).
 *   * Texte werden **verbatim** gespeichert (nur an den Rändern gekürzt). Maskieren ist Sache der
 *     Ausgabe; ein Fremdtext im Befund wird nie automatisch verlinkt oder als HTML ausgegeben.
 *
 * Der Rumpf steht nicht im Log (Fastify loggt keine Rümpfe) und nicht in der Antwort.
 */
import * as z from 'zod';
import { befundMelden } from '../status/befund-speicher.js';
import { modulVersionsWache, UPDATE_ARTEN, VERSIONS_WACHE, type UpdateArt } from '../status/versionen.js';
import { BEFUND_STATUS } from '../status/zustand.js';
import { antworten } from './antwort.js';
import { fehlerhafteFelder, KENNUNG } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

/** Höchstgrenze eines Takts: ein Jahr (366 Tage). Was länger ausbleiben darf, meldet nicht regelmäßig. */
const TAKT_HOECHSTENS_SEKUNDEN = 366 * 86_400;

/** Größter Rumpf: 4000 Zeichen zu je vier Byte sind 16 000 Byte, dazu Klartext und Beiwerk. */
export const BEFUND_RUMPF_HOECHSTENS = 32 * 1024;

/**
 * Der Hauptmesswert (COPI-83). `z.number()` nimmt keine unendlichen Zahlen an — `1e999` im JSON wird beim Parsen zu
 * `Infinity` und hier abgewiesen. Dieselbe Form prüft die Datenbank (`befund_messwert_form`, Migration 0029).
 */
const MESSWERT_SCHEMA = z.strictObject({
  wert: z.number(),
  einheit: z.string().trim().min(1).max(12),
  max: z.number().positive().optional(),
  warnung: z.number().optional(),
});

/** Eine Cockpit-Version wie `0.24.0`, in derselben Form wie `ziel_version` eines Antrags (`eingriff_ziel_version_form`). */
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** Die Form des Ziels je Art: beim Cockpit ein Digest, beim Modul ein voller Commit aus agent-blueprints. */
const ZIEL: Readonly<Record<UpdateArt, RegExp>> = { cockpit: /^sha256:[0-9a-f]{64}$/, modul: /^[0-9a-f]{40}$/ };

/** Das neuere Ziel einer Versions-Wache (COPI-140). Version nur beim Cockpit, dort Pflicht. */
const UPDATE_SCHEMA = z
  .strictObject({
    art: z.enum(UPDATE_ARTEN),
    ziel: z.string(),
    version: z.string().regex(VERSION).max(64).nullable().optional(),
    hinweis: z.string().trim().min(1).max(200).nullable().optional(),
    seit: z.iso.datetime({ offset: true }),
  })
  .superRefine((update, kontext) => {
    if (!ZIEL[update.art].test(update.ziel)) {
      kontext.addIssue({ code: 'custom', path: ['ziel'], message: 'Ziel passt nicht zur Art' });
    }
    if ((update.art === 'cockpit') !== (typeof update.version === 'string')) {
      kontext.addIssue({ code: 'custom', path: ['version'], message: 'Version nur und genau beim Cockpit' });
    }
  });

/** Ob die Wache zur Art des Ziels passt: das Cockpit-Ziel nur an `version-cockpit`, ein Modul-Ziel nur an seiner Wache. */
function wachePasst(wache: string, art: UpdateArt): boolean {
  return art === 'cockpit' ? wache === VERSIONS_WACHE : wache.startsWith(modulVersionsWache(''));
}

const BEFUND_SCHEMA = z
  .strictObject({
    wache: z.string().regex(KENNUNG),
    status: z.enum(BEFUND_STATUS),
    text_intern: z.string().trim().min(1).max(4000),
    text_kunde: z.string().trim().min(1).max(500).optional(),
    kundensichtbar: z.boolean().optional(),
    takt_sekunden: z.int().min(1).max(TAKT_HOECHSTENS_SEKUNDEN).optional(),
    // Wie die Wache dem Kunden heißt; gehört zur Wache, nicht zum Befund (COPI-37).
    anzeigename: z.string().trim().min(1).max(60).optional(),
    messwert: MESSWERT_SCHEMA.optional(),
    // Welchem Agenten die Wache gehört (COPI-113); gehört zur Wache wie der Anzeigename.
    agent: z.string().regex(KENNUNG).optional(),
    update: UPDATE_SCHEMA.optional(),
  })
  .refine((befund) => befund.kundensichtbar !== true || befund.text_kunde !== undefined, {
    // Ohne Klartext hätte ein sichtbarer Befund nichts, was man dem Kunden zeigen dürfte.
    path: ['text_kunde'],
    error: 'kundensichtbar braucht einen Klartext',
  })
  // Ein Update-Ziel heißt „Update verfügbar": nur gelb, und nur an der Wache seiner Art.
  .refine((befund) => befund.update === undefined || befund.status === 'gelb', { path: ['update'], error: 'update nur bei gelb' })
  .refine((befund) => befund.update === undefined || wachePasst(befund.wache, befund.update.art), {
    path: ['update', 'art'],
    error: 'update passt nicht zur Wache',
  });

export function registriereBefundRoute(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool, jetzt } = abhaengigkeiten;

  router.route({
    methode: 'POST',
    url: '/befund',
    scope: 'befund_schreiben',
    bodyLimit: BEFUND_RUMPF_HOECHSTENS,
    handler: async (request, reply) => {
      const zugang = request.internerZugang;
      if (zugang === null) {
        // Kann nicht eintreten (die Prüfung des Plugins lief vor diesem Handler); im Zweifel bleibt die Tür zu.
        return antworten(reply, 401, 'nicht_angemeldet', { 'www-authenticate': 'Bearer' });
      }

      const geprueft = BEFUND_SCHEMA.safeParse(request.body);
      if (!geprueft.success) {
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: fehlerhafteFelder(geprueft.error) });
      }
      const befund = geprueft.data;

      const ergebnis = await befundMelden(pool, {
        wache: befund.wache,
        status: befund.status,
        textIntern: befund.text_intern,
        textKunde: befund.text_kunde,
        kundensichtbar: befund.kundensichtbar ?? false,
        taktSekunden: befund.takt_sekunden,
        anzeigename: befund.anzeigename,
        messwert: befund.messwert,
        agent: befund.agent,
        updateZiel:
          befund.update === undefined
            ? undefined
            : {
                art: befund.update.art,
                ziel: befund.update.ziel,
                ...(typeof befund.update.version === 'string' ? { version: befund.update.version } : {}),
                ...(typeof befund.update.hinweis === 'string' ? { hinweis: befund.update.hinweis } : {}),
                seit: befund.update.seit,
              },
        quelle: zugang.name,
        jetzt: jetzt(),
      });

      if (!ergebnis.ok) {
        // Eine unbekannte Wache ohne Takt: ohne ihn ließe sich nie sagen, ob sie ausbleibt.
        return antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: ['takt_sekunden'] });
      }
      return reply.code(201).send({
        id: ergebnis.id,
        wache: befund.wache,
        gemeldet_am: ergebnis.gemeldetAm.toISOString(),
      });
    },
  });
}
