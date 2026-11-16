-- Epic E2 (COPI-19): `aktiviert_am` folgt dem Zustand, nicht dem Weg.
--
-- COPI-17 hat den Marker in der Route /zwei-faktor/pruefen gesetzt. Wurde der
-- zweite Faktor am Formular vorbei bestätigt — etwa über den rohen
-- Better-Auth-Endpunkt /api/auth/two-factor/verify-totp —, blieb `aktiviert_am`
-- leer, obwohl der Faktor funktionierte. Ein solches Konto wäre nach 72 Stunden
-- samt Sitzungen und 2FA-Daten gelöscht worden.
--
-- Der Trigger unten setzt den Marker bei jedem Update, nach dem der Faktor
-- eingeschaltet ist und der Marker noch fehlt — gleich, welcher Weg dorthin
-- geführt hat. Er überschreibt nie einen vorhandenen Marker und leert keinen.
-- Er greift bewusst nur bei Update: Konten entstehen ohne Faktor, eingeschaltet
-- wird er immer nachträglich.

-- Reparatur: Konten, deren Faktor seit 0006 auf einem solchen Weg eingeschaltet
-- wurde, tragen noch keinen Marker. Sie werden jetzt markiert. Der genaue Zeitwert
-- ist ohne Bedeutung, wichtig ist allein „war aktiviert“. Das steht vor dem
-- Trigger, damit es eine eigene, ausdrückliche Anweisung bleibt.
UPDATE "cockpit"."user"
   SET "aktiviert_am" = now()
 WHERE "twoFactorEnabled" = true
   AND "aktiviert_am" IS NULL;

CREATE FUNCTION "cockpit"."konto_aktivierung_markieren"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Die Bedingung steht in der WHEN-Klausel des Triggers, nicht hier: die
    -- Funktion selbst kennt sie nicht und ist nur zusammen mit ihr sinnvoll.
    NEW."aktiviert_am" := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "user_aktivierung_markieren"
    BEFORE UPDATE ON "cockpit"."user"
    FOR EACH ROW
    WHEN (NEW."twoFactorEnabled" IS TRUE AND NEW."aktiviert_am" IS NULL)
    EXECUTE FUNCTION "cockpit"."konto_aktivierung_markieren"();
