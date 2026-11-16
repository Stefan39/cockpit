-- COPI-129: Preiszeile für Claude Haiku 5.5. Seit 08.10.2026 laufen Claude-Code-Sitzungen mit diesem Modell; der
-- Jira-Abgleich (JAC-635) meldete am 09.10.2026 fünf Einsätze ohne Preis. Preise je Million Tokens in USD, Listenpreis
-- der API, geprüft am 09.10.2026.
--
--   * Haiku 5.5 ist nach Prompt-Länge gestaffelt (Prompt = Eingabe + Cache-Lesen + Cache-Schreiben je Anfrage), über
--     100K Tokens gilt das Fünffache. Entscheidung Stefan, 09.10.2026: nur die Staffel bis 100K, keine
--     Schema-Erweiterung. Einsätze darüber rechnet das Cockpit zu niedrig; die Hinweis-View des Moduls
--     „KI-Verbrauch" warnt dann.
--   * Cache-Spalten wie bei den übrigen Anthropic-Zeilen (0032): Schreiben 1,25-fach (5 Minuten) bzw. 2-fach
--     (1 Stunde), Lesen 0,1-fach des Eingabepreises.
--   * Gültig ab 01.10.2026: das Modell gibt es erst seit Oktober.
--
-- Die Kosten der Einträge ohne Preis rechnet das Server-Kommando `verbrauch-kosten-neu` nach (Ticket, „Fertig, wenn").
INSERT INTO "cockpit"."preis"
    (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
VALUES ('claude-haiku-5-5', 'USD', 0.10, 0.50, 0.125, 0.20, 0.01, '2026-10-01T00:00:00Z',
        'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-09');
