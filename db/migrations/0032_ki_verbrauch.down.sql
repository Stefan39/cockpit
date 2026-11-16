-- Nimmt 0032 zurück. Das Verbrauchsprotokoll und die Preistabelle gehen verloren — ein Werkzeug für die Entwicklung,
-- kein Weg im Betrieb (wie 0028). Das Recht zuerst: das scheitert, solange ein Zugang `verbrauch_schreiben` trägt —
-- gewollt, der Zugang wird erst widerrufen und ersetzt, nicht still entwertet (wie 0026).
ALTER TABLE "cockpit"."api_token"
    DROP CONSTRAINT "api_token_scopes_bekannt",
    ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen']::text[]
    );

DROP TABLE "cockpit"."verbrauch";
DROP FUNCTION "cockpit"."verbrauch_kosten_setzen"();
DROP TABLE "cockpit"."preis";
