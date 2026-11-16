-- COPI-69: Häkchen an den eigenen Nachrichten im Assistenten-Kanal — „angenommen", sobald der Webhook des
-- Koordinators die Nachricht quittiert hat. „gesendet" (noch keine Quittung) und „beantwortet" (eine spätere Antwort
-- des Koordinators) ergeben sich aus dem Verlauf, dafür gibt es keine Spalte.
--
-- Der Zeitpunkt wird einmal gesetzt und bleibt. Der bestehende Trigger `nachricht_pruefen` (0024) vergleicht nur die
-- dort genannten Spalten, das Setzen wäre also schon erlaubt; die Einmaligkeit bekommt eine eigene kleine Funktion mit
-- eigenem Trigger, ohne `nachricht_pruefen` zu ersetzen.
ALTER TABLE "cockpit"."nachricht" ADD COLUMN "zugestellt_am" timestamptz;

CREATE FUNCTION "cockpit"."nachricht_zugestellt_pruefen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."zugestellt_am" IS NOT NULL AND NEW."zugestellt_am" IS DISTINCT FROM OLD."zugestellt_am" THEN
        RAISE EXCEPTION 'nachricht_zugestellt_endgueltig: Der Zeitpunkt der Quittung steht fest';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "nachricht_zugestellt"
    BEFORE UPDATE ON "cockpit"."nachricht"
    FOR EACH ROW
    EXECUTE FUNCTION "cockpit"."nachricht_zugestellt_pruefen"();
