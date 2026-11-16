-- Nimmt 0035 zurück. Alle hochgeladenen Symbole gehen verloren — ein Werkzeug für die Entwicklung, kein Weg im Betrieb
-- (wie 0030). Die Protokollart nur, soweit kein Eintrag sie nutzt (0019).
DROP TABLE "cockpit"."app_symbol";
DROP FUNCTION "cockpit"."app_symbol_pruefen"();

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art = 'erscheinungsbild_geaendert'
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
