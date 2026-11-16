-- COPI-209: Preiszeile für Claude Sonnet 4.6. Seit 21.10.2026 melden Cowork-Sitzungen Einsätze mit diesem Modell; der
-- Jira-Abgleich (JAC-635) meldete am 24.10.2026 fünf Einsätze ohne Preis (COPI-189). Preise je Million Tokens in USD,
-- Listenpreis der API, geprüft am 24.10.2026.
--
--   * Sonnet 4.6 ist nicht gestaffelt, auch der volle 1M-Kontext gilt zum Standardpreis.
--   * Cache-Spalten wie bei den übrigen Anthropic-Zeilen (0032): Schreiben 1,25-fach (5 Minuten) bzw. 2-fach
--     (1 Stunde), Lesen 0,1-fach des Eingabepreises.
--   * Gültig ab 01.10.2026 wie Haiku 5.5 (0047): vor dem ersten Einsatz am 21.10.2026.
--
-- Die Kosten der Einträge ohne Preis rechnet das Server-Kommando `verbrauch-kosten-neu` nach (Ticket, „Fertig, wenn").
INSERT INTO "cockpit"."preis"
    (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
VALUES ('claude-sonnet-4-6', 'USD', 3.00, 15.00, 3.75, 6.00, 0.30, '2026-10-01T00:00:00Z',
        'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-24');
