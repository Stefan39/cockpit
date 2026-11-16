-- Nimmt 0048 zurück: der Betreuer sieht wieder jedes Modul. Alle Freigaben gehen verloren — ein Werkzeug für die
-- Entwicklung, kein Weg im Betrieb (wie 0045). Die Protokollart nur, soweit kein Eintrag sie nutzt (0019).
DROP TABLE "cockpit"."modul_betreuer_zugriff";
DROP FUNCTION "cockpit"."modul_betreuer_zugriff_bleibt"();

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art = 'betreuer_zugriff_geaendert'
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
