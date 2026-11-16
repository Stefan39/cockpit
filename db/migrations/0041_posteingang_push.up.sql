-- COPI-116: Push aufs Gerät, sobald im Posteingang (COPI-112) etwas Neues ist — nicht nur bei Antworten des Assistenten
-- und dringenden Nachrichten (COPI-59).
--
-- Die Einträge des Posteingangs berechnet das Cockpit beim Lesen; ein Ereignis, an dem ein Push hängen könnte, gibt es
-- nicht. Ein Takt im Prozess (eine Minute, nur mit VAPID) liest deshalb je Konto mit Push-Abo den Posteingang wie der
-- Badge und vergleicht mit dem, was zuletzt gemeldet wurde. Das steht hier:
--
--   * `gesamt` — die Zahl des Badges beim letzten Lauf;
--   * `gesehen` — Kennzeichen (16 Hex, gekürzter SHA-256 über Quelle, Ziel, Titel und Zeitpunkt) der Einträge, die
--     schon gemeldet oder beim ersten Lauf vorgefunden wurden; höchstens 200. Kein Inhalt, keine Adresse;
--   * `gemeldet_am` — der letzte Push dieses Takts (für Nachweis und Tests).
--
-- Der erste Lauf für ein Konto legt die Zeile an, ohne zu melden: nach einem Neustart oder einem neuen Abo kommt kein
-- Push für Altes. Wie `posteingang_stand` wird die Zeile nur fortgeschrieben und nie gelöscht (0025).
CREATE TABLE "cockpit"."posteingang_push" (
    benutzer_id     text        PRIMARY KEY REFERENCES "cockpit"."user" ("id"),
    gesamt          integer     NOT NULL,
    gesehen         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    gemeldet_am     timestamptz,
    aktualisiert_am timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT posteingang_push_gesamt_nicht_negativ CHECK (gesamt >= 0),
    CONSTRAINT posteingang_push_gesehen_liste CHECK (jsonb_typeof(gesehen) = 'array' AND jsonb_array_length(gesehen) <= 200)
);

CREATE TRIGGER "posteingang_push_nie_loeschen" BEFORE DELETE ON "cockpit"."posteingang_push"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
