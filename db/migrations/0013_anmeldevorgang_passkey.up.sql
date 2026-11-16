-- Epic E2 (COPI-27): Die Challenge der Passkey-Anmeldung gehört zum Anmeldevorgang.
--
-- Der Anmeldevorgang (0005) ist der Zwischenzustand zwischen Passwort und zweitem
-- Schritt, ohne Sitzung. Fordert die Person dort ihren Passkey an, muss das Gerät genau
-- eine Challenge signieren, und die darf nur für diesen Vorgang gelten: eine Challenge
-- aus einem anderen Vorgang (einem anderen Konto) taugt hier nicht. Deshalb steht sie
-- in der Zeile des Vorgangs und nicht in einer eigenen Tabelle.
--
-- Einmal verbrauchbar: die Anwendung liest und leert beide Spalten in einer Anweisung.
-- Fünf Minuten gültig (der Vorgang selbst zehn); `NULL` heißt „keine offene Challenge".
ALTER TABLE "cockpit"."anmeldevorgang"
    ADD COLUMN "passkey_challenge"           text,
    ADD COLUMN "passkey_challenge_ablauf_am" timestamptz;

-- Beides oder nichts: eine Challenge ohne Ablauf wäre unbegrenzt gültig.
ALTER TABLE "cockpit"."anmeldevorgang"
    ADD CONSTRAINT "anmeldevorgang_challenge_mit_ablauf"
    CHECK (("passkey_challenge" IS NULL) = ("passkey_challenge_ablauf_am" IS NULL));
