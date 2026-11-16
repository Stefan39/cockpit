-- COPI-234: Nach jeder Änderung an `cockpit.preis` rechnet die Datenbank die Verbrauchskosten selbst nach (ADR COPI-211,
-- Teil C). Bisher musste nach einer Preis-Migration das Server-Kommando `verbrauch-kosten-neu` von Hand laufen.
--
--   * Die Funktion tut dasselbe wie `kostenNeuBerechnen()` (src/verbrauch/verbrauch-speicher.ts): `SET modell = modell`
--     löst den Trigger `verbrauch_kosten` (0032, `verbrauch_kosten_setzen()`) für jede Zeile aus; der setzt den Preis.
--   * Ein Trigger je Anweisung, ohne Transition-Tabellen und ohne Einschränkung auf einzelne Modelle: einfach statt
--     schnell, die Preistabelle ändert sich selten.
--   * `verbrauch-kosten-neu` bleibt als Werkzeug für den Notfall.
CREATE FUNCTION "cockpit"."preis_verbrauch_nachrechnen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE "cockpit"."verbrauch" SET "modell" = "modell";
    RETURN NULL;
END;
$$;

CREATE TRIGGER "preis_nachrechnen" AFTER INSERT OR UPDATE OR DELETE ON "cockpit"."preis"
    FOR EACH STATEMENT EXECUTE FUNCTION "cockpit"."preis_verbrauch_nachrechnen"();
