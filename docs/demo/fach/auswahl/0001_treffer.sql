-- Demo-Modul „Auswahl", Fachmigration 0001 (COPI-91): die Vorschläge eines Assistenten und was aus ihnen wird. Die View
-- `v_modul_auswahl.sql` liest daraus, der Block `auswahl.cockpit.yaml` zeigt sie im Cockpit.
--
-- **Ein Eingang:** Beide Meldewege (automatisch und manuell) melden Treffer an einen n8n-Webhook, der hier einfügt.
-- Die URL des Vorschlags ist eindeutig: denselben Treffer aus zwei Wegen gibt es nur einmal (`ON CONFLICT DO NOTHING`).
--
-- **Verlauf als Schritte, nur einfügen** (wie `kommunikation.entwurf`): Der Assistent schreibt `bewerbung` (Entwurf, je
-- Fassung eine Zeile), `beworben` (mit dem Link zum Eintrag im Fremdsystem, `adminUrl` der Intake-API), `aussortiert`
-- oder `wieder_offen`. Der jüngste Schritt ist der Stand. Was ein Mensch entscheidet, steht im Cockpit
-- (`cockpit.entscheidung`, COPI-91), nie hier — das Cockpit schreibt keine Fachtabellen.
--
-- **Frist:** Beschreibungs- und Entwurfstexte 90 Tage nach dem Fund → „(entfernt nach Frist)"
-- (`fristen_anwenden()`, täglich aus n8n, wie Kommunikation 0005). Nie löschen.
BEGIN;

CREATE SCHEMA IF NOT EXISTS auswahl;

CREATE OR REPLACE FUNCTION auswahl.nie_loeschen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'nie_loeschen: In % wird nie geloescht', TG_TABLE_NAME;
END;
$$;

CREATE TABLE IF NOT EXISTS auswahl._migration (
    version        int         PRIMARY KEY,
    herkunft       text        NOT NULL,
    angewendet_am  timestamptz NOT NULL DEFAULT now(),
    angewendet_von text        NOT NULL DEFAULT current_user
);

DROP TRIGGER IF EXISTS migration_nie_loeschen ON auswahl._migration;
CREATE TRIGGER migration_nie_loeschen BEFORE DELETE ON auswahl._migration
    FOR EACH ROW EXECUTE FUNCTION auswahl.nie_loeschen();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM auswahl._migration WHERE version = 1) THEN
        RAISE EXCEPTION 'fach_migration: auswahl 0001 ist schon eingespielt';
    END IF;
END;
$$;

CREATE TABLE auswahl.treffer (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    url              text        NOT NULL UNIQUE,
    plattform        text        NOT NULL,
    titel            text        NOT NULL,
    auftraggeber     text,
    honorar          text,
    umfang           text,
    ort              text,
    einschaetzung    text,
    ausschreibung    text,
    -- `grenzfall`: notiert, aber keine klare Empfehlung. Aussortiertes meldet der Assistent in dieser Migration noch nicht.
    art              text        NOT NULL DEFAULT 'treffer',
    -- Wer gemeldet hat: `assistent` (automatisch) oder `manuell`.
    quelle           text        NOT NULL,
    gefunden_am      timestamptz NOT NULL DEFAULT now(),
    text_entfernt_am timestamptz,
    angelegt_am      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT treffer_url_form CHECK (url ~ '^https://' AND char_length(url) <= 2000),
    CONSTRAINT treffer_plattform_laenge CHECK (char_length(plattform) BETWEEN 1 AND 60),
    CONSTRAINT treffer_titel_laenge CHECK (char_length(titel) BETWEEN 1 AND 300),
    CONSTRAINT treffer_einschaetzung_laenge CHECK (char_length(einschaetzung) <= 4000),
    CONSTRAINT treffer_ausschreibung_laenge CHECK (char_length(ausschreibung) <= 20000),
    CONSTRAINT treffer_art_bekannt CHECK (art IN ('treffer', 'grenzfall')),
    CONSTRAINT treffer_quelle_bekannt CHECK (quelle IN ('assistent', 'manuell'))
);

CREATE INDEX treffer_gefunden ON auswahl.treffer (gefunden_am DESC);

CREATE TABLE auswahl.schritt (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    treffer_id       bigint      NOT NULL REFERENCES auswahl.treffer (id),
    art              text        NOT NULL,
    -- Der Entwurf (nur bei `bewerbung`).
    text             text,
    -- Der Eintrag im Fremdsystem (nur bei `beworben`).
    lead_url         text,
    text_entfernt_am timestamptz,
    angelegt_am      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schritt_art_bekannt CHECK (art IN ('bewerbung', 'beworben', 'aussortiert', 'wieder_offen')),
    CONSTRAINT schritt_bewerbung_mit_text CHECK ((art = 'bewerbung') = (text IS NOT NULL)),
    CONSTRAINT schritt_text_laenge CHECK (char_length(text) <= 10000),
    CONSTRAINT schritt_lead_nur_beworben CHECK (lead_url IS NULL OR (art = 'beworben' AND lead_url ~ '^https://' AND char_length(lead_url) <= 2000))
);

CREATE INDEX schritt_treffer ON auswahl.schritt (treffer_id, id DESC);

CREATE TRIGGER treffer_nie_loeschen BEFORE DELETE ON auswahl.treffer
    FOR EACH ROW EXECUTE FUNCTION auswahl.nie_loeschen();
CREATE TRIGGER schritt_nie_loeschen BEFORE DELETE ON auswahl.schritt
    FOR EACH ROW EXECUTE FUNCTION auswahl.nie_loeschen();

-- Beschreibungs- und Entwurfstexte 90 Tage nach dem Fund. Fest in der Funktion, wiederholbar.
CREATE FUNCTION auswahl.fristen_anwenden()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auswahl, pg_temp
AS $$
DECLARE
    n_treffer integer;
    n_schritte integer;
BEGIN
    UPDATE auswahl.treffer
       SET ausschreibung = CASE WHEN ausschreibung IS NULL THEN NULL ELSE '(entfernt nach Frist)' END,
           text_entfernt_am = now()
     WHERE text_entfernt_am IS NULL
       AND gefunden_am < now() - interval '90 days';
    GET DIAGNOSTICS n_treffer = ROW_COUNT;

    UPDATE auswahl.schritt s
       SET text = '(entfernt nach Frist)', text_entfernt_am = now()
      FROM auswahl.treffer t
     WHERE s.treffer_id = t.id
       AND s.text IS NOT NULL
       AND s.text_entfernt_am IS NULL
       AND t.gefunden_am < now() - interval '90 days';
    GET DIAGNOSTICS n_schritte = ROW_COUNT;

    RETURN n_treffer + n_schritte;
END;
$$;

REVOKE EXECUTE ON FUNCTION auswahl.fristen_anwenden() FROM PUBLIC;

INSERT INTO auswahl._migration (version, herkunft)
VALUES (1, coalesce(nullif(current_setting('fach.herkunft', true), ''), 'unbekannt'));

COMMIT;
