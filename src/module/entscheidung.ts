/**
 * Der Eingriff „Entscheiden" (COPI-91, Migration 0045): Ein Mensch entscheidet über einen Vorgang (etwa einen Treffer des
 * Vorschlags-Laufs), der Agent des Moduls fragt die Entscheidung ab (`GET /intern/vorgaenge/entscheidungen`) und handelt.
 * Das Cockpit schreibt dafür nie in die Fachtabelle (ADR) — die Entscheidung steht in `cockpit.entscheidung`.
 *
 * **Es gilt die jüngste nicht zurückgenommene.** Zurücknehmen markiert die geltende Entscheidung; danach gilt wieder die
 * davor (oder „offen"). Nichts wird gelöscht, jede Entscheidung und jeder Rückzug steht im Protokoll
 * (`entscheidung_getroffen`, `entscheidung_zurueckgenommen`).
 *
 * **Welche Optionen gerade gehen**, bestimmt der Block (`wenn`); der Server prüft es beim Absenden erneut, nicht nur die
 * Seite.
 *
 * Der Entwurf des Agenten (etwa ein Bewerbungsentwurf) kommt aus der Modul-View, über die Spalten von
 * `entscheidung.entwurf` — mit derselben erneuten Katalogprüfung und lesenden Transaktion wie jedes Lesen.
 */
import pg from 'pg';
import { protokollSchreiben, type Abfrager } from '../auth/protokoll.js';
import { inTransaktion } from '../datenbank/transaktion.js';
import { ENTSCHEIDUNG_OFFEN, type EntscheidungOption, type ModulBlock } from './block.js';
import { modulLesen, type Meldung, type ModulLeseErgebnis } from './liste-detail.js';
import { modulViewPruefen } from './registry.js';
import { EHEMALIGES_KONTO } from './vorgang-sperre.js';

const { escapeIdentifier } = pg;

/** Eine Entscheidung, wie Detailseite, Liste und Agenten-API sie brauchen. */
export interface Entscheidung {
  readonly id: number;
  readonly vorgangId: string;
  readonly wert: string;
  readonly vonId: string;
  /** Aus dem Konto; gelöscht oder fehlend: `EHEMALIGES_KONTO`. Nie die E-Mail. */
  readonly von: string;
  readonly am: Date;
}

interface EntscheidungZeile {
  readonly id: number;
  readonly vorgang_id: string;
  readonly wert: string;
  readonly entschieden_von: string;
  readonly name: string | null;
  readonly geloescht: boolean | null;
  readonly entschieden_am: Date;
}

function entscheidungAus(zeile: EntscheidungZeile): Entscheidung {
  const name = zeile.name?.trim() ?? '';
  return {
    id: zeile.id,
    vorgangId: zeile.vorgang_id,
    wert: zeile.wert,
    vonId: zeile.entschieden_von,
    von: zeile.geloescht === false && name !== '' ? name : EHEMALIGES_KONTO,
    am: zeile.entschieden_am,
  };
}

/** Die geltenden Entscheidungen eines Moduls, je Vorgang die jüngste nicht zurückgenommene. */
const GELTENDE_SQL = `
  SELECT DISTINCT ON (e.vorgang_id) e.id::int AS id, e.vorgang_id, e.wert, e.entschieden_von, u.name,
         u.geloescht_am IS NOT NULL AS geloescht, e.entschieden_am
    FROM cockpit.entscheidung e
    LEFT JOIN cockpit."user" u ON u.id = e.entschieden_von
   WHERE e.modul_kennung = $1 AND e.zurueckgenommen_am IS NULL`;

/** Die geltende Entscheidung je Vorgang für diese `ids` (Liste und Detailseite); ohne Eintrag: offen. */
export async function geltendeEntscheidungen(db: Abfrager, modul: string, ids: readonly string[]): Promise<Map<string, Entscheidung>> {
  if (ids.length === 0) {
    return new Map();
  }
  const ergebnis = await db.query<EntscheidungZeile>(`${GELTENDE_SQL} AND e.vorgang_id = ANY($2) ORDER BY e.vorgang_id, e.id DESC`, [modul, [...ids]]);
  return new Map(ergebnis.rows.map((zeile) => [zeile.vorgang_id, entscheidungAus(zeile)]));
}

/** Höchstens so viele Entscheidungen liefert die Agenten-API je Abfrage. */
export const ENTSCHEIDUNGEN_HOECHSTENS = 500;

/** Alle geltenden Entscheidungen eines Moduls, jüngste zuerst — für den Agenten. */
export async function alleGeltendenEntscheidungen(db: Abfrager, modul: string): Promise<Entscheidung[]> {
  const ergebnis = await db.query<EntscheidungZeile>(
    `SELECT * FROM (${GELTENDE_SQL} ORDER BY e.vorgang_id, e.id DESC) g ORDER BY g.id DESC LIMIT ${String(ENTSCHEIDUNGEN_HOECHSTENS)}`,
    [modul],
  );
  return ergebnis.rows.map(entscheidungAus);
}

/**
 * Die Optionen, die bei diesem Stand gehen (`wenn`, ohne Angabe nur „offen") und zum Entwurf passen (`entwurf: mit|ohne`,
 * COPI-125; `entwurfDa` ist, ob die Zeile gerade einen Entwurf hat).
 */
export function moeglicheOptionen(optionen: readonly EntscheidungOption[], geltend: string | undefined, entwurfDa: boolean): EntscheidungOption[] {
  const stand = geltend ?? ENTSCHEIDUNG_OFFEN;
  return optionen.filter(
    (option) => (option.wenn ?? [ENTSCHEIDUNG_OFFEN]).includes(stand) && (option.entwurf === undefined || (option.entwurf === 'mit') === entwurfDa),
  );
}

export interface EntscheidungVorgang {
  readonly modul: string;
  readonly vorgangId: string;
}

/**
 * Trifft eine Entscheidung: neue Zeile und Eintrag `entscheidung_getroffen` in einer Transaktion. Der Stand wird in
 * derselben Transaktion gelesen (gesperrt) und muss der sein, den die Seite gezeigt hat (`erwartet`, `offen` ohne
 * Entscheidung) — sonst nichts. So entscheiden zwei gleichzeitige Klicks nicht zweimal.
 */
export async function entscheiden(pool: pg.Pool, vorgang: EntscheidungVorgang, wert: string, erwartet: string, kontoId: string): Promise<boolean> {
  const ergebnis = await inTransaktion(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entscheidung:${vorgang.modul}:${vorgang.vorgangId}`]);
    const geltend = (await geltendeEntscheidungen(client, vorgang.modul, [vorgang.vorgangId])).get(vorgang.vorgangId);
    if ((geltend?.wert ?? ENTSCHEIDUNG_OFFEN) !== erwartet) {
      return undefined;
    }
    const zeile = await client.query<{ id: number }>(
      `INSERT INTO cockpit.entscheidung (modul_kennung, vorgang_id, wert, entschieden_von) VALUES ($1, $2, $3, $4) RETURNING id::int AS id`,
      [vorgang.modul, vorgang.vorgangId, wert, kontoId],
    );
    const id = zeile.rows[0]?.id;
    if (id === undefined) {
      return undefined;
    }
    await protokollSchreiben(client, { art: 'entscheidung_getroffen', akteur: kontoId, einzelheiten: { entscheidung_id: id } });
    return true;
  });
  return ergebnis === true;
}

/** Nimmt die geltende Entscheidung zurück — nur, wenn es genau die ist, die die Seite gezeigt hat (`entscheidungId`). */
export async function entscheidungZuruecknehmen(pool: pg.Pool, vorgang: EntscheidungVorgang, entscheidungId: number, kontoId: string): Promise<boolean> {
  const ergebnis = await inTransaktion(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entscheidung:${vorgang.modul}:${vorgang.vorgangId}`]);
    const geltend = (await geltendeEntscheidungen(client, vorgang.modul, [vorgang.vorgangId])).get(vorgang.vorgangId);
    if (geltend?.id !== entscheidungId) {
      return undefined;
    }
    await client.query(`UPDATE cockpit.entscheidung SET zurueckgenommen_von = $2, zurueckgenommen_am = now() WHERE id = $1`, [entscheidungId, kontoId]);
    await protokollSchreiben(client, { art: 'entscheidung_zurueckgenommen', akteur: kontoId, ziel: geltend.vonId, einzelheiten: { entscheidung_id: entscheidungId } });
    return true;
  });
  return ergebnis === true;
}

/** Der Entwurf des Agenten zu einer Zeile (`entscheidung.entwurf`), wie die View ihn liefert. */
export interface EntscheidungEntwurf {
  readonly text: string;
  readonly fassung: number | undefined;
}

/** Der Entwurf einer Zeile; `undefined` im Wert ohne Entwurf, ohne Zeile oder ohne `entwurf` im Block. */
export function entscheidungEntwurfLesen(pool: pg.Pool, kennung: string, block: ModulBlock, id: string, log?: Meldung): Promise<ModulLeseErgebnis<EntscheidungEntwurf | undefined>> {
  const entwurf = block.entscheidung?.entwurf;
  if (entwurf === undefined) {
    return Promise.resolve({ ok: true, wert: undefined });
  }
  return modulLesen(pool, kennung, () => modulViewPruefen(pool, block), log, 'Entwurf konnte nicht gelesen werden', async (client) => {
    const fassung = entwurf.fassung === undefined ? 'NULL::integer' : `v.${escapeIdentifier(entwurf.fassung)}`;
    const ergebnis = await client.query<{ text: string | null; fassung: number | null }>(
      `SELECT v.${escapeIdentifier(entwurf.spalte)} AS text, ${fassung} AS fassung FROM cockpit.${escapeIdentifier(block.view)} v WHERE v.id = $1 LIMIT 1`,
      [id],
    );
    const zeile = ergebnis.rows[0];
    return zeile?.text === null || zeile?.text === undefined || zeile.text.trim() === '' ? undefined : { text: zeile.text, fassung: zeile.fassung ?? undefined };
  });
}
