-- Nimmt 0045 zurück. Alle Entscheidungen gehen verloren — ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie
-- 0038). Die Protokollarten nur, soweit kein Eintrag sie nutzt (0019).
DROP TABLE "cockpit"."entscheidung";
DROP FUNCTION "cockpit"."entscheidung_pruefen"();

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art IN ('entscheidung_getroffen', 'entscheidung_zurueckgenommen')
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
