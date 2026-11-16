-- Nimmt 0055 zurück — ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie 0053): die Preiszeile geht verloren,
-- Einsätze mit BAAI/bge-m3 stehen wieder ohne Preis (Kosten NULL). Erst die Zeile beenden und die Einsätze neu rechnen,
-- dann löschen.
UPDATE "cockpit"."preis" SET gueltig_bis = gueltig_ab + interval '1 second' WHERE modell = 'BAAI/bge-m3';

UPDATE "cockpit"."verbrauch" SET zeitpunkt = zeitpunkt
 WHERE preis_id IN (SELECT id FROM "cockpit"."preis" WHERE modell = 'BAAI/bge-m3');

ALTER TABLE "cockpit"."preis" DISABLE TRIGGER "preis_nie_loeschen";
DELETE FROM "cockpit"."preis" WHERE modell = 'BAAI/bge-m3';
ALTER TABLE "cockpit"."preis" ENABLE TRIGGER "preis_nie_loeschen";
