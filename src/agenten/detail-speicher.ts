/**
 * Was die Detailseite eines Agenten (COPI-113) aus der Datenbank liest, über die Kennung des Agenten (Migration 0037):
 * seinen Verbrauch, die Übernahmen in seinen Modulen und die Nachrichten zwischen ihm und anderen Agenten. Das Cockpit
 * holt nichts selbst (ADR) — es liest nur, was ihm gemeldet wurde.
 */
import type pg from 'pg';
import { EHEMALIGES_KONTO } from '../module/vorgang-sperre.js';

/** So weit zurück liest die Seite: Protokoll und Verlauf des Verbrauchs. */
export const AGENT_TAGE = 30;

/** Kosten und Tokens eines Agenten je Berliner Tag und Modell, in Euro (`cockpit.in_eur`, 0033). */
export interface VerbrauchTagModell {
  /** `YYYY-MM-DD`, Berliner Kalendertag. */
  readonly tag: string;
  readonly modell: string;
  readonly einsaetze: number;
  readonly mitSubagent: number;
  readonly tokens: number;
  readonly tokensCacheLesen: number;
  /** `undefined`: ohne Preis (oder ohne Kurs). */
  readonly eur: number | undefined;
}

/** Der Verbrauch eines Agenten ab `ab` (Berliner Tag), je Tag und Modell. */
export async function agentVerbrauchLesen(pool: pg.Pool, kennung: string, ab: string): Promise<VerbrauchTagModell[]> {
  const ergebnis = await pool.query<{
    tag: string;
    modell: string;
    einsaetze: number;
    mit_subagent: number;
    tokens: string;
    cache_lesen: string;
    eur: string | null;
  }>(
    `WITH v AS (
       SELECT (zeitpunkt AT TIME ZONE 'Europe/Berlin')::date AS tag, modell, subagent, kosten, waehrung,
              tokens_eingabe + tokens_ausgabe + tokens_cache_schreiben_5m + tokens_cache_schreiben_1h + tokens_cache_lesen AS tokens,
              tokens_cache_lesen
         FROM cockpit.verbrauch
        WHERE agent = $1 AND zeitpunkt >= ($2::date)::timestamp AT TIME ZONE 'Europe/Berlin'
     )
     SELECT to_char(tag, 'YYYY-MM-DD') AS tag, modell, count(*)::int AS einsaetze, count(*) FILTER (WHERE subagent)::int AS mit_subagent,
            sum(tokens)::text AS tokens, sum(tokens_cache_lesen)::text AS cache_lesen,
            sum(cockpit.in_eur(kosten, waehrung, tag))::text AS eur
       FROM v
      GROUP BY tag, modell
      ORDER BY tag, modell`,
    [kennung, ab],
  );
  return ergebnis.rows.map((zeile) => ({
    tag: zeile.tag,
    modell: zeile.modell,
    einsaetze: zeile.einsaetze,
    mitSubagent: zeile.mit_subagent,
    tokens: Number(zeile.tokens),
    tokensCacheLesen: Number(zeile.cache_lesen),
    eur: zeile.eur === null ? undefined : Number(zeile.eur),
  }));
}

/** Eine Übernahme in einem Modul des Agenten (Migration 0030). */
export interface AgentUebernahme {
  readonly modul: string;
  readonly vorgangId: string;
  readonly von: string;
  readonly am: Date;
  readonly zurueckAm: Date | undefined;
}

/** Die jüngsten Übernahmen in diesen Modulen seit `seit`, neueste zuerst. Ein gelöschtes Konto heißt „ehemaliges Konto". */
export async function uebernahmenLesen(pool: pg.Pool, module: readonly string[], seit: Date, hoechstens: number): Promise<AgentUebernahme[]> {
  if (module.length === 0) {
    return [];
  }
  const ergebnis = await pool.query<{ modul_kennung: string; vorgang_id: string; name: string | null; geloescht: boolean; uebernommen_am: Date; zurueckgegeben_am: Date | null }>(
    `SELECT s.modul_kennung, s.vorgang_id, u.name, u.geloescht_am IS NOT NULL AS geloescht, s.uebernommen_am, s.zurueckgegeben_am
       FROM cockpit.vorgang_sperre s
       LEFT JOIN cockpit."user" u ON u.id = s.uebernommen_von
      WHERE s.modul_kennung = ANY($1::text[]) AND (s.uebernommen_am >= $2 OR s.zurueckgegeben_am >= $2)
      ORDER BY s.uebernommen_am DESC
      LIMIT $3`,
    [module, seit, hoechstens],
  );
  return ergebnis.rows.map((zeile) => {
    const name = zeile.name?.trim() ?? '';
    return {
      modul: zeile.modul_kennung,
      vorgangId: zeile.vorgang_id,
      von: zeile.geloescht || name === '' ? EHEMALIGES_KONTO : name,
      am: zeile.uebernommen_am,
      zurueckAm: zeile.zurueckgegeben_am ?? undefined,
    };
  });
}

/** Eine Nachricht zwischen zwei Agenten (Kanal-Art `agent`, 0037). */
export interface AgentenNachricht {
  readonly kanalId: number;
  readonly von: string;
  readonly an: string;
  readonly inhalt: string | undefined;
  readonly am: Date;
}

/** Die jüngsten Nachrichten zwischen diesem und anderen Agenten seit `seit`, neueste zuerst. */
export async function agentenNachrichtenLesen(pool: pg.Pool, kennung: string, seit: Date, hoechstens: number): Promise<AgentenNachricht[]> {
  const ergebnis = await pool.query<{ kanal_id: number; von: string; an: string; inhalt: string; geloescht: boolean; erstellt_am: Date }>(
    `SELECT n.kanal_id::int AS kanal_id, n.absender_agent AS von,
            CASE WHEN n.absender_agent = k.agent_a THEN k.agent_b ELSE k.agent_a END AS an,
            n.inhalt, n.geloescht_am IS NOT NULL AS geloescht, n.erstellt_am
       FROM cockpit.nachricht n
       JOIN cockpit.kanal k ON k.id = n.kanal_id
      WHERE k.art = 'agent' AND $1 IN (k.agent_a, k.agent_b) AND n.erstellt_am >= $2
      ORDER BY n.id DESC
      LIMIT $3`,
    [kennung, seit, hoechstens],
  );
  return ergebnis.rows.map((zeile) => ({
    kanalId: zeile.kanal_id,
    von: zeile.von,
    an: zeile.an,
    inhalt: zeile.geloescht ? undefined : zeile.inhalt,
    am: zeile.erstellt_am,
  }));
}

/** Wie viele Nachrichten der Agent seit `seit` geschrieben hat — nur in Kanälen, die der Betrachter sehen darf. */
export async function agentNachrichtenZaehlen(pool: pg.Pool, kennung: string, benutzerId: string, seit: Date, mitAgentenkanaelen: boolean): Promise<number> {
  const ergebnis = await pool.query<{ anzahl: number }>(
    `SELECT count(*)::int AS anzahl
       FROM cockpit.nachricht n JOIN cockpit.kanal k ON k.id = n.kanal_id
      WHERE n.absender_agent = $1 AND n.erstellt_am >= $3
        AND (k.art = 'team' OR (k.art = 'assistent' AND k.besitzer_id = $2) OR ($4 AND k.art = 'agent'))`,
    [kennung, benutzerId, seit, mitAgentenkanaelen],
  );
  return ergebnis.rows[0]?.anzahl ?? 0;
}
