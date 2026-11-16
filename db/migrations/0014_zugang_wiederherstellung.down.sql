-- Nimmt 0014 zurück. Die offenen Links gehen verloren (entsperrte Konten bleiben
-- gesperrt, der Betreuer stellt neu aus). Das Protokoll lässt sich nicht bereinigen
-- (0009), vorhandene Einträge mit den neuen Arten bleiben stehen: die alte Bedingung gilt
-- deshalb `NOT VALID` und prüft nur neue Einträge (Muster aus 0010).
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
        'erststart_token_erzeugt'
    )) NOT VALID;

DROP FUNCTION "cockpit"."zweite_faktoren_entfernen"(text);

DROP TABLE "cockpit"."zugang_wiederherstellung";
