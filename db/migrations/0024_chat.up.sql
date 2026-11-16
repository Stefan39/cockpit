-- Epic E4 (COPI-52): Das Schema des Chats — Kanäle, Nachrichten, Lesestand, Push-Abos und Tagesverbrauch.
--
-- Zwei Arten von Kanälen (ADR 6, Entscheidungen Stefan vom 23.09.2026):
--   * `assistent`: je Benutzer ein eigener Dauerkanal mit dem Koordinator, wie eine Direktnachricht.
--   * `team`: genau ein gemeinsamer Kanal der Instanz, in dem die Benutzer miteinander schreiben.
-- Threads je Vorgang (E5) kommen als dritte Art mit eigener Migration, samt Vorgangsbezug am Kanal; E4 kommt vor E5.
--
-- **Nie löschen, nur als gelöscht markieren** (Entscheidung Stefan, 23.09.2026; mögliche Dokumentationspflichten): Eine
-- Nachricht bleibt mit ihrem Inhalt im Bestand, auch wenn sie als gelöscht markiert oder ihr Konto entfernt wird. Die
-- Fremdschlüssel auf `user` haben deshalb weder CASCADE noch SET NULL, und `nie_loeschen()` weist jedes DELETE ab. Den
-- Bestand (Konten u. a.) zieht COPI-62 nach und benutzt dieselbe Funktion. TRUNCATE bleibt möglich: die Anwendung
-- benutzt es nie, und wer es kann, kann die Tabelle auch löschen — die Sperre schützt vor Fehlern im Anwendungscode.

-- 0. Die gemeinsame Sperre gegen DELETE.
CREATE FUNCTION "cockpit"."nie_loeschen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'nie_loeschen: In % wird nie geloescht, nur als geloescht markiert', TG_TABLE_NAME;
END;
$$;

-- 1. Kanal.
CREATE TABLE "cockpit"."kanal" (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    art         text        NOT NULL,
    -- Nur beim Assistenten-Kanal: der Benutzer, dem er gehört.
    besitzer_id text        REFERENCES "cockpit"."user" ("id"),
    angelegt_am timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kanal_art_bekannt CHECK (art IN ('assistent', 'team')),
    CONSTRAINT kanal_besitzer_nur_beim_assistenten CHECK ((art = 'assistent') = (besitzer_id IS NOT NULL))
);

-- Je Benutzer genau ein Assistenten-Kanal, und genau ein Team-Kanal je Instanz.
CREATE UNIQUE INDEX "kanal_assistent_je_benutzer_idx" ON "cockpit"."kanal" (besitzer_id) WHERE art = 'assistent';
CREATE UNIQUE INDEX "kanal_ein_team_idx" ON "cockpit"."kanal" (art) WHERE art = 'team';

INSERT INTO "cockpit"."kanal" (art) VALUES ('team');

-- 2. Nachricht. Der Inhalt ist Klartext, nie HTML: die Oberfläche escaped ihn und verlinkt nie automatisch (ADR 10,
--    Regel wie JAC-577). Den Zeitpunkt setzt die Datenbank.
CREATE TABLE "cockpit"."nachricht" (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kanal_id     bigint      NOT NULL REFERENCES "cockpit"."kanal" ("id"),
    -- `mensch`: ein Benutzer; `agent`: der Koordinator; `system`: das Cockpit (z. B. „Assistent nicht erreichbar").
    absender_art text        NOT NULL,
    -- Nur bei `mensch`: wer geschrieben hat.
    absender_id  text        REFERENCES "cockpit"."user" ("id"),
    inhalt       text        NOT NULL,
    -- Nur Nachrichten von Agent oder Cockpit können dringend sein; sie lösen Push und den E-Mail-Zweitkanal aus (ADR 6).
    dringend     boolean     NOT NULL DEFAULT false,
    -- Die Frage, auf die eine Antwort oder Meldung sich bezieht.
    antwort_auf  bigint      REFERENCES "cockpit"."nachricht" ("id"),
    erstellt_am  timestamptz NOT NULL DEFAULT now(),
    -- Als gelöscht markiert: die Oberfläche zeigt „Nachricht gelöscht", der Inhalt bleibt im Bestand.
    geloescht_am  timestamptz,
    geloescht_von text        REFERENCES "cockpit"."user" ("id"),
    CONSTRAINT nachricht_absender_bekannt CHECK (absender_art IN ('mensch', 'agent', 'system')),
    CONSTRAINT nachricht_absender_nur_beim_menschen CHECK ((absender_art = 'mensch') = (absender_id IS NOT NULL)),
    -- `\S` statt `btrim(...) <> ''`: btrim entfernt nur Leerzeichen, keine Zeilenumbrüche.
    CONSTRAINT nachricht_inhalt_nicht_leer CHECK (inhalt ~ '\S'),
    CONSTRAINT nachricht_inhalt_laenge CHECK (char_length(inhalt) <= 4000),
    CONSTRAINT nachricht_dringend_nicht_vom_menschen CHECK (NOT dringend OR absender_art <> 'mensch'),
    CONSTRAINT nachricht_frage_hat_keinen_bezug CHECK (absender_art <> 'mensch' OR antwort_auf IS NULL),
    CONSTRAINT nachricht_geloescht_vollstaendig CHECK ((geloescht_am IS NULL) = (geloescht_von IS NULL))
);

-- Der Verlauf eines Kanals, seitenweise nach ID — die häufigste Frage.
CREATE INDEX "nachricht_kanal_idx" ON "cockpit"."nachricht" (kanal_id, id);

-- Je Frage höchstens eine Antwort des Koordinators: eine wiederholte Zustellung desselben Agentenlaufs darf keine
-- Doppelantwort erzeugen (COPI-55). Meldungen des Cockpits zur selben Frage bleiben möglich.
CREATE UNIQUE INDEX "nachricht_eine_antwort_je_frage_idx"
    ON "cockpit"."nachricht" (antwort_auf)
    WHERE absender_art = 'agent';

-- Eine Nachricht ist ein Nachweis: nach dem Schreiben ändert sich nur noch, dass sie als gelöscht markiert wird — genau
-- einmal und nicht zurück. Inhalt, Absender, Kanal und Zeitpunkt stehen fest.
CREATE FUNCTION "cockpit"."nachricht_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."kanal_id" IS DISTINCT FROM OLD."kanal_id"
       OR NEW."absender_art" IS DISTINCT FROM OLD."absender_art"
       OR NEW."absender_id" IS DISTINCT FROM OLD."absender_id"
       OR NEW."inhalt" IS DISTINCT FROM OLD."inhalt"
       OR NEW."dringend" IS DISTINCT FROM OLD."dringend"
       OR NEW."antwort_auf" IS DISTINCT FROM OLD."antwort_auf"
       OR NEW."erstellt_am" IS DISTINCT FROM OLD."erstellt_am"
    THEN
        RAISE EXCEPTION 'nachricht_unveraenderlich: Eine Nachricht wird nach dem Schreiben nicht mehr geaendert';
    END IF;
    IF OLD."geloescht_am" IS NOT NULL
       AND (NEW."geloescht_am" IS DISTINCT FROM OLD."geloescht_am" OR NEW."geloescht_von" IS DISTINCT FROM OLD."geloescht_von")
    THEN
        RAISE EXCEPTION 'nachricht_geloescht_endgueltig: Eine als geloescht markierte Nachricht bleibt es';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "nachricht_kette"
    BEFORE UPDATE ON "cockpit"."nachricht"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."nachricht_pruefen"();

-- 3. Lesestand: bis zu welcher Nachricht ein Benutzer einen Kanal gesehen hat.
CREATE TABLE "cockpit"."nachricht_lesestand" (
    benutzer_id     text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    kanal_id        bigint      NOT NULL REFERENCES "cockpit"."kanal" ("id"),
    bis_id          bigint      NOT NULL,
    aktualisiert_am timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (benutzer_id, kanal_id),
    CONSTRAINT nachricht_lesestand_positiv CHECK (bis_id > 0)
);

-- 4. Push-Abo: ein Gerät eines Benutzers (Web Push, VAPID; COPI-59). Abgemeldet wird durch Markieren; ein Endpoint
--    gehört höchstens einem aktiven Abo.
CREATE TABLE "cockpit"."push_abo" (
    id                     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    benutzer_id            text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    endpoint               text        NOT NULL,
    schluessel_p256dh      text        NOT NULL,
    schluessel_auth        text        NOT NULL,
    angelegt_am            timestamptz NOT NULL DEFAULT now(),
    zuletzt_erfolgreich_am timestamptz,
    abgemeldet_am          timestamptz,
    CONSTRAINT push_abo_endpoint_https CHECK (endpoint ~ '^https://' AND char_length(endpoint) <= 2048),
    CONSTRAINT push_abo_schluessel_form CHECK (
        schluessel_p256dh ~ '^[A-Za-z0-9_-]{1,200}$' AND schluessel_auth ~ '^[A-Za-z0-9_-]{1,100}$'
    )
);

CREATE UNIQUE INDEX "push_abo_endpoint_aktiv_idx" ON "cockpit"."push_abo" (endpoint) WHERE abgemeldet_am IS NULL;
CREATE INDEX "push_abo_benutzer_idx" ON "cockpit"."push_abo" (benutzer_id);

-- 5. Tagesverbrauch: gesendete Nachrichten an den Assistenten je Benutzer und Kalendertag (Europe/Berlin; COPI-57). Der
--    Chat ist ein direkter Draht zum Sprachmodell, ein Limit je Benutzer und Tag ist Pflicht (ADR 1).
CREATE TABLE "cockpit"."chat_verbrauch" (
    benutzer_id text    NOT NULL REFERENCES "cockpit"."user" ("id"),
    tag         date    NOT NULL,
    anzahl      integer NOT NULL DEFAULT 0,
    PRIMARY KEY (benutzer_id, tag),
    CONSTRAINT chat_verbrauch_anzahl_positiv CHECK (anzahl >= 0)
);

-- Nie löschen, an jeder Tabelle des Chats.
CREATE TRIGGER "kanal_nie_loeschen" BEFORE DELETE ON "cockpit"."kanal"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "nachricht_nie_loeschen" BEFORE DELETE ON "cockpit"."nachricht"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "nachricht_lesestand_nie_loeschen" BEFORE DELETE ON "cockpit"."nachricht_lesestand"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "push_abo_nie_loeschen" BEFORE DELETE ON "cockpit"."push_abo"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "chat_verbrauch_nie_loeschen" BEFORE DELETE ON "cockpit"."chat_verbrauch"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
