-- Nimmt 0012 zurück. Zuerst die Funktion auf ihre Fassung aus 0011 (sie liest die
-- Tabelle `passkey`; ohne diese Reihenfolge bliebe eine Funktion zurück, die auf eine
-- gelöschte Tabelle zeigt), dann die Tabellen mit ihren Daten. Konten, die nur einen
-- Passkey hatten, gelten danach wieder als ohne zweiten Faktor.
CREATE OR REPLACE FUNCTION "cockpit"."zweiter_faktor_aktiv"(benutzer "cockpit"."user")
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT benutzer."twoFactorEnabled" IS TRUE
$$;

DROP TRIGGER "passkey_aktivierung" ON "cockpit"."passkey";
DROP FUNCTION "cockpit"."passkey_aktivierung_markieren"();

DROP TABLE "cockpit"."ersatzcode";
DROP TABLE "cockpit"."passkey_vorgang";
DROP TABLE "cockpit"."passkey";
