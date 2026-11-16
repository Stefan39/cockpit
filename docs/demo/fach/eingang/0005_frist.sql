-- Modul „Eingang", Fachmigration 0005 (COPI-102): Fristen. Nach Ablauf wird nicht gelöscht (Regel „nie löschen"),
-- sondern entfernt bzw. durch Platzhalter ersetzt — die Zeilen bleiben als Nachweis, dass es den Vorgang gab.
-- Hintergrund: Aufbewahrungsfristen für personenbezogene Daten.
--
-- **Fristen (Entscheidung vom 06.10.2026):**
--   * Anhänge: der Inhalt 90 Tage nach dem Eingang der Mail (`inhalt` NULL, `inhalt_entfernt_am`). Name und SHA-256
--     bleiben bis zur 12-Monats-Frist.
--   * Mailtext und Antwortentwürfe: der Text 90 Tage nach dem Abschluss → „(entfernt nach Frist)".
--   * Absender, Betreff, Triage, Message-ID, Empfänger der Entwürfe und Dateinamen: 12 Monate nach dem Abschluss →
--     Platzhalter (`pseudonymisiert_am`).
--   * Offene Vorgänge (jüngster Entwurf ungesendet, Stand nicht gesendet/erledigt) bleiben unberührt.
-- Datenbank-Backups werden mindestens 365 Tage aufbewahrt: so lange existiert Entferntes dort noch.
--
-- **Abschluss** (`abgeschlossen_seit`): der späteste von Eingang, letztem Versand und — bei Stand gesendet/erledigt —
-- `stand_seit`. Eine Mail ohne Entwurf gilt mit ihrem Eingang als abgeschlossen: Die Schreibrolle setzt keinen Stand,
-- sonst bliebe sie für immer offen (und nach 14 Tagen fällt sie ohnehin aus der Liste des Cockpits).
--
-- **Wer:** `fristen_anwenden()`, täglich aufgerufen von einem n8n-Lauf mit der Rolle `eingang_frist`, die nur diese
-- Funktion ausführen darf (`rechte.sql`). Die Fristen stehen fest in der Funktion, nicht als Parameter: der Aufrufer
-- kann sie nicht verkürzen. Eine andere Frist ist eine neue Fachmigration. Wiederholbar: ein zweiter Lauf ändert nichts.
-- Das Cockpit ruft sie nie auf — es schreibt keine Fachtabellen (ADR).
--
BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM eingang._migration WHERE version = 5) THEN
        RAISE EXCEPTION 'fach_migration: eingang 0005 ist schon eingespielt';
    END IF;
END;
$$;

ALTER TABLE eingang.vorgang
    ADD COLUMN text_entfernt_am timestamptz,
    ADD COLUMN pseudonymisiert_am timestamptz;

ALTER TABLE eingang.entwurf
    ADD COLUMN text_entfernt_am timestamptz;

-- Die Message-ID wird nach 12 Monaten ersetzt; die Anhänge folgen ihr.
ALTER TABLE eingang.anhang
    DROP CONSTRAINT anhang_message_id_fkey,
    ADD CONSTRAINT anhang_message_id_fkey FOREIGN KEY (message_id) REFERENCES eingang.vorgang (message_id) ON UPDATE CASCADE;

-- Seit wann ein Vorgang abgeschlossen ist; NULL: offen (siehe Kopf).
CREATE FUNCTION eingang.abgeschlossen_seit(v eingang.vorgang)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = eingang, pg_temp
AS $$
    SELECT CASE
        WHEN v.stand NOT IN ('gesendet', 'erledigt')
         AND EXISTS (SELECT 1 FROM eingang.entwurf e WHERE e.vorgang_id = v.id)
         AND NOT EXISTS (
               SELECT 1 FROM eingang.versand s
                WHERE s.vorgang_id = v.id
                  AND s.fassung = (SELECT max(e.fassung) FROM eingang.entwurf e WHERE e.vorgang_id = v.id))
        THEN NULL
        ELSE greatest(v.eingang,
                      (SELECT max(s.gesendet_am) FROM eingang.versand s WHERE s.vorgang_id = v.id),
                      CASE WHEN v.stand IN ('gesendet', 'erledigt') THEN v.stand_seit END)
    END
$$;

CREATE FUNCTION eingang.fristen_anwenden()
RETURNS TABLE (anhaenge integer, texte integer, vorgaenge integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = eingang, pg_temp
AS $$
DECLARE
    n_anhaenge integer;
    n_texte integer;
    n_entwuerfe integer;
    n_vorgaenge integer;
BEGIN
    -- Anhänge: Inhalt 90 Tage nach dem Eingang.
    UPDATE eingang.anhang a
       SET inhalt = NULL, inhalt_entfernt_am = now()
      FROM eingang.vorgang v
     WHERE v.message_id = a.message_id
       AND a.inhalt IS NOT NULL
       AND v.eingang < now() - interval '90 days';
    GET DIAGNOSTICS n_anhaenge = ROW_COUNT;

    -- Mailtext und Entwürfe: Text 90 Tage nach dem Abschluss.
    UPDATE eingang.vorgang v
       SET text = '(entfernt nach Frist)', text_gekuerzt = false, text_entfernt_am = now()
     WHERE v.text IS NOT NULL
       AND v.text_entfernt_am IS NULL
       AND eingang.abgeschlossen_seit(v) < now() - interval '90 days';
    GET DIAGNOSTICS n_texte = ROW_COUNT;

    UPDATE eingang.entwurf e
       SET text = '(entfernt nach Frist)', text_entfernt_am = now()
      FROM eingang.vorgang v
     WHERE e.vorgang_id = v.id
       AND e.text_entfernt_am IS NULL
       AND eingang.abgeschlossen_seit(v) < now() - interval '90 days';
    GET DIAGNOSTICS n_entwuerfe = ROW_COUNT;

    -- Alles Personenbezogene 12 Monate nach dem Abschluss: erst Entwürfe und Anhänge, dann der Vorgang selbst (seine
    -- Marke beendet die Auswahl, ein zweiter Lauf trifft ihn nicht mehr).
    UPDATE eingang.entwurf e
       SET an = 'entfernt@invalid', betreff = '(entfernt)'
      FROM eingang.vorgang v
     WHERE e.vorgang_id = v.id
       AND v.pseudonymisiert_am IS NULL
       AND eingang.abgeschlossen_seit(v) < now() - interval '12 months';

    UPDATE eingang.anhang a
       SET dateiname = '(entfernt nach Frist)', typ = NULL,
           inhalt = NULL, inhalt_entfernt_am = coalesce(a.inhalt_entfernt_am, now())
      FROM eingang.vorgang v
     WHERE v.message_id = a.message_id
       AND v.pseudonymisiert_am IS NULL
       AND eingang.abgeschlossen_seit(v) < now() - interval '12 months';

    UPDATE eingang.vorgang v
       SET absender_name = NULL,
           absender_adresse = 'entfernt@invalid',
           betreff = '(entfernt)',
           zusammenfassung = '(entfernt nach Frist)',
           vorschlag = NULL,
           kunde = NULL,
           anhaenge = NULL,
           in_reply_to = NULL,
           message_id = CASE WHEN v.message_id IS NULL THEN NULL ELSE '<entfernt-' || v.id::text || '@cockpit.invalid>' END,
           pseudonymisiert_am = now()
     WHERE v.pseudonymisiert_am IS NULL
       AND eingang.abgeschlossen_seit(v) < now() - interval '12 months';
    GET DIAGNOSTICS n_vorgaenge = ROW_COUNT;

    RETURN QUERY SELECT n_anhaenge, n_texte + n_entwuerfe, n_vorgaenge;
END;
$$;

-- Ausführen darf nur, wem `rechte.sql` es gibt (Rolle `eingang_frist`).
REVOKE EXECUTE ON FUNCTION eingang.abgeschlossen_seit(eingang.vorgang) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION eingang.fristen_anwenden() FROM PUBLIC;

INSERT INTO eingang._migration (version, herkunft)
VALUES (5, coalesce(nullif(current_setting('fach.herkunft', true), ''), 'unbekannt'));

COMMIT;
