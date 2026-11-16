-- Epic E2 (COPI-25): „zweiter Faktor aktiv" hat genau eine Quelle.
--
-- Bisher hat jede Stelle für sich die Spalte `user."twoFactorEnabled"` gelesen — das
-- Tor, die Rechteprüfung, die Einrichtungsseite, die Betreuerübergabe und der
-- Trigger aus 0007. Die Spalte setzt das Better-Auth-Plugin nur für TOTP. Ein
-- Passkey (COPI-26) würde sie nicht setzen; jede Stelle, die sie direkt liest,
-- hielte ein Konto mit Passkey für ungeschützt, und der 72-h-Verfall (COPI-17/19)
-- löschte es.
--
-- Diese Funktion ist die eine Antwort. Heute liefert sie die Spalte; COPI-26
-- erweitert sie um Passkeys (`CREATE OR REPLACE`), ohne dass eine der Stellen
-- angefasst werden muss.
--
-- Sie bekommt die **Zeile**, nicht die Konto-ID: Der Trigger unten prüft den
-- neuen Zustand (`NEW`) einer Zeile, die noch nicht geschrieben ist. Eine
-- Funktion, die per ID in der Tabelle nachschlägt, sähe dort noch den alten.
--
-- Immer wahr oder falsch, nie NULL: eine leere Spalte (sie ist nullable) heißt
-- „kein zweiter Faktor".
CREATE FUNCTION "cockpit"."zweiter_faktor_aktiv"(benutzer "cockpit"."user")
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT benutzer."twoFactorEnabled" IS TRUE
$$;

-- Der Trigger aus 0007 fragt jetzt dieselbe Funktion. Sonst gleich: er setzt
-- `aktiviert_am`, sobald ein Update den Faktor einschaltet und der Marker fehlt.
-- Das Verhalten ändert sich heute nicht, eine Reparatur ist nicht nötig.
DROP TRIGGER "user_aktivierung_markieren" ON "cockpit"."user";

CREATE TRIGGER "user_aktivierung_markieren"
    BEFORE UPDATE ON "cockpit"."user"
    FOR EACH ROW
    WHEN ("cockpit"."zweiter_faktor_aktiv"(NEW) AND NEW."aktiviert_am" IS NULL)
    EXECUTE FUNCTION "cockpit"."konto_aktivierung_markieren"();
