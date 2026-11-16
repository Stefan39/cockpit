-- COPI-223: Staffelpreise nach Prompt-Länge. Nachfolger der Entscheidung aus COPI-129 (0047_haiku_5_5_preis): dort stand
-- nur die untere Staffel von Claude Haiku 5.5 in `cockpit.preis`, Einsätze über 100.000 Tokens Prompt rechnete das
-- Cockpit zu niedrig. Entscheidung Stefan, 30.10.2026: die Staffel wird richtig gerechnet.
--
--   * Neue Spalte `prompt_ab`: Eine Staffel ist eine eigene Preiszeile. Sie gilt für einen Einsatz, wenn die Prompt-Länge
--     (Eingabe + Cache-Schreiben 5m/1h + Cache-Lesen, je Anfrage) mindestens `prompt_ab` beträgt. Es gilt die höchste
--     passende Staffel. Alle vorhandenen Zeilen bekommen 0, ihr Verhalten bleibt gleich.
--   * Eindeutig ist jetzt (Modell, gültig ab, Prompt ab).
--   * Der Trigger `verbrauch_kosten_setzen` (0032, seither nicht geändert) sucht nur noch Zeilen, deren Staffel erreicht ist.
--   * Neue Zeile für Haiku 5.5 ab 100.001 Tokens Prompt: das Fünffache der unteren Staffel („for prompts over 100,000
--     tokens"; genau 100.000 bleibt in der unteren). Geprüft am 30.10.2026.
--
-- Die Kosten der betroffenen Einsätze rechnet das Server-Kommando `verbrauch-kosten-neu` nach (Ticket, „Fertig, wenn").
ALTER TABLE "cockpit"."preis"
    ADD COLUMN prompt_ab integer NOT NULL DEFAULT 0,
    ADD CONSTRAINT preis_prompt_ab_nicht_negativ CHECK (prompt_ab >= 0);

ALTER TABLE "cockpit"."preis"
    DROP CONSTRAINT "preis_modell_ab_eindeutig",
    ADD CONSTRAINT "preis_modell_ab_eindeutig" UNIQUE (modell, gueltig_ab, prompt_ab);

COMMENT ON COLUMN cockpit.preis.prompt_ab IS 'Staffel: gilt ab dieser Prompt-Länge (Eingabe + Cache-Schreiben + Cache-Lesen je Einsatz, in Tokens); 0 = ohne Staffel. Es gilt die höchste passende Zeile.';

CREATE OR REPLACE FUNCTION "cockpit"."verbrauch_kosten_setzen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    p "cockpit"."preis"%ROWTYPE;
BEGIN
    SELECT * INTO p
      FROM "cockpit"."preis"
     WHERE modell IN (NEW."modell", regexp_replace(NEW."modell", '-[0-9]{8}$', ''))
       AND gueltig_ab <= NEW."zeitpunkt"
       AND (gueltig_bis IS NULL OR gueltig_bis > NEW."zeitpunkt")
       AND prompt_ab <= (NEW."tokens_eingabe" + NEW."tokens_cache_schreiben_5m" + NEW."tokens_cache_schreiben_1h" + NEW."tokens_cache_lesen")
     ORDER BY (modell = NEW."modell") DESC, prompt_ab DESC, gueltig_ab DESC
     LIMIT 1;
    IF NOT FOUND THEN
        NEW."preis_id" := NULL;
        NEW."kosten" := NULL;
        NEW."waehrung" := NULL;
        RETURN NEW;
    END IF;
    NEW."preis_id" := p.id;
    NEW."waehrung" := p.waehrung;
    NEW."kosten" := round((
          NEW."tokens_eingabe" * p.eingabe
        + NEW."tokens_ausgabe" * p.ausgabe
        + NEW."tokens_cache_schreiben_5m" * p.cache_schreiben_5m
        + NEW."tokens_cache_schreiben_1h" * p.cache_schreiben_1h
        + NEW."tokens_cache_lesen" * p.cache_lesen
    ) / 1000000, 6);
    RETURN NEW;
END;
$$;

INSERT INTO "cockpit"."preis"
    (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am, prompt_ab)
VALUES ('claude-haiku-5-5', 'USD', 0.50, 2.50, 0.625, 1.00, 0.05, '2026-10-01T00:00:00Z',
        'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-30', 100001);
