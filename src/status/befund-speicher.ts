/**
 * Befund und Herzschlag in der Datenbank (COPI-36, Tabellen aus Migration 0015).
 *
 * Ein Befund und der Herzschlag seiner Wache gehören zusammen: `befundMelden` schreibt beides **in einer
 * Transaktion**. Scheitert der Befund, gilt auch der neue „letzte Lauf" nicht — ein verlorener Befund ist
 * kein „gerade geprüft" — und eine dafür angelegte Wache entsteht nicht.
 *
 * Der Zeitpunkt kommt vom Aufrufer (der Anwendung, nie vom Agenten): so lassen sich Uhrenfehler und
 * Fristen prüfen, und der Herzschlag folgt derselben Uhr wie die Berechnung der Überfälligkeit.
 */
import type pg from 'pg';
import type { Messwert } from './messwert.js';
import type { BefundStatus } from './zustand.js';

export interface BefundMeldung {
  /** Kennung der Wache (Kleinbuchstaben, Ziffern, `_ . -`, höchstens 63 Zeichen). */
  readonly wache: string;
  readonly status: BefundStatus;
  /** Der Rohbefund für den Betreuer. Der Kunde sieht ihn nie. */
  readonly textIntern: string;
  /** Der Klartext für den Kunden; ohne ihn lässt sich kein Befund sichtbar machen. */
  readonly textKunde?: string | undefined;
  readonly kundensichtbar: boolean;
  /**
   * In welchem Takt die Wache meldet. Bei einer unbekannten Wache Pflicht (ohne Takt ließe sich nie
   * sagen, ob sie ausbleibt); bei einer bekannten ersetzt ein genannter Wert den bisherigen.
   */
  readonly taktSekunden?: number | undefined;
  /**
   * Wie die Wache dem Kunden heißt („Buchungs-Agent"). Gehört zur Wache, nicht zum Befund: ohne Angabe
   * bleibt der bisherige Name stehen, ein genannter ersetzt ihn (COPI-37).
   */
  readonly anzeigename?: string | undefined;
  /**
   * Welchem Agenten die Wache gehört (COPI-113), für Protokoll und Befunde auf seiner Detailseite. Gehört zur Wache wie
   * der Anzeigename: ohne Angabe bleibt die bisherige Zuordnung, eine genannte ersetzt sie.
   */
  readonly agent?: string | undefined;
  /** Der Hauptmesswert des Befunds (COPI-83), optional; für den Kunden nur über einen kundensichtbaren Befund. */
  readonly messwert?: Messwert | undefined;
  /**
   * Das neuere Ziel einer Versions-Wache (COPI-140), so gespeichert, wie die Agenten-API es geprüft hat; die Datenbank
   * prüft die Form noch einmal (`befund_update_ziel_form`, Migration 0049).
   */
  readonly updateZiel?: Readonly<Record<string, string>> | undefined;
  /** Wer gemeldet hat: der Name des Zugangs, nie eine Angabe des Absenders. */
  readonly quelle: string;
  readonly jetzt: Date;
}

export type BefundErgebnis =
  | { readonly ok: true; readonly id: number; readonly gemeldetAm: Date }
  | { readonly ok: false; readonly grund: 'takt_fehlt' };

export async function befundMelden(pool: pg.Pool, meldung: BefundMeldung): Promise<BefundErgebnis> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Der Herzschlag läuft nie rückwärts: springt die Uhr zurück, bleibt der jüngste Lauf stehen.
    const aktualisiert = await client.query(
      `UPDATE cockpit.wache
          SET takt_sekunden = COALESCE($2::int, takt_sekunden),
              letzter_lauf = GREATEST(COALESCE(letzter_lauf, $3::timestamptz), $3::timestamptz),
              anzeigename = COALESCE($4::text, anzeigename),
              agent = COALESCE($5::text, agent)
        WHERE kennung = $1`,
      [meldung.wache, meldung.taktSekunden ?? null, meldung.jetzt, meldung.anzeigename ?? null, meldung.agent ?? null],
    );

    if (aktualisiert.rowCount === 0) {
      if (meldung.taktSekunden === undefined) {
        await client.query('ROLLBACK');
        return { ok: false, grund: 'takt_fehlt' };
      }
      // Kommt gleichzeitig ein zweiter Befund für dieselbe neue Wache, wartet er hier auf den ersten und
      // aktualisiert dann dessen Zeile, statt an einem doppelten Schlüssel zu scheitern.
      await client.query(
        `INSERT INTO cockpit.wache (kennung, takt_sekunden, letzter_lauf, anzeigename, agent)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (kennung) DO UPDATE
                SET takt_sekunden = EXCLUDED.takt_sekunden,
                    letzter_lauf = GREATEST(COALESCE(wache.letzter_lauf, EXCLUDED.letzter_lauf), EXCLUDED.letzter_lauf),
                    anzeigename = COALESCE(EXCLUDED.anzeigename, wache.anzeigename),
                    agent = COALESCE(EXCLUDED.agent, wache.agent)`,
        [meldung.wache, meldung.taktSekunden, meldung.jetzt, meldung.anzeigename ?? null, meldung.agent ?? null],
      );
    }

    const befund = await client.query<{ id: number; gemeldet_am: Date }>(
      `INSERT INTO cockpit.befund (wache, status, text_intern, text_kunde, kundensichtbar, quelle, gemeldet_am, messwert, update_ziel)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         RETURNING id::int AS id, gemeldet_am`,
      [
        meldung.wache,
        meldung.status,
        meldung.textIntern,
        meldung.textKunde ?? null,
        meldung.kundensichtbar,
        meldung.quelle,
        meldung.jetzt,
        meldung.messwert === undefined ? null : JSON.stringify(meldung.messwert),
        meldung.updateZiel === undefined ? null : JSON.stringify(meldung.updateZiel),
      ],
    );
    const zeile = befund.rows[0];
    if (zeile === undefined) {
      throw new Error('Befund konnte nicht geschrieben werden');
    }

    await client.query('COMMIT');
    return { ok: true, id: zeile.id, gemeldetAm: zeile.gemeldet_am };
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}
