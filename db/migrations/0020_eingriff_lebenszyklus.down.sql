-- Nimmt 0020 zurück: keine Ziel-Version, kein Beleg für `erledigt`, keine Protokollarten der vier Übergänge.
--
-- Eingriffe bleiben stehen, auch freigegebene, laufende und abgeschlossene; nur ihre Ziel-Version geht mit der Spalte
-- verloren. Die Kette aus 0018 nimmt diese Zeilen an. Eine Protokollart, die ein Eintrag nutzt, bleibt stehen (das
-- Protokoll lässt sich nicht bereinigen, 0009 und 0019).

DROP TRIGGER "eingriff_lebenszyklus" ON "cockpit"."eingriff";
DROP FUNCTION "cockpit"."eingriff_lebenszyklus_pruefen"();

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_ziel_version_passt";
ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_ziel_version_form";
ALTER TABLE "cockpit"."eingriff" DROP COLUMN "ziel_version";

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art IN ('update_freigegeben', 'update_gestartet', 'update_erledigt', 'update_fehlgeschlagen')
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
