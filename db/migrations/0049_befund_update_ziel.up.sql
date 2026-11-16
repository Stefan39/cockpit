-- COPI-140: Das Update-Ziel einer Versions-Wache, maschinenlesbar am Befund. Bisher stand das neuere Ziel nur im Text
-- der Wache, und der Betreuer tippte Commit oder Digest von Hand ab; jetzt meldet die Wache es mit, und die Karte unter
-- Einstellungen › Versionen bietet „Update installieren" an (Antrag wie bisher, COPI-40/COPI-106).
--
-- Optional wie der Messwert (0029): ein Befund ohne Ziel bleibt, wie er war. Nur das Ziel am jüngsten Befund der Wache
-- zählt; meldet sie grün oder ohne Ziel, ist es erledigt. Die Form prüft die Datenbank selbst, nicht nur die Route:
--
--   * `art` `cockpit`: `ziel` ein Digest (`sha256:` und 64 Zeichen 0–9 a–f), `version` Pflicht;
--   * `art` `modul`: `ziel` ein voller Commit (40 Zeichen 0–9 a–f), `version` fehlt oder ist null;
--   * `hinweis` (optional, höchstens 200 Zeichen) und `seit` (Pflicht, Text, von der Route als ISO-8601 geprüft);
--   * nichts sonst, und nur an einem gelben Befund — ein neueres Ziel heißt „Update verfügbar".
ALTER TABLE "cockpit"."befund" ADD COLUMN "update_ziel" jsonb;

ALTER TABLE "cockpit"."befund"
    ADD CONSTRAINT "befund_update_ziel_form" CHECK (
        update_ziel IS NULL OR CASE
            WHEN status <> 'gelb' THEN false
            WHEN jsonb_typeof(update_ziel) <> 'object' THEN false
            WHEN (update_ziel - ARRAY['art', 'ziel', 'version', 'hinweis', 'seit']) <> '{}'::jsonb THEN false
            WHEN jsonb_typeof(update_ziel -> 'seit') IS DISTINCT FROM 'string' THEN false
            WHEN update_ziel ? 'hinweis' AND jsonb_typeof(update_ziel -> 'hinweis') NOT IN ('string', 'null') THEN false
            WHEN char_length(coalesce(update_ziel ->> 'hinweis', '')) > 200 THEN false
            WHEN update_ziel ->> 'art' = 'cockpit' THEN
                coalesce(update_ziel ->> 'ziel', '') ~ '^sha256:[0-9a-f]{64}$'
                AND jsonb_typeof(update_ziel -> 'version') IS NOT DISTINCT FROM 'string'
            WHEN update_ziel ->> 'art' = 'modul' THEN
                coalesce(update_ziel ->> 'ziel', '') ~ '^[0-9a-f]{40}$'
                AND coalesce(jsonb_typeof(update_ziel -> 'version'), 'null') = 'null'
            ELSE false
        END
    );
