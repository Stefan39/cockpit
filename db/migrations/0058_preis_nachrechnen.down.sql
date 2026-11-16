-- Nimmt 0058 zurück: Preisänderungen rechnen die Verbrauchskosten nicht mehr selbst nach, `verbrauch-kosten-neu` ist
-- wieder nötig. Bereits berechnete Kosten bleiben unverändert.
DROP TRIGGER "preis_nachrechnen" ON "cockpit"."preis";
DROP FUNCTION "cockpit"."preis_verbrauch_nachrechnen"();
