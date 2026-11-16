-- Nimmt 0051 zurück und **löscht die Queue samt Audit** — ein Werkzeug für die Entwicklung, kein Weg im Betrieb. Hat ein
-- Zugang schon das Recht `pipeline_verwalten`, scheitert der Rückweg laut an `api_token_scopes_bekannt`, statt ihn zu
-- verfälschen.
ALTER TABLE "cockpit"."api_token"
    DROP CONSTRAINT "api_token_scopes_bekannt",
    ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen', 'verbrauch_schreiben', 'verbrauch_lesen']::text[]
    );

DROP TABLE "cockpit"."pipeline_provider_state";
DROP TABLE "cockpit"."pipeline_usage";
DROP TABLE "cockpit"."pipeline_job_event";
DROP FUNCTION "cockpit"."pipeline_unveraenderlich"();
DROP TABLE "cockpit"."pipeline_job";
DROP TABLE "cockpit"."pipeline_repo_config";
