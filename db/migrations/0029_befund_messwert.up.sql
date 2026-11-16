-- COPI-83: Ein Hauptmesswert je Befund (Entscheidung Stefan, 28.09.2026) — etwa „Plattenplatz 86 % von 100 %,
-- Warnschwelle 85". Daraus zeichnen die Beispiel-Views des Moduls „Server & Dienste" Wert, Balken und Kurve.
--
-- Die Spalte ist optional: ein Befund ohne Messwert bleibt, wie er war. Ihre Form prüft die Datenbank selbst, nicht
-- nur die Route (wie bei 0015): ein Objekt mit genau den Feldern `wert` (Zahl, Pflicht), `einheit` (Text, 1–12
-- sichtbare Zeichen, Pflicht), `max` (Zahl > 0, optional) und `warnung` (Zahl, optional) — nichts sonst. JSON kennt
-- keine unendlichen Zahlen; NaN/Infinity kommen hier also gar nicht erst an.
--
-- Der Messwert gehört zum Befund und damit zu dessen Sichtbarkeit: für den Kunden zählt er nur über einen
-- `kundensichtbar`en Befund (die Views lesen ihn nur von dort). Befunde werden nie gelöscht (0025); das gilt für
-- die neue Spalte mit.
ALTER TABLE "cockpit"."befund" ADD COLUMN "messwert" jsonb;

-- `CASE` statt `AND`, wo ein Cast folgt: Postgres garantiert für `AND` keine Reihenfolge, ein Text in `max` soll
-- die Bedingung scheitern lassen, nicht den Cast.
ALTER TABLE "cockpit"."befund"
    ADD CONSTRAINT "befund_messwert_form" CHECK (
        messwert IS NULL OR CASE
            WHEN jsonb_typeof(messwert) <> 'object' THEN false
            WHEN (messwert - ARRAY['wert', 'einheit', 'max', 'warnung']) <> '{}'::jsonb THEN false
            WHEN jsonb_typeof(messwert -> 'wert') IS DISTINCT FROM 'number' THEN false
            WHEN jsonb_typeof(messwert -> 'einheit') IS DISTINCT FROM 'string' THEN false
            WHEN (messwert ->> 'einheit') !~ '[^[:space:]]' OR char_length(messwert ->> 'einheit') > 12 THEN false
            WHEN messwert ? 'warnung' AND jsonb_typeof(messwert -> 'warnung') <> 'number' THEN false
            WHEN NOT messwert ? 'max' THEN true
            WHEN jsonb_typeof(messwert -> 'max') <> 'number' THEN false
            ELSE (messwert ->> 'max')::numeric > 0
        END
    );
