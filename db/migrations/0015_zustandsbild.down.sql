-- Nimmt 0015 zurück. Das entfernt alle Befunde, Wachen, das Agenten-Inventar, die Instanzzeile und
-- alle Eingriffe mit — als bewusster Schritt der Migration, nicht als Weg der Anwendung.
--
-- Reihenfolge wegen des Fremdschlüssels (`befund` verweist auf `wache`). Der Trigger geht mit der
-- Tabelle `eingriff`, die Funktion dahinter danach.
DROP TABLE "cockpit"."eingriff";
DROP FUNCTION "cockpit"."eingriff_pruefen"();
DROP TABLE "cockpit"."instanz";
DROP TABLE "cockpit"."agent";
DROP TABLE "cockpit"."befund";
DROP TABLE "cockpit"."wache";
