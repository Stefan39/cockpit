-- Nimmt 0044 zurück. Alle Download-Nachweise gehen verloren — ein Werkzeug für die Entwicklung, kein Weg im Betrieb
-- (wie 0038). Die Protokollart nur, soweit kein Eintrag sie nutzt (0019).
DROP TABLE "cockpit"."anhang_download";
DROP FUNCTION "cockpit"."anhang_download_unveraenderlich"();

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art = 'anhang_heruntergeladen'
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
