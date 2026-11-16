-- COPI-90: Der Eingriff „Antwort freigeben" — ein Mensch gibt den Antwortentwurf eines Agenten frei, der Agent sendet
-- erst danach. Die Freigabe ersetzt die Freigabe per Slack (Entscheidung Stefan, 29.09.2026).
--
-- Eine Zeile ist eine Freigabe genau einer **Fassung** eines Entwurfs, gebunden an den SHA-256 seines Texts (Hex), wie
-- die Detailseite ihn gezeigt hat. Der Agent fragt sie vor dem Senden ab (`GET /intern/vorgaenge/freigabe`) und nennt
-- Fassung und Hash des Texts, den er senden will: passt beides nicht, gilt nichts als freigegeben. Ein Vorgang ist eine
-- Zeile einer Modul-View (wie 0030: Modul-Kennung und `id`), ohne Fremdschlüssel auf `modul`.
--
-- Je Vorgang und Fassung höchstens eine aktive Freigabe (partieller Unique-Index); eine zurückgezogene bleibt als
-- Nachweis stehen (nie löschen, 0025), eine erneute Freigabe ist eine neue Zeile.
CREATE TABLE "cockpit"."freigabe" (
    id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    modul_kennung      text        NOT NULL,
    vorgang_id         text        NOT NULL,
    fassung            integer     NOT NULL,
    entwurf_hash       text        NOT NULL,
    freigegeben_von    text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    freigegeben_am     timestamptz NOT NULL DEFAULT now(),
    zurueckgezogen_von text        REFERENCES "cockpit"."user" ("id"),
    zurueckgezogen_am  timestamptz,
    CONSTRAINT freigabe_modul_form CHECK (modul_kennung ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    CONSTRAINT freigabe_vorgang_laenge CHECK (char_length(vorgang_id) BETWEEN 1 AND 200),
    CONSTRAINT freigabe_fassung_positiv CHECK (fassung > 0),
    CONSTRAINT freigabe_hash_form CHECK (entwurf_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT freigabe_rueckzug_vollstaendig CHECK ((zurueckgezogen_am IS NULL) = (zurueckgezogen_von IS NULL)),
    CONSTRAINT freigabe_rueckzug_danach CHECK (zurueckgezogen_am IS NULL OR zurueckgezogen_am >= freigegeben_am)
);

CREATE UNIQUE INDEX "freigabe_eine_aktive" ON "cockpit"."freigabe" (modul_kennung, vorgang_id, fassung)
    WHERE zurueckgezogen_am IS NULL;

-- Nach der Anlage ändert sich nur noch der einmalige Rückzug (Muster 0030).
CREATE FUNCTION "cockpit"."freigabe_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (NEW."id", NEW."modul_kennung", NEW."vorgang_id", NEW."fassung", NEW."entwurf_hash", NEW."freigegeben_von", NEW."freigegeben_am")
       IS DISTINCT FROM (OLD."id", OLD."modul_kennung", OLD."vorgang_id", OLD."fassung", OLD."entwurf_hash", OLD."freigegeben_von", OLD."freigegeben_am")
    THEN
        RAISE EXCEPTION 'freigabe_unveraenderlich: Wer wann welche Fassung freigegeben hat, steht fest';
    END IF;
    IF OLD."zurueckgezogen_am" IS NOT NULL THEN
        RAISE EXCEPTION 'freigabe_rueckzug_endgueltig: Eine zurueckgezogene Freigabe bleibt es; eine neue ist eine neue Zeile';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "freigabe_unveraenderlich"
    BEFORE UPDATE ON "cockpit"."freigabe"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."freigabe_pruefen"();

CREATE TRIGGER "freigabe_nie_loeschen" BEFORE DELETE ON "cockpit"."freigabe"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('antwort_freigegeben'), ('freigabe_zurueckgezogen')
ON CONFLICT (art) DO NOTHING;
