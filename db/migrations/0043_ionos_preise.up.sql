-- COPI-118: IONOS-Preise nachtragen. Der tägliche Abgleich (JAC-635) meldete am 03.10.2026 vier Einsätze ohne Preis für
-- `meta-llama/Meta-Llama-3.1-8B-Instruct`; für Mistral Small 24B, das `team-llama-fast` seit JAC-560 bedient, fehlte er
-- ebenso. Preise je Million Tokens in EUR, netto, aus der Preisliste „IONOS CLOUD GmbH DE" (Stand v2026-09-15, gültig
-- ab 15.09.2026), geprüft am 03.10.2026.
--
--   * Die Namen sind die, die die Meldungen tragen: der Name aus der LiteLLM-Konfiguration ohne den Präfix `openai/`,
--     den der Import (JAC-634) streicht. Belegt durch einen echten Einsatz ist bisher nur der 8B-Name; die Mistral-Zeile
--     folgt der Konfiguration (`jac560-litellm-config.yaml`) — trifft sie einen Einsatz nicht, zeigt es der Hinweis
--     „Einsätze ohne Preis", und eine weitere Zeile mit dem gemeldeten Namen kommt hinzu.
--   * Llama 3.3 70B steht seit 0032 mit demselben Preis (0,65/0,65) in der Tabelle: hier nichts nachzutragen.
--   * Gültig ab 01.09.2026 wie die übrigen Startpreise (0032): erfasst wird erst seit dem Start, Altdaten gibt es nicht.
--     Der Preis von Llama 3.1 8B gilt auch für die Einsätze bis zur Abschaltung bei IONOS am 15.10.2026 (JAC-560).
--   * Der Hub kennt keinen Prompt-Cache; gemeldete Cache-Tokens zählen wie Eingabe (wie bei `openai/gpt-oss-120b`).
--
-- Die Kosten der Einsätze ohne Preis rechnet das Server-Kommando `verbrauch-kosten-neu` nach (Ticket, „Fertig, wenn").
INSERT INTO "cockpit"."preis"
    (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
SELECT v.modell, 'EUR', v.eingabe, v.ausgabe, v.eingabe, v.eingabe, v.eingabe, '2026-09-01T00:00:00Z',
       'https://docs.ionos.com/cloud/support/general-information/price-list/ionos-cloud-gmbh-de', '2026-10-03'
  FROM (VALUES
        ('meta-llama/Meta-Llama-3.1-8B-Instruct', 0.15, 0.15),
        ('mistralai/Mistral-Small-24B-Instruct',  0.10, 0.30)
       ) AS v (modell, eingabe, ausgabe);
