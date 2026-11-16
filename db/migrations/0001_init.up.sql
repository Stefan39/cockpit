-- Eigenes Schema für das Cockpit (Architektur-Vorschlag Abschnitt 2:
-- vorhandene PostgreSQL, eigenes Schema, kein zweiter DB-Container).
-- Nur anlegen, wenn es fehlt: CREATE SCHEMA IF NOT EXISTS verlangt das Recht CREATE auf die Datenbank,
-- auch wenn das Schema schon da ist. Die Rolle cockpit hat es bewusst nicht (docs/installation.md,
-- Schritt 2; COPI-66).
DO $$
BEGIN
    IF to_regnamespace('cockpit') IS NULL THEN
        CREATE SCHEMA cockpit;
    END IF;
END
$$;

-- Verzeichnis der angewendeten Migrationen — von db/migrate.ts selbst genutzt.
CREATE TABLE IF NOT EXISTS cockpit.schema_migrations (
    id           TEXT PRIMARY KEY,
    angewendet_am TIMESTAMPTZ NOT NULL DEFAULT now()
);
