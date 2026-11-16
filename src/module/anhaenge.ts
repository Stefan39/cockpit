/**
 * Die Anhänge einer Modulzeile (COPI-110): lesen aus der Anhang-View des Blocks (`anhaenge:`), ausliefern nur nach
 * Bestätigung, und der Nachweis jedes Downloads.
 *
 * **Erst die Zeile, dann ihre Anhänge.** Jede Abfrage verlangt, dass die Zeile in der Modul-View steht (`EXISTS`): die
 * Modul-View entscheidet, was sichtbar ist (Fenster, Filter), die Anhang-View nur, was dazugehört. Ein Anhang einer Zeile,
 * die die Modul-View nicht (mehr) zeigt, ist für das Cockpit nicht da — dieselbe neutrale 404 wie eine erfundene `id`.
 *
 * **Die Liste liest nie den Inhalt**, nur seine ersten `ANHANG_KOPF_BYTES` (für die Einstufung) und seine Länge. Erst die
 * Warnseite rechnet den SHA-256 (in der Datenbank), erst der Download liest den Inhalt — in einer eigenen lesenden
 * Transaktion mit 10 s Zeitgrenze, nur bis `ANHANG_HOECHSTENS_BYTES` und nur, wenn der SHA-256 noch der ist, den die
 * Warnseite bestätigt hat.
 *
 * Bezeichner kommen nur aus dem geprüften Block, immer über `escapeIdentifier`; Werte nur als Parameter (wie
 * `liste-detail.ts`). Vor jedem Lesen prüft der Katalog beide Views erneut.
 */
import pg from 'pg';
import { protokollSchreiben } from '../auth/protokoll.js';
import { inTransaktion } from '../datenbank/transaktion.js';
import { ANHANG_HOECHSTENS_BYTES, ANHANG_KOPF_BYTES, anhangEinstufen, dateinameBereinigen, type AnhangEinstufung } from './anhang-pruefung.js';
import type { ModulBlock } from './block.js';
import { modulLesen, type Meldung, type ModulLeseErgebnis } from './liste-detail.js';
import { anhaengeViewPruefen, modulViewPruefen, type KatalogErgebnis } from './registry.js';

const { escapeIdentifier } = pg;

/** Höchstens so viele Anhänge zeigt eine Detailseite; eine Mail mit mehr ist ohnehin ein Fall fürs Postfach. */
export const ANHAENGE_HOECHSTENS = 50;

/** Ein Anhang, wie Liste und Warnseite ihn brauchen. */
export interface Anhang {
  readonly id: string;
  /** Bereinigt (`dateinameBereinigen`): so wird er gezeigt, geliefert und nachgewiesen. */
  readonly dateiname: string;
  /** Die Größe laut View (Angabe des Absenders) — für die Anzeige. */
  readonly groesse: number;
  /** Die Länge des Inhalts, wie die Datenbank sie misst; `undefined`: kein Inhalt im Cockpit. */
  readonly laenge: number | undefined;
  readonly einstufung: AnhangEinstufung;
}

interface AnhangZeile {
  readonly id: string;
  readonly dateiname: string;
  readonly groesse: string | number;
  readonly kopf: Buffer | null;
  readonly laenge: number | null;
}

function anhangAus(zeile: AnhangZeile): Anhang {
  const dateiname = dateinameBereinigen(zeile.dateiname);
  const laenge = zeile.laenge ?? undefined;
  const inhaltDa = laenge !== undefined && laenge <= ANHANG_HOECHSTENS_BYTES;
  return {
    id: zeile.id,
    dateiname,
    groesse: Number(zeile.groesse),
    laenge,
    einstufung: anhangEinstufen(dateiname, zeile.kopf ?? undefined, inhaltDa),
  };
}

/** Beide Views, die ein Anhang braucht: die Modul-View (wer was sieht) und die Anhang-View. */
function beidePruefen(pool: pg.Pool, block: ModulBlock): () => Promise<KatalogErgebnis> {
  return async () => {
    const modul = await modulViewPruefen(pool, block);
    return modul.ok ? anhaengeViewPruefen(pool, block) : modul;
  };
}

/** `FROM … WHERE` für die Anhänge einer Zeile, die in der Modul-View steht; `$1` ist die `id` der Zeile. */
function anhaengeDerZeile(block: ModulBlock, anhaenge: string): string {
  return `FROM cockpit.${escapeIdentifier(anhaenge)} a
         WHERE a.vorgang_id = $1
           AND EXISTS (SELECT 1 FROM cockpit.${escapeIdentifier(block.view)} v WHERE v.id = $1)`;
}

const METADATEN = `a.id, a.dateiname, a.groesse, substring(a.inhalt FROM 1 FOR ${String(ANHANG_KOPF_BYTES)}) AS kopf, octet_length(a.inhalt) AS laenge`;

/**
 * Die Anhänge einer Zeile, ohne Inhalt; ohne Feld `anhaenge` im Block: keine. Sortiert nach `position`, wenn die View sie
 * trägt, dann nach Name.
 */
export function anhaengeLesen(pool: pg.Pool, kennung: string, block: ModulBlock, vorgangId: string, log?: Meldung): Promise<ModulLeseErgebnis<readonly Anhang[]>> {
  const anhaenge = block.anhaenge;
  if (anhaenge === undefined) {
    return Promise.resolve({ ok: true, wert: [] });
  }
  return modulLesen(pool, kennung, beidePruefen(pool, block), log, 'Anhänge konnten nicht gelesen werden', async (client, optionale) => {
    const reihenfolge = optionale.includes('position') ? 'a.position NULLS LAST, a.dateiname, a.id' : 'a.dateiname, a.id';
    const ergebnis = await client.query<AnhangZeile>(
      `SELECT ${METADATEN} ${anhaengeDerZeile(block, anhaenge)} ORDER BY ${reihenfolge} LIMIT ${String(ANHAENGE_HOECHSTENS)}`,
      [vorgangId],
    );
    return ergebnis.rows.map(anhangAus);
  });
}

/** Ein Anhang für die Warnseite: dazu der SHA-256 seines Inhalts (nur, wenn er auslieferbar ist), der Typ laut Absender
 * (optionale Spalte `typ`) und der Titel seiner Zeile. */
export interface AnhangMitHash extends Anhang {
  readonly sha256: string | undefined;
  readonly typ: string | undefined;
  readonly vorgangTitel: string;
}

/** Ein einzelner Anhang einer Zeile, für die Warnseite; `undefined` im Wert, wenn es ihn (für diese Zeile) nicht gibt. */
export function anhangLesen(pool: pg.Pool, kennung: string, block: ModulBlock, vorgangId: string, anhangId: string, log?: Meldung): Promise<ModulLeseErgebnis<AnhangMitHash | undefined>> {
  const anhaenge = block.anhaenge;
  if (anhaenge === undefined) {
    return Promise.resolve({ ok: true, wert: undefined });
  }
  return modulLesen(pool, kennung, beidePruefen(pool, block), log, 'Anhang konnte nicht gelesen werden', async (client, optionale) => {
    const ergebnis = await client.query<AnhangZeile & { sha256: string | null; typ: string | null; vorgang_titel: string | null }>(
      `SELECT ${METADATEN},
              CASE WHEN octet_length(a.inhalt) <= ${String(ANHANG_HOECHSTENS_BYTES)} THEN encode(sha256(a.inhalt), 'hex') END AS sha256,
              ${optionale.includes('typ') ? 'a.typ' : 'NULL::text'} AS typ,
              (SELECT v.titel FROM cockpit.${escapeIdentifier(block.view)} v WHERE v.id = $1 LIMIT 1) AS vorgang_titel
         ${anhaengeDerZeile(block, anhaenge)} AND a.id = $2 LIMIT 1`,
      [vorgangId, anhangId],
    );
    const zeile = ergebnis.rows[0];
    return zeile === undefined
      ? undefined
      : { ...anhangAus(zeile), sha256: zeile.sha256 ?? undefined, typ: zeile.typ ?? undefined, vorgangTitel: zeile.vorgang_titel ?? '' };
  });
}

/**
 * Der Inhalt eines Anhangs für den Download: nur bis `ANHANG_HOECHSTENS_BYTES`, nur mit genau diesem SHA-256 (sonst hat
 * er sich seit der Warnseite geändert), mit 10 s Zeitgrenze. `undefined` im Wert: nicht (mehr) so da.
 */
export function anhangInhaltLesen(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  vorgangId: string,
  anhangId: string,
  sha256: string,
  log?: Meldung,
): Promise<ModulLeseErgebnis<Buffer | undefined>> {
  const anhaenge = block.anhaenge;
  if (anhaenge === undefined) {
    return Promise.resolve({ ok: true, wert: undefined });
  }
  return modulLesen(
    pool,
    kennung,
    beidePruefen(pool, block),
    log,
    'Anhang konnte nicht ausgeliefert werden',
    async (client) => {
      const ergebnis = await client.query<{ inhalt: Buffer }>(
        `SELECT a.inhalt ${anhaengeDerZeile(block, anhaenge)} AND a.id = $2
            AND octet_length(a.inhalt) <= ${String(ANHANG_HOECHSTENS_BYTES)}
            AND encode(sha256(a.inhalt), 'hex') = $3
          LIMIT 1`,
        [vorgangId, anhangId, sha256],
      );
      return ergebnis.rows[0]?.inhalt;
    },
    '10s',
  );
}

/** Was ein Download-Nachweis festhält (Migration 0044). */
export interface AnhangDownload {
  readonly modul: string;
  readonly vorgangId: string;
  readonly anhangId: string;
  readonly dateiname: string;
  readonly groesse: number;
  readonly sha256: string;
  readonly klasse: 'normal' | 'warnung';
  readonly konto: string;
}

/** Schreibt den Nachweis und den Protokolleintrag `anhang_heruntergeladen` in einer Transaktion — vor dem Ausliefern. */
export async function anhangDownloadNachweisen(pool: pg.Pool, download: AnhangDownload): Promise<number> {
  const id = await inTransaktion(pool, async (client) => {
    const zeile = await client.query<{ id: number }>(
      `INSERT INTO cockpit.anhang_download (modul_kennung, vorgang_id, anhang_id, dateiname, groesse, sha256, klasse, konto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::int AS id`,
      [download.modul, download.vorgangId, download.anhangId, download.dateiname, download.groesse, download.sha256, download.klasse, download.konto],
    );
    const neu = zeile.rows[0]?.id;
    if (neu !== undefined) {
      await protokollSchreiben(client, { art: 'anhang_heruntergeladen', akteur: download.konto, einzelheiten: { anhang_download_id: neu } });
    }
    return neu;
  });
  if (id === undefined) {
    throw new Error('Anhang: Nachweis nicht geschrieben');
  }
  return id;
}
