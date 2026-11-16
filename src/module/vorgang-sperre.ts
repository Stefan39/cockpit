/**
 * Die Übernahme-Sperre (COPI-85, Migration 0030): Ein Mensch übernimmt einen Vorgang, die Agenten antworten dort nicht
 * mehr, bis er ihn zurückgibt. Ein Vorgang ist eine Zeile einer Modul-View — (Modul-Kennung, `id`) —, kein eigenes
 * Modell.
 *
 * **Wirkt sofort.** Übernehmen ist kein Antrag über `cockpit.eingriff` und die Freigabekette (ADR 13.1), sondern eine
 * Zeile in `cockpit.vorgang_sperre`, geschrieben in derselben Transaktion wie ihr Protokolleintrag: beides gilt oder
 * keins. Die Agenten fragen die Sperre selbst ab (`GET /intern/vorgaenge/sperre`, `intern/vorgaenge.ts`); das Cockpit
 * schickt ihnen nichts.
 *
 * **Gleichzeitig übernehmen: genau einer gewinnt.** Die Datenbank hält „höchstens eine aktive Sperre je Vorgang"
 * (partieller Unique-Index `vorgang_sperre_eine_aktive`). `INSERT … ON CONFLICT DO NOTHING` wartet, bis eine
 * gleichzeitige Übernahme entschieden ist, und legt dann entweder die eigene Zeile an oder nichts — nie einen Fehler,
 * nie zwei Zeilen. Wer nichts angelegt hat, liest die gewinnende Sperre und bekommt „schon gesperrt" mit Name und
 * Zeitpunkt. Wird sie genau dazwischen zurückgegeben, versucht es der Ablauf noch einmal (höchstens `VERSUCHE`-mal).
 *
 * **Zurückgeben** darf, wer übernommen hat, dazu Betriebs-Admin und Betreuer immer (`darfZurueckgeben`). Die Zeile wird
 * dafür gesperrt (`FOR UPDATE`) und die Regel in derselben Transaktion geprüft, in der zurückgegeben wird. Ein
 * Mitarbeiter kann die Sperre eines anderen nicht lösen. Es gibt keinen automatischen Ablauf.
 *
 * **Name aus dem Konto, nie die Adresse.** Wer übernommen hat, erscheint mit seinem Anzeigenamen; ein als gelöscht
 * markiertes Konto als „ehemaliges Konto" (COPI-62).
 */
import type pg from 'pg';
import { ROLLE_ADMIN, ROLLE_BETREUER, type Zugang } from '../auth/berechtigung.js';
import { protokollSchreiben, type Abfrager } from '../auth/protokoll.js';
import { zeitText } from '../chat/ansicht.js';
import { inTransaktion } from '../datenbank/transaktion.js';

/** So heißt ein als gelöscht markiertes (oder fehlendes) Konto in der Oberfläche und in der Agenten-API. */
export const EHEMALIGES_KONTO = 'ehemaliges Konto';

/** Höchstlänge einer Vorgangs-`id` — wie die Adresse der Detailseite (COPI-78) und die Bedingung in Migration 0030. */
export const VORGANG_ID_HOECHSTENS = 200;

/** So oft versucht `uebernehmen` es, wenn eine gewinnende Sperre genau dazwischen zurückgegeben wurde. */
const VERSUCHE = 3;

/** Eine aktive Sperre, wie Oberfläche und Agenten-API sie brauchen. */
export interface VorgangSperre {
  readonly id: number;
  readonly vorgangId: string;
  /** Konto-ID — nur für die Rechteprüfung, nie in einer Antwort. */
  readonly uebernommenVon: string;
  /** Aus dem Konto; gelöscht oder fehlend: `EHEMALIGES_KONTO`. Nie die E-Mail. */
  readonly anzeigename: string;
  readonly uebernommenAm: Date;
}

/** Wer handelt: Konto-ID und die frisch gelesene Rolle (`zugangLesen`). */
export interface Handelnder {
  readonly id: string;
  readonly rolle: Zugang['rolle'];
}

export interface Vorgang {
  readonly modul: string;
  readonly vorgangId: string;
}

export type UebernahmeErgebnis =
  | { readonly ok: true; readonly sperre: VorgangSperre }
  | { readonly ok: false; readonly grund: 'schon_gesperrt'; readonly sperre: VorgangSperre };

export type RueckgabeErgebnis =
  | { readonly ok: true }
  | { readonly ok: false; readonly grund: 'nicht_gesperrt' }
  | { readonly ok: false; readonly grund: 'nicht_erlaubt'; readonly sperre: VorgangSperre };

interface SperrZeile {
  readonly id: number;
  readonly vorgang_id: string;
  readonly uebernommen_von: string;
  readonly uebernommen_am: Date;
  readonly name: string | null;
  readonly geloescht: boolean | null;
}

/** Die aktiven Sperren mit Anzeigename, ein `LEFT JOIN`: ein fehlendes Konto wird zum „ehemaligen Konto". */
const AKTIVE_SPERREN_SQL = `
  SELECT s.id::int AS id, s.vorgang_id, s.uebernommen_von, s.uebernommen_am, u.name, u.geloescht_am IS NOT NULL AS geloescht
    FROM cockpit.vorgang_sperre s
    LEFT JOIN cockpit."user" u ON u.id = s.uebernommen_von
   WHERE s.modul_kennung = $1 AND s.vorgang_id = ANY($2::text[]) AND s.zurueckgegeben_am IS NULL`;

function sperreAus(zeile: SperrZeile): VorgangSperre {
  const name = zeile.name?.trim() ?? '';
  return {
    id: zeile.id,
    vorgangId: zeile.vorgang_id,
    uebernommenVon: zeile.uebernommen_von,
    anzeigename: zeile.geloescht === false && name !== '' ? name : EHEMALIGES_KONTO,
    uebernommenAm: zeile.uebernommen_am,
  };
}

/**
 * Die aktiven Sperren der genannten Vorgänge eines Moduls — **eine** Abfrage für eine ganze Liste oder alle Kacheln,
 * nicht eine je Zeile. Vorgang-`id` → Sperre; ein freier Vorgang fehlt in der Karte.
 */
export async function aktiveSperren(db: Abfrager, modul: string, vorgangIds: readonly string[]): Promise<ReadonlyMap<string, VorgangSperre>> {
  if (vorgangIds.length === 0) {
    return new Map();
  }
  const ergebnis = await db.query<SperrZeile>(AKTIVE_SPERREN_SQL, [modul, [...vorgangIds]]);
  return new Map(ergebnis.rows.map((zeile) => [zeile.vorgang_id, sperreAus(zeile)]));
}

/** Die aktive Sperre eines Vorgangs, oder `undefined`, wenn er frei ist. */
export async function sperreLesen(db: Abfrager, vorgang: Vorgang): Promise<VorgangSperre | undefined> {
  return (await aktiveSperren(db, vorgang.modul, [vorgang.vorgangId])).get(vorgang.vorgangId);
}

/** Wer eine Sperre lösen darf: wer übernommen hat, dazu Betriebs-Admin und Betreuer immer (Entscheidung Stefan). */
export function darfZurueckgeben(handelnder: Handelnder, sperre: Pick<VorgangSperre, 'uebernommenVon'>): boolean {
  return handelnder.id === sperre.uebernommenVon || handelnder.rolle === ROLLE_ADMIN || handelnder.rolle === ROLLE_BETREUER;
}

/**
 * Übernimmt einen Vorgang: eine neue aktive Sperre und der Eintrag `vorgang_uebernommen` in einer Transaktion. Ist er
 * schon gesperrt (auch von derselben Person), ändert sich nichts, und das Ergebnis nennt die bestehende Sperre.
 */
export async function uebernehmen(pool: pg.Pool, vorgang: Vorgang, handelnder: Handelnder): Promise<UebernahmeErgebnis> {
  for (let versuch = 1; versuch <= VERSUCHE; versuch += 1) {
    const angelegt = await inTransaktion(pool, async (client) => {
      const zeile = await client.query<{ id: number }>(
        `INSERT INTO cockpit.vorgang_sperre (modul_kennung, vorgang_id, uebernommen_von)
         VALUES ($1, $2, $3)
         ON CONFLICT (modul_kennung, vorgang_id) WHERE zurueckgegeben_am IS NULL DO NOTHING
         RETURNING id::int AS id`,
        [vorgang.modul, vorgang.vorgangId, handelnder.id],
      );
      const id = zeile.rows[0]?.id;
      if (id === undefined) {
        return undefined;
      }
      await protokollSchreiben(client, { art: 'vorgang_uebernommen', akteur: handelnder.id, einzelheiten: { vorgang_sperre_id: id } });
      return sperreLesen(client, vorgang);
    });
    if (angelegt !== undefined) {
      return { ok: true, sperre: angelegt };
    }
    // Eine andere Übernahme hat gewonnen (die Datenbank hat auf sie gewartet): sie ist jetzt sichtbar — es sei denn,
    // sie wurde schon wieder zurückgegeben; dann noch einmal versuchen.
    const bestehend = await sperreLesen(pool, vorgang);
    if (bestehend !== undefined) {
      return { ok: false, grund: 'schon_gesperrt', sperre: bestehend };
    }
  }
  throw new Error('Übernahme-Sperre: Vorgang nach mehreren Versuchen weder frei noch gesperrt');
}

/**
 * Gibt einen Vorgang zurück: die aktive Sperre bekommt Rückgeber und Zeitpunkt, dazu der Eintrag
 * `vorgang_zurueckgegeben` (Ziel: wer übernommen hatte) — in einer Transaktion, die Zeile dabei gesperrt, damit die
 * Rechteprüfung zur Sperre passt, die zurückgegeben wird.
 */
export async function zurueckgeben(pool: pg.Pool, vorgang: Vorgang, handelnder: Handelnder): Promise<RueckgabeErgebnis> {
  // Ohne Änderung (frei, nicht erlaubt) schreibt die Transaktion nichts; sie endet trotzdem ordentlich.
  const ergebnis = await inTransaktion<RueckgabeErgebnis>(pool, async (client) => {
    const gesperrt = await client.query<SperrZeile>(`${AKTIVE_SPERREN_SQL} FOR UPDATE OF s`, [vorgang.modul, [vorgang.vorgangId]]);
    const zeile = gesperrt.rows[0];
    if (zeile === undefined) {
      return { ok: false, grund: 'nicht_gesperrt' };
    }
    const sperre = sperreAus(zeile);
    if (!darfZurueckgeben(handelnder, sperre)) {
      return { ok: false, grund: 'nicht_erlaubt', sperre };
    }
    await client.query(`UPDATE cockpit.vorgang_sperre SET zurueckgegeben_von = $2, zurueckgegeben_am = now() WHERE id = $1`, [
      sperre.id,
      handelnder.id,
    ]);
    await protokollSchreiben(client, {
      art: 'vorgang_zurueckgegeben',
      akteur: handelnder.id,
      ziel: sperre.uebernommenVon,
      einzelheiten: { vorgang_sperre_id: sperre.id },
    });
    return { ok: true };
  });
  return ergebnis ?? { ok: false, grund: 'nicht_gesperrt' };
}

/** Die Sperre, wie Liste, Kachel, Dashboard-Karte und Detailseite sie zeigen. */
export interface SperrMarke {
  /** Anzeigename, etwa „Stefan Jacomeit" (Band der Detailseite). */
  readonly name: string;
  /** Das erste Wort des Namens (Marke „übernommen · Stefan"); beim ehemaligen Konto der ganze Text. */
  readonly vorname: string;
  /** „heute, 14:02" bzw. „27.09., 14:02" — das Band der Detailseite (Europe/Berlin). */
  readonly seit: string;
  /** „14:02" bzw. „27.09., 14:02" (`zeitText`) — die Marke der Kachel. */
  readonly seitKurz: string;
}

export function sperrMarke(sperre: VorgangSperre, jetzt: Date): SperrMarke {
  const vorname = sperre.anzeigename === EHEMALIGES_KONTO ? EHEMALIGES_KONTO : (sperre.anzeigename.split(/\s+/)[0] ?? sperre.anzeigename);
  const seitKurz = zeitText(sperre.uebernommenAm, jetzt);
  // `zeitText` nennt beim heutigen Tag nur die Uhrzeit; im Satz „übernommen seit …" braucht es das „heute".
  return { name: sperre.anzeigename, vorname, seit: seitKurz.includes(',') ? seitKurz : `heute, ${seitKurz}`, seitKurz };
}

/** Die Marke einer Zeile aus den gelesenen Sperren, oder `undefined`, wenn die Zeile frei ist. */
export function sperrMarkeFuer(sperren: ReadonlyMap<string, VorgangSperre> | undefined, id: string, jetzt: Date): SperrMarke | undefined {
  const sperre = sperren?.get(id);
  return sperre === undefined ? undefined : sperrMarke(sperre, jetzt);
}
