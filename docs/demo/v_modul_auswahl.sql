-- Demo-Modul „Auswahl" (COPI-91): die Modul-View über `auswahl.treffer` und `auswahl.schritt` (Fachmigration 0001), zum
-- Block `auswahl.cockpit.yaml` (Ansichtstyp `liste-detail`).
--
-- **Status** aus dem jüngsten Schritt: ohne Schritt, `bewerbung` und `wieder_offen` gelb (wartet auf eine Entscheidung —
-- das Wort „Offen" kommt aus `statuswoerter` im Block), `beworben` grün, `aussortiert` „Passt nicht" (kein Farbwert: ein
-- neutraler Punkt mit diesem Wort).
--
-- **Fenster:** offene Treffer immer, erledigte und aussortierte 30 Tage nach dem letzten Schritt.
--
-- Aussortiertes (Art `aussortiert`, COPI-240) wird gespeichert, aber nie angezeigt.
--
-- Stufen (Art `lead_stufe`, COPI-244) kommen aus dem Fremdsystem über n8n und ändern den Stand nur als Zusatz: Status und
-- Entscheidung hängen weiter am jüngsten anderen Schritt.
--
-- Für den Eingriff `entscheiden` (Abschnitt `entscheidung:` im Block) hängt am Ende der jüngste Entwurf
-- (`bewerbung`, `bewerbung_fassung`).
--
-- Direkt auf Tabellen (Vertrag: keine Zwischen-View).
CREATE VIEW cockpit.v_modul_auswahl AS
SELECT t.id::text AS id,
       t.titel,
       CASE s.art WHEN 'beworben' THEN 'gruen' WHEN 'aussortiert' THEN 'Passt nicht' ELSE 'gelb' END AS status,
       greatest(t.gefunden_am, s.angelegt_am, ls.angelegt_am) AS aktualisiert_am,
       CASE WHEN t.art = 'grenzfall' THEN 'Grenzfall' END AS marke,
       CASE t.kategorie WHEN 'entwicklung' THEN 'Entwicklung' WHEN 'ki' THEN 'KI' WHEN 'sonstiges' THEN 'Sonstiges' END AS kategorie,
       t.plattform,
       t.auftraggeber,
       t.honorar,
       t.umfang,
       t.ort,
       CASE s.art
            WHEN 'bewerbung' THEN 'Entwurf liegt vor'
            WHEN 'beworben' THEN 'Erledigt' || coalesce(', Stufe: ' || ls.anzeige, '')
            WHEN 'aussortiert' THEN 'Aussortiert'
            ELSE 'Neu, wartet auf Entscheidung' END AS stand,
       t.gefunden_am,
       CASE t.quelle WHEN 'manuell' THEN 'Manuell' ELSE 'Assistent' END AS quelle,
       t.url,
       l.lead_url,
       t.einschaetzung,
       t.ausschreibung,
       b.text AS bewerbung,
       b.fassung AS bewerbung_fassung,
       ls.anzeige AS lead_stufe
  FROM auswahl.treffer t
  LEFT JOIN LATERAL (
       SELECT x.art, x.angelegt_am FROM auswahl.schritt x WHERE x.treffer_id = t.id AND x.art <> 'lead_stufe' ORDER BY x.id DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
       SELECT x.text, (SELECT count(*) FROM auswahl.schritt y WHERE y.treffer_id = t.id AND y.art = 'bewerbung')::integer AS fassung
         FROM auswahl.schritt x WHERE x.treffer_id = t.id AND x.art = 'bewerbung' ORDER BY x.id DESC LIMIT 1
  ) b ON true
  LEFT JOIN LATERAL (
       SELECT x.lead_url FROM auswahl.schritt x WHERE x.treffer_id = t.id AND x.art = 'beworben' ORDER BY x.id DESC LIMIT 1
  ) l ON true
  LEFT JOIN LATERAL (
       SELECT x.lead_stufe, x.angelegt_am,
              CASE x.lead_stufe WHEN 'neu' THEN 'Neu' WHEN 'in_kontakt' THEN 'In Kontakt' WHEN 'interview' THEN 'Interview'
                   WHEN 'angebot' THEN 'Angebot' WHEN 'verhandlung' THEN 'Verhandlung' WHEN 'gewonnen' THEN 'Gewonnen'
                   WHEN 'verloren' THEN 'Verloren' END AS anzeige
         FROM auswahl.schritt x WHERE x.treffer_id = t.id AND x.art = 'lead_stufe' ORDER BY x.id DESC LIMIT 1
  ) ls ON true
 WHERE t.art <> 'aussortiert'
   AND (s.art IS NULL
    OR s.art IN ('bewerbung', 'wieder_offen')
    OR greatest(s.angelegt_am, ls.angelegt_am) > now() - interval '30 days');
