-- Nimmt 0026 zurück. Scheitert, solange ein Zugang eines der neuen Rechte trägt — gewollt: der Zugang wird erst
-- widerrufen und ersetzt, nicht still entwertet.
ALTER TABLE "cockpit"."api_token" DROP CONSTRAINT "api_token_scopes_bekannt";

ALTER TABLE "cockpit"."api_token" ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten']::text[]
);
