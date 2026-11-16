-- Epic E3 (COPI-35): Die Zugänge der Agenten-API.
--
-- Der Admin-Agent (später auch der Koordinator) meldet dem Cockpit per HTTP: Befunde, Inventar,
-- Anträge (Architektur-Vorschlag 4). Das geschieht ohne Sitzung und ohne zweiten Faktor, mit einem
-- Bearer-Token je Zugang. Diese Tabelle hält die Zugänge, nicht die Token: gespeichert wird nur der
-- SHA-256-Hash, wie beim Erststart- und beim Einladungs-Token. Das Token selbst gibt es genau einmal,
-- auf der Konsole (Server-Kommando `api-token-erzeugen`). Wer die Datenbank liest, kann damit keine
-- Anfrage stellen.
--
-- Ein Token hat 256 Bit Zufall und wird deshalb über seinen Hash direkt gefunden (Eindeutigkeit);
-- ein langsamer Passwort-Hash wäre hier ohne Gewinn.
--
-- Zugänge werden nur angelegt und widerrufen, nie geändert: für andere Rechte gibt es einen neuen
-- Zugang. Ein Widerruf bleibt für immer — ein durchgesickertes Token würde sonst mit einem einzigen
-- SQL-Befehl wieder gültig (Trigger unten, im Muster von 0008 und 0009).
--
-- `name` ist eine Kennung für Menschen und Maschinen (`admin-agent`), kein Anzeigename. Er steht im
-- Protokoll und muss dort als Kennung passen (höchstens 40 Zeichen aus Kleinbuchstaben, Ziffern, `_`
-- und `-`). Mehrere Zugänge dürfen denselben Namen tragen: beim Wechsel eines Tokens gilt kurz das
-- alte und das neue, bevor das alte widerrufen wird.
--
-- Die Rechte (`scopes`) sind eine feste Liste. Ein neues Recht kommt mit dem Ticket, das es braucht,
-- samt Migration, die diese Bedingung erweitert (wie die Arten des Protokolls).

CREATE TABLE "cockpit"."api_token" (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          text        NOT NULL,
    token_hash    text        NOT NULL,
    scopes        text[]      NOT NULL,
    erzeugt_am    timestamptz NOT NULL DEFAULT now(),
    widerrufen_am timestamptz,
    CONSTRAINT api_token_name_form       CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    CONSTRAINT api_token_hash_form       CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT api_token_hash_eindeutig  UNIQUE (token_hash),
    CONSTRAINT api_token_scopes_bekannt  CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten']::text[]
    )
);

CREATE FUNCTION "cockpit"."api_token_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."name" IS DISTINCT FROM OLD."name"
       OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
       OR NEW."scopes" IS DISTINCT FROM OLD."scopes"
       OR NEW."erzeugt_am" IS DISTINCT FROM OLD."erzeugt_am"
    THEN
        RAISE EXCEPTION 'api_token_unveraenderlich: Name, Hash, Rechte und Erzeugungszeitpunkt stehen fest; fuer andere Rechte gibt es einen neuen Zugang';
    END IF;

    IF OLD."widerrufen_am" IS NOT NULL AND NEW."widerrufen_am" IS DISTINCT FROM OLD."widerrufen_am" THEN
        RAISE EXCEPTION 'api_token_widerruf_bleibt: Ein widerrufener Zugang wird nie wieder gueltig';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "api_token_unveraenderlich"
    BEFORE UPDATE ON "cockpit"."api_token"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."api_token_pruefen"();

-- Das Protokoll kennt drei neue Ereignisse: ein Zugang wurde erzeugt oder widerrufen, und ein
-- Zugriff wurde abgelehnt, der auf ein durchgesickertes Token oder einen Fehler im Agenten hindeutet
-- (widerrufener Zugang, fehlendes Recht). Ein unbekanntes oder fehlendes Token wird bewusst **nicht**
-- protokolliert: das Protokoll lässt sich nicht bereinigen (0009), und der offene Endpunkt würde es
-- mit Rauschen füllen.
ALTER TABLE "cockpit"."protokoll" DROP CONSTRAINT "protokoll_art_bekannt";

ALTER TABLE "cockpit"."protokoll"
    ADD CONSTRAINT "protokoll_art_bekannt" CHECK (art IN (
        'konto_angelegt',
        'einladung_erzeugt',
        'einladung_eingeloest',
        'anmeldung_erfolgreich',
        'anmeldung_fehlgeschlagen',
        'sperre_ausgeloest',
        'zweiter_faktor_eingerichtet',
        'ersatzcode_verwendet',
        'abmeldung',
        'konto_verfallen',
        'betreuer_uebergeben',
        'erststart_token_erzeugt',
        'konto_entsperrt',
        'zugang_wiederhergestellt',
        'api_token_erzeugt',
        'api_token_widerrufen',
        'api_zugriff_abgelehnt'
    ));
