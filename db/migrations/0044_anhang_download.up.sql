-- COPI-110: Der Nachweis jedes Anhang-Downloads aus einer Modulseite. Wer hat wann welche Datei aus welchem Vorgang
-- geholt, mit welchem Inhalt (SHA-256) und nach welcher Warnung. Das Protokoll trägt nur Kennungen (0009) — Dateiname und
-- Hash stehen deshalb hier, das Protokoll verweist mit `anhang_download_id` auf die Zeile (Muster wie 0030, 0038).
--
-- Ein Vorgang ist eine Zeile einer Modul-View, ein Anhang eine Zeile ihrer Anhang-View (Modul-Kennung und `id`), ohne
-- Fremdschlüssel auf `modul`. Gesperrte Anhänge kommen hier nie an: das Cockpit liefert sie nicht aus.
--
-- Unveränderlich und nie gelöscht (0025): ein Nachweis.
CREATE TABLE "cockpit"."anhang_download" (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    modul_kennung text        NOT NULL,
    vorgang_id    text        NOT NULL,
    anhang_id     text        NOT NULL,
    dateiname     text        NOT NULL,
    groesse       bigint      NOT NULL,
    sha256        text        NOT NULL,
    klasse        text        NOT NULL,
    konto         text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    am            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT anhang_download_modul_form CHECK (modul_kennung ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    CONSTRAINT anhang_download_vorgang_laenge CHECK (char_length(vorgang_id) BETWEEN 1 AND 200),
    CONSTRAINT anhang_download_anhang_laenge CHECK (char_length(anhang_id) BETWEEN 1 AND 200),
    CONSTRAINT anhang_download_name_laenge CHECK (char_length(dateiname) BETWEEN 1 AND 255),
    CONSTRAINT anhang_download_groesse CHECK (groesse BETWEEN 0 AND 10485760),
    CONSTRAINT anhang_download_sha256_form CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT anhang_download_klasse CHECK (klasse IN ('normal', 'warnung'))
);

CREATE FUNCTION "cockpit"."anhang_download_unveraenderlich"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'anhang_download_unveraenderlich: Ein Download-Nachweis wird nie geaendert';
END;
$$;

CREATE TRIGGER "anhang_download_kein_aendern" BEFORE UPDATE ON "cockpit"."anhang_download"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."anhang_download_unveraenderlich"();

CREATE TRIGGER "anhang_download_nie_loeschen" BEFORE DELETE ON "cockpit"."anhang_download"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('anhang_heruntergeladen')
ON CONFLICT (art) DO NOTHING;
