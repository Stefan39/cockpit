-- Epic E4 (COPI-55): Zwei neue Rechte der Agenten-API für den Koordinator-Agenten.
--
--   * `chat_antworten` — auf eine Frage im Assistenten-Kanal antworten (`POST /intern/chat/antwort`).
--   * `zustand_lesen` — den Zustand der Instanz lesen, **nur** was kundensichtbar ist (`GET /intern/zustand`).
--
-- Der Koordinator bekommt einen eigenen Zugang mit genau diesen Rechten (ADR 6): er meldet keine Befunde und schaltet
-- keine Eingriffe weiter. Die Liste folgt der Regel aus 0016: ein neues Recht kommt mit dem Ticket, das es braucht.
ALTER TABLE "cockpit"."api_token" DROP CONSTRAINT "api_token_scopes_bekannt";

ALTER TABLE "cockpit"."api_token" ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen']::text[]
);
