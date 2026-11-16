-- Nimmt 0030 zurück. Alle Übernahmen gehen verloren — ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie 0028).
-- Das Recht zuerst: das scheitert, solange ein Zugang `vorgang_lesen` trägt — gewollt, der Zugang wird erst widerrufen
-- und ersetzt, nicht still entwertet (wie 0026). Die Protokollarten nur, soweit kein Eintrag sie nutzt (0019).
ALTER TABLE "cockpit"."api_token"
    DROP CONSTRAINT "api_token_scopes_bekannt",
    ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen']::text[]
    );

DROP TABLE "cockpit"."vorgang_sperre";
DROP FUNCTION "cockpit"."vorgang_sperre_pruefen"();

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art IN ('vorgang_uebernommen', 'vorgang_zurueckgegeben')
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
