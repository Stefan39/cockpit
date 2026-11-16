-- Nimmt 0038 zurück. Alle Freigaben gehen verloren — ein Werkzeug für die Entwicklung, kein Weg im Betrieb (wie 0030).
-- Die Protokollarten nur, soweit kein Eintrag sie nutzt (0019).
DROP TABLE "cockpit"."freigabe";
DROP FUNCTION "cockpit"."freigabe_pruefen"();

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art IN ('antwort_freigegeben', 'freigabe_zurueckgezogen')
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
