-- Epic E3 (COPI-41): Der Lebenszyklus eines Eingriffs — was der Admin-Agent weiterschaltet, und woran das Cockpit
-- selbst erkennt, dass ein Update gelungen ist.
--
-- Die Kette bleibt die aus 0015 und 0018 (`beantragt → freigegeben → laeuft → erledigt | fehlgeschlagen`, dazu
-- `beantragt → zurueckgezogen`), geprüft vom Trigger `eingriff_kette`. Diese Migration ergänzt zwei Regeln, die an der
-- Freigabe und am Erfolgsbeleg hängen, in einem **eigenen** Trigger `eingriff_lebenszyklus`. Er läuft nach der Kette
-- (Postgres ruft Trigger gleicher Art in der Reihenfolge ihrer Namen auf), sieht also nur Übergänge, die sie erlaubt.
--
--   1. **Die Ziel-Version.** Der Antrag (COPI-40) nennt nur den Ziel-Digest. Erfolg heißt laut ADR 13.1 (Fußnote vom
--      21.09.2026, `docs/adr/0001-digest-aus-der-umgebung.md`): ein Cockpit mit dem Ziel-Digest hat sich gemeldet, **und
--      die gebackene Version passt zum Antrag**. Die Version nennt der Admin-Agent mit der Freigabe, zusammen mit
--      Vorgangs-ID und Ziel-Digest — er kennt sie aus derselben Quelle wie die Änderungsnotiz, die er Stefan schickt.
--      Sie steht genau ab `freigegeben` in der Zeile und danach fest.
--
--      Warum die Version überhaupt zählt, wenn der Digest ein Image eindeutig benennt: der Digest der Selbstmeldung
--      kommt aus der Umgebung (`COCKPIT_IMAGE_DIGEST`), nicht aus dem Image. Wird beim Update nur diese Zeile der
--      Compose-Datei ersetzt und die `image:`-Zeile vergessen, meldet das **alte** Image den **neuen** Digest. Die
--      Version ist ins Image gebacken und verrät das.
--
--      Form: SemVer 2.0 ohne Build-Metadaten (`1.4.0`, `1.4.0-rc.1`), wie das Git-Tag des Release. Verglichen wird mit
--      dem Teil der Selbstmeldung vor dem `+` (`1.4.0+0123456` → `1.4.0`); den Commit hängt das Cockpit selbst an.
--
--   2. **Erledigt nur mit Beleg.** `laeuft → erledigt` gilt nur, wenn `cockpit.instanz` genau diesen Ziel-Digest und
--      diese Ziel-Version meldet. Das setzt das Cockpit beim Start selbst, in derselben Transaktion wie seine
--      Selbstmeldung (`src/status/instanz-speicher.ts`); die Agenten-API kennt keinen Weg dorthin. Die Regel steht
--      trotzdem hier: ein späterer Fehler in einer Route soll ein Update nicht als gelungen ausgeben können, das nie
--      lief (wie bei 0015: die Freigabe ist sonst wertlos).
--
-- Dazu die Protokollarten der vier Übergänge (seit 0019 eine Zeile je Art). Im Eintrag steht nur die Nummer des
-- Eingriffs; Digests und Version stehen unveränderlich in dessen Zeile.
--
-- Bestehende Zeilen: vor COPI-41 gab es keinen Weg über `beantragt` hinaus (nur `zurueckgezogen`). Hat jemand eine
-- Zeile von Hand weitergeschaltet, scheitert diese Migration an `eingriff_ziel_version_passt` — laut, statt eine
-- Freigabe ohne Version stehen zu lassen.

ALTER TABLE "cockpit"."eingriff" ADD COLUMN "ziel_version" text;

-- Dieselbe SemVer-Form wie `ZIEL_VERSION_FORM` in `src/status/eingriff.ts`, höchstens 64 Zeichen.
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_ziel_version_form" CHECK (
        ziel_version IS NULL
        OR (
            char_length(ziel_version) <= 64
            AND ziel_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
        )
    );

-- Genau ab der Freigabe gibt es eine Ziel-Version: ein zurückgezogener Antrag wurde nie freigegeben.
ALTER TABLE "cockpit"."eingriff"
    ADD CONSTRAINT "eingriff_ziel_version_passt" CHECK (
        (ziel_version IS NOT NULL) = (status IN ('freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen'))
    );

CREATE FUNCTION "cockpit"."eingriff_lebenszyklus_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."ziel_version" IS DISTINCT FROM OLD."ziel_version"
       AND NOT (OLD."status" = 'beantragt' AND NEW."status" = 'freigegeben')
    THEN
        RAISE EXCEPTION 'eingriff_ziel_version: Die Ziel-Version wird mit der Freigabe genannt und steht danach fest';
    END IF;

    IF OLD."status" = 'laeuft' AND NEW."status" = 'erledigt' AND NOT EXISTS (
        SELECT 1
          FROM "cockpit"."instanz" i
         WHERE i."digest" = NEW."ziel_digest"
           AND split_part(i."version", '+', 1) = NEW."ziel_version"
    ) THEN
        RAISE EXCEPTION 'eingriff_ohne_beleg: Erledigt ist ein Eingriff erst, wenn sich ein Cockpit mit Ziel-Digest und Ziel-Version gemeldet hat';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "eingriff_lebenszyklus"
    BEFORE UPDATE ON "cockpit"."eingriff"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."eingriff_lebenszyklus_pruefen"();

-- `ON CONFLICT`: eine Art, die beim Zurücknehmen stehen blieb, weil ein Eintrag sie nutzt, ist schon da (0019).
INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('update_freigegeben'), ('update_gestartet'), ('update_erledigt'), ('update_fehlgeschlagen')
ON CONFLICT (art) DO NOTHING;
