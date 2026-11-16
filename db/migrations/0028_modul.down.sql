-- Nimmt 0028 zurück. Die ganze Modul-Registry geht verloren: jedes Modul gilt danach als nicht
-- eingespielt, bis es erneut eingespielt wird. Ein Werkzeug für die Entwicklung, kein Weg im Betrieb
-- (wie 0025 es für „nie löschen" schon festhält).
DROP TABLE "cockpit"."modul";
DROP FUNCTION "cockpit"."modul_pruefen"();
