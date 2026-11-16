-- Nimmt 0050 zurück: jeder Antrag braucht wieder die Freigabe außerhalb des Cockpits. Die Einstellung und der Modus der
-- Anträge gehen verloren — ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie 0048). Gibt es einen direkt
-- freigegebenen und zurückgezogenen Antrag, scheitert der Rückweg laut an `eingriff_zeitstempel_passen`, statt ihn zu
-- verfälschen. Die beiden Bedingungen sind die aus 0018 und 0040, gleichwertig umgeschrieben. Die Protokollart nur,
-- soweit kein Eintrag sie nutzt (0019).
DROP TRIGGER "eingriff_kette" ON "cockpit"."eingriff";
CREATE TRIGGER "eingriff_kette"
    BEFORE INSERT OR UPDATE ON "cockpit"."eingriff"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."eingriff_pruefen"();
DROP FUNCTION "cockpit"."eingriff_kette_pruefen"();

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_ziel_version_passt";
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_ziel_version_passt" CHECK (
        (art = 'modul' AND ziel_version IS NULL)
        OR (art <> 'modul' AND (ziel_version IS NULL) = (status IN ('beantragt', 'zurueckgezogen')))
    );

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_zeitstempel_passen";
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_zeitstempel_passen" CHECK (
        (freigegeben_am IS NULL) = (status IN ('beantragt', 'zurueckgezogen'))
        AND (laeuft_seit IS NULL) = (status IN ('beantragt', 'freigegeben', 'zurueckgezogen'))
        AND (abgeschlossen_am IS NULL) = (status IN ('beantragt', 'freigegeben', 'laeuft'))
    );

ALTER TABLE "cockpit"."eingriff" DROP COLUMN "freigabe_modus";

DROP TABLE "cockpit"."update_freigabemodus";
DROP FUNCTION "cockpit"."update_freigabemodus_bleibt"();

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art = 'update_freigabemodus_geaendert'
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
