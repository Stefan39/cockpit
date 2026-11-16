-- Epic E2 (COPI-13): eigene Ratenbegrenzung der Anmeldung und der kurzlebige
-- Anmeldevorgang zwischen Passwort- und Codeschritt.
--
-- Warum eigene Zähler statt der Better-Auth-Ratenbegrenzung: die greift nur
-- im Router-Haken (also für Anfragen über `auth.handler`), ist standardmäßig
-- nur in Produktion aktiv, hält ihre Zähler im Arbeitsspeicher (ein Neustart
-- löscht sie) und kennt nur Burst-Regeln von wenigen Sekunden. Die
-- Anmeldeseite ruft `auth.api.*` direkt auf und braucht eine Grenze, die
-- Neustarts übersteht und über Minuten zählt. Siehe
-- test/better-auth-ratenbegrenzung.test.ts.

-- Der Zähler wird erhöht, BEVOR Passwort oder Code geprüft werden
-- („reservieren, dann prüfen", siehe ratenbegrenzung.ts) — sonst greift die
-- Grenze bei gleichzeitigen Anfragen nicht. Bei Erfolg wird die Reservierung je
-- IP wieder gutgeschrieben, der Zähler je Adresse bzw. Konto gelöscht.
--
-- Zähler je Kennung. Die Kennung selbst (E-Mail-Adresse, IP, Konto-ID) steht
-- NICHT im Klartext hier: gespeichert wird nur ihr SHA-256-Hash, zusammen mit
-- der Art. Gesucht wird ohnehin immer über den vollständigen Schlüssel, und so
-- sammelt die Tabelle keine Adressen — auch keine getippten Fremdadressen.
CREATE TABLE "cockpit"."anmeldeversuch" (
    -- 'passwort-email' | 'passwort-ip' | 'code-konto' (siehe ratenbegrenzung.ts)
    art            text        NOT NULL,
    kennung_hash   text        NOT NULL,
    fehlversuche   integer     NOT NULL DEFAULT 0,
    -- Beginn des laufenden Zählfensters. Liegt er weiter zurück als die
    -- Fensterlänge, beginnt der nächste Fehlversuch wieder bei 1.
    fenster_beginn timestamptz NOT NULL,
    gesperrt_bis   timestamptz,
    PRIMARY KEY (art, kennung_hash)
);

-- Für das Abräumen abgelaufener Zähler.
CREATE INDEX anmeldeversuch_fenster_beginn_idx
    ON "cockpit"."anmeldeversuch" (fenster_beginn);

-- Der Anmeldevorgang verbindet Passwort- und Codeschritt. Er sagt nur, für
-- welches Konto der Codeschritt läuft — damit dessen Fehlversuche einem Konto
-- zugeordnet werden können, ohne in Better-Auth-Interna zu greifen.
-- Autorisiert wird der Codeschritt weiterhin allein durch den signierten
-- `two_factor`-Cookie von Better Auth.
--
-- Wie bei Erststart- und Einladungs-Token: 32 Byte Zufall, gespeichert wird
-- nur der SHA-256-Hash, der Klartext lebt ausschließlich im Cookie.
CREATE TABLE "cockpit"."anmeldevorgang" (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kennung_hash  text        NOT NULL,
    benutzer_id   text        NOT NULL REFERENCES "cockpit"."user" ("id") ON DELETE CASCADE,
    erstellt_am   timestamptz NOT NULL DEFAULT now(),
    ablauf_am     timestamptz NOT NULL,
    verbraucht_am timestamptz
);

CREATE UNIQUE INDEX anmeldevorgang_kennung_hash_idx
    ON "cockpit"."anmeldevorgang" (kennung_hash);

CREATE INDEX anmeldevorgang_ablauf_am_idx
    ON "cockpit"."anmeldevorgang" (ablauf_am);
