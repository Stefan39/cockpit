-- Epic E2 (COPI-23): Das Protokoll der Sicherheitsereignisse — nur anhängen.
--
-- Jede sicherheitsrelevante Änderung im Zugang hinterlässt einen Eintrag, den die
-- Anwendung weder ändern noch löschen kann. Grundlage für das „revisionssichere
-- Protokoll" der ADR (Seite „Meldungen", E3) und für den Protokolleintrag der
-- Entsperrung (ADR 13.2).
--
-- Bewusst **ohne Fremdschlüssel** auf `user`: ein verfallenes oder gelöschtes Konto
-- lässt seine Einträge stehen. `akteur` und `ziel` sind Kennungen (Konto-ID oder
-- ein fester Begriff wie `system`, `konsole`, `erststart`), keine Adressen.
--
-- Datensparsamkeit gilt schon beim Schreiben (siehe src/auth/protokoll.ts): keine
-- Adresse, kein Token, kein Passwort, keine IP. Was einmal hier steht, lässt sich
-- nicht mehr entfernen — auch nicht auf Antrag.

CREATE TABLE "cockpit"."protokoll" (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    zeitpunkt    timestamptz NOT NULL DEFAULT now(),
    art          text        NOT NULL,
    -- Wer es getan hat: Konto-ID oder fester Begriff.
    akteur       text        NOT NULL,
    -- Woran: Konto-ID, wenn es ein Konto betrifft.
    ziel         text,
    einzelheiten jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Die bekannten Ereignisse. Neue Arten kommen mit den Tickets, die sie
    -- erzeugen, jeweils mit einer Migration, die diese Bedingung erweitert.
    CONSTRAINT protokoll_art_bekannt CHECK (art IN (
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
        'betreuer_uebergeben'
    ))
);

-- Nur anhängen. Die Sperre sitzt in der Datenbank und nicht im Anwendungscode: eine
-- vergessene Route oder ein späterer Fehler soll das Protokoll nicht verändern
-- können. Ohne Ausnahme und ohne Markierung, anders als beim Betreuer (0008): ein
-- Protokoll, das sich „bewusst" ändern ließe, wäre keines.
CREATE FUNCTION "cockpit"."protokoll_nur_anhaengen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'protokoll_nur_anhaengen: Das Protokoll wird nur ergaenzt, nie geaendert, geloescht oder geleert';
END;
$$;

CREATE TRIGGER "protokoll_kein_aendern"
    BEFORE UPDATE OR DELETE ON "cockpit"."protokoll"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."protokoll_nur_anhaengen"();

-- TRUNCATE löst keine Zeilen-Trigger aus und braucht einen eigenen.
CREATE TRIGGER "protokoll_kein_leeren"
    BEFORE TRUNCATE ON "cockpit"."protokoll"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "cockpit"."protokoll_nur_anhaengen"();
