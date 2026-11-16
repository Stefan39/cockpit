/**
 * Der Hinweis „Update verfügbar" neben der Cockpit-Version (COPI-84) — nur für Konten mit `technik_sehen` (Betreuer).
 *
 * **Warum nicht für die Kundenrollen.** ADR 13.1 gibt der Kundensicht nur die Sätze „Aktuell./Update angefragt./Update
 * fehlgeschlagen" und lädt nie Daten der Versions-Wache (`versionen-speicher.ts`). Ein Hinweis mit dem Text der Wache
 * wäre ein Rohbefund; er wird für Kundenrollen deshalb nicht einmal abgefragt.
 *
 * **Dieselbe Quelle wie die Karte „Versionen"** der Einstellungen: der jüngste Befund der Wache `VERSIONS_WACHE`; gelb
 * heißt „Update verfügbar". Wie `moduleSichtbar` (COPI-78) reichert ein Wrapper um den Zugangsleser den Zugang an, damit
 * keine Route etwas davon wissen muss. Scheitert die Abfrage, gibt es einen Warnhinweis im Log und keinen Hinweis — nie
 * eine Fehlerseite: die Anzeige ist eine Randnotiz.
 *
 * **Der Hinweispunkt an „Einstellungen" (COPI-140)** folgt denselben Karten wie die Seite: er steht genau dann, wenn
 * mindestens eine Karte „Update installieren" anbietet (`betreuerVersionen`). So zeigt er nichts an, was dort schon
 * beantragt, eingespielt oder nur per Server-Konsole möglich ist.
 */
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hatRecht, type Zugang, type ZugangLesen } from '../auth/berechtigung.js';
import { betreuerVersionenLesen } from './versionen-speicher.js';
import { betreuerVersionen, VERSIONS_WACHE } from './versionen.js';

interface Meldung {
  warn(objekt: { grund: string }, nachricht: string): void;
}

export async function updateHinweisLesen(pool: pg.Pool, zugang: Zugang, log?: Meldung): Promise<{ readonly text: string } | undefined> {
  if (zugang.angemeldet !== true || zugang.zweiterFaktorAktiv !== true || !hatRecht(zugang, 'technik_sehen')) {
    return undefined;
  }
  try {
    const ergebnis = await pool.query<{ status: string; text_intern: string }>(
      `SELECT status, text_intern FROM cockpit.befund WHERE wache = $1 ORDER BY id DESC LIMIT 1`,
      [VERSIONS_WACHE],
    );
    const zeile = ergebnis.rows[0];
    return zeile?.status === 'gelb' ? { text: zeile.text_intern } : undefined;
  } catch (fehler) {
    log?.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Update-Hinweis: Befund der Versions-Wache konnte nicht gelesen werden');
    return undefined;
  }
}

/** Ob mindestens eine Karte „Update installieren" anbietet (COPI-140); nur mit `technik_sehen`, sonst nie. */
export async function updateInstallierbarLesen(pool: pg.Pool, zugang: Zugang, jetzt: Date, log?: Meldung): Promise<boolean> {
  if (zugang.angemeldet !== true || zugang.zweiterFaktorAktiv !== true || !hatRecht(zugang, 'technik_sehen')) {
    return false;
  }
  try {
    const versionen = betreuerVersionen(await betreuerVersionenLesen(pool, jetzt), jetzt);
    return [...versionen.bereiche, ...versionen.module].some((bereich) => bereich.update !== undefined);
  } catch (fehler) {
    log?.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Update-Hinweis: Versionen konnten nicht gelesen werden');
    return false;
  }
}

/** Wie `zugangLesen`, aber mit `updateVerfuegbar` und `updateInstallierbar` ergänzt (siehe Kopf). */
export function zugangLesenMitUpdateHinweis(basis: ZugangLesen, pool: pg.Pool, jetzt: () => Date = () => new Date()): ZugangLesen {
  return async (request: FastifyRequest): Promise<Zugang> => {
    const zugang = await basis(request);
    const [hinweis, installierbar] = await Promise.all([
      updateHinweisLesen(pool, zugang, request.log),
      updateInstallierbarLesen(pool, zugang, jetzt(), request.log),
    ]);
    return {
      ...zugang,
      ...(hinweis === undefined ? {} : { updateVerfuegbar: hinweis }),
      ...(installierbar ? { updateInstallierbar: true } : {}),
    };
  };
}
