-- Nimmt 0036 zurück. Der Lesestand des Posteingangs geht verloren — danach gilt beim nächsten Laden wieder alles bis
-- dahin als gelesen. Ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie 0030).
DROP TABLE "cockpit"."modul_gelesen";
DROP TABLE "cockpit"."posteingang_stand";
