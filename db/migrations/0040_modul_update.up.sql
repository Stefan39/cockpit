-- COPI-106: Das Modul-Update als Antrag — die Art `modul` in `cockpit.eingriff` (in 0015 als „kommt mit E5" vermerkt).
--
-- Wie beim Cockpit-Image (COPI-40/41, ADR 13.1) beantragt das Cockpit nur. Der Betreuer nennt in den Einstellungen einen
-- Commit in agent-blueprints; freigegeben wird außerhalb des Cockpits, ausgeführt vom Admin-Agenten: er spielt erst die
-- View des Ziel-Commits ein, dann den Block (`modul-einspielen`). Fachmigrationen bleiben Handarbeit des Einrichters
-- (Entscheidung Stefan/Alex, 01./02.10.2026, COPI-107): verlangt der Block eine, die fehlt, bricht der Agent ab.
--
--   1. **Spalten der Art `modul`:** `modul_kennung`, `ziel_commit` (7–40 Hex, wie eingegeben) und `herkunft_vorher` —
--      die Herkunft der beim Antrag aktiven Version (`agent-blueprints@<commit>:<pfad>`), der Weg zurück und zugleich
--      der Pfad des Blocks. Ein Modul-Antrag hat keine Digests, ein Image-Antrag keine dieser Spalten
--      (`eingriff_art_passt`). Alle drei stehen nach dem Antrag fest (Trigger `eingriff_modul`).
--   2. **Grund eines Fehlschlags** (`fehler_grund`, beide Arten): der Agent nennt ihn mit `fehlgeschlagen`, etwa
--      „Fachmigration 0005 fehlt". Gesetzt genau mit diesem Übergang, danach fest. Klartext, höchstens 300 Zeichen.
--   3. **Ein offener Antrag je Art und Modul** statt je Art: ein Update von `kommunikation` sperrt keins von
--      `ki-verbrauch`. Der Index behält seinen Namen, die Anwendung erkennt ihn daran.
--   4. **Erledigt nur mit Beleg**, wie beim Image: `laeuft → erledigt` gilt nur, wenn die aktive Version des Moduls aus
--      dem Ziel-Commit stammt. Aktiv wird eine Version nur nach bestandener Katalogprüfung (`modulEinspielen`), und das
--      Cockpit setzt `erledigt` selbst, in derselben Transaktion. Der Commit gilt als gleich, wenn einer ein Präfix des
--      anderen ist (der Antrag nennt oft sieben Zeichen, die Herkunft den ganzen Hash).
--   5. Der Beleg des Images (`eingriff_lebenszyklus`, 0020) gilt nur noch für seine Art; eine Ziel-Version gibt es beim
--      Modul nie.

ALTER TABLE "cockpit"."eingriff"
    ADD COLUMN "modul_kennung" text,
    ADD COLUMN "ziel_commit" text,
    ADD COLUMN "herkunft_vorher" text,
    ADD COLUMN "fehler_grund" text,
    ALTER COLUMN "ziel_digest" DROP NOT NULL,
    ALTER COLUMN "digest_vorher" DROP NOT NULL;

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_art_bekannt";
ALTER TABLE "cockpit"."eingriff" ADD CONSTRAINT "eingriff_art_bekannt" CHECK (art IN ('cockpit-image', 'modul'));

ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_art_passt" CHECK (
        (art = 'cockpit-image'
            AND ziel_digest IS NOT NULL AND digest_vorher IS NOT NULL
            AND modul_kennung IS NULL AND ziel_commit IS NULL AND herkunft_vorher IS NULL)
        OR (art = 'modul'
            AND ziel_digest IS NULL AND digest_vorher IS NULL
            AND modul_kennung ~ '^[a-z0-9][a-z0-9-]{0,62}$'
            AND ziel_commit ~ '^[0-9a-f]{7,40}$'
            AND char_length(herkunft_vorher) BETWEEN 1 AND 500)
    ),
    ADD CONSTRAINT "eingriff_fehler_grund_passt" CHECK (
        fehler_grund IS NULL OR (status = 'fehlgeschlagen' AND char_length(btrim(fehler_grund)) BETWEEN 1 AND 300)
    );

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_ziel_version_passt";
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_ziel_version_passt" CHECK (
        CASE art
            WHEN 'modul' THEN ziel_version IS NULL
            ELSE (ziel_version IS NOT NULL) = (status IN ('freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen'))
        END
    );

DROP INDEX "cockpit"."eingriff_ein_offener_antrag";
CREATE UNIQUE INDEX "eingriff_ein_offener_antrag"
    ON "cockpit"."eingriff" (art, coalesce(modul_kennung, ''))
    WHERE status IN ('beantragt', 'freigegeben', 'laeuft');

-- Der Commit aus einer Herkunft `agent-blueprints@<commit>:<pfad>`; ohne diese Form NULL.
CREATE FUNCTION "cockpit"."herkunft_commit"(herkunft text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT (regexp_match(herkunft, '^agent-blueprints@([0-9a-f]{7,40}):.+$'))[1]
$$;

-- Derselbe Commit, wenn einer ein Präfix des anderen ist (beide mindestens sieben Zeichen, Form oben).
CREATE FUNCTION "cockpit"."commit_passt"(a text, b text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT a IS NOT NULL AND b IS NOT NULL AND (starts_with(a, b) OR starts_with(b, a))
$$;

CREATE FUNCTION "cockpit"."eingriff_modul_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (NEW."modul_kennung", NEW."ziel_commit", NEW."herkunft_vorher")
       IS DISTINCT FROM (OLD."modul_kennung", OLD."ziel_commit", OLD."herkunft_vorher")
    THEN
        RAISE EXCEPTION 'eingriff_unveraenderlich: Modul, Ziel-Commit und Herkunft stehen nach dem Antrag fest';
    END IF;

    IF NEW."fehler_grund" IS DISTINCT FROM OLD."fehler_grund"
       AND NOT (OLD."status" = 'laeuft' AND NEW."status" = 'fehlgeschlagen')
    THEN
        RAISE EXCEPTION 'eingriff_fehler_grund: Der Grund wird mit dem Fehlschlag genannt und steht danach fest';
    END IF;

    IF NEW."art" = 'modul' AND OLD."status" = 'laeuft' AND NEW."status" = 'erledigt' AND NOT EXISTS (
        SELECT 1
          FROM "cockpit"."modul" m
         WHERE m."kennung" = NEW."modul_kennung"
           AND m."aktiv"
           AND "cockpit"."commit_passt"("cockpit"."herkunft_commit"(m."herkunft"), NEW."ziel_commit")
    ) THEN
        RAISE EXCEPTION 'eingriff_ohne_beleg: Erledigt ist ein Modul-Update erst, wenn die aktive Version aus dem Ziel-Commit stammt';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "eingriff_modul"
    BEFORE UPDATE ON "cockpit"."eingriff"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."eingriff_modul_pruefen"();

DROP TRIGGER "eingriff_lebenszyklus" ON "cockpit"."eingriff";
CREATE TRIGGER "eingriff_lebenszyklus"
    BEFORE UPDATE ON "cockpit"."eingriff"
    FOR EACH ROW
    WHEN (NEW."art" = 'cockpit-image')
    EXECUTE FUNCTION "cockpit"."eingriff_lebenszyklus_pruefen"();
