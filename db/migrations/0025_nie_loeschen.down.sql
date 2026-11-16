-- Nimmt 0025 zurück. Ein Werkzeug für die Entwicklung, kein Weg im Betrieb: als gelöscht markierte Konten behalten
-- ihren Platzhalter, das Archiv der Zugangsmittel geht mit seiner Tabelle. Die Sperre aus 0024 verliert nur die
-- Ausnahme für Testdatenbanken nicht — sie ist dort harmlos und wird mit 0024 entfernt.
DROP TRIGGER "zugangsmittel_archiv_nie_loeschen" ON "cockpit"."zugangsmittel_archiv";
DROP TRIGGER "eingriff_nie_loeschen" ON "cockpit"."eingriff";
DROP TRIGGER "instanz_nie_loeschen" ON "cockpit"."instanz";
DROP TRIGGER "agent_nie_loeschen" ON "cockpit"."agent";
DROP TRIGGER "befund_nie_loeschen" ON "cockpit"."befund";
DROP TRIGGER "wache_nie_loeschen" ON "cockpit"."wache";
DROP TRIGGER "api_token_nie_loeschen" ON "cockpit"."api_token";
DROP TRIGGER "erststart_token_nie_loeschen" ON "cockpit"."erststart_token";
DROP TRIGGER "zugang_wiederherstellung_nie_loeschen" ON "cockpit"."zugang_wiederherstellung";
DROP TRIGGER "email_aenderung_nie_loeschen" ON "cockpit"."email_aenderung";
DROP TRIGGER "einladung_nie_loeschen" ON "cockpit"."einladung";
DROP TRIGGER "user_nie_loeschen" ON "cockpit"."user";

DROP TRIGGER "ersatzcode_archivieren" ON "cockpit"."ersatzcode";
DROP TRIGGER "passkey_archivieren" ON "cockpit"."passkey";
DROP TRIGGER "twofactor_archivieren" ON "cockpit"."twoFactor";
DROP FUNCTION "cockpit"."zugangsmittel_archivieren"();
DROP TABLE "cockpit"."zugangsmittel_archiv";

ALTER TABLE "cockpit"."agent" DROP COLUMN "entfernt_am";

DROP TRIGGER "user_loeschmarke" ON "cockpit"."user";
DROP FUNCTION "cockpit"."konto_loeschmarke_pruefen"();
ALTER TABLE "cockpit"."user"
    DROP CONSTRAINT "user_geloescht_platzhalter",
    DROP CONSTRAINT "user_geloescht_vollstaendig",
    DROP COLUMN "geloescht_email",
    DROP COLUMN "geloescht_von",
    DROP COLUMN "geloescht_am";
