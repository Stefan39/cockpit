-- Epic E5 (COPI-85): Die Übernahme-Sperre — ein Mensch übernimmt einen Vorgang, die Agenten antworten dort nicht mehr.
--
-- Ein Vorgang ist eine Zeile einer Modul-View: (Modul-Kennung, `id`). Kein eigenes Vorgangsmodell (Entscheidung Stefan,
-- 28.09.2026). „Übernehmen" wirkt sofort im Cockpit, nicht über `cockpit.eingriff` und die Freigabekette; die Agenten
-- fragen die Sperre ab (`GET /intern/vorgaenge/sperre`), das Cockpit schickt ihnen nichts.
--
-- Eine Zeile ist eine Übernahme mit ihrer einmaligen Rückgabe. Eine erneute Übernahme nach der Rückgabe ist eine neue
-- Zeile — so bleibt jede Übernahme als Nachweis stehen (nie löschen, 0025). Je Vorgang ist höchstens eine Zeile aktiv
-- (partieller Unique-Index): von zwei gleichzeitigen Übernahmen gewinnt genau eine, die Datenbank entscheidet, nicht
-- der Anwendungscode.
--
-- `modul_kennung` hat die Form einer Modul-Kennung (0028), aber keinen Fremdschlüssel: `cockpit.modul` hält Versionen,
-- die Kennung ist dort nicht eindeutig. Die Konten verweisen per Fremdschlüssel ohne CASCADE/SET NULL auf `user`
-- (Muster 0024): ein Konto wird nur als gelöscht markiert, seine Übernahmen bleiben.
CREATE TABLE "cockpit"."vorgang_sperre" (
    id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    modul_kennung      text        NOT NULL,
    vorgang_id         text        NOT NULL,
    uebernommen_von    text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    uebernommen_am     timestamptz NOT NULL DEFAULT now(),
    zurueckgegeben_von text        REFERENCES "cockpit"."user" ("id"),
    zurueckgegeben_am  timestamptz,
    CONSTRAINT vorgang_sperre_modul_form CHECK (modul_kennung ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    CONSTRAINT vorgang_sperre_vorgang_laenge CHECK (char_length(vorgang_id) BETWEEN 1 AND 200),
    -- Zurückgegeben heißt: wer und wann, beides oder keins — und nie vor der Übernahme.
    CONSTRAINT vorgang_sperre_rueckgabe_vollstaendig CHECK ((zurueckgegeben_am IS NULL) = (zurueckgegeben_von IS NULL)),
    CONSTRAINT vorgang_sperre_rueckgabe_danach CHECK (zurueckgegeben_am IS NULL OR zurueckgegeben_am >= uebernommen_am)
);

-- Höchstens eine aktive Sperre je Vorgang. Zugleich der Weg für die Abfrage der Agenten und der Listen.
CREATE UNIQUE INDEX "vorgang_sperre_eine_aktive" ON "cockpit"."vorgang_sperre" (modul_kennung, vorgang_id)
    WHERE zurueckgegeben_am IS NULL;

-- Nach der Anlage ändert sich nur noch die einmalige Rückgabe. Eigene kleine Funktion (Muster 0028 `modul_pruefen`),
-- als Zeilenvergleich statt Spalte für Spalte.
CREATE FUNCTION "cockpit"."vorgang_sperre_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (NEW."id", NEW."modul_kennung", NEW."vorgang_id", NEW."uebernommen_von", NEW."uebernommen_am")
       IS DISTINCT FROM (OLD."id", OLD."modul_kennung", OLD."vorgang_id", OLD."uebernommen_von", OLD."uebernommen_am")
    THEN
        RAISE EXCEPTION 'vorgang_sperre_unveraenderlich: Wer wann welchen Vorgang uebernommen hat, steht fest';
    END IF;
    IF OLD."zurueckgegeben_am" IS NOT NULL THEN
        RAISE EXCEPTION 'vorgang_sperre_rueckgabe_endgueltig: Eine zurueckgegebene Sperre bleibt es; eine neue Uebernahme ist eine neue Zeile';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "vorgang_sperre_unveraenderlich"
    BEFORE UPDATE ON "cockpit"."vorgang_sperre"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."vorgang_sperre_pruefen"();

CREATE TRIGGER "vorgang_sperre_nie_loeschen" BEFORE DELETE ON "cockpit"."vorgang_sperre"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- Die Protokollarten (seit 0019 eine Zeile je Art).
INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('vorgang_uebernommen'), ('vorgang_zurueckgegeben')
ON CONFLICT (art) DO NOTHING;

-- Das Recht der Agenten-API, die Sperre abzufragen (Regel aus 0016: ein neues Recht kommt mit dem Ticket, das es
-- braucht). In einem Befehl ersetzt, damit die Bedingung nie fehlt.
ALTER TABLE "cockpit"."api_token"
    DROP CONSTRAINT "api_token_scopes_bekannt",
    ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen']::text[]
    );
