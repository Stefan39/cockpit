-- Nimmt 0022 zurück: die Protokollarten des Bearbeitens, soweit kein Eintrag sie nutzt (das Protokoll lässt sich nicht
-- bereinigen, 0009 und 0019).
DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art IN ('name_geaendert', 'rolle_geaendert', 'konto_entfernt')
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
