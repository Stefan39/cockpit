/**
 * Die Daten des Dashboards der Übersicht (COPI-81): welche Module mit `uebersicht:` dieser Zugang sieht, ihre
 * Zeilen und ihr Verlauf. Gerechnet wird in `uebersicht-karten.ts`.
 *
 * **Dieselbe Sichtbarkeit wie die Modulseiten** (`sichtbarkeit.ts`): der Betreuer sieht alles, sonst entscheiden
 * die `rollen` des Blocks. Ein Modul, das die Rolle nicht sehen darf, wird gar nicht erst gelesen.
 *
 * **Dieselben Absicherungen wie `liste-detail.ts`:** vor jedem Lesen erneut die Katalogprüfung (für die
 * Verlaufs-View `verlaufViewPruefen`), eine eigene lesende Transaktion mit 2 s Timeout (`modulLesen`), Bezeichner
 * nur aus dem geprüften Block über `escapeIdentifier`, Werte nur als Parameter. Scheitert der Verlauf, erscheinen
 * die Karten trotzdem, nur die Bänder bleiben neutral; der Grund steht im Log, nie auf der Seite.
 */
import pg from 'pg';
import type { Zugang } from '../auth/berechtigung.js';
import { BEFUND_STATUS, type BefundStatus } from '../status/zustand.js';
import { berlinerTag } from '../chat/tageslimit.js';
import { ANSICHT_KENNZAHLEN, ANSICHT_LISTE_DETAIL, UEBERSICHT_REIHENFOLGE_STANDARD, type ModulBlock } from './block.js';
import { kennzahlenKarte, type KennzahlenKarte } from './kennzahlen-ansicht.js';
import { hinweiseLesen, kennzahlenKarteLesen } from './kennzahlen-lesen.js';
import { kartenSpannen } from './kennzahlen-zeitraum.js';
import { zahlAus } from './messwert-kurve.js';
import { modulLesen, modulListeLesen, type Meldung, type ModulLeseErgebnis } from './liste-detail.js';
import { aktiveModule } from './modul-speicher.js';
import { verlaufViewPruefen } from './registry.js';
import { modulZugriffErlaubt } from './sichtbarkeit.js';
import type { ModulMitKarten } from './uebersicht-karten.js';
import { aktiveSperren } from './vorgang-sperre.js';
import { STUNDE_MS, type VerlaufPunkt } from './zeitraster.js';

const { escapeIdentifier } = pg;

/** Obergrenze der Verlaufszeilen je Modul (sieben Tage, 24 Karten): schützt Speicher und Antwortzeit. */
export const VERLAUF_ZEILEN_HOECHSTENS = 20_000;

/** So weit reicht der Verlauf zurück: die sieben Tage des Wochendiagramms (auch die Übernahme ins 24-Std.-Band). */
const VERLAUF_TAGE = 7;

interface VerlaufZeile {
  readonly id: string;
  readonly zeitpunkt: Date;
  readonly status: string;
  /** Nur, wenn die Verlaufs-View die optionale Spalte `wert` trägt (COPI-83); `pg` liefert `numeric` als Text. */
  readonly wert?: string | null;
}

function istStatus(wert: string): wert is BefundStatus {
  return (BEFUND_STATUS as readonly string[]).includes(wert);
}

/**
 * Der Verlauf der genannten `ids` seit `jetzt − 7 Tage`, je `id` aufsteigend nach Zeit. Ein Status außerhalb von
 * gruen/gelb/rot (ein Fehler in der Fach-View) wird übergangen statt geraten. Trägt die View die optionale Spalte
 * `wert` (COPI-83), bekommt jeder Punkt seinen Wert mit — ein `NULL` bleibt ohne und unterbricht die Kurve.
 */
export async function modulVerlaufLesen(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  ids: readonly string[],
  jetzt: Date,
  log?: Meldung,
): Promise<ModulLeseErgebnis<ReadonlyMap<string, readonly VerlaufPunkt[]>>> {
  const verlauf = block.uebersicht?.verlauf;
  if (verlauf === undefined) {
    return { ok: false, grund: 'ohne-verlauf' };
  }
  const seit = new Date(jetzt.getTime() - VERLAUF_TAGE * 24 * STUNDE_MS);
  return modulLesen(pool, kennung, () => verlaufViewPruefen(pool, block), log, 'Verlauf konnte nicht gelesen werden', async (client, optionale) => {
    const mitWert = optionale.includes('wert');
    const ergebnis = await client.query<VerlaufZeile>(
      `SELECT id, zeitpunkt, status${mitWert ? ', wert' : ''} FROM cockpit.${escapeIdentifier(verlauf)}
        WHERE zeitpunkt >= $1 AND id = ANY($2::text[])
        ORDER BY id, zeitpunkt
        LIMIT ${String(VERLAUF_ZEILEN_HOECHSTENS)}`,
      [seit, [...ids]],
    );
    const nachId = new Map<string, VerlaufPunkt[]>();
    for (const zeile of ergebnis.rows) {
      if (istStatus(zeile.status)) {
        const punkte = nachId.get(zeile.id) ?? [];
        const wert = zahlAus(zeile.wert);
        punkte.push(wert === undefined ? { zeitpunkt: zeile.zeitpunkt, status: zeile.status } : { zeitpunkt: zeile.zeitpunkt, status: zeile.status, wert });
        nachId.set(zeile.id, punkte);
      }
    }
    return nachId;
  });
}

/**
 * Die für diesen Zugang sichtbaren aktiven Module mit `uebersicht:`, mit Zeilen und Verlauf. Nacheinander gelesen,
 * nicht parallel: das Dashboard soll den Pool nicht mit einer Anfrage leerziehen. Ist die Registry nicht lesbar,
 * gilt „kein Modul" — die Übersicht fällt dann auf ihr bisheriges Bild zurück, statt zu scheitern.
 */
export async function dashboardModuleLesen(pool: pg.Pool, zugang: Zugang | undefined, jetzt: Date, log?: Meldung): Promise<ModulMitKarten[]> {
  let module;
  try {
    module = await aktiveModule(pool);
  } catch (fehler) {
    log?.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Übersicht: Registry konnte nicht gelesen werden');
    return [];
  }
  const ergebnis: ModulMitKarten[] = [];
  for (const modul of module) {
    // Kennzahlen-Module (COPI-98) haben keine Zeilen mit Zustand: ihre Karte liest `kennzahlenKartenLesen`.
    if (modul.block.uebersicht === undefined || modul.block.ansicht !== ANSICHT_LISTE_DETAIL || !modulZugriffErlaubt(zugang, modul)) {
      continue;
    }
    const liste = await modulListeLesen(pool, modul.kennung, modul.block, log);
    if (!liste.ok) {
      ergebnis.push({ kennung: modul.kennung, block: modul.block, zeilen: undefined, verlauf: undefined });
      continue;
    }
    const ids = liste.wert.map((zeile) => String(zeile.werte.id));
    const verlauf = await modulVerlaufLesen(pool, modul.kennung, modul.block, ids, jetzt, log);
    // Die Übernahmen (COPI-85) aller Karten des Moduls in einer Abfrage — für die Marke „übernommen · …".
    const sperren = await aktiveSperren(pool, modul.kennung, ids);
    ergebnis.push({ kennung: modul.kennung, block: modul.block, zeilen: liste.wert, verlauf: verlauf.ok ? verlauf.wert : undefined, sperren });
  }
  return ergebnis;
}

/**
 * Die Karten der für diesen Zugang sichtbaren aktiven Kennzahlen-Module mit `uebersicht:` (COPI-98): der Hauptwert
 * des laufenden Monats, der Vormonat, die letzten 30 Tage und die Hinweise. Nacheinander gelesen wie oben; ist die
 * Registry nicht lesbar, gibt es keine Karten. Sortiert nach `reihenfolge`, dann nach Titel.
 */
export async function kennzahlenKartenLesen(pool: pg.Pool, zugang: Zugang | undefined, jetzt: Date, log?: Meldung): Promise<KennzahlenKarte[]> {
  let module;
  try {
    module = await aktiveModule(pool);
  } catch (fehler) {
    log?.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Übersicht: Registry konnte nicht gelesen werden');
    return [];
  }
  const heute = berlinerTag(jetzt);
  const spannen = kartenSpannen(heute);
  const karten: KennzahlenKarte[] = [];
  for (const modul of module) {
    const { block, kennung } = modul;
    if (block.uebersicht === undefined || block.ansicht !== ANSICHT_KENNZAHLEN || !modulZugriffErlaubt(zugang, modul)) {
      continue;
    }
    const daten = await kennzahlenKarteLesen(pool, kennung, block, spannen, log);
    const hinweise = daten.ok ? await hinweiseLesen(pool, kennung, block, log) : undefined;
    karten.push(
      kennzahlenKarte(
        kennung,
        block,
        heute,
        spannen.verlauf,
        daten.ok ? daten.wert : undefined,
        hinweise?.ok === true ? hinweise.wert : [],
        block.uebersicht.reihenfolge ?? UEBERSICHT_REIHENFOLGE_STANDARD,
      ),
    );
  }
  return karten.sort((a, b) => a.reihenfolge - b.reihenfolge || a.titel.localeCompare(b.titel, 'de'));
}
