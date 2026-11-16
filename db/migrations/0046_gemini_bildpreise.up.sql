-- COPI-120: Preiszeilen für die Gemini-Bildmodelle (Nano Banana). Seit 07.10.2026 melden die Bild-Workflows ihren
-- Verbrauch (JAC-671); ohne Preiszeilen standen die Einträge mit `ohne_preis` im Cockpit. Preise je Million Tokens in
-- USD, Listenpreis der Gemini-API, geprüft am 07.10.2026.
--
--   * Google berechnet Bild-Ausgabe-Tokens rund zehnfach teurer als Text- und Denk-Tokens, das Cockpit kennt aber nur
--     einen Ausgabepreis je Modell. Entscheidung Stefan, 07.10.2026: keine neue Tokenart. Jeder Bildaufruf wird als zwei
--     Einträge gemeldet: `<modell>` (Eingabe, Text- und Denk-Ausgabe) und `<modell>:bild` (nur die Bild-Ausgabe). Der
--     Doppelpunkt ist in `preis_modell_form` und `verbrauch_modell_form` erlaubt.
--   * Bild-Einträge tragen keine Eingabe; der Eingabepreis der `:bild`-Zeilen ist der des Textmodells, damit die Zeile
--     auch dann stimmt, wenn einmal Eingabe mitgemeldet wird.
--   * Cache-Spalten gleich dem Eingabepreis (Muster IONOS, 0032/0043): implizites Caching tritt bei den kurzen
--     Bild-Prompts praktisch nicht auf.
--   * `gemini-2.5-flash-image` steht nicht mehr auf der Gemini-API-Preisseite (dort seit 02.10.2026 abgekündigt), der
--     Preis stammt von Vertex AI.
--   * Gültig ab 01.09.2026 wie die übrigen Startpreise (0032): erfasst wird erst seit dem Start, Altdaten gibt es nicht.
--
-- Die Kosten der Einträge ohne Preis rechnet das Server-Kommando `verbrauch-kosten-neu` nach (Ticket, „Fertig, wenn").
INSERT INTO "cockpit"."preis"
    (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
SELECT v.modell, 'USD', v.eingabe, v.ausgabe, v.eingabe, v.eingabe, v.eingabe, '2026-09-01T00:00:00Z', v.quelle, '2026-10-07'
  FROM (VALUES
        ('gemini-3-pro-image',          2.00,  12.00, 'https://ai.google.dev/gemini-api/docs/pricing'),
        ('gemini-3-pro-image:bild',     2.00, 120.00, 'https://ai.google.dev/gemini-api/docs/pricing'),
        ('gemini-3.1-flash-image',      0.50,   3.00, 'https://ai.google.dev/gemini-api/docs/pricing'),
        ('gemini-3.1-flash-image:bild', 0.50,  60.00, 'https://ai.google.dev/gemini-api/docs/pricing'),
        ('gemini-2.5-flash-image',      0.30,   2.50, 'https://cloud.google.com/vertex-ai/generative-ai/pricing'),
        ('gemini-2.5-flash-image:bild', 0.30,  30.00, 'https://cloud.google.com/vertex-ai/generative-ai/pricing')
       ) AS v (modell, eingabe, ausgabe, quelle);
