/**
 * Wer ein Modul sehen darf (COPI-78): Sitzung und zweiter Faktor wie bei jeder anderen Seite, dazu die Rolle
 * im Block. Der Betreuer sieht ein technisches Modul (`art: betrieb`) immer, ein Fachmodul nur mit dem Zugriff, den der
 * Kunde freigegeben hat (COPI-134, `betreuer-zugriff.ts`); `rollen` im Block gilt für ihn nicht. **Dieselbe Regel** filtert die Navigation, die Liste unter
 * `/module` und jede einzelne Modul- bzw. Detailseite: eine unbekannte Kennung, ein inaktives Modul, eine
 * fehlende Rolle und eine abgelaufene Sitzung enden alle in derselben neutralen 404 — nicht in vieren.
 *
 * `zugangLesenMitModulen` reichert einen bestehenden `ZugangLesen` automatisch um `moduleSichtbar` und die angehefteten
 * Module (`moduleAngeheftet`, COPI-121, aus derselben Abfrage) an, genau
 * wie `chatUngelesen` (COPI-53): jede Seite bekommt die richtige Navigation, ohne dass ihre Route etwas davon
 * wissen muss. Das sitzt hier und nicht in `auth/berechtigung.ts`, weil `module/block.ts` bereits von dort
 * importiert (`ALLE_ROLLEN`, `ROLLE_BETREUER`) — ein Import in der Gegenrichtung wäre ein Ringschluss.
 *
 * Die Registry wird bei jedem Aufruf frisch gelesen, nie zwischengespeichert (ADR: ein Modul-Update wirkt
 * ohne Neustart). Scheitert das Lesen der Registry (z. B. eine kaputte Datenbankverbindung), gilt „kein
 * Modul sichtbar" statt eines Fehlers auf jeder einzelnen Seite der Anwendung — die Navigation ist eine
 * Randnotiz, kein Grund, das ganze Cockpit unbenutzbar zu machen.
 */
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ROLLE_BETREUER, type AngeheftetesModul, type Zugang, type ZugangLesen } from '../auth/berechtigung.js';
import { istBetriebsmodul, NAVIGATION_HAUPT } from './block.js';
import { aktiveModule, type AktivesModul } from './modul-speicher.js';

/** Was die Regel von einem Modul braucht: den Block und den Betreuer-Zugriff. */
export type SichtbaresModul = Pick<AktivesModul, 'block' | 'betreuerZugriff'>;

/** Nur die Warnung, die ein Fastify-Logger ohnehin trägt — kein eigenes Interface je Aufrufer. */
interface Meldung {
  warn(objekt: { grund: string }, nachricht: string): void;
}

/** Darf dieser Zugang dieses Modul sehen? Ohne Sitzung oder ohne aktiven zweiten Faktor: nie. */
export function modulZugriffErlaubt(zugang: Zugang | undefined, modul: SichtbaresModul): boolean {
  if (zugang === undefined || zugang.angemeldet !== true || zugang.zweiterFaktorAktiv !== true) {
    return false;
  }
  if (zugang.rolle === ROLLE_BETREUER) {
    return istBetriebsmodul(modul.block) || modul.betreuerZugriff !== 'aus';
  }
  return zugang.rolle !== undefined && (modul.block.rollen as readonly string[]).includes(zugang.rolle);
}

/**
 * Darf dieser Zugang in diesem Modul handeln — übernehmen, freigeben, entscheiden (COPI-134)? Jeder, der es sieht, außer
 * dem Betreuer mit nur lesendem Zugriff auf ein Fachmodul. Welcher Eingriff erlaubt ist, sagt weiter der Block.
 */
export function modulHandelnErlaubt(zugang: Zugang | undefined, modul: SichtbaresModul): boolean {
  if (!modulZugriffErlaubt(zugang, modul)) {
    return false;
  }
  return zugang?.rolle !== ROLLE_BETREUER || istBetriebsmodul(modul.block) || modul.betreuerZugriff === 'entscheiden';
}

/** Was die Navigation über die Module weiß: ob überhaupt eins sichtbar ist und welche angeheftet sind. */
export interface ModulNavigation {
  readonly sichtbar: boolean;
  readonly angeheftet: readonly AngeheftetesModul[];
}

const KEINE_MODULE: ModulNavigation = { sichtbar: false, angeheftet: [] };

/** Die Module der Navigation für diesen Zugang (COPI-78, COPI-121) — eine Abfrage der Registry für beides. */
export async function modulNavigationLesen(pool: pg.Pool, zugang: Zugang, log?: Meldung): Promise<ModulNavigation> {
  if (zugang.angemeldet !== true || zugang.zweiterFaktorAktiv !== true) {
    return KEINE_MODULE;
  }
  try {
    const sichtbar = (await aktiveModule(pool)).filter((modul) => modulZugriffErlaubt(zugang, modul));
    return {
      sichtbar: sichtbar.length > 0,
      angeheftet: sichtbar
        .filter((modul) => modul.block.navigation === NAVIGATION_HAUPT)
        .map((modul) => ({ kennung: modul.kennung, menuename: modul.block.menuename }))
        .sort((a, b) => a.menuename.localeCompare(b.menuename, 'de')),
    };
  } catch (fehler) {
    log?.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Modul-Navigation: Registry konnte nicht gelesen werden');
    return KEINE_MODULE;
  }
}

/** Wie `zugangLesen`, aber mit `moduleSichtbar` und `moduleAngeheftet` ergänzt (siehe Kopf). */
export function zugangLesenMitModulen(basis: ZugangLesen, pool: pg.Pool): ZugangLesen {
  return async (request: FastifyRequest): Promise<Zugang> => {
    const zugang = await basis(request);
    const { sichtbar, angeheftet } = await modulNavigationLesen(pool, zugang, request.log);
    return { ...zugang, moduleSichtbar: sichtbar, moduleAngeheftet: angeheftet };
  };
}
