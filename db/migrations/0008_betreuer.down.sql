-- Nimmt 0008 zurück. Ein vorhandener Betreuer wird dabei Betriebs-Admin: die alte
-- Rollenliste kennt `betreuer` nicht, und seine Rechte gehen nicht verloren, wenn
-- er stattdessen die höchste Rolle bekommt, die es davor gab.

-- Zuerst die Sperre: sie würde die Herabstufung unten sonst verhindern.
DROP TRIGGER "user_betreuer_bleibt_bestehen" ON "cockpit"."user";
DROP FUNCTION "cockpit"."betreuer_bleibt_bestehen"();
DROP INDEX "cockpit"."user_hoechstens_ein_betreuer";

UPDATE "cockpit"."user" SET "rolle" = 'betriebs_admin' WHERE "rolle" = 'betreuer';

ALTER TABLE "cockpit"."user" DROP CONSTRAINT "user_rolle_bekannt";
ALTER TABLE "cockpit"."user"
    ADD CONSTRAINT "user_rolle_bekannt"
    CHECK ("rolle" IN ('betriebs_admin', 'betrieb_mitarbeiter'));

ALTER TABLE "cockpit"."einladung" DROP CONSTRAINT "einladung_rolle_vergebbar";
ALTER TABLE "cockpit"."einladung" DROP COLUMN "rolle";
