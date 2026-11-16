-- Nimmt 0037 zurück; jede Zuordnung zu einem Agenten geht verloren — ein Werkzeug für die Entwicklung, kein Weg im
-- Betrieb (wie 0030). Gibt es schon einen Kanal zwischen Agenten, scheitert es an der alten Bedingung der Kanal-Art:
-- gewollt, denn seine Nachrichten sind Nachweise und werden nie gelöscht (0025).
DROP TRIGGER "nachricht_agent" ON "cockpit"."nachricht";
DROP FUNCTION "cockpit"."nachricht_agent_pruefen"();
DROP INDEX "cockpit"."kanal_agenten_je_paar_idx";
ALTER TABLE "cockpit"."kanal"
    DROP CONSTRAINT kanal_agenten_form,
    DROP CONSTRAINT kanal_agenten_sortiert,
    DROP CONSTRAINT kanal_agenten_nur_beim_agentenkanal,
    DROP CONSTRAINT kanal_art_bekannt,
    ADD CONSTRAINT kanal_art_bekannt CHECK (art IN ('assistent', 'team')),
    DROP COLUMN agent_b,
    DROP COLUMN agent_a;
ALTER TABLE "cockpit"."nachricht" DROP COLUMN absender_agent;
ALTER TABLE "cockpit"."verbrauch" DROP COLUMN agent;
ALTER TABLE "cockpit"."wache" DROP COLUMN agent;
