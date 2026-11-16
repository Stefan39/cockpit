-- Nimmt 0039 zurück. Alle gemeldeten Ereignisse gehen verloren — ein Werkzeug für die Entwicklung, kein Weg im Betrieb
-- (wie 0030).
DROP TABLE "cockpit"."agent_ereignis";
DROP FUNCTION "cockpit"."agent_ereignis_pruefen"();
