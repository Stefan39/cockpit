-- COPI-134: Der Betreuer sieht die Fachdaten eines Moduls nur, wenn der Kunde es freigibt (Entscheidung Stefan,
-- 09.10.2026). In einer Kundeninstanz ist der Kunde Betriebs-Admin und Verantwortlicher für seine Daten, Stefan der
-- Betreuer. Der Betriebs-Admin setzt je Modul eine Stufe: `aus` (Standard, ohne Zeile), `lesen` oder `entscheiden`
-- (auch übernehmen, freigeben, entscheiden). Module mit `art: betrieb` im Block (Server-Zustand, KI-Verbrauch) sieht
-- der Betreuer immer; für sie gilt diese Tabelle nicht.
--
-- Nur anhängen: die jüngste Zeile je Modul gilt, jede ältere bleibt als Nachweis (nie löschen, 0025). `weg` sagt, wer
-- gesetzt hat: die Oberfläche (dann mit Konto), ein Server-Kommando (`konsole`, für Instanzen ohne Kunden-Admin) oder
-- diese Migration.
CREATE TABLE "cockpit"."modul_betreuer_zugriff" (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    modul_kennung text        NOT NULL,
    stufe         text        NOT NULL,
    weg           text        NOT NULL,
    gesetzt_von   text        REFERENCES "cockpit"."user" ("id"),
    gesetzt_am    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT modul_betreuer_zugriff_modul_form CHECK (modul_kennung ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    CONSTRAINT modul_betreuer_zugriff_stufe CHECK (stufe IN ('aus', 'lesen', 'entscheiden')),
    CONSTRAINT modul_betreuer_zugriff_weg CHECK (weg IN ('oberflaeche', 'konsole', 'migration')),
    CONSTRAINT modul_betreuer_zugriff_konto CHECK ((weg = 'oberflaeche') = (gesetzt_von IS NOT NULL))
);

CREATE INDEX "modul_betreuer_zugriff_juengste" ON "cockpit"."modul_betreuer_zugriff" (modul_kennung, id DESC);

CREATE FUNCTION "cockpit"."modul_betreuer_zugriff_bleibt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'modul_betreuer_zugriff_bleibt: Eine gesetzte Stufe wird nie geaendert, eine neue Stufe ist eine neue Zeile';
END;
$$;

CREATE TRIGGER "modul_betreuer_zugriff_nur_neu" BEFORE UPDATE ON "cockpit"."modul_betreuer_zugriff"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."modul_betreuer_zugriff_bleibt"();

CREATE TRIGGER "modul_betreuer_zugriff_nie_loeschen" BEFORE DELETE ON "cockpit"."modul_betreuer_zugriff"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- Bisheriger Stand: bis hierher sah der Betreuer jedes Modul und durfte darin handeln. Für die Module, die jetzt schon
-- aktiv sind, bleibt das so (Stefans eigene Instanz); eine neue Instanz hat noch keine Module und startet mit `aus`.
INSERT INTO "cockpit"."modul_betreuer_zugriff" (modul_kennung, stufe, weg)
SELECT DISTINCT kennung, 'entscheiden', 'migration' FROM "cockpit"."modul" WHERE aktiv = true ORDER BY kennung;

INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('betreuer_zugriff_geaendert')
ON CONFLICT (art) DO NOTHING;
