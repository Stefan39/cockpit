-- Nimmt 0018 zurück: kein Rückzug mehr, keine Regel „höchstens ein offener Antrag", keine
-- Protokollarten des Update-Antrags.
--
-- Zurückgezogene Anträge bleiben stehen, wie Protokolleinträge mit den neuen Arten (das Protokoll lässt
-- sich nicht bereinigen, 0009): Ein Antrag ist ein Nachweis, kein Zwischenstand. Die alten Bedingungen
-- gelten deshalb `NOT VALID` und prüfen nur neue und geänderte Zeilen (Muster aus 0010, 0014 und 0016).

DROP INDEX "cockpit"."eingriff_ein_offener_antrag";

-- Die Kette aus 0015: vier Kanten, kein Rückzug.
CREATE OR REPLACE FUNCTION "cockpit"."eingriff_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'beantragt' THEN
            RAISE EXCEPTION 'eingriff_start_status: Ein Eingriff beginnt immer als beantragt, nicht als %', NEW."status";
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."art" IS DISTINCT FROM OLD."art"
       OR NEW."ziel_digest" IS DISTINCT FROM OLD."ziel_digest"
       OR NEW."digest_vorher" IS DISTINCT FROM OLD."digest_vorher"
       OR NEW."beantragt_von" IS DISTINCT FROM OLD."beantragt_von"
       OR NEW."beantragt_am" IS DISTINCT FROM OLD."beantragt_am"
    THEN
        RAISE EXCEPTION 'eingriff_unveraenderlich: Art, Ziel, Rueckweg, Antragsteller und Antragszeitpunkt stehen nach dem Antrag fest';
    END IF;

    IF NEW."freigegeben_am" IS DISTINCT FROM OLD."freigegeben_am"
       OR NEW."laeuft_seit" IS DISTINCT FROM OLD."laeuft_seit"
       OR NEW."abgeschlossen_am" IS DISTINCT FROM OLD."abgeschlossen_am"
    THEN
        RAISE EXCEPTION 'eingriff_zeitstempel: Die Zeitstempel setzt die Datenbank beim Statuswechsel, nicht der Aufrufer';
    END IF;

    IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
        RETURN NEW;
    END IF;

    IF (OLD."status", NEW."status") NOT IN (
        ('beantragt', 'freigegeben'),
        ('freigegeben', 'laeuft'),
        ('laeuft', 'erledigt'),
        ('laeuft', 'fehlgeschlagen')
    ) THEN
        RAISE EXCEPTION 'eingriff_uebergang: % nach % ist kein erlaubter Uebergang', OLD."status", NEW."status";
    END IF;

    CASE NEW."status"
        WHEN 'freigegeben' THEN NEW."freigegeben_am" := now();
        WHEN 'laeuft' THEN NEW."laeuft_seit" := now();
        ELSE NEW."abgeschlossen_am" := now();
    END CASE;

    RETURN NEW;
END;
$$;

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_zeitstempel_passen";

-- Die Regel aus 0015 (in der Schreibweise von 0018 up): ohne Rückzug.
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_zeitstempel_passen" CHECK (
        status IN ('beantragt', 'freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen')
        AND (freigegeben_am IS NOT NULL) = (status <> 'beantragt')
        AND (laeuft_seit IS NOT NULL) = (status IN ('laeuft', 'erledigt', 'fehlgeschlagen'))
        AND (abgeschlossen_am IS NOT NULL) = (status IN ('erledigt', 'fehlgeschlagen'))
    ) NOT VALID;

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_status_bekannt";

ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_status_bekannt" CHECK (
        status IN ('beantragt', 'freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen')
    ) NOT VALID;

ALTER TABLE "cockpit"."protokoll" DROP CONSTRAINT "protokoll_art_bekannt";

ALTER TABLE "cockpit"."protokoll"
    ADD CONSTRAINT "protokoll_art_bekannt" CHECK (art IN (
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
        'betreuer_uebergeben',
        'erststart_token_erzeugt',
        'konto_entsperrt',
        'zugang_wiederhergestellt',
        'api_token_erzeugt',
        'api_token_widerrufen',
        'api_zugriff_abgelehnt'
    )) NOT VALID;
