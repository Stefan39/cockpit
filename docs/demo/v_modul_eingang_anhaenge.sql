-- Modul „Eingang" (COPI-110): die Anhang-View über `eingang.anhang` (Fachmigration 0004), zum Feld
-- `anhaenge:` im Block `eingang.cockpit.yaml`.
--
-- Vertrag (`docs/modul-vertrag.md`, „Anhänge"): `id`, `vorgang_id` (= `id` der Modul-View), `dateiname`, `groesse`,
-- `inhalt` (NULL: liegt nur im Postfach), optional `typ` und `position`. Welche Anhänge jemand sieht, entscheidet das
-- Cockpit über die Modul-View: nur die Anhänge einer Zeile, die dort steht (Rollen, 14-Tage-Fenster).
--
-- Direkt auf Tabellen (Vertrag: für Kundenrollen keine Zwischen-View). 
CREATE VIEW cockpit.v_modul_eingang_anhaenge AS
SELECT a.id::text AS id,
       v.id::text AS vorgang_id,
       a.dateiname,
       a.groesse::numeric AS groesse,
       a.inhalt,
       a.typ,
       a.position
  FROM eingang.anhang a
  JOIN eingang.vorgang v ON v.message_id = a.message_id;
