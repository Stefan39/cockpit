-- COPI-101: Ein eigenes App-Symbol der Instanz (Favicon und Symbol auf dem Home-Bildschirm), hochgeladen in den
-- Einstellungen. Gespeichert wird nur, was das Cockpit selbst neu kodiert hat: ein PNG mit 512 × 512 Pixeln, nie die
-- hochgeladene Datei. Die kleineren Größen rechnet das Cockpit daraus beim Laden.
--
-- Jede Version bleibt stehen (nie löschen, 0025). Das aktuelle Symbol ist die jüngste nicht als gelöscht markierte
-- Zeile; „Auf Standard zurücksetzen" markiert alle. Wer wann hochgeladen oder zurückgesetzt hat, steht in der Zeile
-- und im Protokoll. Die Konten per Fremdschlüssel ohne CASCADE/SET NULL (Muster 0024).
CREATE TABLE "cockpit"."app_symbol" (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    png           bytea       NOT NULL,
    hash          text        NOT NULL,
    angelegt_von  text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    angelegt_am   timestamptz NOT NULL DEFAULT now(),
    geloescht_von text        REFERENCES "cockpit"."user" ("id"),
    geloescht_am  timestamptz,
    -- Ein neu kodiertes 512er-PNG ist deutlich kleiner; die Grenze fängt nur Unsinn ab.
    CONSTRAINT app_symbol_groesse CHECK (octet_length(png) BETWEEN 1 AND 2000000),
    CONSTRAINT app_symbol_hash_form CHECK (hash ~ '^[0-9a-f]{12}$'),
    CONSTRAINT app_symbol_geloescht_vollstaendig CHECK ((geloescht_am IS NULL) = (geloescht_von IS NULL))
);

CREATE INDEX "app_symbol_aktuell" ON "cockpit"."app_symbol" (id DESC) WHERE geloescht_am IS NULL;

-- Nach der Anlage ändert sich nur noch die einmalige Löschmarke.
CREATE FUNCTION "cockpit"."app_symbol_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (NEW."id", NEW."png", NEW."hash", NEW."angelegt_von", NEW."angelegt_am")
       IS DISTINCT FROM (OLD."id", OLD."png", OLD."hash", OLD."angelegt_von", OLD."angelegt_am")
    THEN
        RAISE EXCEPTION 'app_symbol_unveraenderlich: Ein gespeichertes Symbol bleibt, wie es ist';
    END IF;
    IF OLD."geloescht_am" IS NOT NULL THEN
        RAISE EXCEPTION 'app_symbol_geloescht_endgueltig: Ein als geloescht markiertes Symbol bleibt es';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "app_symbol_unveraenderlich"
    BEFORE UPDATE ON "cockpit"."app_symbol"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."app_symbol_pruefen"();

CREATE TRIGGER "app_symbol_nie_loeschen" BEFORE DELETE ON "cockpit"."app_symbol"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('erscheinungsbild_geaendert')
ON CONFLICT (art) DO NOTHING;
