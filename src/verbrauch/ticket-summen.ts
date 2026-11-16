/**
 * Die Summen des KI-Verbrauchs je Ticket (COPI-98), gelesen aus den Tageswerten (`cockpit.verbrauch_tag`, Migration
 * 0034) — die Quelle für den täglichen Abgleich mit Jira.
 *
 * Summen sind **Gesamtsummen des Tickets**, über alle Tage: die Jira-Felder halten den Stand, keinen Zuwachs. `seit`
 * wählt nur aus, **welche** Tickets kommen — die mit einem Einsatz an oder nach diesem Tag.
 */
import type { Abfrager } from '../auth/protokoll.js';

export interface TicketSumme {
  readonly ticket: string;
  readonly jiraProjekt: string;
  readonly modelle: readonly string[];
  readonly einsaetze: number;
  readonly tokensEingabe: number;
  readonly tokensAusgabe: number;
  /** Cache-Schreiben (beide Laufzeiten) und Cache-Lesen zusammen. */
  readonly tokensCache: number;
  /** Alle Kosten in Euro; ohne die Einsätze, denen Preis oder Kurs fehlt. */
  readonly kostenEur: number;
  /** Der Anteil, der in US-Dollar anfiel, in US-Dollar (Listenpreis). */
  readonly kostenUsd: number;
  readonly geschaetzt: number;
  readonly ohnePreis: number;
  /** Einsätze mit Preis in US-Dollar, für deren Tag (und davor) kein Wechselkurs vorliegt. */
  readonly ohneKurs: number;
  /** Letzter Tag mit einem Einsatz, `YYYY-MM-DD` (Berliner Kalendertag). */
  readonly letzterTag: string;
}

export interface TicketAuswahl {
  /** Nur Tickets mit einem Einsatz an oder nach diesem Tag (`YYYY-MM-DD`). */
  readonly seit?: string | undefined;
  readonly projekt?: string | undefined;
  readonly hoechstens: number;
}

interface Zeile {
  ticket: string;
  jira_projekt: string;
  modelle: string[];
  einsaetze: string;
  tokens_eingabe: string;
  tokens_ausgabe: string;
  tokens_cache: string;
  kosten_eur: string;
  kosten_usd: string;
  geschaetzt: string;
  ohne_preis: string;
  ohne_kurs: string;
  letzter_tag: string;
}

/** Die Tickets nach Schlüssel sortiert, eines mehr als `hoechstens` — so erkennt der Aufrufer, ob es weitere gibt. */
export async function ticketSummen(db: Abfrager, auswahl: TicketAuswahl): Promise<TicketSumme[]> {
  const ergebnis = await db.query<Zeile>(
    `SELECT t.ticket, t.jira_projekt,
            array_agg(DISTINCT t.modell ORDER BY t.modell) AS modelle,
            sum(t.einsaetze) AS einsaetze,
            sum(t.tokens_eingabe) AS tokens_eingabe,
            sum(t.tokens_ausgabe) AS tokens_ausgabe,
            sum(t.tokens_cache_schreiben_5m + t.tokens_cache_schreiben_1h + t.tokens_cache_lesen) AS tokens_cache,
            coalesce(sum(e.eur), 0) AS kosten_eur,
            coalesce(sum(t.kosten) FILTER (WHERE t.waehrung = 'USD'), 0) AS kosten_usd,
            coalesce(sum(t.einsaetze) FILTER (WHERE t.qualitaet = 'geschaetzt'), 0) AS geschaetzt,
            coalesce(sum(t.einsaetze) FILTER (WHERE t.waehrung IS NULL), 0) AS ohne_preis,
            coalesce(sum(t.einsaetze) FILTER (WHERE t.waehrung IS NOT NULL AND e.eur IS NULL), 0) AS ohne_kurs,
            to_char(max(t.tag), 'YYYY-MM-DD') AS letzter_tag
       FROM cockpit.verbrauch_tag t
      CROSS JOIN LATERAL (SELECT cockpit.in_eur(t.kosten, t.waehrung, t.tag) AS eur) e
      WHERE t.ticket IS NOT NULL AND ($2::text IS NULL OR t.jira_projekt = $2)
      GROUP BY t.ticket, t.jira_projekt
     HAVING $1::date IS NULL OR max(t.tag) >= $1::date
      ORDER BY t.jira_projekt, length(t.ticket), t.ticket
      LIMIT $3`,
    [auswahl.seit ?? null, auswahl.projekt ?? null, auswahl.hoechstens + 1],
  );
  return ergebnis.rows.map((zeile) => ({
    ticket: zeile.ticket,
    jiraProjekt: zeile.jira_projekt,
    modelle: zeile.modelle,
    einsaetze: Number(zeile.einsaetze),
    tokensEingabe: Number(zeile.tokens_eingabe),
    tokensAusgabe: Number(zeile.tokens_ausgabe),
    tokensCache: Number(zeile.tokens_cache),
    kostenEur: Number(zeile.kosten_eur),
    kostenUsd: Number(zeile.kosten_usd),
    geschaetzt: Number(zeile.geschaetzt),
    ohnePreis: Number(zeile.ohne_preis),
    ohneKurs: Number(zeile.ohne_kurs),
    letzterTag: zeile.letzter_tag,
  }));
}
