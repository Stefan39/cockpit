-- Nimmt 0010 zurück. Das Protokoll lässt sich nicht bereinigen (0009), vorhandene
-- Einträge mit der neuen Art bleiben also stehen. Die alte Bedingung gilt deshalb
-- `NOT VALID`: sie prüft nur neue Einträge, nicht die vorhandenen. Ein späteres
-- `up` ersetzt sie wieder durch die vollständig geprüfte Fassung.
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
        'betreuer_uebergeben'
    )) NOT VALID;
