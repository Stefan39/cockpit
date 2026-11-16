-- Modul „Eingang", Fachmigration 0001 (COPI-88, Buchführung seit COPI-107): die Fachtabelle, in die der
-- Posteingangs-Workflow eines Assistenten je eingegangener Nachricht eine Zeile schreibt. Die View `v_modul_eingang.sql` liest daraus.
--
-- **Fachtabelle, nicht Cockpit:** eigenes Schema `eingang` in derselben Datenbank wie das Cockpit
-- (`docs/modul-vertrag.md`, „Dieselbe Datenbank"). Das Cockpit liest nur, über die View; es schreibt nie hinein.
-- Rollen und Rechte (Schreibrolle des Workflows, `SELECT` für die Rolle `cockpit`) legt der Einrichter an —
-- `rechte.sql` des Moduls, nicht diese Datei.
--
-- **Kein Mailtext.** Gespeichert wird, was die Liste braucht: Absender, Betreff, Eingang, die Kundenzuordnung und die
-- Triage des Agenten (Zusammenfassung und Vorschlag). Der Text bleibt im Postfach. Alles hier ist Fremdtext oder
-- KI-Text über Fremdtext: das Cockpit maskiert ihn und verlinkt nichts.
--
-- **Nie löschen**, wie im Cockpit (Entscheidung vom 23.09.2026): ein `DELETE` weist der Trigger ab. Eine eigene Funktion statt
-- `cockpit.nie_loeschen()`, damit das Fachmodul nicht an einer internen Funktion des Cockpits hängt.
--
-- **Fachmigration (COPI-107, Regeln: `docs/modul-vertrag.md`, „Fachmigrationen"):** eine Transaktion, die sich selbst
-- in `eingang._migration` bucht und abbricht, wenn Version 1 schon gebucht ist. 0001 legt die Buchführung an;
-- alles mit `IF NOT EXISTS`, damit sie auch auf einer schon von Hand angelegten Tabelle läuft und dann nur bucht.
-- Die Herkunft kommt aus der Sitzungseinstellung `fach.herkunft` (setzt `fach-migrieren.sh`), sonst „unbekannt".
--
-- Nie an einer eingespielten Migration: eine Änderung ist die nächste Nummer.
BEGIN;

CREATE SCHEMA IF NOT EXISTS eingang;

CREATE OR REPLACE FUNCTION eingang.nie_loeschen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'nie_loeschen: In % wird nie geloescht, nur als erledigt markiert', TG_TABLE_NAME;
END;
$$;

-- Die Buchführung der Fachmigrationen dieses Schemas.
CREATE TABLE IF NOT EXISTS eingang._migration (
    version        int         PRIMARY KEY,
    herkunft       text        NOT NULL,
    angewendet_am  timestamptz NOT NULL DEFAULT now(),
    angewendet_von text        NOT NULL DEFAULT current_user
);

DROP TRIGGER IF EXISTS migration_nie_loeschen ON eingang._migration;
CREATE TRIGGER migration_nie_loeschen BEFORE DELETE ON eingang._migration
    FOR EACH ROW EXECUTE FUNCTION eingang.nie_loeschen();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM eingang._migration WHERE version = 1) THEN
        RAISE EXCEPTION 'fach_migration: eingang 0001 ist schon eingespielt';
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS eingang.vorgang (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Message-ID der Mail: verhindert eine zweite Zeile, wenn der Workflow dieselbe Mail noch einmal sieht.
    -- NULL erlaubt (manche Absender setzen keine); mehrere NULL verletzen UNIQUE nicht.
    message_id       text        UNIQUE,
    -- Für das Threading (JAC-505): noch ungenutzt, aber ab dem ersten Tag gespeichert.
    in_reply_to      text,
    postfach         text        NOT NULL,
    absender_name    text,
    absender_adresse text,
    betreff          text        NOT NULL,
    eingang          timestamptz NOT NULL,
    kunde            text,
    zusammenfassung  text        NOT NULL,
    vorschlag        text,
    -- Nur Dateinamen und Typen, nie Inhalte.
    anhaenge         text,
    stand            text        NOT NULL DEFAULT 'neu',
    stand_seit       timestamptz NOT NULL DEFAULT now(),
    angelegt_am      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vorgang_stand_bekannt CHECK (stand IN ('neu', 'entwurf', 'freigegeben', 'gesendet', 'erledigt'))
);

CREATE INDEX IF NOT EXISTS vorgang_eingang ON eingang.vorgang (eingang DESC);

DROP TRIGGER IF EXISTS vorgang_nie_loeschen ON eingang.vorgang;
CREATE TRIGGER vorgang_nie_loeschen BEFORE DELETE ON eingang.vorgang
    FOR EACH ROW EXECUTE FUNCTION eingang.nie_loeschen();

INSERT INTO eingang._migration (version, herkunft)
VALUES (1, coalesce(nullif(current_setting('fach.herkunft', true), ''), 'unbekannt'));

COMMIT;
