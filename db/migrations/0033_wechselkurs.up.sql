-- Epic E6 KI-Verbrauch (COPI-99): der Wechselkurs für eine Summe in Euro.
--
-- Das Verbrauchsprotokoll (0032) hält Kosten in der Währung des Anbieters — Anthropic in USD, IONOS in EUR. Die
-- Auswertung zeigt eine Summe in EUR (Entscheidung Stefan, 30.09.2026). Den Kurs ruft das Cockpit nie selbst ab
-- (ADR: keine eigenen Abrufe nach außen): der tägliche Lauf in n8n meldet den Referenzkurs der EZB über
-- `POST /intern/wechselkurs`.
--
-- Eine Zeile je Tag, in der Schreibweise der EZB: **US-Dollar je 1 Euro** (etwa 1,1712). So steht in der Tabelle, was
-- die Quelle veröffentlicht, ohne Umkehrung beim Melder. Eine erneute Meldung desselben Tages ersetzt den Kurs.
CREATE TABLE "cockpit"."wechselkurs" (
    tag          date          PRIMARY KEY,
    usd_je_eur   numeric(12,6) NOT NULL,
    quelle       text          NOT NULL,
    gemeldet_von text          NOT NULL,
    gemeldet_am  timestamptz   NOT NULL DEFAULT now(),
    -- Grobe Plausibilität: ein Kurs außerhalb ist ein Fehler im Melder (Komma verrutscht, falsches Währungspaar).
    CONSTRAINT wechselkurs_plausibel CHECK (usd_je_eur BETWEEN 0.5 AND 2),
    CONSTRAINT wechselkurs_quelle_laenge CHECK (char_length(quelle) BETWEEN 1 AND 100)
);

CREATE TRIGGER "wechselkurs_nie_loeschen" BEFORE DELETE ON "cockpit"."wechselkurs"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- Der Betrag in Euro zum Kurs des Tages. Fehlt der Kurs eines Tages (Wochenende, Feiertag, Meldung ausgeblieben),
-- gilt der letzte davor. Gibt es gar keinen bis zu diesem Tag, ist das Ergebnis NULL — sichtbar als „ohne Kurs",
-- nie ein geratener Betrag. Euro bleibt Euro; eine unbekannte Währung ergibt NULL.
CREATE FUNCTION "cockpit"."in_eur"(betrag numeric, waehrung text, tag date)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
    SELECT CASE waehrung
        WHEN 'EUR' THEN betrag
        WHEN 'USD' THEN round(betrag / (
            SELECT w.usd_je_eur FROM "cockpit"."wechselkurs" w WHERE w.tag <= in_eur.tag ORDER BY w.tag DESC LIMIT 1
        ), 6)
    END
$$;
