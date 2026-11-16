-- Nimmt 0027 zurück: der Vermerk, welche Nachricht per E-Mail gemeldet ist, geht mit der Tabelle. Die Protokollart nur,
-- soweit kein Eintrag sie nutzt (0009, 0019).
DROP TABLE "cockpit"."chat_mail";

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art = 'chat_mail_gesendet'
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
