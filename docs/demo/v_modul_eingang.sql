-- Modul „Eingang" (COPI-88): die Modul-View über die Fachtabelle `eingang.vorgang`
-- (`fach/eingang/0001_vorgang.sql`), zum Block `eingang.cockpit.yaml` (Ansichtstyp `liste-detail`).
--
-- Status: `neu` und `entwurf` warten auf einen Menschen (gelb), alles danach ist gruen. Rot gibt es hier nicht — eine
-- Mail ist kein Ausfall.
--
-- **Fenster:** die letzten 14 Tage (Entscheidung vom 01.10.2026), dazu seit COPI-90 jeder ältere Vorgang, dessen
-- Entwurf noch nicht gesendet ist — er wartet auf eine Freigabe und darf nicht aus der Liste fallen. Eine Mail ohne
-- Entwurf fällt nach 14 Tagen heraus (die Schreibrolle setzt keinen Stand, sonst blieben alle für immer).
--
-- **Stand:** aus Entwurf und Versand (Fachmigration 0003): gesendet, sobald die jüngste Fassung rausging; im Entwurf,
-- solange es eine Fassung gibt und der Stand noch offen ist; sonst wie bisher aus `stand`. Ob eine Fassung freigegeben
-- ist, weiß nur das Cockpit (`cockpit.freigabe`) — die View nicht.
--
-- Für den Eingriff `antwort_freigeben` (Abschnitt `freigabe:` im Block) hängen am Ende: die jüngste Fassung des
-- Entwurfs (`entwurf`, `entwurf_fassung`, `entwurf_an`, `entwurf_betreff`) und wann sie gesendet wurde (`gesendet_am`).
--
-- Braucht Fachmigration 0003 (Entwurf, Versand; davor 0002 `text`); der Block verlangt sie mit `fach: … mindestens: 3`.
-- Direkt auf der Tabelle (Vertrag: für Kundenrollen keine Zwischen-View). Kein `text_intern` — es gibt hier keins.
CREATE VIEW cockpit.v_modul_eingang AS
SELECT v.id::text AS id,
       v.betreff AS titel,
       CASE WHEN s.gesendet_am IS NOT NULL THEN 'gruen' WHEN v.stand IN ('neu', 'entwurf') THEN 'gelb' ELSE 'gruen' END AS status,
       greatest(v.stand_seit, e.angelegt_am, s.gesendet_am) AS aktualisiert_am,
       CASE WHEN v.absender_name IS NOT NULL AND v.absender_adresse IS NOT NULL
            THEN v.absender_name || ' <' || v.absender_adresse || '>'
            ELSE coalesce(v.absender_adresse, v.absender_name, 'unbekannt') END AS absender,
       v.kunde,
       v.zusammenfassung,
       v.vorschlag,
       CASE WHEN s.gesendet_am IS NOT NULL THEN 'Antwort gesendet'
            WHEN e.fassung IS NOT NULL AND v.stand IN ('neu', 'entwurf') THEN 'Antwort im Entwurf'
            WHEN v.stand = 'neu' THEN 'Neu, wartet auf Entscheidung'
            WHEN v.stand = 'entwurf' THEN 'Antwort im Entwurf'
            WHEN v.stand = 'freigegeben' THEN 'Antwort freigegeben'
            WHEN v.stand = 'gesendet' THEN 'Antwort gesendet'
            ELSE 'Erledigt' END AS stand,
       v.eingang,
       v.anhaenge,
       v.postfach,
       -- Seit Fachmigration 0002 (COPI-103): der Mailtext als Langtext, am Ende (sonst scheitert CREATE OR REPLACE).
       v.text,
       v.text_gekuerzt,
       -- Seit Fachmigration 0003 (COPI-90): die jüngste Fassung des Entwurfs und ihr Versand.
       e.text AS entwurf,
       e.fassung AS entwurf_fassung,
       e.an AS entwurf_an,
       e.betreff AS entwurf_betreff,
       s.gesendet_am
  FROM eingang.vorgang v
  LEFT JOIN LATERAL (
       SELECT x.fassung, x.an, x.betreff, x.text, x.angelegt_am
         FROM eingang.entwurf x
        WHERE x.vorgang_id = v.id
        ORDER BY x.fassung DESC
        LIMIT 1
  ) e ON true
  LEFT JOIN eingang.versand s ON s.vorgang_id = v.id AND s.fassung = e.fassung
 WHERE v.eingang > now() - interval '14 days'
    OR (e.fassung IS NOT NULL AND s.gesendet_am IS NULL AND v.stand IN ('neu', 'entwurf'));
