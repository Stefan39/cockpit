-- Modul „Eingang", Fachmigration 0002 (COPI-103): der Mailtext, damit ein Nutzer ohne Zugang zum Postfach das
-- Original im Cockpit lesen kann — spätestens zum Freigeben einer Antwort (COPI-90) muss er es kennen.
--
-- Nur hinzufügend (Regeln: `docs/modul-vertrag.md`, „Fachmigrationen"): `text` (nur `text/plain`, höchstens 10.000
-- Zeichen; der Workflow kürzt vorher) und `text_gekuerzt`, damit die Seite „gekürzt" sagen kann. Alte Zeilen behalten
-- `text` = NULL; die View zeigt dann keinen Abschnitt.
--
BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM eingang._migration WHERE version = 2) THEN
        RAISE EXCEPTION 'fach_migration: eingang 0002 ist schon eingespielt';
    END IF;
END;
$$;

ALTER TABLE eingang.vorgang
    ADD COLUMN text text,
    ADD COLUMN text_gekuerzt boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT vorgang_text_hoechstens CHECK (char_length(text) <= 10000);

INSERT INTO eingang._migration (version, herkunft)
VALUES (2, coalesce(nullif(current_setting('fach.herkunft', true), ''), 'unbekannt'));

COMMIT;
