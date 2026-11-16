-- Epic E2 (COPI-11): E-Mail-Einladungen (Architektur-Vorschlag Abschnitt 7).
--
-- Gleiches Muster wie beim Erststart-Token: gespeichert wird ausschließlich
-- der SHA-256-Hash, nie das Token selbst. Unterschied zur Erststart-Tabelle
-- ist allein die Gültigkeitsdauer (3 Stunden statt 24) und der Umstand, dass
-- mehrere Einladungen an verschiedene Adressen gleichzeitig offen sein dürfen.

CREATE TABLE "cockpit"."einladung" (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Zieladresse, normalisiert in Kleinschreibung. Sie steht hier und nicht
    -- im Einlöse-Formular: wer den Link hat, darf genau für diese Adresse ein
    -- Konto anlegen und für keine andere.
    email          text        NOT NULL,
    token_hash     text        NOT NULL,
    -- Wer eingeladen hat — für die spätere Nachvollziehbarkeit. ON DELETE SET
    -- NULL, damit das Löschen eines Kontos keine Einladungshistorie mitnimmt.
    eingeladen_von text        REFERENCES "cockpit"."user" ("id") ON DELETE SET NULL,
    erstellt_am    timestamptz NOT NULL DEFAULT now(),
    ablauf_am      timestamptz NOT NULL,
    verbraucht_am  timestamptz
);

CREATE UNIQUE INDEX einladung_token_hash_idx
    ON "cockpit"."einladung" (token_hash);

-- Je Adresse darf höchstens eine Einladung offen sein: eine neue Einladung
-- entwertet die vorherige an dieselbe Adresse (siehe einladung-speicher.ts).
-- Ohne diese Bedingung könnten sich offene Token je Adresse ansammeln.
CREATE UNIQUE INDEX einladung_ein_offenes_je_email_idx
    ON "cockpit"."einladung" (email)
    WHERE verbraucht_am IS NULL;
