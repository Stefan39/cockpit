-- Verlaufs-View zum Beispiel-Modul „Server & Dienste" (COPI-81): jeder kundensichtbare Befund einer Wache als
-- Verlaufspunkt, für die 24-Stunden-Bänder und das Wochendiagramm der Übersicht (`uebersicht.verlauf` in
-- `docs/beispiele/server-zustand.cockpit.yaml`).
--
-- Pflichtspalten: `id` (dieselben ids wie `v_modul_server_zustand`, hier die Kennung der Wache), `zeitpunkt`
-- (timestamptz), `status` (gruen/gelb/rot). Nur Tabellen als Quelle und nur kundensichtbare Befunde, kein
-- `text_intern` — die View ist wie das Modul für betriebs_admin freigegeben (ADR, `registry.ts`). Das Cockpit liest
-- nur die letzten sieben Tage (`WHERE zeitpunkt >= …`); der Index `befund_wache_gemeldet` trägt die Abfrage.
--
-- Messwert (COPI-83): `wert` und `einheit` aus `befund.messwert` für die Kurven; ein Befund ohne Messwert liefert
-- `NULL` (eine Lücke der Kurve). Auch hier nur kundensichtbare Befunde.
--
-- Ausgeliefert wird dieselbe View aus dem Repo `agent-blueprints` (neben `sql/v_modul_server_zustand.sql`).
-- Änderungen immer in beiden Repos.
CREATE VIEW cockpit.v_modul_server_zustand_verlauf AS
SELECT b.wache AS id, b.gemeldet_am AS zeitpunkt, b.status,
  (b.messwert ->> 'wert')::numeric AS wert, b.messwert ->> 'einheit' AS einheit
FROM cockpit.befund b
JOIN cockpit.wache w ON w.kennung = b.wache
WHERE b.kundensichtbar;
