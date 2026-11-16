/**
 * Der Wechselkurs in der Datenbank (COPI-99, Tabelle `cockpit.wechselkurs` aus Migration 0033): eine Zeile je Tag,
 * US-Dollar je 1 Euro, wie die EZB ihn veröffentlicht.
 *
 * **Idempotent je Tag:** eine Meldung legt den Kurs des Tages an oder ersetzt ihn. Mehrere Tage sind **eine**
 * Anweisung und gelten ganz oder gar nicht. Umgerechnet wird in der Datenbank (`cockpit.in_eur`), nicht hier.
 */
import type { Abfrager } from '../auth/protokoll.js';

export interface Tageskurs {
  /** Kalendertag `YYYY-MM-DD`, für den der Kurs gilt. */
  readonly tag: string;
  /** US-Dollar je 1 Euro. */
  readonly usd_je_eur: number;
  readonly quelle: string;
}

export interface KursErgebnis {
  readonly neu: number;
  readonly ersetzt: number;
}

/** Trägt die Kurse ein oder ersetzt sie. Die Tage müssen sich unterscheiden (die Route prüft es vorher). */
export async function kurseMelden(db: Abfrager, kurse: readonly Tageskurs[], meldung: { readonly von: string; readonly jetzt: Date }): Promise<KursErgebnis> {
  // `xmax = 0` trifft nur auf frisch eingefügte Zeilen zu; eine ersetzte trägt die eigene Transaktion.
  const ergebnis = await db.query<{ neu: boolean }>(
    `INSERT INTO cockpit.wechselkurs (tag, usd_je_eur, quelle, gemeldet_von, gemeldet_am)
     SELECT k.tag, k.usd_je_eur, k.quelle, $2, $3
       FROM jsonb_to_recordset($1::jsonb) AS k (tag date, usd_je_eur numeric, quelle text)
     ON CONFLICT (tag) DO UPDATE
        SET usd_je_eur = EXCLUDED.usd_je_eur, quelle = EXCLUDED.quelle,
            gemeldet_von = EXCLUDED.gemeldet_von, gemeldet_am = EXCLUDED.gemeldet_am
     RETURNING (xmax = 0) AS neu`,
    [JSON.stringify(kurse), meldung.von, meldung.jetzt],
  );
  const neu = ergebnis.rows.filter((zeile) => zeile.neu).length;
  return { neu, ersetzt: ergebnis.rows.length - neu };
}
