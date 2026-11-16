-- Modul „KI-Verbrauch" (COPI-98): die Kennzahlen-View über die Tageswerte (`cockpit.verbrauch_tag`, Migration 0034),
-- zum Block `docs/beispiele/ki-verbrauch.cockpit.yaml` (Ansichtstyp `kennzahlen`, `docs/modul-vertrag.md`).
--
-- Eine Zeile je Tag, Projekt, Ticket, Modell, Quelle, Qualität und Währung — so fein wie die Tageswerte. Das Cockpit
-- summiert selbst je Zeitraum und Aufteilung. `wert` sind die Kosten in Euro zum Kurs des Tages (`cockpit.in_eur`,
-- 0033); ohne Preis oder ohne Kurs ist `wert` NULL und fehlt in den Summen — die Hinweis-View nennt das.
--
-- Alle Zahlen als `numeric`, alle Aufteilungen als `text` (der Vertrag prüft die Typen genau). Nur für den Betreuer
-- freigegeben; Rohbefunde kommen hier nicht vor.
--
-- Ausgeliefert wird dieselbe View aus dem Repo `agent-blueprints` (`sql/v_modul_ki_verbrauch.sql`). Änderungen immer
-- in beiden Repos.
CREATE VIEW cockpit.v_modul_ki_verbrauch AS
SELECT t.tag,
       e.eur AS wert,
       (t.tokens_eingabe + t.tokens_ausgabe + t.tokens_cache_schreiben_5m + t.tokens_cache_schreiben_1h + t.tokens_cache_lesen)::numeric AS tokens,
       t.tokens_cache_lesen::numeric AS tokens_cache_lesen,
       t.einsaetze::numeric AS einsaetze,
       t.jira_projekt AS projekt,
       t.ticket,
       t.modell,
       t.quelle,
       CASE WHEN t.qualitaet = 'geschaetzt' THEN e.eur END AS wert_geschaetzt,
       CASE WHEN t.ticket IS NULL THEN e.eur END AS wert_ohne_ticket,
       CASE WHEN t.waehrung IS NULL THEN t.einsaetze END::numeric AS ohne_preis
  FROM cockpit.verbrauch_tag t
 CROSS JOIN LATERAL (SELECT cockpit.in_eur(t.kosten, t.waehrung, t.tag) AS eur) e;
