-- Epic E3 (COPI-34): Das Schema des Zustandsbilds — Befunde, Herzschlag der Wachen, Inventar der
-- Agenten, die Instanz selbst und der Eingriff (Update-Antrag).
--
-- Das Cockpit prüft nichts selbst (Architektur-Vorschlag 4). Diese Tabellen nehmen auf, was der
-- Admin-Agent meldet, und halten fest, was das Cockpit beantragt. Sie sind der Vertrag zwischen
-- beiden Seiten; die Regeln stehen deshalb in der Datenbank und nicht nur in einer Route: ein
-- späterer Fehler im Anwendungscode soll sie nicht aufweichen können (wie bei 0008 und 0009).
--
-- Ohne Fremdschlüssel auf `user`, wie beim Protokoll (0009): `beantragt_von` ist die Konto-ID
-- als Kennung. Ein verfallenes oder gelöschtes Konto lässt seine Anträge stehen.
--
-- Wächter und Agenten heißen in Kleinbuchstaben, Ziffern und `_ . -` (höchstens 63 Zeichen).
-- Das sind Kennungen für Maschinen (Schlüssel im Protokoll, in URLs und im YAML des Agenten-
-- Repos), keine Anzeigenamen — die Betriebssprache steht in den Texten, nicht in der Kennung.

-- 1. Wache: der Herzschlag. „Zuletzt geprüft vor 2 Std." statt eines falschen „alles grün"
--    (ADR 4). `letzter_lauf` ist NULL, solange die Wache noch nie gemeldet hat — ein erfundener
--    Anfangszeitpunkt würde „noch nie" als „gerade eben" ausgeben. Ob eine Wache überfällig ist,
--    berechnet die Anwendung beim Lesen aus Takt und letztem Lauf; das Cockpit hat keinen
--    Scheduler und prüft nichts selbst.
CREATE TABLE "cockpit"."wache" (
    kennung       text        PRIMARY KEY,
    takt_sekunden integer     NOT NULL,
    letzter_lauf  timestamptz,
    angelegt_am   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wache_kennung_form  CHECK (kennung ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
    CONSTRAINT wache_takt_positiv  CHECK (takt_sekunden > 0)
);

-- 2. Befund: eine Meldung einer Wache. Die Zeilen bleiben stehen; die Aufbewahrungsfrist regelt
--    E7 (Betrieb), nicht dieses Schema.
--
--    `kundensichtbar` ist per Default `false` (ADR 4 und 10): Rohbefunde gehen nie direkt an den
--    Kunden. Ein Befund darf nur sichtbar werden, wenn er einen Klartext für den Kunden trägt —
--    das Cockpit übersetzt nichts selbst, es zeigt dem Kunden ausschließlich `text_kunde` und nie
--    `text_intern`. Ein sichtbarer Befund ohne Klartext hätte nichts, was man zeigen dürfte.
CREATE TABLE "cockpit"."befund" (
    id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wache          text        NOT NULL,
    status         text        NOT NULL,
    text_intern    text        NOT NULL,
    text_kunde     text,
    kundensichtbar boolean     NOT NULL DEFAULT false,
    -- Wer gemeldet hat: Kennung des Agenten bzw. des API-Zugangs (COPI-35).
    quelle         text        NOT NULL,
    gemeldet_am    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT befund_wache_bekannt FOREIGN KEY (wache) REFERENCES "cockpit"."wache" (kennung),
    CONSTRAINT befund_status_bekannt CHECK (status IN ('gruen', 'gelb', 'rot')),
    CONSTRAINT befund_kundentext_noetig CHECK (
        NOT kundensichtbar OR (text_kunde IS NOT NULL AND btrim(text_kunde) <> '')
    )
);

-- Der jüngste Befund je Wache ist die häufigste Frage.
CREATE INDEX "befund_wache_gemeldet" ON "cockpit"."befund" (wache, gemeldet_am DESC);

-- 3. Agent: das Inventar, das der Admin-Agent liefert (Rolle, Version, Grenzen, Zeitplan). Das
--    Cockpit liest nie die YAML des Agenten-Repos und fragt GHCR nie selbst (ADR 4, 13.1); es
--    zeigt, was ihm gemeldet wurde. Jeder Agent steht einmal da — ein neues Inventar überschreibt.
CREATE TABLE "cockpit"."agent" (
    kennung         text        PRIMARY KEY,
    rolle           text        NOT NULL,
    version         text        NOT NULL,
    grenzen         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    zeitplan        jsonb       NOT NULL DEFAULT '[]'::jsonb,
    aktualisiert_am timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_kennung_form        CHECK (kennung ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
    CONSTRAINT agent_rolle_nicht_leer    CHECK (btrim(rolle) <> ''),
    CONSTRAINT agent_version_nicht_leer  CHECK (btrim(version) <> ''),
    CONSTRAINT agent_grenzen_objekt      CHECK (jsonb_typeof(grenzen) = 'object'),
    CONSTRAINT agent_zeitplan_liste      CHECK (jsonb_typeof(zeitplan) = 'array')
);

-- 4. Instanz: genau eine Zeile, die das laufende Cockpit selbst schreibt (COPI-39). Der Digest
--    stammt aus der Umgebung des Containers (`COCKPIT_IMAGE_DIGEST`): ein Image kann seinen
--    eigenen Digest nicht enthalten, er ist ein Hash über den Inhalt. Lokal gibt es keinen, dann
--    ist er NULL. Ein Digest ist immer ein vollständiger `sha256:`-Wert, nie ein bewegliches Tag.
--
--    `id` ist immer `true`: der Primärschlüssel lässt keine zweite Zeile zu, der CHECK keine
--    andere Kennung.
CREATE TABLE "cockpit"."instanz" (
    id           boolean     PRIMARY KEY DEFAULT true,
    version      text        NOT NULL,
    digest       text,
    gestartet_am timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT instanz_genau_eine_zeile  CHECK (id),
    CONSTRAINT instanz_version_nicht_leer CHECK (btrim(version) <> ''),
    CONSTRAINT instanz_digest_form       CHECK (digest IS NULL OR digest ~ '^sha256:[0-9a-f]{64}$')
);

-- 5. Eingriff: der Antrag. „Das Cockpit aktualisiert nichts. Es beantragt." (ADR 13.1) Ein Update
--    ist eine Zeile, die der Admin-Agent nach Stefans Freigabe außerhalb des Cockpits abarbeitet.
--
--    Die Kette ist `beantragt → freigegeben → laeuft → erledigt | fehlgeschlagen`. „haengt" (länger
--    als 15 Minuten in `laeuft`) wird nie gespeichert, sondern beim Lesen abgeleitet.
--
--    In E3 gibt es nur die Art `cockpit-image`. `modul` kommt mit der Modul-Registry (E5) und
--    erweitert diese Bedingung in einer eigenen Migration.
--
--    `digest_vorher` steht in derselben Zeile wie das Ziel: der Weg zurück ist ein Befehl, keine
--    Recherche (ADR 13.1). Deshalb gibt es keinen Antrag ohne ihn.
CREATE TABLE "cockpit"."eingriff" (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    art             text        NOT NULL,
    ziel_digest     text        NOT NULL,
    digest_vorher   text        NOT NULL,
    -- Konto-ID des Betreuers, der beantragt hat (keine Adresse; siehe oben).
    beantragt_von   text        NOT NULL,
    status          text        NOT NULL DEFAULT 'beantragt',
    beantragt_am    timestamptz NOT NULL DEFAULT now(),
    -- Je Übergang ein Zeitstempel. Die setzt die Datenbank (`eingriff_pruefen`), nicht der Aufrufer.
    freigegeben_am  timestamptz,
    laeuft_seit     timestamptz,
    abgeschlossen_am timestamptz,
    CONSTRAINT eingriff_art_bekannt              CHECK (art IN ('cockpit-image')),
    CONSTRAINT eingriff_ziel_digest_form         CHECK (ziel_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT eingriff_digest_vorher_form       CHECK (digest_vorher ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT eingriff_beantragt_von_nicht_leer CHECK (btrim(beantragt_von) <> ''),
    CONSTRAINT eingriff_status_bekannt           CHECK (
        status IN ('beantragt', 'freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen')
    ),
    -- Status und Zeitstempel gehören zusammen: wer „laeuft" ist, wurde freigegeben und hat einen
    -- Beginn; wer abgeschlossen ist, hat alle drei. Das hält auch ein direktes INSERT ehrlich.
    CONSTRAINT eingriff_zeitstempel_passen CHECK (
        (status = 'beantragt'
            AND freigegeben_am IS NULL AND laeuft_seit IS NULL AND abgeschlossen_am IS NULL)
        OR (status = 'freigegeben'
            AND freigegeben_am IS NOT NULL AND laeuft_seit IS NULL AND abgeschlossen_am IS NULL)
        OR (status = 'laeuft'
            AND freigegeben_am IS NOT NULL AND laeuft_seit IS NOT NULL AND abgeschlossen_am IS NULL)
        OR (status IN ('erledigt', 'fehlgeschlagen')
            AND freigegeben_am IS NOT NULL AND laeuft_seit IS NOT NULL AND abgeschlossen_am IS NOT NULL)
    )
);

-- Die Regeln der Kette. Sie sitzen in der Datenbank, weil an ihnen die Freigabe hängt: sie lautet
-- auf Vorgangs-ID und Ziel-Digest (ADR 13.1). Ließe sich der Ziel-Digest nach dem Antrag ändern
-- oder die Kette überspringen, wäre die Freigabe wertlos.
--
--   * Ein Eingriff beginnt immer als `beantragt`.
--   * Art, Ziel, Rückweg, Antragsteller und Antragszeitpunkt stehen nach dem Antrag fest.
--   * Erlaubt sind nur die vier Kanten der Kette. Ein Wechsel auf den bisherigen Status ist ein
--     Nichtstun und wird hingenommen (eine wiederholte Meldung soll nichts verändern, aber auch
--     nicht scheitern); ob die Anwendung daraus einen Konflikt macht, entscheidet sie selbst.
--   * Die Zeitstempel setzt die Datenbank beim Übergang. Wer sie von Hand mitgibt, wird abgelehnt
--     — nicht stillschweigend überschrieben, damit ein Fehler im Aufrufer auffällt.
CREATE FUNCTION "cockpit"."eingriff_pruefen"()
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

CREATE TRIGGER "eingriff_kette"
    BEFORE INSERT OR UPDATE ON "cockpit"."eingriff"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."eingriff_pruefen"();
