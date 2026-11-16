-- Nimmt 0040 zurück. Scheitert laut, solange es Modul-Anträge gibt: sie lassen sich nicht in die Form vor 0040 bringen
-- und werden nie gelöscht (Nie löschen, nur markieren).

DROP TRIGGER "eingriff_lebenszyklus" ON "cockpit"."eingriff";
CREATE TRIGGER "eingriff_lebenszyklus"
    BEFORE UPDATE ON "cockpit"."eingriff"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."eingriff_lebenszyklus_pruefen"();

DROP TRIGGER "eingriff_modul" ON "cockpit"."eingriff";
DROP FUNCTION "cockpit"."eingriff_modul_pruefen"();
DROP FUNCTION "cockpit"."commit_passt"(text, text);
DROP FUNCTION "cockpit"."herkunft_commit"(text);

DROP INDEX "cockpit"."eingriff_ein_offener_antrag";
CREATE UNIQUE INDEX "eingriff_ein_offener_antrag"
    ON "cockpit"."eingriff" (art)
    WHERE status IN ('beantragt', 'freigegeben', 'laeuft');

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_ziel_version_passt";
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_ziel_version_passt" CHECK (
        (ziel_version IS NOT NULL) = (status IN ('freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen'))
    );

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_fehler_grund_passt";
ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_art_passt";
ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_art_bekannt";
ALTER TABLE "cockpit"."eingriff" ADD CONSTRAINT "eingriff_art_bekannt" CHECK (art IN ('cockpit-image'));

ALTER TABLE "cockpit"."eingriff"
    ALTER COLUMN "ziel_digest" SET NOT NULL,
    ALTER COLUMN "digest_vorher" SET NOT NULL,
    DROP COLUMN "fehler_grund",
    DROP COLUMN "herkunft_vorher",
    DROP COLUMN "ziel_commit",
    DROP COLUMN "modul_kennung";
