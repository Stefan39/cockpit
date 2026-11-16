-- Demo-Modul „Auswahl", Fachmigration 0002 (COPI-240): der vollständige Eingang. Der Assistent meldet künftig alle
-- Angebote, nicht nur Treffer und Grenzfälle, damit eine Trendauswertung nach Typ (Entwicklung/KI) möglich wird.
--
-- Nur hinzufügend (Regeln: `docs/modul-vertrag.md`, „Fachmigrationen"): `kategorie` (`entwicklung`, `ki`, `sonstiges`)
-- und `score` (0–100). Beide bleiben NULL für den Altbestand und manuelle Meldungen. Die Art kennt jetzt auch
-- `aussortiert`: Score ab 72 `treffer`, 60–71 `grenzfall`, darunter `aussortiert`. Aussortiertes wird gespeichert, die
-- View `v_modul_auswahl.sql` zeigt es nie an.
--
-- Rechte bleiben unverändert: INSERT und SELECT auf der Tabelle decken die neuen Spalten ab.
BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM auswahl._migration WHERE version = 2) THEN
        RAISE EXCEPTION 'fach_migration: auswahl 0002 ist schon eingespielt';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auswahl._migration WHERE version = 1) THEN
        RAISE EXCEPTION 'fach_migration: auswahl 0001 fehlt';
    END IF;
END;
$$;

ALTER TABLE auswahl.treffer
    ADD COLUMN kategorie text,
    ADD COLUMN score smallint,
    ADD CONSTRAINT treffer_kategorie_bekannt CHECK (kategorie IN ('entwicklung', 'ki', 'sonstiges')),
    ADD CONSTRAINT treffer_score_bereich CHECK (score BETWEEN 0 AND 100),
    DROP CONSTRAINT treffer_art_bekannt,
    ADD CONSTRAINT treffer_art_bekannt CHECK (art IN ('treffer', 'grenzfall', 'aussortiert'));

CREATE INDEX treffer_kategorie_gefunden ON auswahl.treffer (kategorie, gefunden_am DESC);

INSERT INTO auswahl._migration (version, herkunft)
VALUES (2, coalesce(nullif(current_setting('fach.herkunft', true), ''), 'unbekannt'));

COMMIT;
