/**
 * Was alle Routen unter `/module/:kennung` gemeinsam haben (COPI-78, ausgelagert mit COPI-110): das Modul aus der Adresse
 * nur für einen Zugang, der es sehen darf — sonst die neutrale 404 —, die Adresse einer Detailseite und die Hinweisseite
 * nach einer abgewiesenen Aktion. Genutzt von `module.ts` (Seiten, Übernahme, Freigabe) und `modul-anhaenge.ts`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { herkunftBelegt } from '../../auth/herkunft.js';
import type pg from 'pg';
import type { Zugang, ZugangLesen } from '../../auth/berechtigung.js';
import { ANSICHT_KENNZAHLEN, istModulKennung } from '../../module/block.js';
import { aktiveModule, type AktivesModul } from '../../module/modul-speicher.js';
import { modulHandelnErlaubt, modulZugriffErlaubt } from '../../module/sichtbarkeit.js';
import { VORGANG_ID_HOECHSTENS } from '../../module/vorgang-sperre.js';
import { navigationFuerZugang } from '../navigation.js';
import { nichtGefunden } from './neutral.js';

export interface ModulZiel {
  readonly zugang: Zugang | undefined;
  readonly modul: AktivesModul;
  readonly pool: pg.Pool;
}

export type ModulZielFinder = (request: FastifyRequest<{ Params: { kennung: string } }>, reply: FastifyReply) => Promise<ModulZiel | undefined>;

/**
 * Das Modul aus der Adresse, wenn dieser Zugang es sehen darf — sonst `undefined`, und die neutrale 404 ist schon
 * gesendet. Eine ungültige Kennung, eine unbekannte oder inaktive und eine ohne Zugriff enden gleich.
 */
export function modulZielFinder(app: FastifyInstance, pool: pg.Pool | undefined, zugangLesen: ZugangLesen | undefined): ModulZielFinder {
  return async (request, reply) => {
    const zugang = zugangLesen ? await zugangLesen(request) : undefined;
    const { kennung } = request.params;
    const modul = pool && istModulKennung(kennung) ? (await aktiveModule(pool)).find((eintrag) => eintrag.kennung === kennung) : undefined;
    if (pool === undefined || modul === undefined || !modulZugriffErlaubt(zugang, modul)) {
      request.log.warn('Module: Zugriff ohne Berechtigung abgewiesen');
      await nichtGefunden(app, reply);
      return undefined;
    }
    return { zugang, modul, pool };
  };
}

export function detailPfad(kennung: string, id: string): string {
  return `/module/${encodeURIComponent(kennung)}/${encodeURIComponent(id)}`;
}

export function seiteSenden(reply: FastifyReply, html: string): FastifyReply {
  return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
}

/** Eine Hinweisseite mit Status (`403` nicht erlaubt, `503` nicht verfügbar) und dem Weg zurück. */
export async function modulHinweisSenden(app: FastifyInstance, reply: FastifyReply, zugang: Zugang | undefined, status: 403 | 503, text: string, zurueck: string): Promise<FastifyReply> {
  const html = await app.render('benutzer-hinweis.eta', {
    titel: status === 403 ? 'Nicht erlaubt' : 'Nicht verfügbar',
    nav: navigationFuerZugang('module', zugang),
    text,
    zurueck,
  });
  return reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
}

/** Was eine Aktion an einem Vorgang nach den gemeinsamen Prüfungen in der Hand hat. */
export interface VorgangAktion {
  readonly zugang: Zugang | undefined;
  readonly modul: AktivesModul;
  readonly db: pg.Pool;
  readonly konto: string;
  readonly id: string;
  readonly detail: string;
}

export type VorgangAktionPruefen = (
  request: FastifyRequest<{ Params: { kennung: string; id: string } }>,
  reply: FastifyReply,
  erlaubt: (modul: AktivesModul) => boolean,
  bezeichnung: string,
) => Promise<VorgangAktion | undefined>;

/**
 * Die gemeinsamen ersten Prüfungen jeder Aktion an einem Vorgang (Sperre COPI-85, Freigabe COPI-90, Entscheidung
 * COPI-91): Zugriff auf das Modul, Konto, gültige `id`, Eingriff erlaubt (sonst die neutrale 404), die Herkunft und das
 * Recht zu handeln — ein Betreuer mit nur lesendem Zugriff, COPI-134 (sonst 403). `undefined`: die Antwort ist schon
 * gesendet.
 */
export function vorgangAktionPruefer(app: FastifyInstance, modulZiel: ModulZielFinder): VorgangAktionPruefen {
  return async (request, reply, erlaubt, bezeichnung) => {
    const ziel = await modulZiel(request, reply);
    if (ziel === undefined) {
      return undefined;
    }
    const { zugang, modul, pool: db } = ziel;
    const { id } = request.params;
    const konto = zugang?.benutzerId;
    if (konto === undefined || modul.block.ansicht === ANSICHT_KENNZAHLEN || id.length === 0 || id.length > VORGANG_ID_HOECHSTENS || !erlaubt(modul)) {
      request.log.warn(`${bezeichnung}: abgewiesen (Konto, Vorgang oder Eingriff)`);
      await nichtGefunden(app, reply);
      return undefined;
    }
    const detail = detailPfad(modul.kennung, id);
    const { origin, referer, host } = request.headers;
    if (!herkunftBelegt(origin, referer, host)) {
      request.log.warn(`${bezeichnung}: Herkunft fehlt oder ist fremd`);
      await modulHinweisSenden(app, reply, zugang, 403, HERKUNFT_FEHLER, detail);
      return undefined;
    }
    if (!modulHandelnErlaubt(zugang, modul)) {
      request.log.warn(`${bezeichnung}: nur lesender Betreuer-Zugriff`);
      await modulHinweisSenden(app, reply, zugang, 403, NUR_LESEN_FEHLER, detail);
      return undefined;
    }
    return { zugang, modul, db, konto, id, detail };
  };
}

/** Die Antwort auf eine Aktion des Betreuers, dem der Kunde nur Lesen freigegeben hat (COPI-134). */
export const NUR_LESEN_FEHLER =
  'Für dieses Modul hat der Betriebs-Admin dir nur Lesen freigegeben. Es wurde nichts geändert; entscheiden kannst du erst, wenn er unter Einstellungen „Lesen und entscheiden“ wählt.';

/** Die Antwort auf eine Aktion ohne belegte Herkunft. */
export const HERKUNFT_FEHLER = 'Die Anfrage kam nicht von dieser Seite. Es wurde nichts geändert.';
