-- Nimmt 0053 zurück — ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie 0043, 0046, 0047): die Preiszeile geht
-- verloren, Einsätze mit Sonnet 4.6 stehen wieder ohne Preis (Kosten NULL). Erst die Zeile beenden und die Einsätze neu
-- rechnen, dann löschen.
UPDATE "cockpit"."preis" SET gueltig_bis = gueltig_ab + interval '1 second' WHERE modell = 'claude-sonnet-4-6';

UPDATE "cockpit"."verbrauch" SET zeitpunkt = zeitpunkt
 WHERE preis_id IN (SELECT id FROM "cockpit"."preis" WHERE modell = 'claude-sonnet-4-6');

ALTER TABLE "cockpit"."preis" DISABLE TRIGGER "preis_nie_loeschen";
DELETE FROM "cockpit"."preis" WHERE modell = 'claude-sonnet-4-6';
ALTER TABLE "cockpit"."preis" ENABLE TRIGGER "preis_nie_loeschen";
