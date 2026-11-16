-- Epic E4 (COPI-60): Der E-Mail-Zweitkanal — welche dringende Nachricht per E-Mail gemeldet ist.
--
-- ADR 6: „Zweitkanal E-Mail ist Pflicht, nicht Fallback, für als dringend markierte, ungelesene Nachrichten." Eine
-- Nachricht ist unveränderlich (0024), deshalb steht der Versand in einer eigenen Tabelle: je Nachricht höchstens eine
-- Zeile (Primärschlüssel), geschrieben in derselben Transaktion wie der Versand. Scheitert der Versand, gibt es die
-- Zeile nicht, und der nächste Lauf versucht es wieder; auch nach einem Neustart geht keine Nachricht doppelt hinaus.
-- Die Zeilen eines Kontos sind zugleich die Drosselung (höchstens eine Mail je Stunde).
CREATE TABLE "cockpit"."chat_mail" (
    nachricht_id bigint      PRIMARY KEY REFERENCES "cockpit"."nachricht" ("id"),
    -- An wen die Mail ging: der Besitzer des Assistenten-Kanals. Nie die Adresse, die kann sich ändern.
    benutzer_id  text        NOT NULL REFERENCES "cockpit"."user" ("id"),
    gesendet_am  timestamptz NOT NULL
);

-- Die Drosselung fragt je Konto nach der jüngsten Mail.
CREATE INDEX "chat_mail_benutzer_idx" ON "cockpit"."chat_mail" (benutzer_id, gesendet_am);

CREATE TRIGGER "chat_mail_nie_loeschen" BEFORE DELETE ON "cockpit"."chat_mail"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- Die Protokollart (seit 0019 eine Zeile je Art).
INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('chat_mail_gesendet')
ON CONFLICT (art) DO NOTHING;
