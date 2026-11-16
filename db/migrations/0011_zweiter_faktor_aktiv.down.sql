-- Nimmt 0011 zurück: der Trigger liest die Spalte wieder selbst (Fassung aus 0007).
DROP TRIGGER "user_aktivierung_markieren" ON "cockpit"."user";

CREATE TRIGGER "user_aktivierung_markieren"
    BEFORE UPDATE ON "cockpit"."user"
    FOR EACH ROW
    WHEN (NEW."twoFactorEnabled" IS TRUE AND NEW."aktiviert_am" IS NULL)
    EXECUTE FUNCTION "cockpit"."konto_aktivierung_markieren"();

DROP FUNCTION "cockpit"."zweiter_faktor_aktiv"("cockpit"."user");
