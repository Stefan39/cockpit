-- Nimmt 0056 zurück — ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie 0047): die Staffelzeile geht verloren,
-- Einsätze von Haiku 5.5 über 100K Prompt werden wieder mit der unteren Staffel gerechnet. Reihenfolge: erst die alte
-- Funktion wiederherstellen (sie kennt `prompt_ab` nicht), dann die Staffelzeile vollständig in die Vergangenheit
-- verschieben, damit sie für keinen Einsatz mehr gilt (auch nicht für einen genau zum Staffelbeginn), dann die Einsätze
-- neu rechnen und erst danach löschen.
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
     ORDER BY (modell = NEW."modell") DESC, gueltig_ab DESC
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

UPDATE "cockpit"."preis" SET gueltig_ab = '1970-01-01T00:00:00Z', gueltig_bis = '1970-01-02T00:00:00Z' WHERE prompt_ab > 0;

UPDATE "cockpit"."verbrauch" SET zeitpunkt = zeitpunkt
 WHERE preis_id IN (SELECT id FROM "cockpit"."preis" WHERE prompt_ab > 0);

ALTER TABLE "cockpit"."preis" DISABLE TRIGGER "preis_nie_loeschen";
DELETE FROM "cockpit"."preis" WHERE prompt_ab > 0;
ALTER TABLE "cockpit"."preis" ENABLE TRIGGER "preis_nie_loeschen";

ALTER TABLE "cockpit"."preis"
    DROP CONSTRAINT "preis_modell_ab_eindeutig",
    ADD CONSTRAINT "preis_modell_ab_eindeutig" UNIQUE (modell, gueltig_ab);

ALTER TABLE "cockpit"."preis" DROP COLUMN prompt_ab;
