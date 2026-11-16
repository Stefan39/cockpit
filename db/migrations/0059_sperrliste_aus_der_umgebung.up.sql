-- Die Sperrliste für Auto-Merge ist Sache der Instanz und kommt aus der Umgebung (`COCKPIT_AUTO_MERGE_SPERRLISTE`,
-- geprüft in `src/pipeline/repo-config.ts`). Die feste Bedingung aus 0051 entfällt; auf frischen Datenbanken gibt es sie
-- nie, daher IF EXISTS.
ALTER TABLE "cockpit"."pipeline_repo_config" DROP CONSTRAINT IF EXISTS "pipeline_repo_sperrliste";
