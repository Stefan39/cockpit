-- Nimmt 0046 zurück — ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie 0032, 0043): die sechs Preiszeilen
-- gehen verloren, obwohl die Tabelle sonst nie löscht (0025). Einsätze, die sie nutzten, verlieren ihren Preis (Kosten
-- NULL): erst die Zeilen beenden, damit die Neuberechnung des Triggers sie nicht wiederfindet, dann die Einsätze neu
-- rechnen, dann löschen.
UPDATE "cockpit"."preis" SET gueltig_bis = gueltig_ab + interval '1 second'
 WHERE modell LIKE 'gemini-%-image%' AND quelle IN ('https://ai.google.dev/gemini-api/docs/pricing', 'https://cloud.google.com/vertex-ai/generative-ai/pricing');

UPDATE "cockpit"."verbrauch" SET zeitpunkt = zeitpunkt
 WHERE preis_id IN (SELECT id FROM "cockpit"."preis" WHERE modell LIKE 'gemini-%-image%');

ALTER TABLE "cockpit"."preis" DISABLE TRIGGER "preis_nie_loeschen";
DELETE FROM "cockpit"."preis" WHERE modell LIKE 'gemini-%-image%';
ALTER TABLE "cockpit"."preis" ENABLE TRIGGER "preis_nie_loeschen";
