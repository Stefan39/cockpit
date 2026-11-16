-- Modul „Eingang", Fachmigration 0003 (COPI-90): Antwortentwürfe und ihr Versand, damit eine Antwort im Cockpit
-- freigegeben werden kann (Eingriff `antwort_freigeben`). Die Freigabe selbst steht im Cockpit (`cockpit.freigabe`),
-- nie hier — das Cockpit schreibt nie in Fachtabellen.
--
-- Nur hinzufügend, und wie `vorgang` nur einfügen (die Schreibrolle hat kein UPDATE): ein geänderter Entwurf ist eine
-- neue **Fassung** (1, 2, …) desselben Vorgangs; ein Versand eine Zeile in `versand` mit der Fassung, die rausging.
-- Beide Tabellen weisen DELETE ab (nie löschen, wie `vorgang`).
--
BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM eingang._migration WHERE version = 3) THEN
        RAISE EXCEPTION 'fach_migration: eingang 0003 ist schon eingespielt';
    END IF;
END;
$$;

CREATE TABLE eingang.entwurf (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vorgang_id  bigint      NOT NULL REFERENCES eingang.vorgang (id),
    fassung     integer     NOT NULL,
    an          text        NOT NULL,
    betreff     text        NOT NULL,
    text        text        NOT NULL,
    angelegt_am timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT entwurf_fassung_positiv CHECK (fassung > 0),
    CONSTRAINT entwurf_text_laenge CHECK (char_length(text) BETWEEN 1 AND 10000),
    CONSTRAINT entwurf_je_fassung UNIQUE (vorgang_id, fassung)
);

CREATE TABLE eingang.versand (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vorgang_id  bigint      NOT NULL REFERENCES eingang.vorgang (id),
    fassung     integer     NOT NULL,
    gesendet_am timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT versand_je_fassung UNIQUE (vorgang_id, fassung),
    CONSTRAINT versand_hat_entwurf FOREIGN KEY (vorgang_id, fassung) REFERENCES eingang.entwurf (vorgang_id, fassung)
);

CREATE TRIGGER entwurf_nie_loeschen BEFORE DELETE ON eingang.entwurf
    FOR EACH ROW EXECUTE FUNCTION eingang.nie_loeschen();
CREATE TRIGGER versand_nie_loeschen BEFORE DELETE ON eingang.versand
    FOR EACH ROW EXECUTE FUNCTION eingang.nie_loeschen();

INSERT INTO eingang._migration (version, herkunft)
VALUES (3, coalesce(nullif(current_setting('fach.herkunft', true), ''), 'unbekannt'));

COMMIT;
