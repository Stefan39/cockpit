-- Nimmt 0017 zurück. Die Anzeigenamen gehen verloren, die Wachen und ihre Befunde bleiben. Die Bedingung
-- geht mit der Spalte.
ALTER TABLE "cockpit"."wache" DROP COLUMN "anzeigename";
