-- Epic E2 (COPI-24): Neue Protokollart `erststart_token_erzeugt`.
--
-- Ein neues Erststart-Token öffnet den Weg zum Betreuer-Konto und ist deshalb ein
-- sicherheitsrelevantes Ereignis: beim Start der Anwendung (Akteur `system`) und
-- beim Server-Kommando (Akteur `konsole`). Der Eintrag nennt nie das Token selbst.
--
-- Nach dem Muster aus 0009: eine neue Art braucht eine Migration, die die Bedingung
-- erweitert (und den Eintrag in PROTOKOLL_ARTEN in src/auth/protokoll.ts).
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
    ));
