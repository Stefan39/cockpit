/**
 * Die Eingriffe in der Datenbank, wie der Admin-Agent sie liest und weiterschaltet (COPI-41, Migration 0020).
 *
 * Ein Übergang läuft **in einer Transaktion mit seinem Protokolleintrag** — beides gilt oder keins. Die Zeile wird
 * dafür gesperrt (`FOR UPDATE`): zwei gleichzeitige Wechsel derselben Zeile laufen nacheinander, der zweite sieht den
 * neuen Status und scheitert als doppelter Wechsel, statt als Nichtstun durchzugehen.
 *
 * Die Regeln der Kette stehen in der Datenbank (`eingriff_pruefen`); hier stehen nur die Prüfungen, die eine Antwort
 * brauchen: gibt es die Zeile, steht sie dort, woher der Übergang führt, und lautet die Freigabe auf ihr Ziel.
 */
import type pg from 'pg';
import { protokollSchreiben, type Abfrager } from '../auth/protokoll.js';
import {
  AGENTEN_UEBERGAENGE,
  haengt,
  haengtGrenze,
  istEingriffStatus,
  OFFENE_STATUS,
  type AgentenZiel,
  type EingriffStatus,
} from './eingriff.js';
import { istAntragModus, type AntragModus } from './freigabe-modus.js';

/** Ein Eingriff, wie er gespeichert ist — ohne `beantragt_von`: wer beantragt hat, braucht hier niemand. */
export interface EingriffDaten {
  readonly id: number;
  readonly art: string;
  readonly status: EingriffStatus;
  /** Nur beim Cockpit-Image (`eingriff_art_passt`, 0040). */
  readonly zielDigest: string | undefined;
  /** Genau ab der Freigabe gesetzt, nur beim Cockpit-Image. */
  readonly zielVersion: string | undefined;
  /** Der Weg zurück beim Cockpit-Image. */
  readonly digestVorher: string | undefined;
  /** Nur beim Modul-Update (COPI-106): das Modul, der Commit in agent-blueprints und die Herkunft davor (Weg zurück). */
  readonly modulKennung: string | undefined;
  readonly zielCommit: string | undefined;
  readonly herkunftVorher: string | undefined;
  /** Was der Agent mit `fehlgeschlagen` als Grund nannte. */
  readonly fehlerGrund: string | undefined;
  /** Wie freigegeben wird, beim Antrag festgeschrieben (COPI-141). */
  readonly freigabeModus: AntragModus;
  /** Vom Cockpit selbst gestellt, im Freigabemodus `automatisch` (COPI-142); dann immer `direkt`. */
  readonly automatisch: boolean;
  readonly beantragtAm: Date;
  readonly freigegebenAm: Date | undefined;
  readonly laeuftSeit: Date | undefined;
  readonly abgeschlossenAm: Date | undefined;
}

/** Ein Eingriff, wie ihn der Admin-Agent sieht: dazu, ob er hängt. */
export interface Eingriff extends EingriffDaten {
  /** Abgeleitet, nie gespeichert (ADR 13.1). */
  readonly haengt: boolean;
}

interface Zeile {
  readonly id: number;
  readonly art: string;
  readonly status: string;
  readonly ziel_digest: string | null;
  readonly ziel_version: string | null;
  readonly digest_vorher: string | null;
  readonly modul_kennung: string | null;
  readonly ziel_commit: string | null;
  readonly herkunft_vorher: string | null;
  readonly fehler_grund: string | null;
  readonly freigabe_modus: string;
  readonly automatisch: boolean;
  readonly beantragt_am: Date;
  readonly freigegeben_am: Date | null;
  readonly laeuft_seit: Date | null;
  readonly abgeschlossen_am: Date | null;
}

const SPALTEN = `id::int AS id, art, status, ziel_digest, ziel_version, digest_vorher,
                 modul_kennung, ziel_commit, herkunft_vorher, fehler_grund, freigabe_modus, automatisch, beantragt_am, freigegeben_am, laeuft_seit, abgeschlossen_am`;

function datenLesen(zeile: Zeile): EingriffDaten {
  if (!istEingriffStatus(zeile.status) || !istAntragModus(zeile.freigabe_modus)) {
    // Die Datenbank lässt nur bekannte Werte zu; ein anderer wäre ein Fehler, kein Zustand.
    throw new Error('Unbekannter Status in der Datenbank');
  }
  return {
    id: zeile.id,
    art: zeile.art,
    status: zeile.status,
    zielDigest: zeile.ziel_digest ?? undefined,
    zielVersion: zeile.ziel_version ?? undefined,
    digestVorher: zeile.digest_vorher ?? undefined,
    modulKennung: zeile.modul_kennung ?? undefined,
    zielCommit: zeile.ziel_commit ?? undefined,
    herkunftVorher: zeile.herkunft_vorher ?? undefined,
    fehlerGrund: zeile.fehler_grund ?? undefined,
    freigabeModus: zeile.freigabe_modus,
    automatisch: zeile.automatisch,
    beantragtAm: zeile.beantragt_am,
    freigegebenAm: zeile.freigegeben_am ?? undefined,
    laeuftSeit: zeile.laeuft_seit ?? undefined,
    abgeschlossenAm: zeile.abgeschlossen_am ?? undefined,
  };
}

function zeileLesen(zeile: Zeile, jetzt: Date): Eingriff {
  const daten = datenLesen(zeile);
  return { ...daten, haengt: haengt(daten.status, daten.laeuftSeit, jetzt) };
}

/** Wonach sich die Liste filtern lässt: ein gespeicherter Status, alles Offene, oder was hängt. */
export type EingriffFilter = EingriffStatus | 'offen' | 'haengt';

/** So viele Eingriffe höchstens je Abfrage, die jüngsten zuerst. */
export const EINGRIFFE_HOECHSTENS = 50;

export async function eingriffeLesen(db: Abfrager, filter: EingriffFilter | undefined, jetzt: Date): Promise<Eingriff[]> {
  let bedingung = '';
  const werte: unknown[] = [EINGRIFFE_HOECHSTENS];
  if (filter === 'offen') {
    werte.push([...OFFENE_STATUS]);
    bedingung = 'WHERE status = ANY($2::text[])';
  } else if (filter === 'haengt') {
    werte.push(haengtGrenze(jetzt));
    bedingung = `WHERE status = 'laeuft' AND laeuft_seit < $2`;
  } else if (filter !== undefined) {
    werte.push(filter);
    bedingung = 'WHERE status = $2';
  }
  const ergebnis = await db.query<Zeile>(`SELECT ${SPALTEN} FROM cockpit.eingriff ${bedingung} ORDER BY id DESC LIMIT $1`, werte);
  return ergebnis.rows.map((zeile) => zeileLesen(zeile, jetzt));
}

export async function eingriffLesen(db: Abfrager, id: number, jetzt: Date): Promise<Eingriff | undefined> {
  const ergebnis = await db.query<Zeile>(`SELECT ${SPALTEN} FROM cockpit.eingriff WHERE id = $1`, [id]);
  const zeile = ergebnis.rows[0];
  return zeile === undefined ? undefined : zeileLesen(zeile, jetzt);
}

/** Der jüngste Eingriff einer Art: zuletzt angelegt (`id`), nicht spätester Zeitpunkt. */
export async function juengsterEingriffLesen(db: Abfrager, art: string): Promise<EingriffDaten | undefined> {
  const ergebnis = await db.query<Zeile>(`SELECT ${SPALTEN} FROM cockpit.eingriff WHERE art = $1 ORDER BY id DESC LIMIT 1`, [art]);
  const zeile = ergebnis.rows[0];
  return zeile === undefined ? undefined : datenLesen(zeile);
}

/** Je Modul der jüngste Modul-Antrag (COPI-106), nach Kennung. */
export async function juengsteModulEingriffeLesen(db: Abfrager): Promise<Map<string, EingriffDaten>> {
  const ergebnis = await db.query<Zeile>(
    `SELECT DISTINCT ON (modul_kennung) ${SPALTEN} FROM cockpit.eingriff WHERE art = 'modul' ORDER BY modul_kennung, id DESC`,
  );
  return new Map(ergebnis.rows.map((zeile) => [zeile.modul_kennung ?? '', datenLesen(zeile)]));
}

export type Uebergang =
  | { readonly nach: 'freigegeben'; readonly zielDigest: string; readonly zielVersion: string }
  /** Die Freigabe eines Modul-Updates (COPI-106) lautet auf den Ziel-Commit, genau wie beantragt. */
  | { readonly nach: 'freigegeben'; readonly zielCommit: string }
  | { readonly nach: 'laeuft' }
  | { readonly nach: 'fehlgeschlagen'; readonly grund?: string | undefined };

export type UebergangErgebnis =
  | { readonly ok: true; readonly eingriff: Eingriff }
  | { readonly ok: false; readonly grund: 'unbekannt' }
  /** Die Zeile steht nicht dort, woher der Übergang führt: doppelter Wechsel oder verbotene Kante. */
  | { readonly ok: false; readonly grund: 'status'; readonly status: EingriffStatus }
  /** Die Freigabe lautet auf ein anderes Ziel als die Zeile. */
  | { readonly ok: false; readonly grund: 'ziel' };

/** Die Protokollart je Übergang. */
const PROTOKOLL_ART = {
  freigegeben: 'update_freigegeben',
  laeuft: 'update_gestartet',
  fehlgeschlagen: 'update_fehlgeschlagen',
} as const satisfies Record<AgentenZiel, string>;

/**
 * Schaltet einen Eingriff weiter, wie es der Admin-Agent meldet, mit Protokolleintrag. Scheitert eine Prüfung, ändert
 * sich nichts — weder die Zeile noch das Protokoll.
 *
 * `akteur` ist die Kennung des Zugangs (`api_token_<id>`), nie ein Token.
 */
export async function eingriffWeiterschalten(
  pool: pg.Pool,
  id: number,
  uebergang: Uebergang,
  akteur: string,
  jetzt: Date,
): Promise<UebergangErgebnis> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ergebnis = await weiterschaltenIn(client, id, uebergang, akteur, jetzt);
    await client.query(ergebnis.ok ? 'COMMIT' : 'ROLLBACK');
    return ergebnis;
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

function zielPasst(uebergang: Extract<Uebergang, { nach: 'freigegeben' }>, eingriff: EingriffDaten): boolean {
  return 'zielDigest' in uebergang
    ? eingriff.art === 'cockpit-image' && uebergang.zielDigest === eingriff.zielDigest
    : eingriff.art === 'modul' && uebergang.zielCommit === eingriff.zielCommit;
}

async function weiterschaltenIn(
  client: pg.PoolClient,
  id: number,
  uebergang: Uebergang,
  akteur: string,
  jetzt: Date,
): Promise<UebergangErgebnis> {
  const gesperrt = await client.query<Zeile>(`SELECT ${SPALTEN} FROM cockpit.eingriff WHERE id = $1 FOR UPDATE`, [id]);
  const zeile = gesperrt.rows[0];
  if (zeile === undefined) {
    return { ok: false, grund: 'unbekannt' };
  }
  const vorher = zeileLesen(zeile, jetzt);
  if (vorher.status !== AGENTEN_UEBERGAENGE[uebergang.nach]) {
    return { ok: false, grund: 'status', status: vorher.status };
  }
  // Die Freigabe lautet auf Vorgangs-ID und Ziel (ADR 13.1): die ID steht in der Adresse, das Ziel muss passen — beim
  // Image der Digest, beim Modul der Commit, genau wie beantragt. Eine Freigabe der falschen Art passt nie.
  if (uebergang.nach === 'freigegeben' && !zielPasst(uebergang, vorher)) {
    return { ok: false, grund: 'ziel' };
  }

  const geaendert = await client.query<Zeile>(
    `UPDATE cockpit.eingriff SET status = $2, ziel_version = coalesce($3, ziel_version), fehler_grund = $4
      WHERE id = $1 RETURNING ${SPALTEN}`,
    [
      id,
      uebergang.nach,
      uebergang.nach === 'freigegeben' && 'zielVersion' in uebergang ? uebergang.zielVersion : null,
      uebergang.nach === 'fehlgeschlagen' ? (uebergang.grund ?? null) : null,
    ],
  );
  const nachher = geaendert.rows[0];
  if (nachher === undefined) {
    throw new Error('Eingriff verschwand während des Übergangs');
  }
  await protokollSchreiben(client, { art: PROTOKOLL_ART[uebergang.nach], akteur, einzelheiten: { eingriff_id: id } });
  return { ok: true, eingriff: zeileLesen(nachher, jetzt) };
}
