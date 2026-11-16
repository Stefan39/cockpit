-- Epic E2 (COPI-22): Die Rolle `betreuer` — höchstens einer, dauerhaft,
-- nur durch eine bewusste Übergabe wechselnd.
--
-- Der Betreuer (Stefan, oder wer die Betreuung übernimmt) hat vollständige Rechte
-- für das gesamte System. Er entsteht durch den Erststart und ist in der
-- Oberfläche nicht vergebbar (Architektur-Vorschlag 13.1). Was hier steht, hält
-- drei Regeln in der Datenbank fest, nicht nur im Anwendungscode:
--
--   1. Höchstens ein Betreuer — niemals zwei nebeneinander.
--   2. Ein aktivierter Betreuer bleibt bestehen: er lässt sich nicht löschen,
--      nicht herabstufen und nicht „deaktivieren", außer in der Übergabe.
--   3. Eine Einladung trägt ihre Rolle, und die ist nie `betreuer`.

-- 1. Die Rolle ist bekannt.
ALTER TABLE "cockpit"."user"
    DROP CONSTRAINT "user_rolle_bekannt";

ALTER TABLE "cockpit"."user"
    ADD CONSTRAINT "user_rolle_bekannt"
    CHECK ("rolle" IN ('betreuer', 'betriebs_admin', 'betrieb_mitarbeiter'));

-- 2. Die Einladung trägt die Rolle des Eingeladenen. Bisherige Einladungen
--    behalten den Default, den sie bisher hatten. `betreuer` ist nie einladbar.
ALTER TABLE "cockpit"."einladung"
    ADD COLUMN "rolle" text NOT NULL DEFAULT 'betrieb_mitarbeiter';

ALTER TABLE "cockpit"."einladung"
    ADD CONSTRAINT "einladung_rolle_vergebbar"
    CHECK ("rolle" IN ('betriebs_admin', 'betrieb_mitarbeiter'));

-- 3. Reparatur: Wer die Instanz über das Konsolen-Token eingerichtet hat, ist
--    ihr Betreuer (ADR 13.2). Auf einer frischen Instanz vergibt die Erststart-
--    Route die Rolle selbst. Ein Bestandskonto aus der Zeit davor trägt sie nicht.
--
--    Bewusst nur, wenn es genau ein Konto gibt und noch keinen Betreuer: bei
--    mehreren Konten ist die Zuordnung nicht eindeutig, und eine Migration rät
--    keine Rechte zusammen. Dann bleibt es bei den Rollen von Hand.
--    Das steht vor Index und Trigger unten, damit es eine eigene, ausdrückliche
--    Anweisung bleibt.
UPDATE "cockpit"."user"
   SET "rolle" = 'betreuer'
 WHERE (SELECT count(*) FROM "cockpit"."user") = 1
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."user" WHERE "rolle" = 'betreuer');

-- 4. Höchstens ein Betreuer. Der partielle Index enthält nur Zeilen mit der Rolle
--    `betreuer` und ist auf `rolle` eindeutig: eine zweite Zeile wäre ein Duplikat.
--    Er prüft sofort (nicht am Ende der Transaktion); die Übergabe stuft deshalb
--    erst den bisherigen herab und befördert dann den neuen.
CREATE UNIQUE INDEX "user_hoechstens_ein_betreuer"
    ON "cockpit"."user" ("rolle")
    WHERE "rolle" = 'betreuer';

-- 5. Ein aktivierter Betreuer bleibt bestehen.
--
--    „Aktiviert" heißt `aktiviert_am` gesetzt (0006/0007). Ein Erststart-Konto,
--    das nie aktiviert wurde, ist nicht geschützt: der 72-h-Verfall (COPI-17) muss
--    es weiter entfernen dürfen, sonst könnte ein abgebrochener Erststart die
--    Instanz dauerhaft blockieren.
--
--    Die Ausnahme ist die Übergabe. Sie setzt in ihrer Transaktion
--    `cockpit.betreuer_aenderung` auf `ja` (transaktionslokal, verfällt am Ende).
--    Das ist eine Markierung gegen Versehen, keine Zugriffskontrolle: wer SQL auf
--    diese Datenbank ausführen kann, kann sie setzen. Das ist gewollt und
--    im README als bewusster Handgriff beschrieben.
CREATE FUNCTION "cockpit"."betreuer_bleibt_bestehen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."rolle" = 'betreuer'
       AND OLD."aktiviert_am" IS NOT NULL
       AND coalesce(current_setting('cockpit.betreuer_aenderung', true), '') <> 'ja'
       AND (TG_OP = 'DELETE'
            OR NEW."rolle" IS DISTINCT FROM 'betreuer'
            OR NEW."aktiviert_am" IS NULL)
    THEN
        RAISE EXCEPTION 'betreuer_bleibt_bestehen: Ein aktivierter Betreuer wird nicht geloescht, herabgestuft oder deaktiviert, ausser in der Uebergabe (cockpit.betreuer_aenderung)';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "user_betreuer_bleibt_bestehen"
    BEFORE DELETE OR UPDATE OF "rolle", "aktiviert_am" ON "cockpit"."user"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."betreuer_bleibt_bestehen"();
