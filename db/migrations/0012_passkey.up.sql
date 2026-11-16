-- Epic E2 (COPI-26): Passkeys (WebAuthn) als zweiter Faktor, gleichwertig zu TOTP.
--
-- Drei Tabellen und eine Erweiterung der einen Antwort auf „zweiter Faktor aktiv":
--
--   * `passkey`         — die eingerichteten Passkeys eines Kontos (mehrere erlaubt).
--   * `passkey_vorgang` — die offene Registrierungszeremonie: die Challenge, die das
--                         Gerät signieren muss. Höchstens eine je Konto, kurzlebig,
--                         einmal verbrauchbar (die Anwendung löscht sie beim Prüfen).
--   * `ersatzcode`      — Wiederherstellungscodes für Konten, deren erster Faktor ein
--                         Passkey ist. Die Better-Auth-Codes gibt es nur mit aktivem
--                         TOTP (gemessen: `TWO_FACTOR_NOT_ENABLED`), also eine eigene
--                         Tabelle: nur Hash, einmal gültig.
--
-- Alle drei hängen mit ON DELETE CASCADE am Konto: ein verfallenes oder gelöschtes
-- Konto nimmt seine Passkeys, Vorgänge und Codes mit (auch der 72-h-Verfall).

CREATE TABLE "cockpit"."passkey" (
    -- Die Kennung des Passkeys (base64url), wie sie das Gerät liefert. Global
    -- eindeutig: ein Passkey gehört zu genau einem Konto.
    id                       text        PRIMARY KEY,
    benutzer_id              text        NOT NULL REFERENCES "cockpit"."user" ("id") ON DELETE CASCADE,
    -- Der öffentliche Schlüssel im COSE-Format. Der private Schlüssel verlässt das Gerät nie.
    oeffentlicher_schluessel bytea       NOT NULL,
    -- Der Signaturzähler des Geräts; die Anmeldung (COPI-27) prüft, dass er steigt.
    zaehler                  bigint      NOT NULL DEFAULT 0,
    transports               text[]      NOT NULL DEFAULT '{}',
    -- Wie das Gerät in der Oberfläche heißt („Mein Laptop"); frei wählbar, kein Merkmal
    -- der Sicherheit. Im Protokoll steht er nie.
    name                     text        NOT NULL,
    angelegt_am              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT passkey_name_laenge CHECK (char_length(name) BETWEEN 1 AND 60)
);

CREATE INDEX "passkey_benutzer_idx" ON "cockpit"."passkey" ("benutzer_id");

CREATE TABLE "cockpit"."passkey_vorgang" (
    -- Höchstens ein offener Vorgang je Konto: eine neue Zeremonie ersetzt die alte.
    benutzer_id text        PRIMARY KEY REFERENCES "cockpit"."user" ("id") ON DELETE CASCADE,
    challenge   text        NOT NULL,
    ablauf_am   timestamptz NOT NULL
);

CREATE TABLE "cockpit"."ersatzcode" (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    benutzer_id text        NOT NULL REFERENCES "cockpit"."user" ("id") ON DELETE CASCADE,
    -- Argon2id-Hash (wie das Passwort). Der Klartext steht nirgends; er wird einmal angezeigt.
    code_hash   text        NOT NULL,
    verbraucht_am timestamptz,
    angelegt_am timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "ersatzcode_offen_idx" ON "cockpit"."ersatzcode" ("benutzer_id") WHERE "verbraucht_am" IS NULL;

-- Die eine Antwort auf „zweiter Faktor aktiv" (0011) bekommt die zweite Quelle. Alle
-- Stellen, die sie fragen — Tor, Rechteprüfung, Einrichtungsseite, Übergabe und der
-- Trigger unten aus 0007 —, ändern sich nicht.
CREATE OR REPLACE FUNCTION "cockpit"."zweiter_faktor_aktiv"(benutzer "cockpit"."user")
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT benutzer."twoFactorEnabled" IS TRUE
        OR EXISTS (SELECT 1 FROM "cockpit"."passkey" p WHERE p."benutzer_id" = benutzer."id")
$$;

-- Ein Passkey aktiviert das Konto wie ein bestätigtes TOTP: `aktiviert_am` folgt dem
-- Zustand, nicht dem Weg (0007). Der Trigger auf `user` läuft von selbst mit — er
-- fragt dieselbe Funktion —, aber ein Konto, das nur diesen einen Weg kennt, soll
-- nicht davon abhängen, dass eine zweite Bedingung passt: der Marker wird hier
-- ausdrücklich gesetzt, und nur, wenn er fehlt.
CREATE FUNCTION "cockpit"."passkey_aktivierung_markieren"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE "cockpit"."user"
       SET "aktiviert_am" = now()
     WHERE "id" = NEW."benutzer_id"
       AND "aktiviert_am" IS NULL;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "passkey_aktivierung"
    AFTER INSERT ON "cockpit"."passkey"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."passkey_aktivierung_markieren"();
