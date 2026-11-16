-- Epic E2 (COPI-11): Rollenmodell auf dem Better-Auth-Benutzertisch.
--
-- Zwei Rollen sind in der Oberfläche vorgesehen:
--   * `betriebs_admin`      — Betriebs-Admin des Kunden, darf einladen
--   * `betrieb_mitarbeiter` — Default für jeden eingeladenen Zugang
--
-- Die dritte Rolle `betreuer` (Stefan) gehört zu Epic E3 und wird hier bewusst
-- NICHT angelegt — sie ist laut Architektur-Vorschlag in der Oberfläche
-- ohnehin nicht vergebbar. Die CHECK-Bedingung hält das fest: ein späteres
-- Ticket muss sie bewusst erweitern, versehentlich entsteht die Rolle nicht.
--
-- Die Spalte liegt bewusst auf "user" und nicht in einer eigenen Tabelle:
-- genau eine Rolle je Konto, keine Mehrfachzuordnung, kein Rechte-Editor.

ALTER TABLE "cockpit"."user"
    ADD COLUMN "rolle" text NOT NULL DEFAULT 'betrieb_mitarbeiter';

ALTER TABLE "cockpit"."user"
    ADD CONSTRAINT "user_rolle_bekannt"
    CHECK ("rolle" IN ('betriebs_admin', 'betrieb_mitarbeiter'));

-- Bestandskonto aus dem Erststart-Bootstrap (COPI-10): Wer die Instanz über
-- das Konsolen-Token eingerichtet hat, ist ihr Betriebs-Admin — sonst könnte
-- nach dieser Migration niemand mehr einladen.
--
-- Bewusst nur, wenn es genau ein Konto gibt: bei mehreren Konten ist die
-- Zuordnung nicht eindeutig, und eine Migration rät keine Rechte zusammen.
-- Dann bleibt es bei `betrieb_mitarbeiter`, und die Rolle wird von Hand
-- gesetzt.
UPDATE "cockpit"."user"
   SET "rolle" = 'betriebs_admin'
 WHERE (SELECT count(*) FROM "cockpit"."user") = 1;
