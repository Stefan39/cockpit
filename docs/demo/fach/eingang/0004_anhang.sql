-- Modul „Eingang", Fachmigration 0004 (COPI-110): die Anhänge eingegangener Mails, damit Nutzer ohne Zugang zum
-- Postfach sie im Cockpit herunterladen können — nur über eine Warnseite, gesperrte Typen nie. Die View
-- `v_modul_eingang_anhaenge.sql` liest daraus, der Block nennt sie unter `anhaenge:`.
--
-- **Zuordnung über die Message-ID.** Die Schreibrolle des Workflows hat nur INSERT, kein SELECT: Sie kennt die `id` des
-- Vorgangs nicht, wohl aber die Message-ID der Mail, die sie gerade geschrieben hat. Eine Mail ohne Message-ID bekommt vom
-- Workflow eine eigene (`<sha256 der Kopfzeilen>@cockpit.invalid`), sonst lassen sich ihre Anhänge nicht zuordnen.
--
-- **Inhalt höchstens 10 MB je Anhang** (Entscheidung vom 01.10.2026). Größere stehen mit `inhalt` NULL da — das
-- Cockpit zeigt dann „liegt im Postfach". Den SHA-256 rechnet die Datenbank selbst beim Einfügen; er bleibt stehen, wenn
-- der Inhalt nach der Frist entfernt wird (COPI-102: `inhalt` NULL, `inhalt_entfernt_am`), als Nachweis, was da war.
--
-- **Echte Anhänge erst mit der Frist** (Entscheidung vom 06.10.2026): Der Workflow schreibt Inhalte erst, wenn der
-- Job aus COPI-102 sie nach der Frist wieder entfernt. Bis dahin bleibt die Tabelle leer.
--
-- Nur hinzufügend; nie löschen wie `vorgang`.
BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM eingang._migration WHERE version = 4) THEN
        RAISE EXCEPTION 'fach_migration: eingang 0004 ist schon eingespielt';
    END IF;
END;
$$;

CREATE TABLE eingang.anhang (
    id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id         text        NOT NULL REFERENCES eingang.vorgang (message_id),
    -- Reihenfolge in der Mail, ab 1; mit der Message-ID zusammen eindeutig (ein zweiter Lauf schreibt nichts doppelt).
    position           integer     NOT NULL,
    dateiname          text        NOT NULL,
    -- Der Typ laut Absender (Content-Type) — nur zur Anzeige, das Cockpit stuft nach Endung und Inhalt ein.
    typ                text,
    groesse            bigint      NOT NULL,
    inhalt             bytea,
    sha256             text,
    inhalt_entfernt_am timestamptz,
    angelegt_am        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT anhang_je_position UNIQUE (message_id, position),
    CONSTRAINT anhang_position_positiv CHECK (position > 0),
    CONSTRAINT anhang_name_laenge CHECK (char_length(dateiname) BETWEEN 1 AND 255),
    CONSTRAINT anhang_groesse_positiv CHECK (groesse >= 0),
    CONSTRAINT anhang_inhalt_hoechstens CHECK (inhalt IS NULL OR octet_length(inhalt) <= 10485760),
    CONSTRAINT anhang_inhalt_passt CHECK (inhalt IS NULL OR octet_length(inhalt) = groesse),
    CONSTRAINT anhang_sha256_form CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')
);

-- Den SHA-256 rechnet die Datenbank, nicht der Workflow: so passt er sicher zum Inhalt.
CREATE FUNCTION eingang.anhang_sha256_setzen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.inhalt IS NOT NULL THEN
        NEW.sha256 := encode(sha256(NEW.inhalt), 'hex');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER anhang_sha256 BEFORE INSERT ON eingang.anhang
    FOR EACH ROW EXECUTE FUNCTION eingang.anhang_sha256_setzen();
CREATE TRIGGER anhang_nie_loeschen BEFORE DELETE ON eingang.anhang
    FOR EACH ROW EXECUTE FUNCTION eingang.nie_loeschen();

INSERT INTO eingang._migration (version, herkunft)
VALUES (4, coalesce(nullif(current_setting('fach.herkunft', true), ''), 'unbekannt'));

COMMIT;
