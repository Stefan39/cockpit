-- Modul „KI-Verbrauch" (COPI-98): die Hinweis-View zum Block `docs/beispiele/ki-verbrauch.cockpit.yaml` — je Zeile
-- eine Warnung mit `titel` und `text`. Ohne Anlass ist die View leer, und die Seite zeigt keine Warnung.
--
-- Betrachtet werden die letzten 30 Berliner Kalendertage:
--   1. Einsätze ohne Preis (für das Modell steht keine Zeile in `cockpit.preis`) — sie fehlen in den Kosten.
--   2. Einsätze in US-Dollar ohne Wechselkurs (kein Kurs bis zu ihrem Tag) — sie fehlen in den Euro-Beträgen.
--   3. Der Wechselkurs ist älter als vier Tage, obwohl danach noch in US-Dollar gearbeitet wurde — umgerechnet wird
--      dann mit dem letzten bekannten Kurs (ein Wochenende samt Feiertag bleibt ohne Warnung).
--
-- Ausgeliefert wird dieselbe View aus dem Repo `agent-blueprints` (`sql/v_modul_ki_verbrauch_hinweise.sql`).
CREATE VIEW cockpit.v_modul_ki_verbrauch_hinweise AS
WITH fenster AS (
    SELECT t.*, cockpit.in_eur(t.kosten, t.waehrung, t.tag) AS eur
      FROM cockpit.verbrauch_tag t
     WHERE t.tag >= (now() AT TIME ZONE 'Europe/Berlin')::date - 29
), kurs AS (
    SELECT tag, usd_je_eur FROM cockpit.wechselkurs ORDER BY tag DESC LIMIT 1
)
SELECT o.einsaetze || ' Einsätze ohne Preis' AS titel,
       'Für ' || o.modelle || ' ist kein Preis hinterlegt. Diese Einsätze fehlen in den Kosten, die Tokens sind gezählt.' AS text
  FROM (SELECT sum(einsaetze) AS einsaetze, string_agg(DISTINCT modell, ', ' ORDER BY modell) AS modelle
          FROM fenster WHERE waehrung IS NULL) o
 WHERE o.einsaetze > 0
UNION ALL
SELECT k.einsaetze || ' Einsätze ohne Wechselkurs' AS titel,
       'Für Beträge in US-Dollar bis zum ' || to_char(k.bis, 'DD.MM.YYYY') || ' liegt kein Kurs vor. Sie fehlen in den Euro-Beträgen.' AS text
  FROM (SELECT sum(einsaetze) AS einsaetze, max(tag) AS bis FROM fenster WHERE waehrung IS NOT NULL AND eur IS NULL) k
 WHERE k.einsaetze > 0
UNION ALL
SELECT 'Wechselkurs zuletzt am ' || to_char(kurs.tag, 'DD.MM.YYYY') || ' gemeldet' AS titel,
       'Beträge in US-Dollar danach sind mit diesem Kurs umgerechnet (1 € = '
           || replace(trim(trailing '0' FROM to_char(kurs.usd_je_eur, 'FM0.000000')), '.', ',') || ' $).' AS text
  FROM kurs
 WHERE EXISTS (SELECT 1 FROM fenster f WHERE f.waehrung = 'USD' AND f.tag > kurs.tag + 4);
