-- Beispiel-Modul „Server & Dienste" (COPI-78): eine Modul-View über den Herzschlag der Wachen
-- (`cockpit.wache`/`cockpit.befund`, Migration 0015 und 0017), im selben Wortlaut wie die Übereinstimmungs-
-- prüfung gegen `wachenZustand` (`src/status/zustand.ts`, `test/modul-server-zustand-datenbank.test.ts`):
-- der Status einer Zeile muss genau dann „gelb" heißen, wenn die Wache überfällig ist, und ein gemeldetes
-- Rot bleibt rot, unabhängig vom Alter der Meldung.
--
-- Nur Pflichtspalten und die deklarierten Spalten (`docs/beispiele/server-zustand.cockpit.yaml`); ausschließlich
-- kundensichtbare Befunde (`text_kunde`, `kundensichtbar`) — die View ist für die Rollen betreuer und
-- betriebs_admin freigegeben, ein Rohbefund (`text_intern`) darf hier nicht vorkommen (ADR, `registry.ts`).
--
-- Messwert (COPI-83): `wert`, `einheit`, `wert_max`, `wert_warnung` kommen aus `befund.messwert` desselben jüngsten
-- kundensichtbaren Befunds — ein Messwert eines internen Befunds kommt hier nie vor. Die Spalten stehen am Ende,
-- damit `CREATE OR REPLACE VIEW` eine ältere Fassung ohne sie ersetzen kann.
--
-- Ausgeliefert wird dieselbe View aus dem Repo `agent-blueprints` (`sql/v_modul_server_zustand.sql`, zum
-- Block `module/server-zustand.cockpit.yaml`). Änderungen immer in beiden Repos.
CREATE VIEW cockpit.v_modul_server_zustand AS
SELECT w.kennung AS id, coalesce(w.anzeigename, 'Bereich') AS titel,
  CASE WHEN b.status = 'rot' THEN 'rot' WHEN u.ueberfaellig THEN 'gelb' ELSE b.status END AS status,
  -- Überfällig und nicht rot: der letzte Klartext („Zertifikat gültig.") wäre veraltet (COPI-81).
  CASE WHEN u.ueberfaellig AND b.status <> 'rot'
       THEN 'Keine aktuelle Prüfung: die letzte Meldung liegt zu lange zurück.'
       ELSE b.text_kunde END AS text,
  b.gemeldet_am AS aktualisiert_am,
  (b.messwert ->> 'wert')::numeric AS wert,
  b.messwert ->> 'einheit' AS einheit,
  (b.messwert ->> 'max')::numeric AS wert_max,
  (b.messwert ->> 'warnung')::numeric AS wert_warnung
FROM cockpit.wache w
JOIN LATERAL (SELECT status, text_kunde, gemeldet_am, messwert FROM cockpit.befund
              WHERE wache = w.kennung AND kundensichtbar
              ORDER BY gemeldet_am DESC LIMIT 1) b ON true
CROSS JOIN LATERAL (SELECT b.gemeldet_am IS NULL OR now() - b.gemeldet_am >
            make_interval(secs => w.takt_sekunden + greatest(60, ceil(w.takt_sekunden / 2.0))) AS ueberfaellig) u;
