-- Nimmt 0003_rollen zurück. Die Rollenzuordnung geht dabei verloren; nach
-- einem erneuten `up` wird das Bestandskonto wieder zum Betriebs-Admin.
ALTER TABLE "cockpit"."user" DROP CONSTRAINT IF EXISTS "user_rolle_bekannt";
ALTER TABLE "cockpit"."user" DROP COLUMN IF EXISTS "rolle";
