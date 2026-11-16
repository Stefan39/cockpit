-- Nimmt 0049 zurück. Die gemeldeten Update-Ziele gehen verloren, die Befunde selbst bleiben. Die Bedingung geht mit der
-- Spalte.
ALTER TABLE "cockpit"."befund" DROP COLUMN "update_ziel";
