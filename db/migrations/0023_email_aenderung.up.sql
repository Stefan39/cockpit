-- Epic E2 (COPI-47): Die E-Mail-Adresse eines Kontos ändern — erst, wenn die neue Adresse bestätigt ist.
--
-- Betreuer bzw. Betriebs-Admin beantragen die neue Adresse auf der Seite des Kontos (Rechte wie COPI-46). Das ändert
-- noch nichts am Konto: es entsteht eine Zeile hier, und an die **neue** Adresse geht ein Einmal-Link. Erst wer ihn
-- einlöst, macht die Adresse gültig — der Besitz des Postfachs ist der Nachweis (Vorbild ADR 13.2). Die angemeldet wird,
-- ist die E-Mail; ein Tippfehler darf niemanden aussperren, und niemand soll ein Konto auf eine fremde Adresse umlenken.
--
-- Wie bei Einladung und Wiederherstellung: gespeichert wird nur der SHA-256-Hash des Tokens, das Token selbst lebt allein
-- in der Mail. `beantragt_von` ist die Konto-ID als Kennung, ohne Fremdschlüssel (wie beim Eingriff, 0015).

CREATE TABLE "cockpit"."email_aenderung" (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- ON DELETE CASCADE: ein entferntes Konto nimmt seine offene Änderung mit.
    benutzer_id   text        NOT NULL REFERENCES "cockpit"."user" ("id") ON DELETE CASCADE,
    -- Normalisiert (klein, ohne Rand), wie die Adressen der Einladung.
    neue_email    text        NOT NULL,
    token_hash    text        NOT NULL,
    beantragt_von text        NOT NULL,
    erstellt_am   timestamptz NOT NULL DEFAULT now(),
    ablauf_am     timestamptz NOT NULL,
    verbraucht_am timestamptz,
    CONSTRAINT email_aenderung_email_form CHECK (neue_email = lower(btrim(neue_email)) AND neue_email LIKE '%_@_%'),
    CONSTRAINT email_aenderung_hash_form CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "email_aenderung_token_hash_idx" ON "cockpit"."email_aenderung" ("token_hash");

-- Je Konto höchstens eine offene Änderung, und je Adresse höchstens eine: ein neuer Antrag entwertet den alten (die
-- Anwendung tut das in derselben Transaktion; die Indizes erzwingen es, auch bei gleichzeitigen Anträgen).
CREATE UNIQUE INDEX "email_aenderung_offen_je_konto_idx"
    ON "cockpit"."email_aenderung" ("benutzer_id")
    WHERE "verbraucht_am" IS NULL;

CREATE UNIQUE INDEX "email_aenderung_offen_je_adresse_idx"
    ON "cockpit"."email_aenderung" ("neue_email")
    WHERE "verbraucht_am" IS NULL;

-- Die Protokollarten (seit 0019 eine Zeile je Art).
INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('email_aenderung_beantragt'), ('email_geaendert')
ON CONFLICT (art) DO NOTHING;
