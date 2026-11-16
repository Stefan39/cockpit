-- COPI-94: Zweite Faktoren verwalten — weiterer Passkey, Authenticator-App neben dem Passkey, Entfernen und neue
-- Ersatzcodes, jeweils nach einer frischen Bestätigung durch einen vorhandenen Faktor (Seite `/sicherheit`).
--
--   * `passkey_vorgang.zweck` — die offene Zeremonie eines Kontos ist entweder eine Registrierung (wie bisher) oder
--     die Bestätigung mit einem vorhandenen Passkey. Eine Challenge gilt nur für ihren Zweck: eine Antwort auf die
--     eine lässt sich nie als die andere einreichen.
--   * `ersatzcode.entwertet_am` — „Neu erzeugen" entwertet alle offenen Codes, statt sie zu löschen (nie löschen, 0025).
--     Ein entwerteter Code ist kein verbrauchter: er wurde nie eingelöst.
--   * Vier Protokollarten für die Verwaltung. Entfernte Passkeys und eine entfernte Authenticator-App gehen wie bisher
--     über den Archiv-Trigger aus 0025 (ohne Geheimnis) in `zugangsmittel_archiv`; wer entfernt hat, steht im Protokoll.
ALTER TABLE "cockpit"."passkey_vorgang"
    ADD COLUMN zweck text NOT NULL DEFAULT 'registrierung'
        CHECK (zweck IN ('registrierung', 'bestaetigung'));

ALTER TABLE "cockpit"."ersatzcode"
    ADD COLUMN entwertet_am timestamptz;

-- Die Authenticator-App allein entfernen, wie `zweite_faktoren_entfernen` (0014) für alle: die Spalte
-- `twoFactorEnabled` fasst der Code nie selbst an (COPI-25). Die Regel „nie der letzte Faktor" prüft die Anwendung
-- vorher in derselben Transaktion (`faktoren.ts`).
CREATE FUNCTION "cockpit"."totp_entfernen"(benutzer text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM "cockpit"."twoFactor" WHERE "userId" = benutzer;
    UPDATE "cockpit"."user" SET "twoFactorEnabled" = false, "updatedAt" = now() WHERE "id" = benutzer;
END;
$$;

INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('zweiter_faktor_hinzugefuegt'), ('zweiter_faktor_entfernt'), ('ersatzcodes_erneuert'), ('faktor_bestaetigt')
ON CONFLICT (art) DO NOTHING;
