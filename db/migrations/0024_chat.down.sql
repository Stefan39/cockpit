-- Nimmt 0024 zurück. Das ist ein Werkzeug für die Entwicklung, kein Weg im Betrieb: mit den Tabellen gehen Verläufe,
-- Lesestände, Push-Abos und Tagesverbrauch — genau das, was nie gelöscht werden soll.
DROP TABLE "cockpit"."chat_verbrauch";
DROP TABLE "cockpit"."push_abo";
DROP TABLE "cockpit"."nachricht_lesestand";
DROP TABLE "cockpit"."nachricht";
DROP TABLE "cockpit"."kanal";
DROP FUNCTION "cockpit"."nachricht_pruefen"();
DROP FUNCTION "cockpit"."nie_loeschen"();
