-- Epic E6 KI-Verbrauch (COPI-97): das Verbrauchsprotokoll und die versionierte Preistabelle.
--
-- Werkzeuge und Agenten melden über `POST /intern/verbrauch`, welches Modell mit wie vielen Tokens gearbeitet hat — eine
-- Zeile je Einsatz (Nachricht, Lauf). Die Kosten rechnet die Datenbank selbst aus der Preistabelle, beim Eintragen und
-- bei jeder Änderung der Zeile: so stimmen Tokens, Preis und Kosten immer überein, und eine Neuberechnung ist ein
-- `UPDATE` ohne eigene Rechenlogik im Anwendungscode.

-- 1. Die Preistabelle. Ein Preis je Tokenart, in der Währung des Anbieters und je **eine Million** Tokens — so, wie die
--    Anbieter ihn veröffentlichen. Bewusst absolute Preise statt Faktoren: Cache-Lesen ist je nach Modell das 0,1-,
--    0,05- oder 0,025-fache des Eingabepreises. Ein Preiswechsel ist eine neue Zeile mit neuem `gueltig_ab`; die alte
--    bekommt ihr `gueltig_bis` und bleibt stehen (nie löschen, 0025).
CREATE TABLE "cockpit"."preis" (
    id                 bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    modell             text          NOT NULL,
    waehrung           text          NOT NULL,
    eingabe            numeric(12,6) NOT NULL,
    ausgabe            numeric(12,6) NOT NULL,
    cache_schreiben_5m numeric(12,6) NOT NULL,
    cache_schreiben_1h numeric(12,6) NOT NULL,
    cache_lesen        numeric(12,6) NOT NULL,
    gueltig_ab         timestamptz   NOT NULL,
    gueltig_bis        timestamptz,
    quelle             text          NOT NULL,
    geprueft_am        date          NOT NULL,
    CONSTRAINT preis_modell_form CHECK (modell ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$'),
    CONSTRAINT preis_waehrung_bekannt CHECK (waehrung IN ('USD', 'EUR')),
    CONSTRAINT preis_nicht_negativ CHECK (
        eingabe >= 0 AND ausgabe >= 0 AND cache_schreiben_5m >= 0 AND cache_schreiben_1h >= 0 AND cache_lesen >= 0
    ),
    CONSTRAINT preis_gueltigkeit CHECK (gueltig_bis IS NULL OR gueltig_bis > gueltig_ab),
    CONSTRAINT preis_quelle_laenge CHECK (char_length(quelle) BETWEEN 1 AND 300),
    CONSTRAINT preis_modell_ab_eindeutig UNIQUE (modell, gueltig_ab)
);

CREATE TRIGGER "preis_nie_loeschen" BEFORE DELETE ON "cockpit"."preis"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- 2. Das Protokoll. `schluessel` macht die Meldung idempotent: dieselbe Nachricht ein zweites Mal ersetzt ihre Zeile.
--    `zeitpunkt` ist der Zeitpunkt des Einsatzes (vom Melder, er liefert aus einem Puffer nach), `gemeldet_am` der der
--    jüngsten Meldung (vom Cockpit). `preis_id`, `kosten` und `waehrung` setzt nur der Trigger unten.
CREATE TABLE "cockpit"."verbrauch" (
    id                        bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schluessel                text          NOT NULL,
    zeitpunkt                 timestamptz   NOT NULL,
    quelle                    text          NOT NULL,
    modell                    text          NOT NULL,
    ticket                    text,
    jira_projekt              text,
    sitzung                   text,
    qualitaet                 text          NOT NULL DEFAULT 'gemessen',
    zuordnung                 text          NOT NULL DEFAULT 'keine',
    subagent                  boolean       NOT NULL DEFAULT false,
    tokens_eingabe            bigint        NOT NULL,
    tokens_ausgabe            bigint        NOT NULL,
    tokens_cache_schreiben_5m bigint        NOT NULL,
    tokens_cache_schreiben_1h bigint        NOT NULL,
    tokens_cache_lesen        bigint        NOT NULL,
    preis_id                  bigint        REFERENCES "cockpit"."preis" ("id"),
    kosten                    numeric(16,6),
    waehrung                  text,
    gemeldet_von              text          NOT NULL,
    gemeldet_am               timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT verbrauch_schluessel_eindeutig UNIQUE (schluessel),
    CONSTRAINT verbrauch_schluessel_form CHECK (schluessel ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$'),
    CONSTRAINT verbrauch_quelle_bekannt CHECK (quelle IN ('cowork', 'claude-code', 'n8n')),
    CONSTRAINT verbrauch_modell_form CHECK (modell ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$'),
    CONSTRAINT verbrauch_ticket_form CHECK (ticket IS NULL OR ticket ~ '^[A-Z][A-Z0-9]{1,19}-[0-9]{1,9}$'),
    CONSTRAINT verbrauch_projekt_form CHECK (jira_projekt IS NULL OR jira_projekt ~ '^[A-Z][A-Z0-9]{1,19}$'),
    -- Ein Ticket gehört zu seinem Projekt: `JAC-630` nie unter `COPI`.
    CONSTRAINT verbrauch_ticket_im_projekt CHECK (ticket IS NULL OR jira_projekt = split_part(ticket, '-', 1)),
    CONSTRAINT verbrauch_sitzung_laenge CHECK (sitzung IS NULL OR char_length(sitzung) BETWEEN 1 AND 200),
    CONSTRAINT verbrauch_qualitaet_bekannt CHECK (qualitaet IN ('gemessen', 'geschaetzt')),
    CONSTRAINT verbrauch_zuordnung_bekannt CHECK (zuordnung IN ('branch', 'repo-map', 'prompt', 'auftrag', 'tag', 'keine')),
    CONSTRAINT verbrauch_tokens_nicht_negativ CHECK (
        tokens_eingabe >= 0 AND tokens_ausgabe >= 0 AND tokens_cache_schreiben_5m >= 0
        AND tokens_cache_schreiben_1h >= 0 AND tokens_cache_lesen >= 0
    ),
    -- Kosten gibt es nur mit Preis und Währung — alle drei oder keins (Eintrag ohne Preis: alles NULL).
    CONSTRAINT verbrauch_kosten_vollstaendig CHECK (
        (preis_id IS NULL) = (kosten IS NULL) AND (preis_id IS NULL) = (waehrung IS NULL)
    )
);

-- Die Auswertung (COPI-98) liest nach Zeitraum, dazu nach Projekt und Ticket.
CREATE INDEX "verbrauch_zeitpunkt" ON "cockpit"."verbrauch" (zeitpunkt);
CREATE INDEX "verbrauch_projekt_ticket" ON "cockpit"."verbrauch" (jira_projekt, ticket);

-- 3. Die Kosten. Der Preis ist der, der zum Zeitpunkt des Einsatzes galt. Ein Datums-Anhang am Modellnamen
--    (`claude-haiku-4-5-20251001`) zählt für die Suche nicht; der genaue Name gewinnt, falls es beide gibt. Ohne Preis
--    bleibt der Eintrag stehen, mit Kosten NULL — er wird sichtbar, statt verloren zu gehen.
CREATE FUNCTION "cockpit"."verbrauch_kosten_setzen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    p "cockpit"."preis"%ROWTYPE;
BEGIN
    SELECT * INTO p
      FROM "cockpit"."preis"
     WHERE modell IN (NEW."modell", regexp_replace(NEW."modell", '-[0-9]{8}$', ''))
       AND gueltig_ab <= NEW."zeitpunkt"
       AND (gueltig_bis IS NULL OR gueltig_bis > NEW."zeitpunkt")
     ORDER BY (modell = NEW."modell") DESC, gueltig_ab DESC
     LIMIT 1;
    IF NOT FOUND THEN
        NEW."preis_id" := NULL;
        NEW."kosten" := NULL;
        NEW."waehrung" := NULL;
        RETURN NEW;
    END IF;
    NEW."preis_id" := p.id;
    NEW."waehrung" := p.waehrung;
    NEW."kosten" := round((
          NEW."tokens_eingabe" * p.eingabe
        + NEW."tokens_ausgabe" * p.ausgabe
        + NEW."tokens_cache_schreiben_5m" * p.cache_schreiben_5m
        + NEW."tokens_cache_schreiben_1h" * p.cache_schreiben_1h
        + NEW."tokens_cache_lesen" * p.cache_lesen
    ) / 1000000, 6);
    RETURN NEW;
END;
$$;

CREATE TRIGGER "verbrauch_kosten" BEFORE INSERT OR UPDATE ON "cockpit"."verbrauch"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."verbrauch_kosten_setzen"();

CREATE TRIGGER "verbrauch_nie_loeschen" BEFORE DELETE ON "cockpit"."verbrauch"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- 4. Die Startpreise, geprüft am 30.09.2026. Gültig ab 01.09.2026: erfasst wird erst ab dem Start, Altdaten gibt es
--    nicht (Entscheidung Stefan, 30.09.2026).
--
--    Anthropic (USD je Mio. Tokens, Listenpreis der API): Cache-Schreiben 1,25-fach (5 Minuten) bzw. 2-fach (1 Stunde)
--    des Eingabepreises; Cache-Lesen 0,1-fach, bei Opus 5.5 0,05-fach, bei Fable 5.1 0,025-fach. Sonnet 5 bleibt bei
--    2 $/10 $: die für den 01.09.2026 angekündigte Erhöhung auf 3 $/15 $ findet laut derselben Seite nicht statt.
INSERT INTO "cockpit"."preis"
    (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
SELECT v.modell, 'USD', v.eingabe, v.ausgabe, v.eingabe * 1.25, v.eingabe * 2, v.cache_lesen, '2026-09-01T00:00:00Z',
       'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-30'
  FROM (VALUES
        ('claude-fable-5-1',  10, 50, 0.25),
        ('claude-fable-5',    10, 50, 1),
        ('claude-opus-5-5',    4, 20, 0.20),
        ('claude-opus-5',      5, 25, 0.50),
        ('claude-sonnet-5-5',  2, 10, 0.20),
        ('claude-sonnet-5',    2, 10, 0.20),
        ('claude-haiku-4-5',   1,  5, 0.10)
       ) AS v (modell, eingabe, ausgabe, cache_lesen);

--    IONOS AI Model Hub (EUR je Mio. Tokens, netto). Der Hub kennt keinen Prompt-Cache; sollten dennoch Cache-Tokens
--    gemeldet werden, zählen sie wie Eingabe. Für Llama 3.1 8B war kein Preis zu belegen — Einträge dazu bleiben ohne
--    Kosten, bis eine Zeile nachgetragen ist.
INSERT INTO "cockpit"."preis"
    (modell, waehrung, eingabe, ausgabe, cache_schreiben_5m, cache_schreiben_1h, cache_lesen, gueltig_ab, quelle, geprueft_am)
SELECT v.modell, 'EUR', v.eingabe, v.ausgabe, v.eingabe, v.eingabe, v.eingabe, '2026-09-01T00:00:00Z',
       'https://cloud.ionos.de/managed/ai-model-hub', '2026-09-30'
  FROM (VALUES
        ('meta-llama/Llama-3.3-70B-Instruct', 0.65, 0.65),
        ('openai/gpt-oss-120b',               0.15, 0.65)
       ) AS v (modell, eingabe, ausgabe);

-- 5. Das Recht der Agenten-API, Verbrauch zu melden (Regel aus 0016: ein neues Recht kommt mit dem Ticket, das es
--    braucht). In einem Befehl ersetzt, damit die Bedingung nie fehlt.
ALTER TABLE "cockpit"."api_token"
    DROP CONSTRAINT "api_token_scopes_bekannt",
    ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen', 'verbrauch_schreiben']::text[]
    );
