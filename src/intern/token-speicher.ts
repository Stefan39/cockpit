/**
 * Die Zugänge der Agenten-API in der Datenbank (COPI-35, Migration 0016).
 *
 * Gespeichert wird nur der SHA-256-Hash des Tokens; den Klartext bekommt genau einmal, wer den Zugang
 * anlegt (`apiTokenAnlegen`). Erzeugen und Widerrufen laufen **in einer Transaktion mit ihrem
 * Protokolleintrag** (COPI-23): kein Zugang ohne Eintrag und kein Widerruf ohne Eintrag. Scheitert der
 * Eintrag, bleibt der Zustand davor bestehen.
 */
import type pg from 'pg';
import { protokollSchreiben, type Abfrager } from '../auth/protokoll.js';
import { apiTokenErzeugen, istApiScope, type ApiScope } from './token.js';

/** Ein Zugang, wie ihn Prüfung und Auflistung sehen — nie mit Hash und nie mit Token. */
export interface ApiTokenZeile {
  readonly id: number;
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  readonly erzeugtAm: Date;
  /** Gesetzt, sobald der Zugang widerrufen ist; ein widerrufener Zugang wird nie wieder gültig. */
  readonly widerrufenAm: Date | undefined;
}

interface Zeile {
  readonly id: number;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly erzeugt_am: Date;
  readonly widerrufen_am: Date | null;
}

const SPALTEN = 'id::int AS id, name, scopes, erzeugt_am, widerrufen_am';

function zeileLesen(zeile: Zeile): ApiTokenZeile {
  return {
    id: zeile.id,
    name: zeile.name,
    // Die Datenbank lässt nur bekannte Rechte zu (`api_token_scopes_bekannt`).
    scopes: zeile.scopes.filter(istApiScope),
    erzeugtAm: zeile.erzeugt_am,
    widerrufenAm: zeile.widerrufen_am ?? undefined,
  };
}

/** Die Kennung des Zugangs im Protokoll: eine Kennung, keine Adresse und kein Token. */
export function zugangKennung(id: number): string {
  return `api_token_${String(id)}`;
}

export interface NeuerZugang {
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  /** Wer ihn anlegt: die Konsole, solange es nur das Server-Kommando gibt. */
  readonly akteur?: string;
}

export interface AngelegterZugang {
  readonly id: number;
  /** Klartext-Token — steht nur hier, nur einmal. */
  readonly token: string;
}

export async function apiTokenAnlegen(pool: pg.Pool, zugang: NeuerZugang): Promise<AngelegterZugang> {
  const { token, hash } = apiTokenErzeugen();
  const scopes = [...new Set(zugang.scopes)];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const angelegt = await client.query<{ id: number }>(
      `INSERT INTO cockpit.api_token (name, token_hash, scopes)
       VALUES ($1, $2, $3::text[])
       RETURNING id::int AS id`,
      [zugang.name, hash, scopes],
    );
    const id = angelegt.rows[0]?.id;
    if (id === undefined) {
      throw new Error('Zugang konnte nicht angelegt werden');
    }
    await protokollSchreiben(client, {
      art: 'api_token_erzeugt',
      akteur: zugang.akteur ?? 'konsole',
      ziel: zugangKennung(id),
      einzelheiten: { token_id: id, name: zugang.name },
    });
    await client.query('COMMIT');
    return { id, token };
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

/** Der Zugang zu einem Hash, auch wenn er widerrufen ist — die Prüfung lehnt ihn dann selbst ab. */
export async function apiTokenSuchen(db: Abfrager, hash: string): Promise<ApiTokenZeile | undefined> {
  const ergebnis = await db.query<Zeile>(`SELECT ${SPALTEN} FROM cockpit.api_token WHERE token_hash = $1`, [hash]);
  const zeile = ergebnis.rows[0];
  return zeile === undefined ? undefined : zeileLesen(zeile);
}

export async function apiTokenAuflisten(pool: pg.Pool): Promise<ApiTokenZeile[]> {
  const ergebnis = await pool.query<Zeile>(`SELECT ${SPALTEN} FROM cockpit.api_token ORDER BY id`);
  return ergebnis.rows.map(zeileLesen);
}

export type WiderrufErgebnis = 'widerrufen' | 'schon_widerrufen' | 'unbekannt';

/**
 * Widerruft einen Zugang. Ein zweiter Aufruf ändert nichts und schreibt keinen zweiten Eintrag; ein
 * unbekannter Zugang wird gemeldet, nicht angelegt.
 */
export async function apiTokenWiderrufen(
  pool: pg.Pool,
  id: number,
  akteur = 'konsole',
): Promise<WiderrufErgebnis> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const widerrufen = await client.query(
      'UPDATE cockpit.api_token SET widerrufen_am = now() WHERE id = $1 AND widerrufen_am IS NULL RETURNING id',
      [id],
    );
    if (widerrufen.rowCount === 1) {
      await protokollSchreiben(client, {
        art: 'api_token_widerrufen',
        akteur,
        ziel: zugangKennung(id),
        einzelheiten: { token_id: id },
      });
      await client.query('COMMIT');
      return 'widerrufen';
    }
    const vorhanden = await client.query('SELECT 1 FROM cockpit.api_token WHERE id = $1', [id]);
    await client.query('COMMIT');
    return vorhanden.rowCount === 1 ? 'schon_widerrufen' : 'unbekannt';
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}
