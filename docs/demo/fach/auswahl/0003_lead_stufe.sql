-- Demo-Modul „Auswahl", Fachmigration 0003 (COPI-244): die Stufe des Eintrags im Fremdsystem als Schritt. Eine
-- Funnel-Auswertung braucht Interview, gewonnen und verloren; die kennt nur das Fremdsystem. Ein n8n-Workflow liest die
-- Stufe über dessen API und schreibt sie als neuen Schritt.
--
-- Nur hinzufügend (Regeln: `docs/modul-vertrag.md`, „Fachmigrationen"): die Spalte `lead_stufe` und die Art
-- `lead_stufe`. Die Werte entsprechen der Stufen-Aufzählung des Fremdsystems (new, contacted, interview, offer,
-- negotiation, won, lost); die Übersetzung macht n8n. Die Stufe steht nur bei der Art `lead_stufe`, und umgekehrt.
--
-- Rechte bleiben unverändert: INSERT und SELECT auf der Tabelle decken die neue Spalte ab.
BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM auswahl._migration WHERE version = 3) THEN
        RAISE EXCEPTION 'fach_migration: auswahl 0003 ist schon eingespielt';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auswahl._migration WHERE version = 2) THEN
        RAISE EXCEPTION 'fach_migration: auswahl 0002 fehlt';
    END IF;
END;
$$;

ALTER TABLE auswahl.schritt
    ADD COLUMN lead_stufe text,
    DROP CONSTRAINT schritt_art_bekannt,
    ADD CONSTRAINT schritt_art_bekannt CHECK (art IN ('bewerbung', 'beworben', 'aussortiert', 'wieder_offen', 'lead_stufe')),
    ADD CONSTRAINT schritt_lead_stufe_bekannt CHECK (lead_stufe IN ('neu', 'in_kontakt', 'interview', 'angebot', 'verhandlung', 'gewonnen', 'verloren')),
    ADD CONSTRAINT schritt_lead_stufe_nur_dort CHECK ((art = 'lead_stufe') = (lead_stufe IS NOT NULL));

INSERT INTO auswahl._migration (version, herkunft)
VALUES (3, coalesce(nullif(current_setting('fach.herkunft', true), ''), 'unbekannt'));

COMMIT;
