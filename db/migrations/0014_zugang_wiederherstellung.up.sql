-- Epic E2 (COPI-28): Entsperrung bei verlorenem zweitem Faktor.
--
-- Der Betreuer stellt den Zugang per Server-Kommando wieder her (ADR Abschnitt 7,
-- kein E-Mail-Reset). Das Kommando entfernt alle Faktoren, beendet alle Sitzungen,
-- entwertet das Passwort und gibt einen Einmal-Link aus. Diese Tabelle hält den Link.
--
-- Wie bei Erststart-Token und Einladung: gespeichert wird nur der SHA-256-Hash, das
-- Token selbst lebt allein in der Ausgabe des Kommandos. Der Link gehört zu **einem
-- Konto** — wer ihn hat, kann für genau dieses Konto ein neues Passwort setzen.

CREATE TABLE "cockpit"."zugang_wiederherstellung" (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- ON DELETE CASCADE: ein gelöschtes Konto nimmt seinen Link mit.
    benutzer_id   text        NOT NULL REFERENCES "cockpit"."user" ("id") ON DELETE CASCADE,
    token_hash    text        NOT NULL,
    erstellt_am   timestamptz NOT NULL DEFAULT now(),
    -- 3 Stunden nach dem Ausstellen, wie bei der Einladung.
    ablauf_am     timestamptz NOT NULL,
    verbraucht_am timestamptz
);

CREATE UNIQUE INDEX "zugang_wiederherstellung_token_hash_idx"
    ON "cockpit"."zugang_wiederherstellung" ("token_hash");

-- Je Konto höchstens ein offener Link: ein neuer Aufruf des Kommandos entwertet den
-- alten (die Anwendung tut das in derselben Transaktion; der Index erzwingt es).
CREATE UNIQUE INDEX "zugang_wiederherstellung_ein_offener_je_konto_idx"
    ON "cockpit"."zugang_wiederherstellung" ("benutzer_id")
    WHERE "verbraucht_am" IS NULL;

-- Alle zweiten Faktoren eines Kontos entfernen — die Gegenstelle zu
-- `zweiter_faktor_aktiv` (0011, 0012): was dort als Faktor zählt, entfernt diese Funktion.
-- Kommt ein weiterer Faktor hinzu, gehört er in **beide**. Sie steht in der Datenbank und
-- nicht im Code, weil die Spalte `twoFactorEnabled` im Code nirgends genannt wird (COPI-25,
-- `test/zweiter-faktor.test.ts`): sie ist ein Detail des Better-Auth-Plugins.
--
-- Das Entfernen der TOTP-Zeile allein genügte nicht: die Spalte bliebe wahr, und das Konto
-- gälte weiter als „zweiter Faktor aktiv". `aktiviert_am` bleibt unangetastet.
CREATE FUNCTION "cockpit"."zweite_faktoren_entfernen"(benutzer text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM "cockpit"."twoFactor" WHERE "userId" = benutzer;
    DELETE FROM "cockpit"."passkey" WHERE "benutzer_id" = benutzer;
    DELETE FROM "cockpit"."ersatzcode" WHERE "benutzer_id" = benutzer;
    DELETE FROM "cockpit"."passkey_vorgang" WHERE "benutzer_id" = benutzer;
    UPDATE "cockpit"."user" SET "twoFactorEnabled" = false, "updatedAt" = now() WHERE "id" = benutzer;
END;
$$;

-- Zwei neue Protokollarten (Muster aus 0009/0010): das Entsperren durch die Konsole und
-- das Einlösen des Links. Beide tragen nie Token oder Adresse.
ALTER TABLE "cockpit"."protokoll" DROP CONSTRAINT "protokoll_art_bekannt";

ALTER TABLE "cockpit"."protokoll"
    ADD CONSTRAINT "protokoll_art_bekannt" CHECK (art IN (
        'konto_angelegt',
        'einladung_erzeugt',
        'einladung_eingeloest',
        'anmeldung_erfolgreich',
        'anmeldung_fehlgeschlagen',
        'sperre_ausgeloest',
        'zweiter_faktor_eingerichtet',
        'ersatzcode_verwendet',
        'abmeldung',
        'konto_verfallen',
        'betreuer_uebergeben',
        'erststart_token_erzeugt',
        'konto_entsperrt',
        'zugang_wiederhergestellt'
    ));
