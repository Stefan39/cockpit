/**
 * Die gemeldeten Ereignisse der Agenten (COPI-114, Migration 0039): was ein Agent getan hat, wie er es meldet. Das
 * Cockpit holt nichts selbst — kein Container-Log, kein SSH (ADR).
 *
 * **Zwei Sichten wie bei Befunden:** Mit `technik_sehen` den Text des Agenten; sonst nur kundensichtbare Ereignisse mit
 * ihrem Klartext. Die Trennung liegt in der Abfrage, nicht in der Vorlage.
 *
 * **Begrenzung:** höchstens `EREIGNISSE_JE_STUNDE` je Agent in der letzten Stunde (nach Eingang gezählt) — ein
 * durchdrehender Workflow soll das Protokoll nicht fluten.
 */
import type pg from 'pg';
import type { Abfrager } from '../auth/protokoll.js';

export const EREIGNIS_STUFEN = ['info', 'warnung', 'fehler'] as const;
export type EreignisStufe = (typeof EREIGNIS_STUFEN)[number];

/** So viele Ereignisse nimmt die API je Agent und Stunde an. */
export const EREIGNISSE_JE_STUNDE = 50;

export interface NeuesEreignis {
  readonly agent: string;
  readonly stufe: EreignisStufe;
  readonly titel: string | undefined;
  readonly text: string;
  readonly textKunde: string | undefined;
  readonly kundensichtbar: boolean;
  readonly zeitpunkt: Date;
  /** Der Name des Zugangs, nie eine Angabe des Absenders. */
  readonly quelle: string;
}

export type EreignisErgebnis = { readonly ok: true; readonly id: number } | { readonly ok: false; readonly grund: 'zu_viele' };

/**
 * Speichert ein Ereignis, wenn der Agent in der letzten Stunde weniger als `EREIGNISSE_JE_STUNDE` gemeldet hat. Zählen
 * und Einfügen in einer Anweisung mit Sperre je Agent: zwei gleichzeitige Meldungen überschreiten die Grenze nicht.
 */
export async function ereignisMelden(pool: pg.Pool, neu: NeuesEreignis): Promise<EreignisErgebnis> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent_ereignis:${neu.agent}`]);
    const zahl = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cockpit.agent_ereignis WHERE agent = $1 AND gemeldet_am > now() - interval '1 hour'`,
      [neu.agent],
    );
    if ((zahl.rows[0]?.n ?? 0) >= EREIGNISSE_JE_STUNDE) {
      await client.query('ROLLBACK');
      return { ok: false, grund: 'zu_viele' };
    }
    const zeile = await client.query<{ id: number }>(
      `INSERT INTO cockpit.agent_ereignis (agent, stufe, titel, text, text_kunde, kundensichtbar, zeitpunkt, quelle)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::int AS id`,
      [neu.agent, neu.stufe, neu.titel ?? null, neu.text, neu.textKunde ?? null, neu.kundensichtbar, neu.zeitpunkt, neu.quelle],
    );
    await client.query('COMMIT');
    return { ok: true, id: zeile.rows[0]?.id ?? 0 };
  } catch (fehler) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw fehler;
  } finally {
    client.release();
  }
}

/** Ein Ereignis in der Sicht des Betrachters. */
export interface AgentEreignis {
  readonly stufe: EreignisStufe;
  /** Nur mit `technik`; die Kundensicht hat keinen Titel des Agenten. */
  readonly titel: string | undefined;
  readonly text: string;
  readonly zeitpunkt: Date;
}

/** Die Ereignisse eines Agenten seit `seit`, neueste zuerst; `technik`: Text des Agenten, sonst nur Kundensichtbares. */
export async function ereignisseLesen(db: Abfrager, agent: string, seit: Date, technik: boolean, hoechstens: number): Promise<AgentEreignis[]> {
  const ergebnis = await db.query<{ stufe: EreignisStufe; titel: string | null; text: string; zeitpunkt: Date }>(
    technik
      ? `SELECT stufe, titel, text, zeitpunkt FROM cockpit.agent_ereignis WHERE agent = $1 AND zeitpunkt >= $2 ORDER BY zeitpunkt DESC, id DESC LIMIT $3`
      : `SELECT stufe, NULL::text AS titel, text_kunde AS text, zeitpunkt FROM cockpit.agent_ereignis
          WHERE agent = $1 AND zeitpunkt >= $2 AND kundensichtbar ORDER BY zeitpunkt DESC, id DESC LIMIT $3`,
    [agent, seit, hoechstens],
  );
  return ergebnis.rows.map((zeile) => ({ stufe: zeile.stufe, titel: zeile.titel ?? undefined, text: zeile.text, zeitpunkt: zeile.zeitpunkt }));
}
