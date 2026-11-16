-- Nimmt 0016 zurück. Alle Zugänge der Agenten-API gehen verloren: Agenten, die sich damit melden,
-- werden abgewiesen, bis ein neuer Zugang angelegt ist. Das Protokoll lässt sich nicht bereinigen
-- (0009): vorhandene Einträge mit den neuen Arten bleiben stehen, die alte Bedingung gilt deshalb
-- `NOT VALID` und prüft nur neue Einträge (Muster aus 0010 und 0014).
ALTER TABLE "cockpit"."protokoll" DROP CONSTRAINT "protokoll_art_bekannt";

ALTER TABLE "cockpit"."protokoll"
    ADD CONSTRAINT "protokoll_art_bekannt" CHECK (art IN (
        'konto_angelegt',
        'einladung_erzeugt',
        'einladung_eingeloest',
        'anmeldung_erfolgreich',
        'anmeldung_fehlgeschlagen',
        'sperre_ausgeloest',
        'zweiter_faktor_eingerichtet',
        'ersatzcode_verwendet',
        'abmeldung',
        'konto_verfallen',
        'betreuer_uebergeben',
        'erststart_token_erzeugt',
        'konto_entsperrt',
        'zugang_wiederhergestellt'
    )) NOT VALID;

DROP TABLE "cockpit"."api_token";
DROP FUNCTION "cockpit"."api_token_pruefen"();
