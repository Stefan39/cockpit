-- Epic E5 (COPI-77): Die Modul-Registry. „Modulseiten sind deklariert, nicht programmiert" (ADR,
-- Abschnitt „Architektur-Leitplanken"): ein `cockpit:`-Block in der Agent-Blueprint-YAML beschreibt
-- Menüname, Ansichtstyp, View und Spalten — der Vertrag zum Fachmodul ist eine SQL-View mit festen
-- Spaltennamen, nie Code. Diese Tabelle ist die Registry, **in der Datenbank, nicht im Image**: ein
-- Modul-Update kommt ohne Image-Wechsel und ohne Neustart aus.
--
-- Eine Zeile ist eine eingespielte Version eines Moduls, nie ein Entwurf: geprüfter Block (zod),
-- geprüfter Katalog (die View mit ihren Pflichtspalten) und Prüfsumme über den rohen Text, aus dem er
-- entstand. Wie beim Zugangs-Token (0016) und beim Eingriff (0015) steht die Historie fest — eine neue
-- Version ist eine neue Zeile, keine Änderung: `kennung`, `version`, `block`, `block_roh`, `pruefsumme`,
-- `herkunft` und `eingespielt_*` sind nach dem Einspielen unveränderlich (Trigger unten). Nur `aktiv`
-- und `aktiv_seit` dürfen sich noch ändern — das ist der Wechsel der aktiven Version.
--
-- Je Kennung ist höchstens eine Zeile aktiv (partieller Unique-Index): das Modul zeigt sich nie mit
-- zwei Versionen zugleich. `version` zählt je Kennung fortlaufend ab 1, geprüft über den Anwendungscode
-- (`modulEinspielen`), nicht über eine eigene Sequenz je Kennung.
--
-- Die Oberfläche liest den YAML-Block nie: `block` ist der geprüfte Vertrag als jsonb, `block_roh` der
-- Text, aus dem die Prüfsumme entsteht — beides bleibt stehen, damit ein Streit über „was genau wurde
-- eingespielt" sich an der Zeile klären lässt, nicht am Gedächtnis.

CREATE TABLE "cockpit"."modul" (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kennung         text        NOT NULL,
    version         integer     NOT NULL,
    block           jsonb       NOT NULL,
    block_roh       text        NOT NULL,
    pruefsumme      text        NOT NULL,
    -- Frei, etwa `agent-blueprints@<commit>:agents/agent-admin.yaml`; ohne Angabe NULL, kein Zwang.
    herkunft        text,
    eingespielt_am  timestamptz NOT NULL DEFAULT now(),
    eingespielt_von text        NOT NULL,
    aktiv           boolean     NOT NULL DEFAULT false,
    aktiv_seit      timestamptz,
    CONSTRAINT modul_kennung_form CHECK (kennung ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    CONSTRAINT modul_version_positiv CHECK (version > 0),
    CONSTRAINT modul_kennung_version_eindeutig UNIQUE (kennung, version),
    CONSTRAINT modul_block_objekt CHECK (jsonb_typeof(block) = 'object'),
    -- sha256 in Hex, wie der Hash eines Zugangs-Tokens (`api_token_hash_form`, 0016).
    CONSTRAINT modul_pruefsumme_form CHECK (pruefsumme ~ '^[0-9a-f]{64}$'),
    CONSTRAINT modul_eingespielt_von_nicht_leer CHECK (btrim(eingespielt_von) <> ''),
    -- Aktiv und Aktivierungszeitpunkt gehören zusammen: aktiv immer mit Zeitpunkt, inaktiv nie mit einem.
    CONSTRAINT modul_aktiv_seit_passt CHECK (
        (aktiv AND aktiv_seit IS NOT NULL) OR (NOT aktiv AND aktiv_seit IS NULL)
    )
);

-- Höchstens eine aktive Version je Kennung.
CREATE UNIQUE INDEX "modul_eine_aktive_je_kennung" ON "cockpit"."modul" (kennung) WHERE aktiv;

-- Unveränderlich nach dem Einspielen (Muster aus 0016 `api_token_pruefen`): nur `aktiv`/`aktiv_seit`
-- dürfen sich noch ändern, beim Wechsel der aktiven Version. Für alles andere gibt es eine neue Zeile.
CREATE FUNCTION "cockpit"."modul_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."kennung" IS DISTINCT FROM OLD."kennung"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."block" IS DISTINCT FROM OLD."block"
       OR NEW."block_roh" IS DISTINCT FROM OLD."block_roh"
       OR NEW."pruefsumme" IS DISTINCT FROM OLD."pruefsumme"
       OR NEW."herkunft" IS DISTINCT FROM OLD."herkunft"
       OR NEW."eingespielt_am" IS DISTINCT FROM OLD."eingespielt_am"
       OR NEW."eingespielt_von" IS DISTINCT FROM OLD."eingespielt_von"
    THEN
        RAISE EXCEPTION 'modul_unveraenderlich: Eine eingespielte Version aendert sich nicht; eine neue Version kommt als neue Zeile';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "modul_unveraenderlich"
    BEFORE UPDATE ON "cockpit"."modul"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."modul_pruefen"();

-- Nie löschen (0025): die Registry ist eine Nachweistabelle wie jede andere.
CREATE TRIGGER "modul_nie_loeschen" BEFORE DELETE ON "cockpit"."modul"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
