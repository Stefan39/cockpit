-- COPI-112: Der Posteingang im Kopf der Seiten — was ein Konto noch nicht gelesen hat, aus Chat, Modulen mit
-- `posteingang:` (etwa die Mails des Moduls Kommunikation) und Meldungen. Der Lesestand des Chats steht schon in
-- `nachricht_lesestand` (0024); hier kommt der Lesestand der übrigen Quellen dazu. Das Cockpit schreibt nie in
-- Fachtabellen: was ein Konto in einem Modul gelesen hat, steht hier, nicht in der View des Moduls.
--
-- 1. Je Konto und Quelle ein Zeitpunkt „gelesen bis": was davor liegt, gilt als gelesen. Angelegt beim ersten Lesen des
--    Posteingangs (was dann schon da ist, zählt nicht als neu), vorgerückt durch „Alle als gelesen" und — bei den
--    Meldungen — durch einen Besuch der Seite. Quelle ist `meldungen` oder `modul:<kennung>` (Form der Kennung wie 0028).
--    Er geht nur vorwärts (wie `nachricht_lesestand`).
CREATE TABLE "cockpit"."posteingang_stand" (
    benutzer_id     text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    quelle          text        NOT NULL,
    gelesen_bis     timestamptz NOT NULL,
    aktualisiert_am timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (benutzer_id, quelle),
    CONSTRAINT posteingang_stand_quelle_form CHECK (quelle = 'meldungen' OR quelle ~ '^modul:[a-z0-9][a-z0-9-]{0,62}$')
);

-- 2. Je Konto und Zeile eines Moduls: geöffnet am. Eine Zeile ist ein Vorgang (0030: Modul-Kennung und `id`), ohne
--    Fremdschlüssel auf `modul` aus demselben Grund wie dort.
CREATE TABLE "cockpit"."modul_gelesen" (
    benutzer_id   text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    modul_kennung text        NOT NULL,
    vorgang_id    text        NOT NULL,
    gelesen_am    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (benutzer_id, modul_kennung, vorgang_id),
    CONSTRAINT modul_gelesen_modul_form CHECK (modul_kennung ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    CONSTRAINT modul_gelesen_vorgang_laenge CHECK (char_length(vorgang_id) BETWEEN 1 AND 200)
);

-- Nie löschen (0025), wie `nachricht_lesestand`.
CREATE TRIGGER "posteingang_stand_nie_loeschen" BEFORE DELETE ON "cockpit"."posteingang_stand"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "modul_gelesen_nie_loeschen" BEFORE DELETE ON "cockpit"."modul_gelesen"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
