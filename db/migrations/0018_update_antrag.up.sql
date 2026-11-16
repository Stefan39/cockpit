-- Epic E3 (COPI-40): Der Update-Antrag aus dem Cockpit.
--
-- Der Betreuer beantragt in den Einstellungen ein Update des Cockpit-Images; das schreibt eine Zeile
-- `cockpit.eingriff` (0015) und einen Protokolleintrag. Freigabe und Ausführung liegen außerhalb des
-- Cockpits (ADR 13.1). Diese Migration ergänzt, was der Antrag dafür braucht:
--
--   1. Einen Endstatus `zurueckgezogen`, erreichbar nur aus `beantragt`: ein Antrag, der noch nicht
--      freigegeben ist, lässt sich zurücknehmen (etwa ein falscher Ziel-Digest). Ein freigegebener nicht
--      mehr — über ihn hat die Freigabe schon entschieden. Wie jeder Abschluss setzt der Rückzug
--      `abgeschlossen_am`; freigegeben und gelaufen ist er nie.
--   2. Höchstens **einen** offenen Antrag je Art (`beantragt`, `freigegeben`, `laeuft`), auch mit
--      anderem Ziel. So stehen für den Admin-Agenten nie zwei Updates des Cockpits zugleich an, und ein
--      doppelt abgeschickter Antrag scheitert an der Datenbank, nicht erst an der Anwendung. Mit den
--      Modulen (E5) kommt die Art `modul`; dann gilt die Regel je Modul (eigene Migration).
--   3. Die Protokollarten `update_beantragt` und `update_zurueckgezogen`. Im Eintrag steht nur die
--      Nummer des Antrags; die Digests stehen unveränderlich in dessen Zeile.

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_status_bekannt";

ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_status_bekannt" CHECK (
        status IN ('beantragt', 'freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen', 'zurueckgezogen')
    );

ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_zeitstempel_passen";

-- Dieselbe Regel wie in 0015, anders geschrieben und um den Rückzug ergänzt: jeder Zeitstempel ist genau dann
-- gesetzt, wenn der Antrag diese Stufe erreicht hat. Ein zurückgezogener ist abgeschlossen, aber nie freigegeben
-- und nie gelaufen.
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_zeitstempel_passen" CHECK (
        (freigegeben_am IS NOT NULL) = (status IN ('freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen'))
        AND (laeuft_seit IS NOT NULL) = (status IN ('laeuft', 'erledigt', 'fehlgeschlagen'))
        AND (abgeschlossen_am IS NOT NULL) = (status IN ('erledigt', 'fehlgeschlagen', 'zurueckgezogen'))
    );

-- Die Regeln der Kette aus 0015, mit der fünften Kante `beantragt → zurueckgezogen`. Alles andere
-- bleibt: Start immer als `beantragt`, Art/Ziel/Rückweg/Antragsteller/Antragszeitpunkt fest,
-- Zeitstempel nur von der Datenbank, ein Wechsel auf den bisherigen Status ist ein Nichtstun.
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

    IF (NEW."art", NEW."ziel_digest", NEW."digest_vorher", NEW."beantragt_von", NEW."beantragt_am")
       IS DISTINCT FROM (OLD."art", OLD."ziel_digest", OLD."digest_vorher", OLD."beantragt_von", OLD."beantragt_am")
    THEN
        RAISE EXCEPTION 'eingriff_unveraenderlich: Art, Ziel, Rueckweg, Antragsteller und Antragszeitpunkt stehen nach dem Antrag fest';
    END IF;

    IF (NEW."freigegeben_am", NEW."laeuft_seit", NEW."abgeschlossen_am")
       IS DISTINCT FROM (OLD."freigegeben_am", OLD."laeuft_seit", OLD."abgeschlossen_am")
    THEN
        RAISE EXCEPTION 'eingriff_zeitstempel: Die Zeitstempel setzt die Datenbank beim Statuswechsel, nicht der Aufrufer';
    END IF;

    IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
        RETURN NEW;
    END IF;

    IF (OLD."status", NEW."status") NOT IN (
        ('beantragt', 'freigegeben'),
        ('beantragt', 'zurueckgezogen'),
        ('freigegeben', 'laeuft'),
        ('laeuft', 'erledigt'),
        ('laeuft', 'fehlgeschlagen')
    ) THEN
        RAISE EXCEPTION 'eingriff_uebergang: % nach % ist kein erlaubter Uebergang', OLD."status", NEW."status";
    END IF;

    CASE NEW."status"
        WHEN 'freigegeben' THEN NEW."freigegeben_am" := now();
        WHEN 'laeuft' THEN NEW."laeuft_seit" := now();
        -- erledigt, fehlgeschlagen, zurueckgezogen: der Abschluss
        ELSE NEW."abgeschlossen_am" := now();
    END CASE;

    RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX "eingriff_ein_offener_antrag"
    ON "cockpit"."eingriff" (art)
    WHERE status IN ('beantragt', 'freigegeben', 'laeuft');

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
        'api_zugriff_abgelehnt',
        'update_beantragt',
        'update_zurueckgezogen'
    ));
