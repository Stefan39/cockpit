-- COPI-141: Der Freigabemodus für Updates (Stefan, 13.10.2026). Bisher gibt Stefan jeden Antrag außerhalb des Cockpits
-- frei (Slack-Rückfrage des Admin-Agenten, ADR 13.1). Das bleibt der Standard (`rueckfrage`). Getrennt für das Cockpit
-- und für die Module lässt sich auf `direkt` umschalten: dann gilt die signierte Bestätigung des Betreuers im Cockpit als
-- Freigabe, und der Antrag steht sofort auf `freigegeben`. Ausgeführt wird weiterhin nur vom Admin-Agenten
-- (`docs/adr/0002-freigabe-direkt.md`).
--
--   1. **Die Einstellung** (`cockpit.update_freigabemodus`): nur anhängen wie der Betreuer-Zugriff (0048). Die jüngste
--      Zeile je Bereich gilt, ohne Zeile `rueckfrage`; jede ältere bleibt als Nachweis (nie löschen, 0025).
--   2. **Der Modus am Antrag** (`eingriff.freigabe_modus`): beim Antrag festgeschrieben, danach fest. Ein späterer Wechsel
--      der Einstellung ändert keinen laufenden Antrag. Bestehende Zeilen bekommen `rueckfrage`, so liefen sie.
--   3. **Rückzug nach direkter Freigabe:** ein direkt freigegebener Antrag lässt sich zurückziehen, solange der Agent ihn
--      nicht gestartet hat (`freigegeben → zurueckgezogen`, nur mit `direkt`). Über einen Antrag mit Rückfrage hat Stefan
--      entschieden; dort bleibt die Kante verboten. Die Kette prüft dafür eine eigene Funktion (`eingriff_kette_pruefen`),
--      die die aus 0018 ablöst; die alte bleibt für den Rückweg stehen.

CREATE TABLE "cockpit"."update_freigabemodus" (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bereich      text        NOT NULL,
    modus        text        NOT NULL,
    gesetzt_von  text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    gesetzt_am   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT update_freigabemodus_bereich CHECK (bereich IN ('cockpit', 'module')),
    CONSTRAINT update_freigabemodus_modus CHECK (modus IN ('rueckfrage', 'direkt'))
);

CREATE INDEX "update_freigabemodus_juengste" ON "cockpit"."update_freigabemodus" (bereich, id DESC);

CREATE FUNCTION "cockpit"."update_freigabemodus_bleibt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'update_freigabemodus_bleibt: Ein gesetzter Modus wird nie geaendert, ein neuer Modus ist eine neue Zeile';
END;
$$;

CREATE TRIGGER "update_freigabemodus_nur_neu" BEFORE UPDATE ON "cockpit"."update_freigabemodus"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."update_freigabemodus_bleibt"();

CREATE TRIGGER "update_freigabemodus_nie_loeschen" BEFORE DELETE ON "cockpit"."update_freigabemodus"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

ALTER TABLE "cockpit"."eingriff"
    ADD COLUMN "freigabe_modus" text NOT NULL DEFAULT 'rueckfrage',
    ADD CONSTRAINT "eingriff_freigabe_modus_bekannt" CHECK (freigabe_modus IN ('rueckfrage', 'direkt'));

-- Ein direkt freigegebener und dann zurückgezogener Antrag behält seinen Freigabe-Zeitpunkt (und beim Image die
-- Ziel-Version, die zur Freigabe gehört). Sonst gilt die Regel aus 0018 unverändert.
ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_zeitstempel_passen";
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_zeitstempel_passen" CHECK (
        ((freigegeben_am IS NOT NULL) = (status IN ('freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen'))
            OR (status = 'zurueckgezogen' AND freigabe_modus = 'direkt'))
        AND (laeuft_seit IS NOT NULL) = (status IN ('laeuft', 'erledigt', 'fehlgeschlagen'))
        AND (abgeschlossen_am IS NOT NULL) = (status IN ('erledigt', 'fehlgeschlagen', 'zurueckgezogen'))
    );

-- Die Ziel-Version des Images gehört zur Freigabe: gesetzt genau dann, wenn freigegeben wurde.
ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_ziel_version_passt";
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_ziel_version_passt" CHECK (
        (art = 'modul' AND ziel_version IS NULL)
        OR (art = 'cockpit-image' AND (ziel_version IS NOT NULL) = (freigegeben_am IS NOT NULL))
    );

-- Die Kette mit der sechsten Kante. Dieselben Regeln und Meldungen wie `eingriff_pruefen` (0018), dazu ist der Modus
-- nach dem Antrag fest.
CREATE FUNCTION "cockpit"."eingriff_kette_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    kante text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'beantragt' THEN
            RAISE EXCEPTION 'eingriff_start_status: Ein Eingriff beginnt immer als beantragt, nicht als %', NEW."status";
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(NEW."art", NEW."ziel_digest", NEW."digest_vorher", NEW."beantragt_von", NEW."beantragt_am", NEW."freigabe_modus")
       IS DISTINCT FROM ROW(OLD."art", OLD."ziel_digest", OLD."digest_vorher", OLD."beantragt_von", OLD."beantragt_am", OLD."freigabe_modus")
    THEN
        RAISE EXCEPTION 'eingriff_unveraenderlich: Art, Ziel, Rueckweg, Antragsteller, Antragszeitpunkt und Freigabemodus stehen nach dem Antrag fest';
    END IF;

    IF ROW(NEW."freigegeben_am", NEW."laeuft_seit", NEW."abgeschlossen_am")
       IS DISTINCT FROM ROW(OLD."freigegeben_am", OLD."laeuft_seit", OLD."abgeschlossen_am")
    THEN
        RAISE EXCEPTION 'eingriff_zeitstempel: Die Zeitstempel setzt die Datenbank beim Statuswechsel, nicht der Aufrufer';
    END IF;

    IF NEW."status" = OLD."status" THEN
        RETURN NEW;
    END IF;

    kante := OLD."status" || '>' || NEW."status";
    IF NOT (
        kante = ANY (ARRAY['beantragt>freigegeben', 'beantragt>zurueckgezogen', 'freigegeben>laeuft', 'laeuft>erledigt', 'laeuft>fehlgeschlagen'])
        OR (kante = 'freigegeben>zurueckgezogen' AND NEW."freigabe_modus" = 'direkt')
    ) THEN
        RAISE EXCEPTION 'eingriff_uebergang: % nach % ist kein erlaubter Uebergang', OLD."status", NEW."status";
    END IF;

    IF NEW."status" = 'freigegeben' THEN
        NEW."freigegeben_am" := now();
    ELSIF NEW."status" = 'laeuft' THEN
        NEW."laeuft_seit" := now();
    ELSE
        NEW."abgeschlossen_am" := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER "eingriff_kette" ON "cockpit"."eingriff";
CREATE TRIGGER "eingriff_kette"
    BEFORE INSERT OR UPDATE ON "cockpit"."eingriff"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."eingriff_kette_pruefen"();

INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('update_freigabemodus_geaendert')
ON CONFLICT (art) DO NOTHING;
