/**
 * Der Eingriff „Antwort freigeben" (COPI-90, Migration 0038): Ein Mensch gibt eine bestimmte **Fassung** des
 * Antwortentwurfs eines Agenten frei; der Agent sendet erst danach — und nur diese Fassung mit genau diesem Text.
 *
 * **Gebunden an den Text.** Gespeichert wird der SHA-256 (Hex, UTF-8) des Entwurfs, wie die Detailseite ihn gelesen
 * hat. Der Agent nennt beim Abfragen Fassung und Hash des Texts, den er senden will; passt eines nicht, ist nichts
 * freigegeben. Eine neue Fassung braucht eine neue Freigabe — die alte bleibt stehen, gilt aber für sie nicht.
 *
 * **Woher der Entwurf kommt:** aus der Modul-View, über die Spalten des Abschnitts `freigabe:` im Block — mit derselben
 * erneuten Katalogprüfung und derselben lesenden Transaktion wie jedes Lesen (`modulLesen`). Das Cockpit schreibt nie in
 * die Fachtabelle; was gesendet wurde, meldet die View (`gesendet_am`).
 *
 * **Nachweis:** Freigeben und Zurückziehen stehen im Protokoll (`antwort_freigegeben`, `freigabe_zurueckgezogen`);
 * eine Freigabe wird nie gelöscht, ein Rückzug ist endgültig (die Datenbank hält beides fest).
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { protokollSchreiben, type Abfrager } from '../auth/protokoll.js';
import { inTransaktion } from '../datenbank/transaktion.js';
import type { ModulBlock, ModulFreigabe } from './block.js';
import { modulLesen, type Meldung, type ModulLeseErgebnis } from './liste-detail.js';
import { modulViewPruefen } from './registry.js';
import { EHEMALIGES_KONTO } from './vorgang-sperre.js';

const { escapeIdentifier } = pg;

/** SHA-256 des Entwurfstexts, Hex — so rechnet auch der Agent (UTF-8, der Text genau wie in der View). */
export function entwurfHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Die jüngste Fassung des Entwurfs einer Zeile, wie die View sie liefert. */
export interface Entwurf {
  readonly text: string;
  readonly fassung: number;
  readonly hash: string;
  readonly empfaenger: string | undefined;
  readonly betreff: string | undefined;
  readonly gesendetAm: Date | undefined;
}

function spalteSql(name: string | undefined, alias: string): string {
  return name === undefined ? `NULL AS ${alias}` : `v.${escapeIdentifier(name)} AS ${alias}`;
}

/** Die Spalten des Abschnitts `freigabe:` unter festen Namen. */
function entwurfSpalten(f: ModulFreigabe): string {
  return [
    spalteSql(f.entwurf, 'entwurf'),
    spalteSql(f.fassung, 'fassung'),
    spalteSql(f.empfaenger, 'empfaenger'),
    spalteSql(f.betreff, 'betreff'),
    spalteSql(f.gesendet_am, 'gesendet_am'),
  ].join(', ');
}

interface EntwurfZeile {
  readonly id: unknown;
  readonly titel?: unknown;
  readonly entwurf: string | null;
  readonly fassung: number | null;
  readonly empfaenger: string | null;
  readonly betreff: string | null;
  readonly gesendet_am: Date | null;
}

function entwurfAus(zeile: EntwurfZeile): Entwurf | undefined {
  if (zeile.entwurf === null || zeile.fassung === null) {
    return undefined;
  }
  return {
    text: zeile.entwurf,
    fassung: zeile.fassung,
    hash: entwurfHash(zeile.entwurf),
    empfaenger: zeile.empfaenger ?? undefined,
    betreff: zeile.betreff ?? undefined,
    gesendetAm: zeile.gesendet_am ?? undefined,
  };
}

/** Der Entwurf einer Zeile; `undefined` im Wert, wenn es (noch) keinen gibt oder die Zeile fehlt. */
export function entwurfLesen(pool: pg.Pool, kennung: string, block: ModulBlock, id: string, log?: Meldung): Promise<ModulLeseErgebnis<Entwurf | undefined>> {
  const freigabe = block.freigabe;
  if (freigabe === undefined) {
    return Promise.resolve({ ok: true, wert: undefined });
  }
  return modulLesen(pool, kennung, () => modulViewPruefen(pool, block), log, 'Entwurf konnte nicht gelesen werden', async (client) => {
    const ergebnis = await client.query<EntwurfZeile>(`SELECT v.id, ${entwurfSpalten(freigabe)} FROM cockpit.${escapeIdentifier(block.view)} v WHERE v.id = $1 LIMIT 1`, [id]);
    const zeile = ergebnis.rows[0];
    return zeile === undefined ? undefined : entwurfAus(zeile);
  });
}

/** Eine Zeile, deren jüngster Entwurf noch auf eine Freigabe wartet — für den Posteingang. */
export interface OffeneFreigabe {
  readonly id: string;
  readonly titel: string;
  readonly seit: Date | undefined;
  readonly empfaenger: string | undefined;
  readonly fassung: number;
}

/**
 * Die Zeilen mit einem ungesendeten Entwurf, dessen jüngste Fassung (mit diesem Text) nicht aktiv freigegeben ist — eine
 * Aufgabe, solange sie offen ist. Der Hash wird in der Abfrage gerechnet (`sha256`), gleich wie `entwurfHash`.
 */
export function offeneFreigabenLesen(pool: pg.Pool, kennung: string, block: ModulBlock, hoechstens: number, log?: Meldung): Promise<ModulLeseErgebnis<{ readonly zeilen: readonly OffeneFreigabe[]; readonly anzahl: number }>> {
  const freigabe = block.freigabe;
  if (freigabe === undefined) {
    return Promise.resolve({ ok: true, wert: { zeilen: [], anzahl: 0 } });
  }
  return modulLesen(pool, kennung, () => modulViewPruefen(pool, block), log, 'Offene Freigaben konnten nicht gelesen werden', async (client) => {
    const ergebnis = await client.query<EntwurfZeile & { titel: string; aktualisiert_am: Date | null }>(
      `SELECT * FROM (
         SELECT v.id, v.titel, v.aktualisiert_am, ${entwurfSpalten(freigabe)} FROM cockpit.${escapeIdentifier(block.view)} v
       ) e
        WHERE e.entwurf IS NOT NULL AND e.fassung IS NOT NULL AND e.gesendet_am IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM cockpit.freigabe f
                 WHERE f.modul_kennung = $1 AND f.vorgang_id = e.id::text AND f.fassung = e.fassung
                   AND f.entwurf_hash = encode(sha256(convert_to(e.entwurf, 'UTF8')), 'hex') AND f.zurueckgezogen_am IS NULL)
          AND NOT EXISTS (
                SELECT 1 FROM cockpit.vorgang_sperre s
                 WHERE s.modul_kennung = $1 AND s.vorgang_id = e.id::text AND s.zurueckgegeben_am IS NULL)
        ORDER BY e.aktualisiert_am DESC
        LIMIT $2`,
      [kennung, hoechstens],
    );
    const zeilen = ergebnis.rows.map((zeile) => ({
      id: String(zeile.id),
      titel: zeile.titel,
      seit: zeile.aktualisiert_am ?? undefined,
      empfaenger: zeile.empfaenger ?? undefined,
      fassung: zeile.fassung ?? 0,
    }));
    return { zeilen, anzahl: zeilen.length };
  });
}

/** Eine Freigabe, wie Detailseite und Agenten-API sie brauchen. */
export interface Freigabe {
  readonly id: number;
  readonly fassung: number;
  readonly hash: string;
  readonly vonId: string;
  /** Aus dem Konto; gelöscht oder fehlend: `EHEMALIGES_KONTO`. Nie die E-Mail. */
  readonly von: string;
  readonly am: Date;
  readonly zurueckgezogenAm: Date | undefined;
}

interface FreigabeZeile {
  readonly id: number;
  readonly fassung: number;
  readonly entwurf_hash: string;
  readonly freigegeben_von: string;
  readonly name: string | null;
  readonly geloescht: boolean | null;
  readonly freigegeben_am: Date;
  readonly zurueckgezogen_am: Date | null;
}

function freigabeAus(zeile: FreigabeZeile): Freigabe {
  const name = zeile.name?.trim() ?? '';
  return {
    id: zeile.id,
    fassung: zeile.fassung,
    hash: zeile.entwurf_hash,
    vonId: zeile.freigegeben_von,
    von: zeile.geloescht === false && name !== '' ? name : EHEMALIGES_KONTO,
    am: zeile.freigegeben_am,
    zurueckgezogenAm: zeile.zurueckgezogen_am ?? undefined,
  };
}

const FREIGABEN_SQL = `
  SELECT f.id::int AS id, f.fassung, f.entwurf_hash, f.freigegeben_von, u.name, u.geloescht_am IS NOT NULL AS geloescht,
         f.freigegeben_am, f.zurueckgezogen_am
    FROM cockpit.freigabe f
    LEFT JOIN cockpit."user" u ON u.id = f.freigegeben_von
   WHERE f.modul_kennung = $1 AND f.vorgang_id = $2`;

/** Alle Freigaben eines Vorgangs, jüngste zuerst — auch zurückgezogene. */
export async function freigabenLesen(db: Abfrager, modul: string, vorgangId: string): Promise<Freigabe[]> {
  const ergebnis = await db.query<FreigabeZeile>(`${FREIGABEN_SQL} ORDER BY f.id DESC`, [modul, vorgangId]);
  return ergebnis.rows.map(freigabeAus);
}

/** Die aktive Freigabe genau dieser Fassung mit genau diesem Text; sonst `undefined`. */
export function passendeFreigabe(freigaben: readonly Freigabe[], fassung: number, hash: string): Freigabe | undefined {
  return freigaben.find((freigabe) => freigabe.zurueckgezogenAm === undefined && freigabe.fassung === fassung && freigabe.hash === hash);
}

export type FreigabeZustand =
  | { readonly art: 'offen'; readonly veraltet: Freigabe | undefined }
  | { readonly art: 'freigegeben'; readonly freigabe: Freigabe }
  | { readonly art: 'gesendet'; readonly am: Date; readonly freigabe: Freigabe | undefined };

/**
 * Wo der Entwurf steht: gesendet (die View meldet es), freigegeben (aktive Freigabe dieser Fassung mit diesem Text) oder
 * offen — dann ggf. mit der aktiven Freigabe einer **älteren** Fassung, die nicht mehr gilt.
 */
export function freigabeZustand(entwurf: Entwurf, freigaben: readonly Freigabe[]): FreigabeZustand {
  const passend = passendeFreigabe(freigaben, entwurf.fassung, entwurf.hash);
  if (entwurf.gesendetAm !== undefined) {
    return { art: 'gesendet', am: entwurf.gesendetAm, freigabe: passend ?? freigaben.find((freigabe) => freigabe.fassung === entwurf.fassung) };
  }
  if (passend !== undefined) {
    return { art: 'freigegeben', freigabe: passend };
  }
  return { art: 'offen', veraltet: freigaben.find((freigabe) => freigabe.zurueckgezogenAm === undefined && freigabe.fassung !== entwurf.fassung) };
}

export interface FreigabeVorgang {
  readonly modul: string;
  readonly vorgangId: string;
}

export type FreigebenErgebnis = { readonly ok: true; readonly freigabe: Freigabe } | { readonly ok: false; readonly grund: 'schon_freigegeben' };

/** Gibt eine Fassung frei: neue Zeile und Eintrag `antwort_freigegeben` in einer Transaktion. Schon freigegeben: nichts. */
export async function freigeben(pool: pg.Pool, vorgang: FreigabeVorgang, entwurf: Pick<Entwurf, 'fassung' | 'hash'>, kontoId: string): Promise<FreigebenErgebnis> {
  const angelegt = await inTransaktion(pool, async (client) => {
    const zeile = await client.query<{ id: number }>(
      `INSERT INTO cockpit.freigabe (modul_kennung, vorgang_id, fassung, entwurf_hash, freigegeben_von)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (modul_kennung, vorgang_id, fassung) WHERE zurueckgezogen_am IS NULL DO NOTHING
       RETURNING id::int AS id`,
      [vorgang.modul, vorgang.vorgangId, entwurf.fassung, entwurf.hash, kontoId],
    );
    const id = zeile.rows[0]?.id;
    if (id === undefined) {
      return undefined;
    }
    await protokollSchreiben(client, { art: 'antwort_freigegeben', akteur: kontoId, einzelheiten: { freigabe_id: id } });
    return (await freigabenLesen(client, vorgang.modul, vorgang.vorgangId)).find((freigabe) => freigabe.id === id);
  });
  return angelegt === undefined ? { ok: false, grund: 'schon_freigegeben' } : { ok: true, freigabe: angelegt };
}

/** Zieht die aktive Freigabe einer Fassung zurück, mit Eintrag `freigabe_zurueckgezogen`. Ohne aktive: `false`. */
export async function freigabeZurueckziehen(pool: pg.Pool, vorgang: FreigabeVorgang, fassung: number, kontoId: string): Promise<boolean> {
  const ergebnis = await inTransaktion(pool, async (client) => {
    const zeile = await client.query<{ id: number; freigegeben_von: string }>(
      `UPDATE cockpit.freigabe SET zurueckgezogen_von = $4, zurueckgezogen_am = now()
        WHERE modul_kennung = $1 AND vorgang_id = $2 AND fassung = $3 AND zurueckgezogen_am IS NULL
        RETURNING id::int AS id, freigegeben_von`,
      [vorgang.modul, vorgang.vorgangId, fassung, kontoId],
    );
    const getroffen = zeile.rows[0];
    if (getroffen === undefined) {
      return undefined;
    }
    await protokollSchreiben(client, { art: 'freigabe_zurueckgezogen', akteur: kontoId, ziel: getroffen.freigegeben_von, einzelheiten: { freigabe_id: getroffen.id } });
    return true;
  });
  return ergebnis === true;
}
