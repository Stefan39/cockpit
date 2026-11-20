-- COPI-254: Grundlage der Kalkulation je Ticket. Zwei Tabellen: der erfasste Aufwand (Minuten aus der Zeiterfassung oder
-- von Hand) und die Merkmale eines Tickets (Aufgabentyp, Stack, geänderte Zeilen), nach denen sich Tickets vergleichen lassen.
-- Beide im Schema `cockpit` mit Präfix `pipeline_` (siehe 0051). Rechte brauchen sie keine eigenen: die Rolle `cockpit` besitzt
-- die Tabellen, `pipeline_verwalten` deckt die Routen (kein neuer Scope).
--
-- Nie löschen (0025): beide Tabellen weisen `DELETE` ab.

-- Ein Eintrag der Zeiterfassung (Tag, Minuten) zu einem Ticket. Er kann sich nachträglich ändern (Minuten korrigiert,
-- Eintrag einem anderen Ticket zugeordnet, Tag verschoben). Deshalb ist er **kein** Anhänge-Protokoll wie `pipeline_usage`:
-- dieselbe Meldung (`quelle`, `extern_id`) überschreibt `ticket_key`, `tag` und `minuten` (Upsert). Entfernt wird ein Eintrag
-- nicht (nie löschen), sondern mit `minuten = 0` neutralisiert; die Summe je Ticket bleibt damit richtig, die Zeile als
-- Nachweis bestehen.
CREATE TABLE "cockpit"."pipeline_aufwand" (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_key text        NOT NULL,
    quelle     text        NOT NULL,
    extern_id  text        NOT NULL,
    tag        date        NOT NULL,
    minuten    integer     NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pipeline_aufwand_ticket_key CHECK (char_length(ticket_key) BETWEEN 1 AND 200),
    CONSTRAINT pipeline_aufwand_quelle CHECK (quelle IN ('zeiterfassung', 'manuell')),
    CONSTRAINT pipeline_aufwand_extern_id CHECK (char_length(extern_id) BETWEEN 1 AND 200),
    CONSTRAINT pipeline_aufwand_minuten CHECK (minuten BETWEEN 0 AND 1440),
    CONSTRAINT pipeline_aufwand_quelle_extern UNIQUE (quelle, extern_id)
);

CREATE INDEX "pipeline_aufwand_ticket" ON "cockpit"."pipeline_aufwand" (ticket_key);

CREATE TRIGGER "pipeline_aufwand_nie_loeschen" BEFORE DELETE ON "cockpit"."pipeline_aufwand"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- Die Merkmale eines Tickets: eine Zeile je Ticket, nicht genannte Felder bleiben bei einer neuen Meldung erhalten.
-- `stack`: höchstens 10 Marken, je 1 bis 40 Zeichen (Kleinbuchstaben, Ziffern, `.`, `+`, `#`, `-`). Die Form je Eintrag prüft
-- der Ausdruck über den zusammengefügten Text: das Komma kommt in keiner Marke vor und trennt sie eindeutig.
CREATE TABLE "cockpit"."pipeline_ticket_merkmal" (
    ticket_key        text        PRIMARY KEY,
    aufgabentyp       text,
    stack             text[]      NOT NULL DEFAULT ARRAY[]::text[],
    geaenderte_zeilen integer,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pipeline_ticket_merkmal_ticket_key CHECK (char_length(ticket_key) BETWEEN 1 AND 200),
    CONSTRAINT pipeline_ticket_merkmal_aufgabentyp CHECK (
        aufgabentyp IS NULL OR aufgabentyp IN ('bugfix', 'feature', 'skript', 'wordpress-plugin', 'datenkonvertierung', 'doku')
    ),
    CONSTRAINT pipeline_ticket_merkmal_stack CHECK (
        cardinality(stack) <= 10
        AND array_position(stack, NULL) IS NULL
        AND (cardinality(stack) = 0 OR array_to_string(stack, ',') ~ '^[a-z0-9][a-z0-9.+#-]{0,39}(,[a-z0-9][a-z0-9.+#-]{0,39})*$')
    ),
    CONSTRAINT pipeline_ticket_merkmal_zeilen CHECK (geaenderte_zeilen IS NULL OR geaenderte_zeilen >= 0)
);

CREATE TRIGGER "pipeline_ticket_merkmal_nie_loeschen" BEFORE DELETE ON "cockpit"."pipeline_ticket_merkmal"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
