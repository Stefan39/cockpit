/**
 * Betreuer-Zugriff auf Fachmodule (COPI-134, Entscheidung Stefan 09.10.2026). In einer Kundeninstanz ist der Kunde
 * Betriebs-Admin und Verantwortlicher für seine Daten, Stefan der Betreuer. Ob der Betreuer die Fachdaten eines Moduls
 * sieht, legt der Betriebs-Admin je Modul fest:
 *
 *   * `aus` — Standard: das Modul ist für den Betreuer überall unsichtbar (dieselbe neutrale 404 wie ohne Rolle);
 *   * `lesen` — er sieht Liste, Detail, Anhänge und Übersicht, aber ohne Aktionen;
 *   * `entscheiden` — dazu übernehmen, freigeben, entscheiden wie ein Betriebs-Admin.
 *
 * Module mit `art: betrieb` (Server-Zustand, KI-Verbrauch) betrifft das nicht; der Betreuer sieht sie immer
 * (`sichtbarkeit.ts`). Gesetzt wird über die Einstellungen (nur Recht `betreuer_zugriff_freigeben`, also nie der
 * Betreuer selbst) oder über das Server-Kommando `modul-freigabe` für eine Instanz ohne Kunden-Admin (Stefans eigene).
 * Jede Änderung ist eine neue Zeile (Migration 0048, nur anhängen) und ein Protokolleintrag in derselben Transaktion.
 */
import type pg from 'pg';
import { protokollSchreiben, type Abfrager } from '../auth/protokoll.js';
import { inTransaktion } from '../datenbank/transaktion.js';

export const BETREUER_ZUGRIFF_STUFEN = ['aus', 'lesen', 'entscheiden'] as const;

export type BetreuerZugriff = (typeof BETREUER_ZUGRIFF_STUFEN)[number];

/** Ohne Zeile gilt `aus`. */
export const BETREUER_ZUGRIFF_STANDARD: BetreuerZugriff = 'aus';

/** So heißen die Stufen in der Oberfläche und in der Ausgabe des Server-Kommandos. */
export const BETREUER_ZUGRIFF_TEXT: Readonly<Record<BetreuerZugriff, string>> = {
  aus: 'Kein Zugriff',
  lesen: 'Lesen',
  entscheiden: 'Lesen und entscheiden',
};

export function istBetreuerZugriff(wert: unknown): wert is BetreuerZugriff {
  return typeof wert === 'string' && (BETREUER_ZUGRIFF_STUFEN as readonly string[]).includes(wert);
}

/** Die jüngste Zeile je Modul, als SQL-Ausdruck für `aktiveModule` und die Einstellungen — eine Quelle für beide. */
export const JUENGSTER_ZUGRIFF = `
  SELECT DISTINCT ON (modul_kennung) id, modul_kennung, stufe, weg, gesetzt_von, gesetzt_am
    FROM cockpit.modul_betreuer_zugriff
   ORDER BY modul_kennung, id DESC`;

/** Wer zuletzt gesetzt hat: für die Einstellungen. */
export interface BetreuerZugriffStand {
  readonly stufe: BetreuerZugriff;
  readonly weg: 'oberflaeche' | 'konsole' | 'migration';
  /** Name des Kontos, nur bei `oberflaeche`. */
  readonly von: string | undefined;
  readonly am: Date;
}

/** Der jüngste Stand je Modul-Kennung. Ein Modul ohne Zeile fehlt (es gilt `aus`). */
export async function betreuerZugriffeLesen(db: Abfrager): Promise<ReadonlyMap<string, BetreuerZugriffStand>> {
  const ergebnis = await db.query<{ modul_kennung: string; stufe: string; weg: BetreuerZugriffStand['weg']; von: string | null; gesetzt_am: Date }>(
    `SELECT z.modul_kennung, z.stufe, z.weg, u.name AS von, z.gesetzt_am
       FROM (${JUENGSTER_ZUGRIFF}) z
       LEFT JOIN cockpit."user" u ON u.id = z.gesetzt_von`,
  );
  return new Map(
    ergebnis.rows.map((zeile) => [
      zeile.modul_kennung,
      { stufe: istBetreuerZugriff(zeile.stufe) ? zeile.stufe : BETREUER_ZUGRIFF_STANDARD, weg: zeile.weg, von: zeile.von ?? undefined, am: zeile.gesetzt_am },
    ]),
  );
}

export interface BetreuerZugriffSetzen {
  readonly kennung: string;
  readonly stufe: BetreuerZugriff;
  /** Das Konto in der Oberfläche; ohne Konto: das Server-Kommando (`konsole`). */
  readonly konto?: string;
}

export type BetreuerZugriffErgebnis =
  | { readonly ok: true; readonly status: 'gesetzt' | 'unveraendert'; readonly stufe: BetreuerZugriff }
  | { readonly ok: false; readonly grund: string };

/**
 * Setzt die Stufe für ein aktives Modul. Ein unbekanntes, inaktives oder technisches Modul (`art: betrieb`) wird
 * abgewiesen; dieselbe Stufe noch einmal ergibt keine neue Zeile. Zeile und Protokoll in einer Transaktion.
 */
export async function betreuerZugriffSetzen(pool: pg.Pool, eingabe: BetreuerZugriffSetzen): Promise<BetreuerZugriffErgebnis> {
  const ergebnis = await inTransaktion<BetreuerZugriffErgebnis>(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cockpit.modul_betreuer_zugriff:${eingabe.kennung}`]);
    const modul = await client.query<{ art: string | null }>(`SELECT block->>'art' AS art FROM cockpit.modul WHERE kennung = $1 AND aktiv = true`, [eingabe.kennung]);
    const zeile = modul.rows[0];
    if (zeile === undefined) {
      return { ok: false, grund: `Kein aktives Modul „${eingabe.kennung}“.` };
    }
    if (zeile.art === 'betrieb') {
      return { ok: false, grund: `„${eingabe.kennung}“ ist ein technisches Modul (art: betrieb); der Betreuer sieht es immer.` };
    }
    const bisher = await client.query<{ stufe: string }>(
      `SELECT stufe FROM cockpit.modul_betreuer_zugriff WHERE modul_kennung = $1 ORDER BY id DESC LIMIT 1`,
      [eingabe.kennung],
    );
    if ((bisher.rows[0]?.stufe ?? BETREUER_ZUGRIFF_STANDARD) === eingabe.stufe) {
      return { ok: true, status: 'unveraendert', stufe: eingabe.stufe };
    }
    const weg = eingabe.konto === undefined ? 'konsole' : 'oberflaeche';
    const eingefuegt = await client.query<{ id: string }>(
      `INSERT INTO cockpit.modul_betreuer_zugriff (modul_kennung, stufe, weg, gesetzt_von) VALUES ($1, $2, $3, $4) RETURNING id::text`,
      [eingabe.kennung, eingabe.stufe, weg, eingabe.konto ?? null],
    );
    await protokollSchreiben(client, {
      art: 'betreuer_zugriff_geaendert',
      akteur: eingabe.konto ?? 'konsole',
      einzelheiten: { betreuer_zugriff_id: Number(eingefuegt.rows[0]?.id), an: eingabe.stufe },
    });
    return { ok: true, status: 'gesetzt', stufe: eingabe.stufe };
  });
  // `inTransaktion` liefert `undefined` nur, wenn die Arbeit es tut — hier nie.
  return ergebnis ?? { ok: false, grund: 'Nicht gespeichert.' };
}
