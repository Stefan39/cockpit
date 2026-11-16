-- Nimmt 0007_konto_aktivierung zurück: Trigger und Funktion entfallen. Bereits
-- gesetzte Marker bleiben stehen (die Spalte gehört zu 0006). Ohne den Trigger
-- gilt wieder der Stand von COPI-17: nur die Route /zwei-faktor/pruefen setzt
-- den Marker.
DROP TRIGGER IF EXISTS "user_aktivierung_markieren" ON "cockpit"."user";
DROP FUNCTION IF EXISTS "cockpit"."konto_aktivierung_markieren"();
