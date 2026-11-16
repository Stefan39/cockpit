-- Epic E6 KI-Verbrauch (COPI-98): die Tageswerte — das Verbrauchsprotokoll (0032) verdichtet je Tag, Projekt, Ticket,
-- Modell, Quelle und Qualität. Grundlage der Modulseite, der Karte auf der Übersicht und der Summen je Ticket.
--
-- **Mitgeführt, nicht nachts gerechnet** (Entscheidung Stefan, 30.09.2026): das Cockpit hat keinen Scheduler. Jede
-- Meldung rechnet die Tage neu, die sie berührt — in derselben Transaktion, per Trigger. So sind die Tageswerte immer
-- aktuell, und eine nachgelieferte oder ersetzte Meldung ändert auch einen älteren Tag richtig.
--
-- **Ausnahme von „nie löschen" (0025):** diese Tabelle ist abgeleitet, kein Nachweis. Ihre Zeilen werden je Tag
-- verworfen und neu geschrieben; der Nachweis ist `cockpit.verbrauch`, und dort wird nie gelöscht. Deshalb trägt sie
-- bewusst keine Sperre gegen DELETE (Entscheidung Stefan, 30.09.2026).
--
-- Der Tag ist der Berliner Kalendertag des Einsatzes. Kosten stehen in der Währung des Anbieters (eine Zeile je
-- Währung); in Euro wird erst beim Lesen umgerechnet (`cockpit.in_eur`, 0033) — der Kurs eines Tages gilt für alle
-- seine Einsätze, die Summe eines Tages lässt sich also als Ganzes umrechnen. `waehrung` NULL heißt: ohne Preis.
CREATE TABLE "cockpit"."verbrauch_tag" (
    tag                       date          NOT NULL,
    jira_projekt              text,
    ticket                    text,
    modell                    text          NOT NULL,
    quelle                    text          NOT NULL,
    qualitaet                 text          NOT NULL,
    waehrung                  text,
    einsaetze                 integer       NOT NULL,
    tokens_eingabe            bigint        NOT NULL,
    tokens_ausgabe            bigint        NOT NULL,
    tokens_cache_schreiben_5m bigint        NOT NULL,
    tokens_cache_schreiben_1h bigint        NOT NULL,
    tokens_cache_lesen        bigint        NOT NULL,
    kosten                    numeric(18,6),
    CONSTRAINT verbrauch_tag_kosten_mit_waehrung CHECK ((waehrung IS NULL) = (kosten IS NULL))
);

CREATE INDEX "verbrauch_tag_tag" ON "cockpit"."verbrauch_tag" (tag);
CREATE INDEX "verbrauch_tag_ticket" ON "cockpit"."verbrauch_tag" (ticket) WHERE ticket IS NOT NULL;

-- Rechnet die genannten Tage neu aus dem Protokoll. Wiederholbar: das Ergebnis hängt nur vom Protokoll ab. Die Sperre
-- reiht gleichzeitige Meldungen auf — sonst rechnete jede ohne die noch nicht bestätigten Einträge der anderen.
CREATE FUNCTION "cockpit"."verbrauch_tage_verdichten"(tage date[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('cockpit.verbrauch_tag'));
    DELETE FROM "cockpit"."verbrauch_tag" WHERE tag = ANY (tage);
    INSERT INTO "cockpit"."verbrauch_tag"
        (tag, jira_projekt, ticket, modell, quelle, qualitaet, waehrung, einsaetze, tokens_eingabe, tokens_ausgabe,
         tokens_cache_schreiben_5m, tokens_cache_schreiben_1h, tokens_cache_lesen, kosten)
    SELECT (v.zeitpunkt AT TIME ZONE 'Europe/Berlin')::date, v.jira_projekt, v.ticket, v.modell, v.quelle, v.qualitaet,
           v.waehrung, count(*), sum(v.tokens_eingabe), sum(v.tokens_ausgabe), sum(v.tokens_cache_schreiben_5m),
           sum(v.tokens_cache_schreiben_1h), sum(v.tokens_cache_lesen), sum(v.kosten)
      FROM "cockpit"."verbrauch" v
           -- Der Bereich nutzt den Index auf `zeitpunkt`; die genaue Auswahl trifft der Tag.
     WHERE v.zeitpunkt >= (SELECT min(t) FROM unnest(tage) AS t)::timestamp AT TIME ZONE 'Europe/Berlin'
       AND v.zeitpunkt < ((SELECT max(t) FROM unnest(tage) AS t) + 1)::timestamp AT TIME ZONE 'Europe/Berlin'
       AND (v.zeitpunkt AT TIME ZONE 'Europe/Berlin')::date = ANY (tage)
     GROUP BY 1, 2, 3, 4, 5, 6, 7;
END;
$$;

-- Nach jeder Anweisung am Protokoll: die Tage der neuen Zeilen, bei einer Änderung auch die der alten (eine ersetzte
-- Meldung kann ihren Tag wechseln). Die Übergangstabelle `alt` gibt es nur beim UPDATE.
CREATE FUNCTION "cockpit"."verbrauch_tage_nachfuehren"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    tage date[];
BEGIN
    IF TG_OP = 'UPDATE' THEN
        SELECT array_agg(DISTINCT (z.zeitpunkt AT TIME ZONE 'Europe/Berlin')::date) INTO tage
          FROM (SELECT zeitpunkt FROM alt UNION ALL SELECT zeitpunkt FROM neu) z;
    ELSE
        SELECT array_agg(DISTINCT (zeitpunkt AT TIME ZONE 'Europe/Berlin')::date) INTO tage FROM neu;
    END IF;
    IF tage IS NOT NULL THEN
        PERFORM "cockpit"."verbrauch_tage_verdichten"(tage);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "verbrauch_tage_neu" AFTER INSERT ON "cockpit"."verbrauch"
    REFERENCING NEW TABLE AS neu
    FOR EACH STATEMENT EXECUTE FUNCTION "cockpit"."verbrauch_tage_nachfuehren"();

CREATE TRIGGER "verbrauch_tage_geaendert" AFTER UPDATE ON "cockpit"."verbrauch"
    REFERENCING OLD TABLE AS alt NEW TABLE AS neu
    FOR EACH STATEMENT EXECUTE FUNCTION "cockpit"."verbrauch_tage_nachfuehren"();

-- Was schon im Protokoll steht (seit 0032), einmal verdichten.
SELECT "cockpit"."verbrauch_tage_verdichten"(array_agg(DISTINCT (zeitpunkt AT TIME ZONE 'Europe/Berlin')::date))
  FROM "cockpit"."verbrauch"
HAVING count(*) > 0;

-- Das Recht der Agenten-API, die Summen je Ticket zu lesen — für den täglichen Abgleich mit Jira (Regel aus 0016: ein
-- neues Recht kommt mit dem Ticket, das es braucht). In einem Befehl ersetzt, damit die Bedingung nie fehlt.
ALTER TABLE "cockpit"."api_token"
    DROP CONSTRAINT "api_token_scopes_bekannt",
    ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen', 'verbrauch_schreiben', 'verbrauch_lesen']::text[]
    );
