-- COPI-62: Nie physisch löschen, nur als gelöscht markieren — der Bestand zieht nach (Entscheidung Stefan, 23.09.2026;
-- mögliche Dokumentationspflichten). Der Chat (0024) setzt es schon um; hier folgen Konten, Zugangsmittel, Agenten und
-- die übrigen Nachweistabellen.
--
-- Ausgenommen sind technische Kurzzeitdaten ohne Dokumentationswert (Stefan, 23.09.2026): Sitzungen, Better Auths
-- `verification`, `anmeldevorgang`, `passkey_vorgang`, `anmeldeversuch`. Sie dürfen weiter ablaufen und gelöscht
-- werden; was dort geschieht, steht als Nachweis im Protokoll (0009), das ohnehin nie gelöscht wird.

-- 1. Die Sperre aus 0024 mit einer Ausnahme für die Testdatenbanken: Tests räumen ihre Tabellen ab. Die Ausnahme
--    greift nur, wenn die Einstellung gesetzt ist **und** der Name der Datenbank auf `_test` endet (wie die
--    Schutzschicht der Tests, COPI-21) — in einer Kundeninstanz nie. Die Tests setzen sie für ihre Datenbank
--    (`test/global-setup.ts`).
CREATE OR REPLACE FUNCTION "cockpit"."nie_loeschen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF coalesce(current_setting('cockpit.testdaten_loeschen', true), '') = 'ja' AND current_database() LIKE '%\_test' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'nie_loeschen: In % wird nie geloescht, nur als geloescht markiert', TG_TABLE_NAME;
END;
$$;

-- 2. Konto. Beim Löschen wird die Adresse durch einen Platzhalter ersetzt und in `geloescht_email` festgehalten: So
--    findet keine Anmeldung, Einladung oder Adressprüfung das gelöschte Konto mehr, die Adresse ist wieder frei, und
--    der Bestand weiß trotzdem, wem sie gehörte. `geloescht_von` ist eine Kennung (Konto-ID oder `system`,
--    `erststart`), wie `akteur` im Protokoll — ohne Fremdschlüssel.
ALTER TABLE "cockpit"."user"
    ADD COLUMN "geloescht_am" timestamptz,
    ADD COLUMN "geloescht_von" text,
    ADD COLUMN "geloescht_email" text,
    ADD CONSTRAINT "user_geloescht_vollstaendig" CHECK (
        ("geloescht_am" IS NULL) = ("geloescht_von" IS NULL)
        AND ("geloescht_am" IS NULL) = ("geloescht_email" IS NULL)
    ),
    ADD CONSTRAINT "user_geloescht_platzhalter" CHECK (
        "geloescht_am" IS NULL OR "email" = 'geloescht-' || "id" || '@geloescht.invalid'
    );

-- Endgültig, und nie der aktivierte Betreuer: ihn kann nur die Übergabe ablösen (0008), nicht das Löschen. Ein nie
-- aktivierter Betreuer (abgebrochener Erststart) verfällt wie jedes halbfertige Konto — wie in 0008.
CREATE FUNCTION "cockpit"."konto_loeschmarke_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."geloescht_am" IS NOT NULL THEN
        RAISE EXCEPTION 'konto_geloescht_endgueltig: Ein als geloescht markiertes Konto bleibt es';
    END IF;
    IF NEW."geloescht_am" IS NOT NULL AND OLD."rolle" = 'betreuer' AND OLD."aktiviert_am" IS NOT NULL THEN
        RAISE EXCEPTION 'konto_betreuer_nicht_loeschen: Der aktivierte Betreuer wird nicht geloescht, nur uebergeben';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "user_loeschmarke"
    BEFORE UPDATE OF "geloescht_am", "geloescht_von", "geloescht_email" ON "cockpit"."user"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."konto_loeschmarke_pruefen"();

-- 3. Agent: wer nicht mehr im Inventar steht, wird als entfernt markiert; meldet er sich wieder, gilt er wieder.
ALTER TABLE "cockpit"."agent" ADD COLUMN "entfernt_am" timestamptz;

-- 4. Zugangsmittel: Die Tabellen, aus denen die Anmeldung liest, enthalten nur benutzbare Zugangsmittel — keine Abfrage
--    kann ein widerrufenes durchlassen, weil sie einen Filter vergisst. Wird eines entfernt (Entsperren, Konto löschen,
--    Better Auth selbst), hält ein Trigger es hier fest: welche Art, wessen, seit wann, bis wann — **ohne** Geheimnis.
--    Wie im Protokoll ohne Fremdschlüssel: `benutzer_id` ist eine Kennung.
CREATE TABLE "cockpit"."zugangsmittel_archiv" (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    art           text        NOT NULL,
    benutzer_id   text        NOT NULL,
    -- Die Kennung in der Ursprungstabelle (Passkey-ID, Zeilen-ID).
    ursprung_id   text        NOT NULL,
    angelegt_am   timestamptz,
    widerrufen_am timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT zugangsmittel_archiv_art_bekannt CHECK (art IN ('totp', 'passkey', 'ersatzcode'))
);

CREATE INDEX "zugangsmittel_archiv_benutzer_idx" ON "cockpit"."zugangsmittel_archiv" (benutzer_id);

-- Eine Funktion für alle drei Tabellen; die Art kommt als Argument des Triggers. Die Spalten lesen sich über jsonb,
-- weil Better Auths Tabelle `userId`/`createdAt` heißt und die eigenen `benutzer_id`/`angelegt_am`.
CREATE FUNCTION "cockpit"."zugangsmittel_archivieren"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    alt jsonb := to_jsonb(OLD);
BEGIN
    INSERT INTO "cockpit"."zugangsmittel_archiv" (art, benutzer_id, ursprung_id, angelegt_am)
    VALUES (
        TG_ARGV[0],
        coalesce(alt ->> 'benutzer_id', alt ->> 'userId'),
        alt ->> 'id',
        (coalesce(alt ->> 'angelegt_am', alt ->> 'createdAt'))::timestamptz
    );
    RETURN OLD;
END;
$$;

CREATE TRIGGER "twofactor_archivieren" AFTER DELETE ON "cockpit"."twoFactor"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."zugangsmittel_archivieren"('totp');
CREATE TRIGGER "passkey_archivieren" AFTER DELETE ON "cockpit"."passkey"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."zugangsmittel_archivieren"('passkey');
CREATE TRIGGER "ersatzcode_archivieren" AFTER DELETE ON "cockpit"."ersatzcode"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."zugangsmittel_archivieren"('ersatzcode');

-- 5. Nie löschen, an allen Nachweistabellen des Bestands.
CREATE TRIGGER "user_nie_loeschen" BEFORE DELETE ON "cockpit"."user"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "einladung_nie_loeschen" BEFORE DELETE ON "cockpit"."einladung"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "email_aenderung_nie_loeschen" BEFORE DELETE ON "cockpit"."email_aenderung"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "zugang_wiederherstellung_nie_loeschen" BEFORE DELETE ON "cockpit"."zugang_wiederherstellung"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "erststart_token_nie_loeschen" BEFORE DELETE ON "cockpit"."erststart_token"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "api_token_nie_loeschen" BEFORE DELETE ON "cockpit"."api_token"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "wache_nie_loeschen" BEFORE DELETE ON "cockpit"."wache"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "befund_nie_loeschen" BEFORE DELETE ON "cockpit"."befund"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "agent_nie_loeschen" BEFORE DELETE ON "cockpit"."agent"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "instanz_nie_loeschen" BEFORE DELETE ON "cockpit"."instanz"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "eingriff_nie_loeschen" BEFORE DELETE ON "cockpit"."eingriff"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "zugangsmittel_archiv_nie_loeschen" BEFORE DELETE ON "cockpit"."zugangsmittel_archiv"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

