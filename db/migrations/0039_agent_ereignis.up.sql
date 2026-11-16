-- COPI-114: Was ein Agent getan hat, meldet er selbst (Lauf gescheitert, Update eingespielt, Wochenbericht erstellt) —
-- für das Protokoll seiner Detailseite. Das Cockpit holt nichts selbst (ADR: kein Docker-Socket, kein SSH, keine
-- Container-Logs); es speichert nur, was ihm gemeldet wird.
--
-- Wie ein Befund (0015): `kundensichtbar` ist per Default `false`, und sichtbar werden kann ein Ereignis nur mit einem
-- Klartext für den Kunden. Die Kennung des Agenten in der Form des Inventars, ohne Fremdschlüssel (wie 0037). Eine
-- Zeile ist ein Nachweis: unveränderlich, nie gelöscht (0025).
CREATE TABLE "cockpit"."agent_ereignis" (
    id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent          text        NOT NULL,
    stufe          text        NOT NULL,
    -- Optional eine Überschrift („Fehler im Lauf Datensicherung"); nur für `technik_sehen`, die Kundensicht nennt die Stufe.
    titel          text,
    text           text        NOT NULL,
    text_kunde     text,
    kundensichtbar boolean     NOT NULL DEFAULT false,
    zeitpunkt      timestamptz NOT NULL,
    quelle         text        NOT NULL,
    gemeldet_am    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_ereignis_agent_form CHECK (agent ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
    CONSTRAINT agent_ereignis_stufe_bekannt CHECK (stufe IN ('info', 'warnung', 'fehler')),
    CONSTRAINT agent_ereignis_titel_laenge CHECK (titel IS NULL OR char_length(titel) BETWEEN 1 AND 80),
    CONSTRAINT agent_ereignis_text_laenge CHECK (char_length(text) BETWEEN 1 AND 500),
    CONSTRAINT agent_ereignis_text_kunde_laenge CHECK (text_kunde IS NULL OR char_length(text_kunde) BETWEEN 1 AND 500),
    CONSTRAINT agent_ereignis_sichtbar_braucht_klartext CHECK (NOT kundensichtbar OR text_kunde IS NOT NULL)
);

CREATE INDEX "agent_ereignis_agent_zeit" ON "cockpit"."agent_ereignis" (agent, zeitpunkt DESC);
-- Für die Begrenzung je Agent und Stunde.
CREATE INDEX "agent_ereignis_agent_gemeldet" ON "cockpit"."agent_ereignis" (agent, gemeldet_am);

CREATE FUNCTION "cockpit"."agent_ereignis_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'agent_ereignis_unveraenderlich: Ein gemeldetes Ereignis bleibt, wie es ist';
END;
$$;

CREATE TRIGGER "agent_ereignis_unveraenderlich"
    BEFORE UPDATE ON "cockpit"."agent_ereignis"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."agent_ereignis_pruefen"();

CREATE TRIGGER "agent_ereignis_nie_loeschen" BEFORE DELETE ON "cockpit"."agent_ereignis"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
