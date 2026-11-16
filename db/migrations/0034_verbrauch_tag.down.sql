-- Nimmt 0034 zurück. Die Tageswerte sind abgeleitet und gehen ohne Verlust: das Protokoll bleibt. Das Recht zuerst:
-- das scheitert, solange ein Zugang `verbrauch_lesen` trägt — gewollt (wie 0026).
ALTER TABLE "cockpit"."api_token"
    DROP CONSTRAINT "api_token_scopes_bekannt",
    ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen', 'verbrauch_schreiben']::text[]
    );

DROP TRIGGER "verbrauch_tage_neu" ON "cockpit"."verbrauch";
DROP TRIGGER "verbrauch_tage_geaendert" ON "cockpit"."verbrauch";
DROP FUNCTION "cockpit"."verbrauch_tage_nachfuehren"();
DROP FUNCTION "cockpit"."verbrauch_tage_verdichten"(date[]);
DROP TABLE "cockpit"."verbrauch_tag";
