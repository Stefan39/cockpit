-- Epic E2 (COPI-45): Ist die Authenticator-App (TOTP) eines Kontos eingerichtet? Eine Antwort, in der Datenbank.
--
-- Die Seite Benutzer nennt die Art des zweiten Faktors („Passkey", „Authenticator-App" oder beides). Ob überhaupt einer
-- aktiv ist, beantwortet `cockpit.zweiter_faktor_aktiv` (0011, 0012). Welche Art, steht für Passkeys in ihrer Tabelle,
-- für TOTP aber nur in der Spalte `twoFactorEnabled` des Better-Auth-Plugins — und die liest im Code niemand selbst
-- (COPI-25, `test/zweiter-faktor.test.ts`). Deshalb hier dieselbe Form: eine Funktion über die Zeile des Kontos.

CREATE FUNCTION "cockpit"."totp_aktiv"(benutzer "cockpit"."user")
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT benutzer."twoFactorEnabled" IS TRUE
$$;
