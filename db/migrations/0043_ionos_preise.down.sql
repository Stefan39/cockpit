-- Nimmt 0043 zurück — ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie 0032): die beiden Preiszeilen gehen
-- verloren, obwohl die Tabelle sonst nie löscht (0025). Einsätze, die sie nutzten, verlieren ihren Preis (Kosten NULL):
-- erst die Zeilen beenden, damit die Neuberechnung des Triggers sie nicht wiederfindet, dann die Einsätze neu rechnen,
-- dann löschen.
UPDATE "cockpit"."preis" SET gueltig_bis = gueltig_ab + interval '1 second'
 WHERE modell IN ('meta-llama/Meta-Llama-3.1-8B-Instruct', 'mistralai/Mistral-Small-24B-Instruct')
   AND quelle LIKE 'https://docs.ionos.com/%';

UPDATE "cockpit"."verbrauch" SET zeitpunkt = zeitpunkt
 WHERE preis_id IN (SELECT id FROM "cockpit"."preis" WHERE quelle LIKE 'https://docs.ionos.com/%');

ALTER TABLE "cockpit"."preis" DISABLE TRIGGER "preis_nie_loeschen";
DELETE FROM "cockpit"."preis"
 WHERE modell IN ('meta-llama/Meta-Llama-3.1-8B-Instruct', 'mistralai/Mistral-Small-24B-Instruct')
   AND quelle LIKE 'https://docs.ionos.com/%';
ALTER TABLE "cockpit"."preis" ENABLE TRIGGER "preis_nie_loeschen";
