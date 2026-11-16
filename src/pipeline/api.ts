/**
 * Die Pipeline-API für den Runner (COPI-145, JAC-757; Konzept Abschnitt 3): `POST /pipeline/claim`, `/heartbeat`,
 * `/event`, `/complete`. Der Vertrag steht in `docs/pipeline-api.md`.
 *
 * **Anmeldung per HMAC** (`signatur.ts`) statt per Bearer-Token wie unter `/intern`: der Runner auf dem Mini-PC hat nur
 * das gemeinsame Geheimnis `COCKPIT_PIPELINE_SECRET`, und die Signatur deckt den rohen Rumpf und den Zeitpunkt ab. Das
 * Tor (`auth/zwei-faktor-tor.ts`) lässt den Präfix ohne Sitzung durch; geprüft wird hier, deny by default:
 *
 *   1. `onRequest` (vor dem Rumpf): Bremse je Client-IP, Geheimnis eingerichtet, Kopfzeilen wohlgeformt, Zeitpunkt im
 *      Fenster — sonst 401.
 *   2. Der Parser des Rumpfs prüft die Signatur über **genau die empfangenen Zeichen**, bevor er JSON liest — sonst 401.
 *   3. `preHandler`: eine Anfrage ohne geprüften Rumpf (kein Inhaltstyp, leer) erreicht keine Route — 401.
 *
 * Alle Antworten sind JSON und `no-store`, Fehler knapp und ohne Werte aus der Eingabe (wie die Agenten-API).
 * Ohne Geheimnis gibt es keine gültige Anfrage: jede bekommt 401 — dieselbe Antwort wie bei falscher Signatur.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import * as z from 'zod';
import { antworten } from '../intern/antwort.js';
import { abfrageLesen, KENNUNG } from '../intern/eingabe.js';
import { FensterZaehler } from '../intern/ratenbegrenzung.js';
import { clientIp, knappeFehlerEinrichten } from '../intern/zugang.js';
import { PIPELINE_PFAD } from '../auth/zwei-faktor-tor.js';
import { ereignisMelden, JOB_ARTEN, jobAbschliessen, jobAlsJson, jobVergeben, leaseVerlaengern } from './queue.js';
import { repoConfigFuer } from './repo-config.js';
import { kopfLesen, SIGNATUR_KOPF, signaturStimmt, ZEITPUNKT_KOPF, type PipelineKonfiguration, type SignaturKopf } from './signatur.js';

/** Fehlversuche je Client-IP im Fenster, bevor die Adresse gebremst wird (wie unter `/intern`). */
const IP_FEHLVERSUCHE = 20;
const IP_FENSTER_MS = 15 * 60 * 1000;

/** Größter Rumpf: Ereignisse und Abschluss tragen Daten des Runners (Befunde, Ergebnis), aber keine Logs. */
const RUMPF_HOECHSTENS = 256 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    /** Wohlgeformte Kopfzeilen im Zeitfenster (`onRequest`); sonst `null`. */
    pipelineKopf: SignaturKopf | null;
    /** Die Signatur über den Rumpf stimmt. */
    pipelineSigniert: boolean;
  }
}

export interface PipelineAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly jetzt: () => Date;
  /** Ohne Konfiguration ist keine Anfrage gültig. */
  readonly konfiguration: PipelineKonfiguration | undefined;
}

const RUNNER = z.string().regex(KENNUNG);
const JOB_ID = z.uuid();
const OBJEKT = z.record(z.string(), z.unknown());

const CLAIM = z.strictObject({
  runner: RUNNER,
  arten: z.array(z.enum(JOB_ARTEN)).min(1).optional(),
});

const HEARTBEAT = z.strictObject({ runner: RUNNER, job_id: JOB_ID });

const EVENT = z.strictObject({
  runner: RUNNER,
  job_id: JOB_ID,
  event_id: z.uuid(),
  type: z.string().regex(/^[a-z][a-z0-9_.]{0,62}$/),
  data: OBJEKT.optional(),
});

const ANZAHL = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const EURO = z.number().min(0).max(1_000_000);

const USAGE = z.strictObject({
  tool: z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/),
  model: z.string().min(1).max(100).optional(),
  billing: z.enum(['abo', 'api']),
  input_tokens: ANZAHL.default(0),
  output_tokens: ANZAHL.default(0),
  cache_tokens: ANZAHL.default(0),
  cost_eur_notional: EURO.optional(),
  cost_eur_real: EURO.optional(),
  duration_s: z.int().min(0).max(7 * 24 * 3600).optional(),
});

const COMPLETE = z
  .strictObject({
    runner: RUNNER,
    job_id: JOB_ID,
    ergebnis: z.enum(['done', 'failed', 'abandoned', 'released', 'quota']),
    result: OBJEKT.optional(),
    usage: z.array(USAGE).max(50).default([]),
    provider_bis: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((wert) => wert.provider_bis === undefined || wert.ergebnis === 'quota', { path: ['provider_bis'] });

function nichtAngemeldet(reply: FastifyReply): FastifyReply {
  return antworten(reply, 401, 'nicht_angemeldet', { 'www-authenticate': 'HMAC-SHA256' });
}

function signaturFehler(): Error {
  return Object.assign(new Error('Signatur ungültig'), { statusCode: 401 });
}

/** Hängt die Pipeline-API unter `/pipeline` ein. */
export function registrierePipelineApi(app: FastifyInstance, abhaengigkeiten: PipelineAbhaengigkeiten): void {
  const { pool, jetzt, konfiguration } = abhaengigkeiten;
  const ipZaehler = new FensterZaehler(IP_FEHLVERSUCHE, IP_FENSTER_MS);

  async function kopfPruefen(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    // Reservieren, dann prüfen (wie unter `/intern`): wer besteht, bekommt die Reservierung beim Rumpf zurück.
    const reservierung = ipZaehler.reservieren(clientIp(request), jetzt().getTime());
    if (!reservierung.erlaubt) {
      return antworten(reply, 429, 'zu_viele_anfragen', { 'retry-after': String(reservierung.wiederNachSekunden) });
    }
    const kopf = kopfLesen(request.headers[ZEITPUNKT_KOPF], request.headers[SIGNATUR_KOPF], jetzt());
    if (konfiguration === undefined || kopf === undefined) {
      return nichtAngemeldet(reply);
    }
    request.pipelineKopf = kopf;
    void reply.header('cache-control', 'no-store');
    return undefined;
  }

  void app.register(
    async (api) => {
      api.decorateRequest('pipelineKopf', null);
      api.decorateRequest('pipelineSigniert', false);
      api.addHook('onRequest', kopfPruefen);

      const jsonLesen = api.getDefaultJsonParser('error', 'error');
      api.removeAllContentTypeParsers();
      api.addContentTypeParser('application/json', { parseAs: 'string' }, (request, rumpf, fertig) => {
        const kopf = request.pipelineKopf;
        const text = typeof rumpf === 'string' ? rumpf : rumpf.toString('utf8');
        if (konfiguration === undefined || kopf === null || !signaturStimmt(konfiguration.geheimnis, kopf, text)) {
          fertig(signaturFehler(), undefined);
          return;
        }
        request.pipelineSigniert = true;
        ipZaehler.gutschreiben(clientIp(request));
        jsonLesen(request, text, fertig);
      });

      api.addHook('preHandler', async (request, reply) => (request.pipelineSigniert ? undefined : nichtAngemeldet(reply)));
      knappeFehlerEinrichten(api, 'Pipeline-API', nichtAngemeldet);
      api.setNotFoundHandler((request, reply) =>
        request.pipelineSigniert ? antworten(reply, 404, 'nicht_gefunden') : nichtAngemeldet(reply),
      );

      api.post('/claim', { bodyLimit: RUMPF_HOECHSTENS }, async (request, reply) => {
        const eingabe = abfrageLesen(CLAIM, request.body, reply);
        if (eingabe === undefined) {
          return reply;
        }
        const job = await jobVergeben(pool, { runner: eingabe.runner, arten: eingabe.arten ?? JOB_ARTEN, jetzt: jetzt() });
        if (job === undefined) {
          return { job: null };
        }
        const repo = await repoConfigFuer(pool, job.repo);
        return {
          job: jobAlsJson(job),
          repo_config:
            repo === undefined
              ? null
              : {
                  quelle: repo.quelle,
                  jira_project: repo.jiraProject,
                  base_branch: repo.baseBranch,
                  auto_merge: repo.autoMerge,
                  phase: repo.phase,
                  reviewers: repo.reviewers,
                  protected_paths: repo.protectedPaths,
                },
        };
      });

      api.post('/heartbeat', { bodyLimit: RUMPF_HOECHSTENS }, async (request, reply) => {
        const eingabe = abfrageLesen(HEARTBEAT, request.body, reply);
        if (eingabe === undefined) {
          return reply;
        }
        const bis = await leaseVerlaengern(pool, { runner: eingabe.runner, jobId: eingabe.job_id, jetzt: jetzt() });
        return bis === undefined ? antworten(reply, 409, 'lease_verloren') : { lease_until: bis.toISOString() };
      });

      api.post('/event', { bodyLimit: RUMPF_HOECHSTENS }, async (request, reply) => {
        const eingabe = abfrageLesen(EVENT, request.body, reply);
        if (eingabe === undefined) {
          return reply;
        }
        const ergebnis = await ereignisMelden(pool, {
          runner: eingabe.runner,
          jobId: eingabe.job_id,
          eventId: eingabe.event_id,
          type: eingabe.type,
          data: eingabe.data ?? {},
        });
        if (ergebnis === 'job_unbekannt') {
          return antworten(reply, 404, 'job_unbekannt');
        }
        return reply.code(ergebnis === 'gespeichert' ? 201 : 200).send({ gespeichert: ergebnis === 'gespeichert' });
      });

      api.post('/complete', { bodyLimit: RUMPF_HOECHSTENS }, async (request, reply) => {
        const eingabe = abfrageLesen(COMPLETE, request.body, reply);
        if (eingabe === undefined) {
          return reply;
        }
        const antwort = await jobAbschliessen(pool, {
          runner: eingabe.runner,
          jobId: eingabe.job_id,
          ergebnis: eingabe.ergebnis,
          result: eingabe.result,
          usage: eingabe.usage.map((lauf) => ({
            tool: lauf.tool,
            model: lauf.model,
            billing: lauf.billing,
            inputTokens: lauf.input_tokens,
            outputTokens: lauf.output_tokens,
            cacheTokens: lauf.cache_tokens,
            costEurNotional: lauf.cost_eur_notional,
            costEurReal: lauf.cost_eur_real,
            durationS: lauf.duration_s,
          })),
          providerBis: eingabe.provider_bis === undefined ? undefined : new Date(eingabe.provider_bis),
          jetzt: jetzt(),
        });
        switch (antwort.art) {
          case 'job_unbekannt':
            return antworten(reply, 404, 'job_unbekannt');
          case 'lease_verloren':
            return antworten(reply, 409, 'lease_verloren');
          case 'wiederholt':
          case 'abgeschlossen':
            return { status: antwort.job.status, attempt: antwort.job.attempt, wiederholt: antwort.art === 'wiederholt' };
        }
      });
    },
    { prefix: PIPELINE_PFAD },
  );
}
