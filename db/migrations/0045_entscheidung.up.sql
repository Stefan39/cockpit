-- COPI-91: Der Eingriff „Entscheiden" — ein Mensch entscheidet über einen Vorgang (etwa einen Vorschlag eines Assistenten:
-- „Interessant", „Passt nicht", „Beworben"), der Agent des Moduls fragt die Entscheidung ab und handelt danach. Das
-- Cockpit schreibt dafür nie in die Fachtabelle (ADR), die Entscheidung steht hier.
--
-- Ein Vorgang ist eine Zeile einer Modul-View (Modul-Kennung und `id`, wie 0030 und 0038), ohne Fremdschlüssel auf
-- `modul`. Die jüngste nicht zurückgenommene Entscheidung gilt; eine zurückgenommene bleibt als Nachweis stehen (nie
-- löschen, 0025). Nach der Anlage ändert sich nur der einmalige Rückzug.
CREATE TABLE "cockpit"."entscheidung" (
    id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    modul_kennung       text        NOT NULL,
    vorgang_id          text        NOT NULL,
    wert                text        NOT NULL,
    entschieden_von     text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    entschieden_am      timestamptz NOT NULL DEFAULT now(),
    zurueckgenommen_von text        REFERENCES "cockpit"."user" ("id"),
    zurueckgenommen_am  timestamptz,
    CONSTRAINT entscheidung_modul_form CHECK (modul_kennung ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    CONSTRAINT entscheidung_vorgang_laenge CHECK (char_length(vorgang_id) BETWEEN 1 AND 200),
    CONSTRAINT entscheidung_wert_form CHECK (wert ~ '^[a-z][a-z_]{0,29}$' AND wert <> 'offen'),
    CONSTRAINT entscheidung_rueckzug_vollstaendig CHECK ((zurueckgenommen_am IS NULL) = (zurueckgenommen_von IS NULL)),
    CONSTRAINT entscheidung_rueckzug_danach CHECK (zurueckgenommen_am IS NULL OR zurueckgenommen_am >= entschieden_am)
);

CREATE INDEX "entscheidung_vorgang" ON "cockpit"."entscheidung" (modul_kennung, vorgang_id, id DESC);

CREATE FUNCTION "cockpit"."entscheidung_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (NEW."id", NEW."modul_kennung", NEW."vorgang_id", NEW."wert", NEW."entschieden_von", NEW."entschieden_am")
       IS DISTINCT FROM (OLD."id", OLD."modul_kennung", OLD."vorgang_id", OLD."wert", OLD."entschieden_von", OLD."entschieden_am")
       OR OLD."zurueckgenommen_am" IS NOT NULL
    THEN
        RAISE EXCEPTION 'entscheidung_unveraenderlich: Eine Entscheidung steht fest; zurueckgenommen wird sie genau einmal';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "entscheidung_unveraenderlich" BEFORE UPDATE ON "cockpit"."entscheidung"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."entscheidung_pruefen"();

CREATE TRIGGER "entscheidung_nie_loeschen" BEFORE DELETE ON "cockpit"."entscheidung"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('entscheidung_getroffen'), ('entscheidung_zurueckgenommen')
ON CONFLICT (art) DO NOTHING;
