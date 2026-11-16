/**
 * Das Verbrauchsprotokoll der KI-Modelle in der Datenbank (COPI-97, Tabellen `cockpit.verbrauch` und `cockpit.preis`
 * aus Migration 0032).
 *
 * **Idempotent über den Schlüssel:** eine Meldung legt ihren Eintrag an oder ersetzt ihn — ganz, mit allen Feldern.
 * Ein Melder, der aus einem Puffer nachliefert, zählt so nie doppelt. Ein Stapel ist **eine** Anweisung und gilt damit
 * ganz oder gar nicht.
 *
 * **Die Kosten rechnet die Datenbank** (Trigger `verbrauch_kosten`): hier steht keine Rechenlogik. Deshalb ist auch
 * die Neuberechnung nur ein `UPDATE`, das jede Zeile einmal anfasst.
 */
import type { Abfrager } from '../auth/protokoll.js';

export const VERBRAUCH_QUELLEN = ['cowork', 'claude-code', 'n8n'] as const;
export const VERBRAUCH_QUALITAETEN = ['gemessen', 'geschaetzt'] as const;
export const VERBRAUCH_ZUORDNUNGEN = ['branch', 'repo-map', 'prompt', 'auftrag', 'tag', 'keine'] as const;

/** Ein Eintrag in der Schreibweise der Spalten — so reicht ihn die Route als JSON an die Datenbank durch. */
export interface VerbrauchEintrag {
  readonly schluessel: string;
  /** Zeitpunkt des Einsatzes, ISO-8601. Er bestimmt, welcher Preis gilt. */
  readonly zeitpunkt: string;
  readonly quelle: (typeof VERBRAUCH_QUELLEN)[number];
  readonly modell: string;
  readonly ticket: string | null;
  readonly jira_projekt: string | null;
  readonly sitzung: string | null;
  readonly qualitaet: (typeof VERBRAUCH_QUALITAETEN)[number];
  readonly zuordnung: (typeof VERBRAUCH_ZUORDNUNGEN)[number];
  readonly subagent: boolean;
  /** Welcher Agent den Einsatz hatte (COPI-113); `null` ohne Zuordnung. */
  readonly agent: string | null;
  readonly tokens_eingabe: number;
  readonly tokens_ausgabe: number;
  readonly tokens_cache_schreiben_5m: number;
  readonly tokens_cache_schreiben_1h: number;
  readonly tokens_cache_lesen: number;
}

export interface VerbrauchErgebnis {
  readonly neu: number;
  readonly ersetzt: number;
  /** Wie viele Einträge ohne Preis blieben (Kosten NULL). */
  readonly ohnePreis: number;
  /** Die Modelle der Einträge, für die kein Preis galt (Kosten NULL), ohne Wiederholung. */
  readonly modelleOhnePreis: readonly string[];
}

const SPALTEN = [
  'schluessel',
  'zeitpunkt',
  'quelle',
  'modell',
  'ticket',
  'jira_projekt',
  'sitzung',
  'qualitaet',
  'zuordnung',
  'subagent',
  'agent',
  'tokens_eingabe',
  'tokens_ausgabe',
  'tokens_cache_schreiben_5m',
  'tokens_cache_schreiben_1h',
  'tokens_cache_lesen',
] as const satisfies readonly (keyof VerbrauchEintrag)[];

/** Beim Ersetzen bleibt nur der Schlüssel; alles andere kommt aus der neuen Meldung. */
const ERSETZEN = SPALTEN.filter((spalte) => spalte !== 'schluessel')
  .map((spalte) => `${spalte} = EXCLUDED.${spalte}`)
  .join(', ');

/**
 * Trägt die Einträge ein oder ersetzt sie. Die Schlüssel müssen sich unterscheiden (die Route prüft es vorher) —
 * zwei Einträge zum selben Schlüssel in einer Anweisung weist die Datenbank ab.
 */
export async function verbrauchMelden(
  db: Abfrager,
  eintraege: readonly VerbrauchEintrag[],
  meldung: { readonly von: string; readonly jetzt: Date },
): Promise<VerbrauchErgebnis> {
  // `xmax = 0` trifft nur auf frisch eingefügte Zeilen zu; eine ersetzte trägt die eigene Transaktion.
  const ergebnis = await db.query<{ neu: boolean; modell: string; ohne_preis: boolean }>(
    `INSERT INTO cockpit.verbrauch (${SPALTEN.join(', ')}, gemeldet_von, gemeldet_am)
     SELECT ${SPALTEN.map((spalte) => `e.${spalte}`).join(', ')}, $2, $3
       FROM jsonb_to_recordset($1::jsonb) AS e (
            schluessel text, zeitpunkt timestamptz, quelle text, modell text, ticket text, jira_projekt text,
            sitzung text, qualitaet text, zuordnung text, subagent boolean, agent text, tokens_eingabe bigint, tokens_ausgabe bigint,
            tokens_cache_schreiben_5m bigint, tokens_cache_schreiben_1h bigint, tokens_cache_lesen bigint)
     ON CONFLICT (schluessel) DO UPDATE
        SET ${ERSETZEN}, gemeldet_von = EXCLUDED.gemeldet_von, gemeldet_am = EXCLUDED.gemeldet_am
     RETURNING (xmax = 0) AS neu, modell, (kosten IS NULL) AS ohne_preis`,
    [JSON.stringify(eintraege), meldung.von, meldung.jetzt],
  );
  const neu = ergebnis.rows.filter((zeile) => zeile.neu).length;
  const ohnePreis = ergebnis.rows.filter((zeile) => zeile.ohne_preis);
  return {
    neu,
    ersetzt: ergebnis.rows.length - neu,
    ohnePreis: ohnePreis.length,
    modelleOhnePreis: [...new Set(ohnePreis.map((zeile) => zeile.modell))].sort(),
  };
}

export interface NeuberechnungErgebnis {
  readonly eintraege: number;
  /** Wie viele Einträge auch danach keinen Preis haben. */
  readonly ohnePreis: number;
}

/**
 * Rechnet die Kosten aller Einträge neu aus der Preistabelle — nach einem nachgetragenen oder berichtigten Preis. Die
 * Zeilen ändern sich sonst nicht; der Trigger setzt Preis, Kosten und Währung.
 */
export async function kostenNeuBerechnen(db: Abfrager): Promise<NeuberechnungErgebnis> {
  const ergebnis = await db.query<{ ohne_preis: boolean }>(
    'UPDATE cockpit.verbrauch SET modell = modell RETURNING (kosten IS NULL) AS ohne_preis',
  );
  return { eintraege: ergebnis.rows.length, ohnePreis: ergebnis.rows.filter((zeile) => zeile.ohne_preis).length };
}
