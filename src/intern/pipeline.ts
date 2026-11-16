/**
 * Die Seite des Koordinator-Agenten in der Entwicklungspipeline (COPI-145, JAC-757) unter der Agenten-API, Recht `pipeline_verwalten`:
 *
 *   * `POST /intern/pipeline/jobs` — einen Job anlegen (nach der Ready-Prüfung des Tickets, JAC-741). Wartet oder läuft
 *     derselbe Job (Ticket und Art) schon, kommt er zurück (`angelegt: false`) — das Polling des Koordinators legt nichts doppelt an.
 *     Ein Repo ohne Einstellungen (`pipeline-repo`) ist `409 repo_unbekannt`.
 *   * `GET /intern/pipeline/jobs` — die Jobs als Liste, neueste zuerst; Filter `status`, `ticket_key`, `limit` (Standard 50, höchstens 200).
 *   * `GET /intern/pipeline/jobs/:id` — ein Job mit seinem Verlauf (Status, Meldungen des Runners).
 *   * `GET /intern/pipeline/freigaben` — die PRs, die auf Stefans Freigabe warten (COPI-180).
 *   * `POST /intern/pipeline/jobs/:id/freigabe-erledigt` — eine Anfrage als erledigt markieren (PR gemergt oder geschlossen).
 *   * `POST /intern/pipeline/aufraeumen` — abgelaufene Leases zurück in die Queue, nach `max_attempts` auf `parked`.
 *     Die Antwort nennt die geparkten Jobs: die meldet der Koordinator an Stefan.
 *
 * Der Runner hat dieses Recht nicht: er meldet über `/pipeline` (`src/pipeline/api.ts`) und kann keine Jobs anlegen.
 */
import * as z from 'zod';
import { FREIGABE_GRUENDE, freigabeErledigen, offeneFreigaben } from '../pipeline/freigaben.js';
import { aufraeumen, JOB_ARTEN, JOB_STATUS, jobAlsJson, jobAnlegen, jobLesen, jobsLesen } from '../pipeline/queue.js';
import { REPO_FORM } from '../pipeline/repo-config.js';
import { antworten } from './antwort.js';
import { abfrageLesen } from './eingabe.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

const NEUER_JOB = z.strictObject({
  ticket_key: z.string().min(1).max(200),
  repo: z.string().regex(REPO_FORM),
  kind: z.enum(JOB_ARTEN),
  priority: z.int().min(1).max(5).optional(),
  due_date: z.iso.date().optional(),
  max_attempts: z.int().min(0).max(10).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const JOB_LISTE = z.strictObject({
  status: z.enum(JOB_STATUS).optional(),
  ticket_key: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const JOB_PFAD = z.strictObject({ id: z.uuid() });

const FREIGABE_ERLEDIGT = z.strictObject({ grund: z.enum(FREIGABE_GRUENDE) });

/** Ein Job mit Verlauf lässt sich sehr lang melden; ein Anlegen trägt nur den Ticket-Kontext. */
const RUMPF_HOECHSTENS = 256 * 1024;

export function registrierePipelineRouten(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool, jetzt } = abhaengigkeiten;

  router.route({
    methode: 'POST',
    url: '/pipeline/jobs',
    scope: 'pipeline_verwalten',
    bodyLimit: RUMPF_HOECHSTENS,
    handler: async (request, reply) => {
      const eingabe = abfrageLesen(NEUER_JOB, request.body, reply);
      if (eingabe === undefined) {
        return reply;
      }
      const antwort = await jobAnlegen(
        pool,
        {
          ticketKey: eingabe.ticket_key,
          repo: eingabe.repo,
          kind: eingabe.kind,
          priority: eingabe.priority,
          dueDate: eingabe.due_date,
          maxAttempts: eingabe.max_attempts,
          payload: eingabe.payload,
        },
        jetzt(),
      );
      if (antwort.art === 'repo_unbekannt') {
        return antworten(reply, 409, 'repo_unbekannt');
      }
      return reply.code(antwort.art === 'angelegt' ? 201 : 200).send({ angelegt: antwort.art === 'angelegt', job: jobAlsJson(antwort.job) });
    },
  });

  router.route({
    methode: 'GET',
    url: '/pipeline/jobs',
    scope: 'pipeline_verwalten',
    handler: async (request, reply) => {
      const abfrage = abfrageLesen(JOB_LISTE, request.query, reply);
      if (abfrage === undefined) {
        return reply;
      }
      const jobs = await jobsLesen(pool, { status: abfrage.status, ticketKey: abfrage.ticket_key, limit: abfrage.limit });
      return { jobs: jobs.map(jobAlsJson) };
    },
  });

  router.route({
    methode: 'GET',
    url: '/pipeline/jobs/:id',
    scope: 'pipeline_verwalten',
    handler: async (request, reply) => {
      const pfad = abfrageLesen(JOB_PFAD, request.params, reply);
      if (pfad === undefined) {
        return reply;
      }
      const gelesen = await jobLesen(pool, pfad.id);
      if (gelesen === undefined) {
        return antworten(reply, 404, 'nicht_gefunden');
      }
      return {
        job: jobAlsJson(gelesen.job),
        ereignisse: gelesen.ereignisse.map((e) => ({
          event_id: e.eventId,
          runner: e.runner,
          ts: e.ts.toISOString(),
          type: e.type,
          data: e.data,
        })),
      };
    },
  });

  router.route({
    methode: 'GET',
    url: '/pipeline/freigaben',
    scope: 'pipeline_verwalten',
    handler: async () => {
      const freigaben = await offeneFreigaben(pool);
      return {
        freigaben: freigaben.map((f) => ({
          job_id: f.jobId,
          ticket_key: f.ticketKey,
          titel: f.titel,
          repo: f.repo,
          pr: f.pr,
          pr_url: f.prUrl,
          head_sha: f.headSha,
          runden: f.runden,
          angefragt_am: f.angefragtAm.toISOString(),
        })),
      };
    },
  });

  router.route({
    methode: 'POST',
    url: '/pipeline/jobs/:id/freigabe-erledigt',
    scope: 'pipeline_verwalten',
    handler: async (request, reply) => {
      const pfad = abfrageLesen(JOB_PFAD, request.params, reply);
      if (pfad === undefined) {
        return reply;
      }
      const eingabe = abfrageLesen(FREIGABE_ERLEDIGT, request.body, reply);
      if (eingabe === undefined) {
        return reply;
      }
      const antwort = await freigabeErledigen(pool, { jobId: pfad.id, grund: eingabe.grund, jetzt: jetzt() });
      if (antwort === 'job_unbekannt') {
        return antworten(reply, 404, 'nicht_gefunden');
      }
      return { erledigt: antwort === 'erledigt' };
    },
  });

  router.route({
    methode: 'POST',
    url: '/pipeline/aufraeumen',
    scope: 'pipeline_verwalten',
    handler: async () => {
      const aufgeraeumt = await aufraeumen(pool, jetzt());
      return {
        aufgeraeumt: aufgeraeumt.map((job) => ({ id: job.id, ticket_key: job.ticketKey, status: job.status, attempt: job.attempt })),
      };
    },
  });
}
