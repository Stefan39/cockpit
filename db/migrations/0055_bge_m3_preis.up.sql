-- COPI-222: Preiszeile für IONOS BAAI/bge-m3. Seit JAC-900 (28.10.2026) holt die Haupt-Website Embeddings über den LiteLLM-Alias
-- `team-embedding`; Wache meldete am 29.10.2026 93 Einsätze ohne Preis. Preis je Million Tokens in EUR, netto, aus der
-- Preisliste „IONOS CLOUD GmbH DE" (v2026-10-22), Abschnitt Embedding-Modelle („bge-m3 | 0,02 €"), geprüft am 30.10.2026.
--
--   * IONOS nennt einen Einheitspreis: Eingabe und Ausgabe bekommen beide 0,02. Embeddings haben keine Ausgabe-Tokens.
--   * Cache-Spalten wie bei `openai/gpt-oss-120b` (0032): gemeldete Cache-Tokens zählen wie Eingabe.
--   * Gültig ab 01.10.2026 wie 0053: vor dem ersten Einsatz am 28.10.2026.
--   * Gibt es schon eine Zeile zum Modell (auch in anderer Schreibweise), wird sie berichtigt statt gedoppelt,
--     auch ihre Gültigkeit (ab 01.10.2026, offen), damit die Einsätze vom 28.10.2026 einen Preis finden.
--
-- Die Kosten der Einsätze ohne Preis rechnet das Server-Kommando `verbrauch-kosten-neu` nach (Ticket, „Fertig, wenn").
UPDATE "cockpit"."preis"
   SET modell = 'BAAI/bge-m3', waehrung = 'EUR', eingabe = 0.02, ausgabe = 0.02,
       cache_schreiben_5m = 0.02, cache_schreiben_1h = 0.02, cache_lesen = 0.02,
       quelle = 'https://docs.ionos.com/cloud/support/general-information/price-list/ionos-cloud-gmbh-de',
       gueltig_ab = '2026-10-01T00:00:00Z', gueltig_bis = NULL, geprueft_am = '2026-10-30'
 WHERE lower(regexp_replace(modell, '^openai/', '')) = 'baai/bge-m3';

INSERT INTO "cockpit"."preis"
    (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
SELECT 'BAAI/bge-m3', 'EUR', 0.02, 0.02, 0.02, 0.02, 0.02, '2026-10-01T00:00:00Z',
       'https://docs.ionos.com/cloud/support/general-information/price-list/ionos-cloud-gmbh-de', '2026-10-30'
 WHERE NOT EXISTS (
       SELECT 1 FROM "cockpit"."preis" WHERE lower(regexp_replace(modell, '^openai/', '')) = 'baai/bge-m3');
