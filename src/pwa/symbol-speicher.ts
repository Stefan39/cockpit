/**
 * Das App-Symbol der Instanz in der Datenbank (COPI-101, Migration 0035) und der Satz, den das Cockpit ausliefert.
 *
 * Gespeichert wird nur das neu kodierte 512er-PNG. Das aktuelle Symbol ist die jüngste nicht als gelöscht markierte
 * Zeile; „Zurücksetzen" markiert alle. Änderung und Protokolleintrag laufen in **einer** Transaktion.
 *
 * `SymbolQuelle` hält den aktuellen Satz im Speicher: gelesen beim ersten Bedarf, ersetzt nach jeder Änderung. Das
 * Cockpit ist ein Prozess (ADR), ein zweiter, der dieselbe Datenbank ändert, ist nicht vorgesehen. Scheitert das Lesen,
 * gilt für diese Anfrage der Standard und beim nächsten Mal wird neu gelesen — ein Symbol ist kein Grund für eine
 * Fehlerseite.
 */
import type pg from 'pg';
import { protokollSchreiben } from '../auth/protokoll.js';
import { eigenerSymbolSatz, standardSymbolSatz, type SymbolSatz } from './symbol.js';

export interface GespeichertesSymbol {
  readonly id: number;
  readonly png: Buffer;
  readonly angelegtAm: Date;
  /** Der Name des Kontos, das hochgeladen hat; leer, wenn das Konto keinen hat. */
  readonly angelegtVon: string;
}

export async function aktuellesSymbolLesen(pool: pg.Pool): Promise<GespeichertesSymbol | undefined> {
  const ergebnis = await pool.query<{ id: string; png: Buffer; angelegt_am: Date; name: string | null }>(
    `SELECT s.id::text, s.png, s.angelegt_am, u.name
       FROM cockpit.app_symbol s
       JOIN cockpit."user" u ON u.id = s.angelegt_von
      WHERE s.geloescht_am IS NULL
      ORDER BY s.id DESC
      LIMIT 1`,
  );
  const zeile = ergebnis.rows[0];
  return zeile === undefined
    ? undefined
    : { id: Number(zeile.id), png: zeile.png, angelegtAm: zeile.angelegt_am, angelegtVon: zeile.name ?? '' };
}

async function inTransaktion<T>(pool: pg.Pool, arbeit: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ergebnis = await arbeit(client);
    await client.query('COMMIT');
    return ergebnis;
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

/** Speichert einen geprüften Satz (sein 512er-PNG) als aktuelles Symbol. */
export async function symbolSpeichern(pool: pg.Pool, satz: SymbolSatz, konto: string): Promise<number> {
  return inTransaktion(pool, async (client) => {
    const ergebnis = await client.query<{ id: string }>(
      'INSERT INTO cockpit.app_symbol (png, hash, angelegt_von) VALUES ($1, $2, $3) RETURNING id::text',
      [satz.dateien['icon-512'], satz.hash, konto],
    );
    const id = Number(ergebnis.rows[0]?.id);
    await protokollSchreiben(client, {
      art: 'erscheinungsbild_geaendert',
      akteur: konto,
      einzelheiten: { weg: 'hochgeladen', app_symbol_id: id },
    });
    return id;
  });
}

/** Markiert jedes eigene Symbol als gelöscht; danach gilt der Standard. `false`, wenn es keines gab. */
export async function symbolZuruecksetzen(pool: pg.Pool, konto: string): Promise<boolean> {
  return inTransaktion(pool, async (client) => {
    const ergebnis = await client.query(
      `UPDATE cockpit.app_symbol SET geloescht_am = now(), geloescht_von = $1 WHERE geloescht_am IS NULL`,
      [konto],
    );
    if (ergebnis.rowCount === 0) {
      return false;
    }
    await protokollSchreiben(client, { art: 'erscheinungsbild_geaendert', akteur: konto, einzelheiten: { weg: 'zurueckgesetzt' } });
    return true;
  });
}

/** Was die Einstellungen über das aktuelle Symbol zeigen. */
export interface SymbolStand {
  readonly satz: SymbolSatz;
  /** Nur bei einem eigenen Symbol: seit wann und von wem. */
  readonly eigenes?: { readonly seit: Date; readonly von: string };
}

export class SymbolQuelle {
  private readonly standard = standardSymbolSatz();
  private stand: SymbolStand | undefined;

  constructor(
    private readonly pool: pg.Pool | undefined,
    private readonly fehlerMelden: (grund: string) => void = () => undefined,
  ) {}

  async aktuell(): Promise<SymbolStand> {
    if (this.stand !== undefined) {
      return this.stand;
    }
    if (this.pool === undefined) {
      return { satz: this.standard };
    }
    try {
      const gespeichert = await aktuellesSymbolLesen(this.pool);
      this.stand =
        gespeichert === undefined
          ? { satz: this.standard }
          : { satz: eigenerSymbolSatz(gespeichert.png), eigenes: { seit: gespeichert.angelegtAm, von: gespeichert.angelegtVon } };
      return this.stand;
    } catch (fehler) {
      this.fehlerMelden(fehler instanceof Error ? fehler.message : 'unbekannt');
      return { satz: this.standard };
    }
  }

  /** Nach einer Änderung: beim nächsten Bedarf neu lesen. */
  vergessen(): void {
    this.stand = undefined;
  }
}
