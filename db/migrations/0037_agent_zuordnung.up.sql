-- COPI-113: Die Detailseite eines Agenten — was wem gehört. Das Cockpit holt nichts selbst (ADR); es ordnet zu, was ihm
-- gemeldet wird, über die Kennung des Agenten (Form wie `agent.kennung`, 0015). Kein Fremdschlüssel auf `agent`: das
-- Inventar meldet der Admin-Agent, eine Wache, ein Einsatz oder eine Nachricht kann vor ihm da sein. Ein entfernter
-- Agent bleibt ohnehin im Bestand (0025), seine Zuordnungen auch.
--
-- 1. Eine Wache gehört optional einem Agenten (Befunde je Agent, Protokoll). Gemeldet mit dem Befund, wie der Anzeigename.
ALTER TABLE "cockpit"."wache"
    ADD COLUMN agent text,
    ADD CONSTRAINT wache_agent_form CHECK (agent IS NULL OR agent ~ '^[a-z0-9][a-z0-9_.-]{0,62}$');

-- 2. Ein Einsatz im KI-Verbrauch gehört optional einem Agenten (Verbrauch je Agent).
ALTER TABLE "cockpit"."verbrauch"
    ADD COLUMN agent text,
    ADD CONSTRAINT verbrauch_agent_form CHECK (agent IS NULL OR agent ~ '^[a-z0-9][a-z0-9_.-]{0,62}$');

CREATE INDEX "verbrauch_agent_zeit" ON "cockpit"."verbrauch" (agent, zeitpunkt) WHERE agent IS NOT NULL;

-- 3. Welcher Agent eine Nachricht geschrieben hat. Nur bei `absender_art = 'agent'`; ältere Antworten des Koordinators
--    bleiben ohne Kennung (sie lassen sich nicht nachträglich zuordnen).
ALTER TABLE "cockpit"."nachricht"
    ADD COLUMN absender_agent text,
    ADD CONSTRAINT nachricht_absender_agent_form CHECK (absender_agent IS NULL OR absender_agent ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
    ADD CONSTRAINT nachricht_absender_agent_nur_beim_agenten CHECK (absender_agent IS NULL OR absender_art = 'agent');

CREATE INDEX "nachricht_absender_agent_idx" ON "cockpit"."nachricht" (absender_agent, id) WHERE absender_agent IS NOT NULL;

-- 4. Kanal zwischen zwei Agenten. Die beiden Kennungen sortiert (`agent_a < agent_b`), damit es je Paar genau einen gibt.
--    Menschen lesen dort nur mit; schreiben dürfen nur die beiden Agenten (Prüfung unten).
ALTER TABLE "cockpit"."kanal"
    ADD COLUMN agent_a text,
    ADD COLUMN agent_b text,
    DROP CONSTRAINT kanal_art_bekannt,
    ADD CONSTRAINT kanal_art_bekannt CHECK (art IN ('assistent', 'team', 'agent')),
    ADD CONSTRAINT kanal_agenten_nur_beim_agentenkanal CHECK ((art = 'agent') = (agent_a IS NOT NULL AND agent_b IS NOT NULL)),
    ADD CONSTRAINT kanal_agenten_sortiert CHECK (agent_a IS NULL OR agent_a < agent_b),
    ADD CONSTRAINT kanal_agenten_form CHECK (
        agent_a IS NULL OR (agent_a ~ '^[a-z0-9][a-z0-9_.-]{0,62}$' AND agent_b ~ '^[a-z0-9][a-z0-9_.-]{0,62}$')
    );

CREATE UNIQUE INDEX "kanal_agenten_je_paar_idx" ON "cockpit"."kanal" (agent_a, agent_b) WHERE art = 'agent';

-- Eigene Prüfung statt `nachricht_pruefen` (0024) zu ersetzen: im Agentenkanal schreibt nur einer der beiden Agenten,
-- mit Kennung; die Kennung steht danach fest wie der übrige Absender.
CREATE FUNCTION "cockpit"."nachricht_agent_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    k "cockpit"."kanal"%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."absender_agent" IS DISTINCT FROM OLD."absender_agent" THEN
            RAISE EXCEPTION 'nachricht_unveraenderlich: Eine Nachricht wird nach dem Schreiben nicht mehr geaendert';
        END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO k FROM "cockpit"."kanal" WHERE id = NEW."kanal_id";
    IF k."art" = 'agent' AND (NEW."absender_art" <> 'agent' OR NEW."absender_agent" IS NULL
                              OR NEW."absender_agent" NOT IN (k."agent_a", k."agent_b")) THEN
        RAISE EXCEPTION 'nachricht_agentenkanal: Im Kanal zweier Agenten schreibt nur einer der beiden';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "nachricht_agent"
    BEFORE INSERT OR UPDATE ON "cockpit"."nachricht"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."nachricht_agent_pruefen"();
