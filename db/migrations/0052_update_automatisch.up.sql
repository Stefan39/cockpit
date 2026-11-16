-- COPI-142: Updates automatisch installieren (Stefan, 13.10.2026, `docs/adr/0003-update-automatisch.md`). Die dritte Stufe
-- nach `rueckfrage` und `direkt` (0050): im Modus `automatisch` stellt das Cockpit den Antrag selbst, sobald die
-- Versions-Wache ein Update meldet, und gibt ihn wie bei `direkt` sofort frei. Ausgeführt wird weiterhin nur vom
-- Admin-Agenten.
--
--   1. **Die Einstellung** bekommt den Wert `automatisch` (`update_freigabemodus`, nur anhängen wie bisher).
--   2. **Der Antrag** trägt `freigabe_modus = direkt` — für den Agenten ändert sich nichts — und dazu `automatisch`, damit
--      Oberfläche, Protokoll und Schleifenschutz ihn vom Klick unterscheiden. Automatisch heißt immer direkt freigegeben.
--      Wie Art, Ziel und Modus steht das Feld nach dem Antrag fest; das prüft ein eigener Trigger, die Kette aus 0050
--      bleibt unverändert.

ALTER TABLE "cockpit"."update_freigabemodus" DROP CONSTRAINT "update_freigabemodus_modus";
ALTER TABLE "cockpit"."update_freigabemodus"
    ADD CONSTRAINT "update_freigabemodus_modus" CHECK (modus IN ('rueckfrage', 'direkt', 'automatisch'));

ALTER TABLE "cockpit"."eingriff"
    ADD COLUMN "automatisch" boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT "eingriff_automatisch_direkt" CHECK (NOT automatisch OR freigabe_modus = 'direkt');

CREATE FUNCTION "cockpit"."eingriff_automatisch_fest"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."automatisch" IS DISTINCT FROM OLD."automatisch" THEN
        RAISE EXCEPTION 'eingriff_unveraenderlich: Ob ein Antrag automatisch gestellt wurde, steht nach dem Antrag fest';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "eingriff_kette_automatisch"
    BEFORE UPDATE ON "cockpit"."eingriff"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."eingriff_automatisch_fest"();

-- Der Schleifenschutz fragt je Art und Modul nach den jüngsten automatischen Anträgen.
CREATE INDEX "eingriff_automatisch_juengste" ON "cockpit"."eingriff" (art, modul_kennung, id DESC) WHERE automatisch;
