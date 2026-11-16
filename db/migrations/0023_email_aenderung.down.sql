-- Nimmt 0023 zurück: offene und erledigte Anträge zur Adressänderung gehen mit der Tabelle; die Adressen der Konten
-- bleiben, wie sie sind. Protokollarten nur, soweit kein Eintrag sie nutzt (0009, 0019).
DROP TABLE "cockpit"."email_aenderung";

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art IN ('email_aenderung_beantragt', 'email_geaendert')
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
