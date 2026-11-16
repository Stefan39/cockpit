-- Nimmt 0031 zurück. Die Zeitpunkte der Quittungen gehen verloren — ein Werkzeug für die Entwicklung, kein Weg im
-- Betrieb (wie 0028).
DROP TRIGGER "nachricht_zugestellt" ON "cockpit"."nachricht";
DROP FUNCTION "cockpit"."nachricht_zugestellt_pruefen"();
ALTER TABLE "cockpit"."nachricht" DROP COLUMN "zugestellt_am";
