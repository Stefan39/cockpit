# Modul-Vertrag des Cockpits — der `cockpit:`-Block

Stand: COPI-137 (`euro` in Liste+Detail), 09.10.2026; davor COPI-134 (`art`, Betreuer-Zugriff), 09.10.2026; davor COPI-131 (`formatierung: einfach`, Liste neueste zuerst), 09.10.2026; davor COPI-103 (Format `langtext`), 01.10.2026; davor COPI-107 (Fachmigrationen, Feld `fach`); davor COPI-98 (Ansichtstyp Kennzahlen), 30.09.2026; davor COPI-85 (Übernahme-Sperre), 28.09.2026; davor COPI-83 (Messwerte und Kurven); davor COPI-82 (Kacheln der Modulseite), Grundlage COPI-81 (Karten auf der Übersicht) und COPI-79. Grundlage für den optionalen `cockpit:`-Block in den
Agent-Blueprints im Repo `agent-blueprints` (dort eigene PRs, Schema `schema/agent.schema.json`). Dieses Dokument
soll genügen, um ein Fachmodul als Modulseite anzubinden, ohne in den Code des Cockpits zu sehen. Weicht der Code
davon ab, ist das ein Fehler — im Code oder hier.

Architektur: Betriebs-Cockpit (Architektur-Vorschlag),
Abschnitte 5 und 13.1 — „Modulseiten sind deklariert, nicht programmiert".

## Worum es geht

Ein Fachmodul bekommt eine Seite im Cockpit, ohne dass im Cockpit-Image eine Zeile Code dazukommt. Der Vertrag hat
genau zwei Teile:

| Teil | Wer liefert | Wo es lebt |
| --- | --- | --- |
| **Eine SQL-View** `cockpit.v_modul_<name>` mit festen Pflichtspalten | das Fachmodul (bzw. wer es aufsetzt) | in der Datenbank der Instanz, Schema `cockpit` |
| **Ein `cockpit:`-Block** (YAML): Kennung, Menüname, Ansichtstyp, View, Spalten, Rollen | die Agent-Blueprint-YAML | in der Registry `cockpit.modul`, eingespielt per Server-Kommando |

Das Cockpit liest die View **nur**, schreibt nie hinein und führt nichts aus. Die Registry lebt in der Datenbank,
nicht im Image: ein neues oder geändertes Modul wirkt sofort, ohne Image-Wechsel und ohne Neustart.

## Der Block

```yaml
cockpit:
  kennung: server-zustand
  menuename: "Server & Dienste"
  ansicht: liste-detail
  view: v_modul_server_zustand
  spalten:
    - { name: titel, label: "Bereich" }
    - { name: status, label: "Status" }
    - { name: text, label: "Meldung" }
    - { name: aktualisiert_am, label: "Zuletzt gemeldet", format: zeitpunkt }
  rollen: [betreuer, betriebs_admin]
  eingriffe: []
```

Alle Felder sind Pflicht — bis auf `darstellung` (Standard `liste`, siehe „Darstellung der Modulseite" unten), den
Abschnitt `uebersicht:` (siehe „Karten auf der Übersicht") und die in der Tabelle als optional markierten; ein **unbekanntes Feld** wird abgelehnt (ein Tippfehler soll auffallen, nicht still
ignoriert werden).

| Feld | Regel | Bedeutung |
| --- | --- | --- |
| `kennung` | `^[a-z0-9][a-z0-9-]{0,62}$` — Kleinbuchstaben, Ziffern, Bindestrich; kein `_`, kein `.` | Name des Moduls in der Adresse (`/module/<kennung>`) und in der Registry. Bleibt über alle Versionen gleich. |
| `menuename` | 1–40 Zeichen | So heißt das Modul in der Oberfläche, in Betriebssprache („Buchungen", nicht „booking-sync"). |
| `ansicht` | einer von `liste-detail`, `verlauf`, `belegung`, `aufgaben`, `kennzahlen` | Ansichtstyp. **Umgesetzt sind `liste-detail` und `kennzahlen`** (siehe „Ansichtstyp Kennzahlen" unten — dort gelten eigene Regeln für `spalten` und die View); die anderen drei sind gültiges YAML, werden aber mit „noch nicht umgesetzt" abgelehnt. |
| `view` | `^v_modul_[a-z0-9_]{1,55}$`, **ohne** Schema-Präfix | Name der View im Schema `cockpit`. Das Präfix `v_modul_` ist Pflicht: es trennt Modul-Views sichtbar von den Tabellen des Cockpits. |
| `spalten` | mindestens eine; je Spalte `name` (`^[a-z_][a-z0-9_]{0,62}$`), `label` (1–80 Zeichen), `format` optional | Die Felder der Detailseite, in dieser Reihenfolge, mit diesem Label. |
| `spalten[].format` | `text` (Standard), `zeitpunkt`, `zahl`, `euro`, `langtext`, `link` | `zeitpunkt`: Uhrzeit Europe/Berlin, bei einem anderen Tag mit Datum davor; `zahl`: deutsche Schreibweise (`5.000`, `0,5`); `euro` (seit COPI-137 auch in Liste+Detail, ab Cockpit v0.23.0): Betrag „12.345,60 €“; `langtext` (COPI-103): langer Fremdtext, siehe „Langtext“ unten; `link` (COPI-91): URL als Link, siehe „Link“ unten; `NULL` zeigt sich immer als „—“. |
| `spalten[].domains` | Pflicht bei `link`, sonst verboten; 1–20 Hosts | Wohin ein Link führen darf (siehe „Link" unten). Ab Cockpit v0.17.0. |
| `spalten[].gekuerzt` | nur bei `langtext`; `{ spalte, hinweis }` | Eine Spalte der View, die „gekürzt“ meldet (`true`), und der Satz (1–160 Zeichen), den die Seite dann unter dem Text zeigt. |
| `spalten[].formatierung` | nur bei `langtext`; nur `einfach` (COPI-131) | Den Langtext mit einfacher Formatierung zeigen, siehe „Langtext“ unten. Ab Cockpit v0.22.0. |
| `art` | optional; `fach` (Standard) oder `betrieb` (COPI-134) | `fach`: Fachdaten des Kunden — der Betreuer sieht das Modul nur, wenn der Betriebs-Admin es freigibt (README „Betreuer-Zugriff auf Fachmodule"). `betrieb`: technisches Modul ohne Fachdaten (Server-Zustand, KI-Verbrauch), das der Betreuer immer sieht. Ab Cockpit v0.23.0. |
| `rollen` | mindestens eine von `betreuer`, `betriebs_admin`, `betrieb_mitarbeiter` | Welche Kundenrollen das Modul sehen. Ein Fachmodul braucht mindestens `betriebs_admin` oder `betrieb_mitarbeiter`, sonst lehnt das Einspielen es ab (ab v0.23.0); `betreuer` gilt nur bei `art: betrieb`. |
| `eingriffe` | Liste von Namen aus `uebernehmen`, `antwort_freigeben`, `entscheiden` | Was ein Mensch auf der Detailseite tun kann (siehe „Übernahme" und „Antwort freigeben" unten); jeder andere Name wird mit „noch nicht umgesetzt" abgelehnt. `antwort_freigeben` braucht den Abschnitt `freigabe:`. |
| `darstellung` | optional; `liste` (Standard) oder `kacheln`; nur bei `ansicht: liste-detail` | Wie `GET /module/<kennung>` die Zeilen zeigt (siehe unten). Ohne Angabe genau das bisherige Verhalten. |
| `fach` | optional; `{ schema, mindestens }` | Die Fachmigrationen, die der Block mindestens braucht (siehe „Fachmigrationen" unten). Ohne Angabe keine Prüfung. |
| `agent` | optional; Kennung wie im Inventar (`^[a-z0-9][a-z0-9_.-]{0,62}$`) | Wem das Modul gehört (COPI-113, Cockpit ab v0.12.0): seine Detailseite zeigt die Zeilen (Reiter „Mails", bei `posteingang:`) und die Übernahmen darin (Protokoll). |
| `posteingang` | optional; `{ anriss, zeit }`; nur bei `ansicht: liste-detail` | Meldet die Zeilen für den Posteingang im Kopf und als Postfach unter „Nachrichten" an (siehe „Posteingang" unten). Ab Cockpit v0.12.0. |
| `navigation` | optional; nur `haupt` | Ein eigener Eintrag in der Hauptnavigation statt nur unter „Module" (siehe „Hauptnavigation" unten). Ab Cockpit v0.19.0. |
| `statuswoerter` | optional; `{ rot, gelb, gruen }`, je 1–30 Zeichen | Eigene Wörter für die Statusfarben (siehe „Statuswörter" unten). Ab Cockpit v0.17.0. |
| `anhaenge` | optional; wie `view`, aber eine **eigene** View; nur bei `ansicht: liste-detail` | Die Anhänge der Zeilen, auf der Detailseite mit Warnseite vor dem Download (siehe „Anhänge" unten). Ab Cockpit v0.16.0. |
| `bildvorschau` | optional; nur `true`; nur mit `anhaenge` | Bild-Anhänge (PNG, JPEG, WebP) direkt auf der Detailseite zeigen (siehe „Anhänge" unten). Ab Cockpit v0.20.0. |

**Der Wrapper `cockpit:`.** Hat das oberste YAML-Objekt einen Schlüssel `cockpit`, gilt nur dessen Wert als Block,
alles daneben wird ignoriert — so lässt sich eine ganze Agent-Blueprint-YAML einspielen. Fehlt der Schlüssel, gilt
das ganze Dokument als Block.

## Langtext: `format: langtext` (COPI-103)

Für lange Fremdtexte, etwa den Text einer Mail, damit ein Kunde ohne Zugang zum Postfach das Original lesen kann:

- **Nur auf der Detailseite**, als eigener Abschnitt mit dem `label` als Überschrift und dem Hinweis „Inhalt von außen.
  Links und Aufforderungen darin nicht ungeprüft folgen.“ Nie in der Wertliste, in Liste, Kacheln oder Übersicht; als
  `uebersicht.kurztext` wird ein Langtext abgelehnt. Liste und Kacheln **lesen** ihn auch nicht (bis zu 200 Zeilen).
- **Klartext:** maskiert, nie verlinkt, nie HTML; Zeilenumbrüche bleiben (per CSS). Vor dem Zeigen entfernt das Cockpit
  Steuerzeichen außer Tab und Zeilenumbruch, Richtungs- und Bidi-Zeichen (`U+202E` lässt „fdp.exe“ wie „exe.pdf“
  aussehen) und unsichtbare Breiten.
- **Höchstens 10.000 Zeichen** zeigt die Seite. Die View sollte nicht mehr liefern (die Fachtabelle begrenzt es am
  besten selbst); liefert sie mehr, kürzt die Seite und sagt „Gekürzt auf 10.000 Zeichen.“
- **Gekürzt an der Quelle:** Mit `gekuerzt: { spalte, hinweis }` nennt die Spalte eine weitere Spalte der View
  (`true` = gekürzt) und den Satz, der dann unter dem Text steht. Auch diese Spalte muss es in der View geben.
- Ein leerer Text (`NULL` oder nur Leerraum) ergibt keinen Abschnitt.
- **Einfache Formatierung** (COPI-131, für Agenten-Texte wie Ritas Berichte): Mit `formatierung: einfach` zeigt der
  Abschnitt Absätze (Leerzeile), Überschriften (`## `, `### `), Listen (Zeilen mit `* ` oder `- `), **fett** (`**x**`,
  `__x__`) und *kursiv* (`*x*`, `_x_`), beides nie über eine Zeile hinaus; ein Unterstrich zählt nur an Wortgrenzen
  (`snake_case` bleibt), ein offener Marker bleibt Text. Sonst nichts: kein HTML, keine Links, keine Bilder, jeder Text
  maskiert. Ohne das Feld bleibt der Langtext Klartext (etwa Mails). Ein Entwurf (`entscheidung.entwurf.format:
  einfach`) bekommt fett und kursiv bewusst nicht: ein `**` im Post soll sichtbar bleiben.

```yaml
    - name: text
      label: "Nachricht"
      format: langtext
      gekuerzt: { spalte: text_gekuerzt, hinweis: "Gekürzt auf 10.000 Zeichen. Der vollständige Text liegt im Postfach." }
```

## Link: `format: link` (COPI-91)

Eine Spalte mit einer URL (etwa die Ausschreibung eines Projekts oder ein Lead im Admin-Bereich eines Lead-Systems) wird auf der
Detailseite zum Link nach außen — **die einzige Ausnahme** von „Moduldaten nie verlinken" (Entscheidung Stefan,
06.10.2026). Deshalb ist die Liste der erlaubten Domains Pflicht:

```yaml
    - { name: url, label: "Ausschreibung", format: link, domains: [portal-a.example.com, portal-b.example.org] }
```

- Verlinkt wird nur `https`, ohne Zugangsdaten und ohne Port, und nur, wenn der Host einer der `domains` ist (genau
  oder als Subdomain: `portal-a.example.com` erlaubt `www.portal-a.example.com`, nicht `portal-a.example.com.evil.example`).
- Der Linktext ist der Host ohne `www.`, nie die ganze URL; der Link öffnet mit `noopener noreferrer` in einem neuen Tab.
- Alles andere bleibt Text. In Kacheln steht nur der Host. Als `kurztext` einer Übersichtskarte und als `anriss` im
  Posteingang ist ein Link nicht erlaubt.

## Statuswörter: `statuswoerter` (optional, COPI-91)

Die drei Farben der Pflichtspalte `status` heißen überall „Störung", „Achtung" und „Läuft". Ein Modul, für das das nicht
passt, nennt eigene Wörter — die Farbe bleibt:

```yaml
  statuswoerter: { gelb: "Offen", gruen: "Beworben" }
```

Je Farbe 1–30 Zeichen, nicht genannte Farben behalten ihr Wort. Gilt in Liste, Detailseite, Kacheln, Übersicht und
Postfach. Ein Wert außerhalb der drei Farben (etwa `Passt nicht`) zeigt weiterhin sich selbst mit neutralem Punkt.

## Darstellung der Modulseite: `darstellung` (optional, COPI-82)

`GET /module/<kennung>` zeigt die Zeilen der Modul-View standardmäßig als Liste (`darstellung: liste` oder ganz
ohne das Feld — beides ist gleich). Mit `darstellung: kacheln` zeigt dieselbe Adresse stattdessen ein Kartenraster,
sortiert wie die Liste (rot → gelb → grün, darin das zuletzt Geänderte zuerst):

- **Kopf der Kachel:** Kürzel, `titel` und die Pflichtspalte `status` als Punkt + Wort.
- **Felder der Kachel:** die in `spalten` deklarierten Spalten **außer** `titel`, `status` und `aktualisiert_am` —
  die stehen schon im Kopf bzw. der Fußzeile. Formatiert wie auf der Detailseite (`spalten[].format`).
- **„Letzte 7 Tage":** ein Band aus derselben Verlaufs-View wie das Dashboard der Übersicht (`uebersicht.verlauf`,
  siehe unten) — 28 Sechs-Stunden-Eimer statt der 24 Ein-Stunden-Eimer des Dashboards, dieselbe Rechnung. **Ohne**
  `uebersicht.verlauf` (oder scheitert ihre Katalogprüfung bzw. das Lesen) entfällt der ganze Block; anders als im
  Dashboard gibt es auf der Modulseite kein neutrales Band ohne Daten.
- **Fußzeile:** `aktualisiert_am`, formatiert wie überall im Cockpit, und ein Verweis auf die Detailseite (die ganze
  Kachel ist bereits der Link).
- **Filter ohne Skript:** `?status=gruen|gelb|rot` an derselben Adresse, serverseitig gefiltert; ein Chip „Alle"
  und je Zustand einer, jeweils mit der Anzahl **aller** Zeilen (nicht nur der gerade gezeigten).

Die Detailseite (`GET /module/<kennung>/<id>`) ändert `darstellung` nicht: sie zeigt unverändert alle deklarierten
Spalten mit Label (siehe unten), am Desktop weiterhin mit der kompakten Liste links.

## Die View

### Pflichtspalten (Ansichtstyp `liste-detail`)

| Spalte | Postgres-Typ (genau dieser) | Bedeutung |
| --- | --- | --- |
| `id` | `text` | Eindeutig je Zeile, stabil über die Zeit; steht in der Adresse der Detailseite (`/module/<kennung>/<id>`). |
| `titel` | `text` | Zeilentext der Liste und Überschrift der Detailseite. |
| `status` | `text` | `gruen`, `gelb` oder `rot` — gezeigt als Punkt und Wort („Läuft", „Achtung", „Störung"). |
| `aktualisiert_am` | `timestamp with time zone` | Stand der Zeile, formatiert wie jeder Zeitpunkt im Cockpit. |

Der Typ wird **genau** geprüft: `varchar`, `integer` oder `timestamp` ohne Zeitzone werden abgelehnt. Im Zweifel in
der View casten (`kennung::text AS id`, `gemeldet_am::timestamptz AS aktualisiert_am`).

Ein `status` außerhalb von `gruen`/`gelb`/`rot` bringt die Seite nicht zum Scheitern — die Zeile zeigt dann einen
neutralen Punkt und den Wert selbst. Das ist ein Fehler in der View, kein erlaubter vierter Zustand.

### Optionale Spalte: Marke (COPI-91)

| Spalte | Postgres-Typ (genau dieser) | Bedeutung |
| --- | --- | --- |
| `marke` | `text` | Eine kurze Marke neben der Zeit in der Liste, etwa „Grenzfall" (höchstens 40 Zeichen, maskiert). `NULL` oder leer: keine. |

### Optionale Spalten: Messwert (COPI-83)

| Spalte | Postgres-Typ (genau dieser) | Bedeutung |
| --- | --- | --- |
| `wert` | `numeric` | Der aktuelle Messwert der Zeile („86"). Ohne diese Spalte — oder mit `NULL` — zeigt die Zeile keinen Wert, genau wie bisher. |
| `einheit` | `text` | Einheit zum Wert: `%`, `ms`, `Tage`, `von 5`. Gezeigt mit Leerzeichen („86 %"), immer maskiert. |
| `wert_max` | `numeric` | Obergrenze (> 0): ergibt auf der Karte den Füllbalken und „von 100 %". Beginnt die Einheit mit „von ", entfällt der Bezug („5 von 5"). |
| `wert_warnung` | `numeric` | Warnschwelle: ergibt auf der Kachel die gestrichelte Warnlinie der Kurve. |

Die Spalten dürfen fehlen, einzeln oder alle. **Sind sie da, wird ihr Typ genau geprüft** — beim Einspielen und vor
jedem Lesen, wie bei den Pflichtspalten: `wert text` oder `einheit integer` lässt `modul-einspielen` scheitern bzw.
die Seite den neutralen Hinweis zeigen. Im Zweifel casten (`(b.messwert ->> 'wert')::numeric AS wert`). Für
Kundenrollen gilt dieselbe Regel wie für Texte: **nur Messwerte aus kundensichtbaren Befunden** (bzw. aus Daten,
die der Kunde sehen darf) — das Cockpit kann nicht erkennen, woher eine Zahl stammt.

Weitere Spalten sind erlaubt; gezeigt wird nur, was in `spalten` deklariert ist. Die Pflichtspalten müssen dort nicht
stehen — `status` erscheint auf der Detailseite immer (fehlt er in `spalten`, vorangestellt mit dem Label „Status").

### Regeln für die View

- **Im Schema `cockpit`**, und es muss wirklich eine View sein (keine Tabelle, keine Materialized View).
- **Kein `text_intern` für Kundenrollen.** Ist irgendeine andere Rolle als `betreuer` freigegeben, darf die View die
  Spalte `text_intern` nicht verwenden — Rohbefunde des Admin-Agenten gehen nie an den Kunden (ADR). Kundensichtbar
  ist nur `text_kunde` bei `kundensichtbar = true`.
- **Für Kundenrollen direkt auf Tabellen**, nicht auf einer anderen View: sonst ließe sich `text_intern` hinter einer
  Zwischen-View (`SELECT text_intern AS harmlos …`) verstecken. Eine View nur für `betreuer` darf auf Views aufbauen.
- **Schnell genug.** Das Cockpit liest in einer eigenen, lesenden Transaktion mit **2 Sekunden** Timeout; eine
  langsamere View zeigt „Dieses Modul ist gerade nicht verfügbar."
- **Nie mehr als 200 Zeilen sichtbar.** Die Liste zeigt höchstens 200 Zeilen, sortiert nach Status (rot, gelb,
  grün, unbekannt), darin nach `aktualisiert_am` absteigend (COPI-131), bei Gleichstand nach `titel`. Blättern gibt es noch nicht; eine View, die mehr liefert, sollte selbst
  filtern (z. B. nur offene Vorgänge).
- **Eigentümer ist die Rolle `cockpit`** (die aus `DATABASE_URL`, `docs/installation.md` Abschnitt 2). Postgres prüft
  die Rechte einer View mit den Rechten ihres Eigentümers: die Rolle `cockpit` braucht deshalb `SELECT` auf jede
  Fachtabelle, aus der die View liest — und auf nichts sonst. Die View legt der Einrichter an, nie das Cockpit.
- **Dieselbe Datenbank.** Eine View kann nur lesen, was in der Datenbank des Cockpits liegt (siehe
  `docs/installation.md`, „Welche Datenbank?").

Die View wird **nicht nur beim Einspielen** geprüft, sondern **vor jedem Lesen erneut**: eine View, die nachträglich per
`CREATE OR REPLACE VIEW` gegen den Vertrag verändert wurde, zeigt keine Daten mehr, sondern den neutralen Hinweis. Der
Grund steht im Log des Cockpits (`docker compose logs cockpit`), nie auf der Seite.

Ein durchgespieltes Beispiel: [`docs/beispiele/v_modul_server_zustand.sql`](beispiele/v_modul_server_zustand.sql)
und [`docs/beispiele/server-zustand.cockpit.yaml`](beispiele/server-zustand.cockpit.yaml).

## Übernahme: `eingriffe: [uebernehmen]` (COPI-85)

Mit `eingriffe: [uebernehmen]` kann ein Mensch einen **Vorgang** übernehmen — eine Zeile der Modul-View, also
(`kennung`, `id`). Solange er übernommen ist, antworten die Agenten dort nicht (sie fragen vor jedem Senden
`GET /intern/vorgaenge/sperre` ab, Pflichtregel in [`agenten-api.md`](agenten-api.md)). Entscheidungen Stefan, 28.09.2026:

- **Wer übernimmt:** jede Rolle, die das Modul sieht (`rollen`, der Betreuer immer). **Zurückgeben:** wer übernommen
  hat, dazu Betriebs-Admin und Betreuer immer; ein anderer Mitarbeiter nicht.
- **Wirkt sofort**, kein Antrag über die Freigabekette; **kein automatischer Ablauf**; der Gast merkt nichts.
- **Oberfläche:** auf der Detailseite der Knopf „Übernehmen" mit Hinweis, danach ein Band „Von <Name> übernommen seit
  <Zeit>" mit „Zurückgeben"; in Liste, Kacheln und Dashboard-Karten die Marke „übernommen · <Vorname>".
- **Protokoll:** `vorgang_uebernommen`, `vorgang_zurueckgegeben`.

**Was das Fachmodul dafür liefern muss:** nichts weiter als eine stabile `id` (Pflichtspalte, sie ist schon da). Die
Sperre gilt für genau diese `id`; ändert die View die `id` eines Vorgangs, ist es für das Cockpit ein anderer Vorgang.
Die Agenten des Moduls brauchen einen Zugang mit dem Recht `vorgang_lesen` und müssen die Pflichtregel befolgen — sonst
ist die Übernahme nur eine Anzeige.

```yaml
  eingriffe: [uebernehmen]
```

## Antwort freigeben: `eingriffe: [antwort_freigeben]` und `freigabe:` (COPI-90)

Schreibt der Agent eines Moduls Antworten nach außen (etwa Mails), sendet er erst nach einer Freigabe im Cockpit. Der
Block nennt dafür die Spalten der View, die die **jüngste Fassung** des Entwurfs tragen — sie stehen **nicht** in
`spalten`, erscheinen nur in der Entwurfskarte der Detailseite und werden beim Einspielen und vor jedem Lesen geprüft:

```yaml
  eingriffe: [uebernehmen, antwort_freigeben]
  freigabe: { entwurf: entwurf, fassung: entwurf_fassung, empfaenger: entwurf_an, betreff: entwurf_betreff, gesendet_am: gesendet_am }
```

| Feld | Typ in der View | Bedeutung |
| --- | --- | --- |
| `entwurf` | `text` | der Text, genau wie er gesendet wird |
| `fassung` | `integer` | Nummer der Fassung (1, 2, …); ein geänderter Entwurf ist eine neue Fassung |
| `empfaenger`, `betreff` | `text`, optional | in der Karte über dem Text |
| `gesendet_am` | `timestamptz`, optional | wann diese Fassung gesendet wurde — dann zeigt die Karte den Nachweis |

- **Ablauf:** „Freigeben" → Rückfrage → Freigabe der Fassung mit SHA-256 ihres Texts (`cockpit.freigabe`, Migration
  0038). Bis zum Versand lässt sie sich zurückziehen (wer freigegeben hat, Betriebs-Admin, Betreuer). Ist der Vorgang
  übernommen, gibt es kein Freigeben. Offene Freigaben stehen als Aufgabe oben im Posteingang.
- **Wer:** jede Rolle, die das Modul sieht. **Protokoll:** `antwort_freigegeben`, `freigabe_zurueckgezogen`.
- **Was der Agent tun muss:** Pflichtregel in [`agenten-api.md`](agenten-api.md) („Antwort freigeben").
- Eine Zeile ohne Entwurf (`entwurf` NULL) zeigt keine Karte.

## Anhänge: `anhaenge:` (optional, COPI-110)

Liefert ein Modul Dateien mit (etwa die Anhänge eingegangener Mails), nennt der Block dafür eine zweite View. Die
Detailseite zeigt die Anhänge der Zeile unter den Langtexten; heruntergeladen wird nur über eine Warnseite mit
Bestätigung (Entscheidungen Stefan, 01.10. und 06.10.2026).

```yaml
  anhaenge: v_modul_kommunikation_anhaenge
```

| Spalte | Typ | Pflicht | Bedeutung |
| --- | --- | --- | --- |
| `id` | `text` | ja | Kennung des Anhangs, stabil (sie steht in der Adresse der Warnseite) |
| `vorgang_id` | `text` | ja | die `id` der Zeile in der Modul-View |
| `dateiname` | `text` | ja | Name laut Absender — Fremdtext; das Cockpit bereinigt ihn (Bidi-, Steuer-, Pfadzeichen) |
| `groesse` | `numeric` | ja | Größe in Byte laut Absender, für die Anzeige |
| `inhalt` | `bytea` | ja | der Inhalt; `NULL`: liegt nur im Postfach (zu groß, oder nach der Frist entfernt) |
| `typ` | `text` | nein | Content-Type laut Absender — nur Anzeige, nie Grundlage der Einstufung |
| `position` | `integer` | nein | Reihenfolge in der Liste; sonst nach Name |

- **Sichtbar ist ein Anhang nur zu einer Zeile, die in der Modul-View steht** (Rollen, Fenster der View). Alles andere,
  auch eine erfundene oder fremde Anhang-`id`, endet in der neutralen 404.
- **Einstufung durch das Cockpit**, nach Endung und den ersten 16 Byte: *gesperrt* (ausführbar: `.exe .msi .bat .cmd
  .com .scr .ps1 .vbs .js .jse .wsf .jar .lnk .iso .img .dll .hta .reg .msc` oder Inhalt MZ/PE, ELF, Mach-O — nie
  auslieferbar), *Warnung* (Archive, Office mit Makros und das alte Office-Format, HTML, SVG, Widerspruch zwischen Endung
  und Inhalt — Download nach Pflicht-Haken), *liegt im Postfach* (kein Inhalt oder über 10 MB), sonst *normal*.
- **Download:** höchstens 10 MB (das Cockpit misst selbst), 10 s Zeitgrenze, höchstens zwei gleichzeitig, immer als
  `attachment` mit strengen Headern. Die Bestätigung bindet den SHA-256, den die Warnseite gezeigt hat: ändert sich der
  Inhalt dazwischen, wird nichts geliefert.
- **Nachweis:** `cockpit.anhang_download` (Migration 0044) und Protokoll `anhang_heruntergeladen`. **Wer:** jede Rolle,
  die das Modul sieht.
- Für Kundenrollen gilt dieselbe Regel wie für die Modul-View: direkt auf Tabellen, kein `text_intern`. Die Rolle
  `cockpit` braucht `SELECT` auf die Tabellen, aus denen die View liest.
- Fristen (Inhalt nach Ablauf entfernen) gehören zum Fachmodul, nicht ins Cockpit (Kommunikation: COPI-102).

### Bildvorschau: `bildvorschau: true` (optional, COPI-124)

Für Module, deren Anhänge Bilder sind, die man ansehen muss (Beispiel: Bilder für Beiträge), zeigt die
Detailseite Bild-Anhänge direkt unter der Entscheidungskarte. Vorschau gibt es nur, wenn **Endung und Inhalt** PNG, JPEG
oder WebP sind und der Anhang sonst ganz normal ist (keine Warnung, kein Widerspruch, höchstens 10 MB) — nie für GIF
oder SVG. Ausgeliefert wird über `GET /module/<kennung>/<id>/anhang/<anhang>/bild` mit denselben Prüfungen wie der
Download, als `inline` mit dem erkannten Typ (nie dem aus der View), `nosniff`, `no-store` und Sandbox-CSP. Eine
Vorschau ist kein Download und wird nicht als Download nachgewiesen; das Original lädt man weiter über die Liste mit
Warnseite.

## Entscheiden: `eingriffe: [entscheiden]` und `entscheidung:` (COPI-91)

Ein Mensch entscheidet über einen Vorgang, der Agent des Moduls handelt danach (Beispiel „Akquise": Interessant →
Bewerbungsentwurf, Beworben → Lead). Die Karte steht oben auf der Detailseite:

```yaml
  eingriffe: [entscheiden]
  entscheidung:
    titel: "Freigabe des Angebots"
    hinweis: "Wird protokolliert."                                 # optional
    optionen:
      - { wert: annehmen, label: "Angebot annehmen", kurz: "Angenommen", primaer: true }
      - { wert: ablehnen, label: "Ablehnen", kurz: "Abgelehnt", wenn: [offen, annehmen] }
      - { wert: unterschrieben, label: "Vertrag unterschrieben", kurz: "Unterschrieben", wenn: [annehmen] }
    entwurf: { spalte: angebot_text, fassung: angebot_fassung, titel: "Angebot" }   # optional
```

| Feld | Regel | Bedeutung |
| --- | --- | --- |
| `optionen` | 1–10 Optionen (bis Cockpit v0.25.0: 1–6) | Die Knöpfe; welche gerade gehen, bestimmen `wenn` und `entwurf`. Zehn ab COPI-146 („Social": vier zur Themenwahl, vier zum Post) |
| `optionen[].wert` | `^[a-z][a-z_]{0,29}$`, nicht `offen`, je Wert einmal | Was gespeichert und dem Agenten gemeldet wird |
| `optionen[].label` / `kurz` | 1–60 / 1–30 Zeichen | Beschriftung des Knopfs / Wort für Marke und Band |
| `optionen[].wenn` | optional, Standard `[offen]` | In welchem Stand die Option angeboten wird: `offen` (keine Entscheidung) oder Werte anderer Optionen |
| `optionen[].entwurf` | optional, `mit` oder `ohne`; nur mit `entwurf:` | Nur anbieten, wenn die Zeile gerade einen Entwurf hat (`mit`) bzw. keinen (`ohne`) — etwa „Thema wählen" vor dem Artikel, „Freigeben" erst danach. Der Server prüft es beim Absenden erneut. Ab Cockpit v0.21.0 (COPI-125). |
| `entwurf.spalte` / `fassung` | `text` / `integer` in der View | Ein Text des Agenten zur Zeile, in der Karte mit „Text kopieren" (nicht in `spalten`) |
| `entwurf.format` | optional, nur `einfach` | Den Entwurf mit einfacher Formatierung zeigen: Absätze (Leerzeile), Überschriften (`## `, `### `), Listen (Zeilen mit `* ` oder `- `). Sonst nichts — keine Links, kein HTML, alles maskiert. „Text kopieren" nimmt den Originaltext. Ab Cockpit v0.21.0. |
| `aufgabe` | optional, `true`/`false` (Standard) | Jede offene Zeile (Status `rot` oder `gelb`) ist eine Aufgabe: sie steht unter „Freigaben" im Posteingang (mit Push) und in „Zu tun", bis sie nicht mehr offen ist. Anriss ist `uebersicht.kurztext`. Ab Cockpit v0.20.0 (COPI-124). |

- Gespeichert wird im Cockpit (`cockpit.entscheidung`, Migration 0045), nie in der Fachtabelle; jede Entscheidung und
  jeder Rückzug steht im Protokoll (`entscheidung_getroffen`, `entscheidung_zurueckgenommen`). Es gilt die jüngste nicht
  zurückgenommene; „Zurücknehmen" macht die davor wieder geltend.
- Das Formular bindet Konto, Vorgang, Wert und den gezeigten Stand; der Server prüft `wenn` erneut. Hat inzwischen jemand
  anders entschieden, wird nichts gespeichert und die Seite sagt es.
- In der Liste trägt eine Zeile mit geltender Entscheidung die Marke „<kurz> · <Vorname>".
- **Wer:** jede Rolle, die das Modul sieht. **Was der Agent tun muss:** `agenten-api.md`, „Entscheidungen".

## Karten auf der Übersicht: `uebersicht:` (optional)

Seit COPI-81 (Entscheidung Stefan, 28.09.2026) meldet ein Modul seine Karten für das Dashboard der Übersicht (`/`)
selbst an — mit einem zusätzlichen Abschnitt im Block. Ohne ihn erscheint das Modul nur unter „Module".

```yaml
  uebersicht:
    titel: "Server & Dienste"                   # optional
    kurztext: text                              # Pflicht
    verlauf: v_modul_server_zustand_verlauf     # optional
    reihenfolge: 10                             # optional
    art: karten                                 # optional: karten (Standard) oder liste
```

| Feld | Regel | Bedeutung |
| --- | --- | --- |
| `titel` | optional, 1–40 Zeichen | Überschrift des Abschnitts auf der Übersicht; ohne Angabe der `menuename`. |
| `kurztext` | Pflicht; Name einer in `spalten` **deklarierten** Spalte | Der Text der Karte (und der Satz im Zustandsband). Eine nicht deklarierte Spalte wird abgelehnt. |
| `verlauf` | optional; wie `view`: `^v_modul_[a-z0-9_]{1,55}$` | Die Verlaufs-View für die 24-Stunden-Bänder und das Wochendiagramm. Ohne sie bleiben die Bänder neutral. |
| `reihenfolge` | optional, ganze Zahl 0–1000, Standard 100 | Reihenfolge der Abschnitte (kleiner zuerst), bei Gleichstand nach `menuename`. |
| `art` | optional; `karten` (Standard) oder `liste`; `liste` ohne `verlauf` | Wie das Modul erscheint (COPI-122, ab Cockpit v0.19.0): als aufklappbarer Bereich mit Karten, der in Statuszeile, Kennzahlen und Woche zählt, oder als kompakte Liste in der Team-Reihe (siehe unten). |

Auch hier gilt: **unbekannte Felder werden abgelehnt**, und `uebersicht:` ist nur beim Ansichtstyp `liste-detail`
erlaubt. Sichtbar ist der Abschnitt nach derselben Regel wie die Modulseite (`rollen`, der Betreuer nach `art` und Freigabe).

**Karten.** Eine Karte ist eine Zeile der Modul-View: `titel`, `status`, `aktualisiert_am` und die `kurztext`-Spalte;
die ganze Karte verlinkt auf `/module/<kennung>/<id>`. Sortiert rot → gelb → grün, dann nach `titel`; je Modul
höchstens **24 Karten** (die schlimmsten), dazu „+ n weitere" mit Link aufs Modul. Ein unbekannter `status` zeigt
sich neutral mit seinem eigenen Wort und zählt für Zustandsband und Kennzahlen als gelb („im Zweifel gelb").

**Bereich (COPI-122).** Je Modul mit Karten ein aufklappbarer Bereich: der Kopf fasst zusammen („1 Störung · 3 Achtung
· 4 laufen" bzw. „Alle 8 laufen · zuletzt geprüft vor 4 Min."); offen, sobald etwas nicht grün ist. Volle Karten gibt
es nur für Gelb und Rot, grüne Zeilen stehen als kleine Chips darunter. Ist alles grün, merkt sich der Browser auf/zu.

**Team-Liste (`art: liste`, COPI-122).** Für die Arbeit eines Agenten statt eines Dienstes (etwa Maras Posts der
Woche): eine kompakte Karte in der Team-Reihe (je ½ Breite) mit höchstens vier Zeilen — offene (nicht grüne) zuerst,
dann die jüngsten nach `aktualisiert_am` —, je Zeile Titel, Status als Wort, `kurztext` und Zeit, im Kopf die Zahl der
offenen Zeilen (Rot und Gelb; ein eigenes Wort ohne Farbe wie „Nicht gewählt" zählt nicht, ab v0.21.0). Eine Liste zählt
**nicht** in Statuszeile, Kennzahlen und Woche.

### Die Verlaufs-View

| Spalte | Postgres-Typ (genau dieser) | Bedeutung |
| --- | --- | --- |
| `id` | `text` | Dieselben ids wie in der Modul-View — so findet ein Verlaufspunkt seine Karte. |
| `zeitpunkt` | `timestamp with time zone` | Wann dieser Zustand galt (bzw. gemeldet wurde). |
| `status` | `text` | `gruen`, `gelb` oder `rot`; ein anderer Wert wird übergangen. |
| `wert` | `numeric`, **optional** (COPI-83) | Der Messwert zu diesem Zeitpunkt — die Punkte der Kurven. `NULL` unterbricht die Kurve. |
| `einheit` | `text`, **optional** (COPI-83) | Wird geprüft, aber nicht gezeigt: die Einheit der Kurve ist die der Zeile in der Modul-View. |

Es gelten **dieselben Regeln wie für die Modul-View**: im Schema `cockpit`, wirklich eine View, Typen genau, für
Kundenrollen kein `text_intern` und nur Tabellen als Quelle, Eigentümer die Rolle `cockpit`. Geprüft wird beim
Einspielen (eine fehlende oder falsche Verlaufs-View lässt `modul-einspielen` scheitern) **und vor jedem Lesen**.
Gelesen wird in einer eigenen lesenden Transaktion mit **2 Sekunden** Timeout, nur die letzten **7 Tage**
(`WHERE zeitpunkt >= …`) und nur die ids der gezeigten Karten, höchstens 20.000 Zeilen — ein Index auf
(`id`, `zeitpunkt`) bzw. der Quellspalten lohnt sich. Scheitert Prüfung oder Lesen, erscheinen die Karten trotzdem,
nur die Bänder bleiben neutral; der Grund steht im Log.

**Wie gerechnet wird.** Das Band einer Karte hat 24 gleitende Stunden bis jetzt. Je Stunde gilt der **schlimmste**
Verlaufspunkt darin; eine Stunde ohne Punkt übernimmt den **zuletzt bekannten** Status davor (auch aus einem Punkt
vor dem Band, innerhalb der 7 Tage); ist nichts bekannt, bleibt sie neutral. Die jüngste Stunde zeigt zusätzlich den
aktuellen `status` der Karte (der schlimmere zählt), damit ein überfälliges Gelb sichtbar ist. Die Verfügbarkeit ist
der Anteil grüner unter den belegten Stunden, abgerundet. Das Wochendiagramm zählt je Kalendertag (Europe/Berlin)
und Stunde den schlimmsten Status über alle Karten.

Ein durchgespieltes Beispiel: [`docs/beispiele/v_modul_server_zustand_verlauf.sql`](beispiele/v_modul_server_zustand_verlauf.sql).
Reihenfolge beim Einspielen: **erst beide Views, dann der Block**.

### Messwert und Kurven (COPI-83)

Trägt eine Zeile einen `wert`, zeigt sie ihn — alles serverseitiges Inline-SVG ohne Skript, mit Textalternative
(„Plattenplatz, letzte 24 Stunden: 80 – 86 %, aktuell 86 %"):

- **Karte im Dashboard:** unter dem Kopf groß der Wert mit Einheit (bei Gelb/Rot in der Zustandsfarbe), rechts „von
  100 %" und darunter der Füllbalken (nur mit `wert_max`), dann die **24-Stunden-Kurve** aus der Verlaufs-View mit der
  Zeile „vor 24 Std. · 80 – 86 % · jetzt", dann der Kurztext. Die Kurve **ersetzt** auf dieser Karte das
  Statusband; eine Karte ohne `wert` bleibt genau wie vorher.
- **Kachel der Modulseite** (`darstellung: kacheln`): der Wert rechts im Kopf („aktuell"), über dem Band eine
  **7-Tage-Kurve** mit Tageskürzeln und „min. 71 % · max. 86 %", bei `wert_warnung` die gestrichelte Warnlinie; das
  7-Tage-Band bleibt darunter, schmaler.
- **Skalierung:** mit `wert_max` von 0 (bzw. dem kleinsten Wert, falls negativ) bis `wert_max`, sonst kleinster bis
  größter Wert mit 10 % Luft; die Warnschwelle liegt immer im Bereich. Punkte ohne `wert` unterbrechen die Linie,
  ohne jeden Wert im Zeitfenster gibt es keine Kurve (der Wert selbst erscheint trotzdem). Zahlen deutsch: `86`,
  `0,5`, `1.234`.

## Ansichtstyp Kennzahlen: `ansicht: kennzahlen` (COPI-98)

Für Module, die **Summen über einen Zeitraum** zeigen statt Zeilen mit Zustand — Kosten, Mengen, Anzahlen. Die Seite
`/module/<kennung>` zeigt dann: den Zeitraum als Chips (Heute, 7 Tage, 30 Tage, Monat, Vormonat — Links, ohne Skript),
die Kennzahlen, ein Balkendiagramm des Hauptwerts je Tag, die Aufteilungen und die Anteile. Eine Detailseite gibt es
nicht, Eingriffe auch nicht.

```yaml
cockpit:
  kennung: ki-verbrauch
  menuename: "KI-Verbrauch"
  ansicht: kennzahlen
  view: v_modul_ki_verbrauch
  spalten:
    - { name: wert, label: "Kosten", format: euro }
    - { name: tokens, label: "Tokens", format: zahl, davon: { name: tokens_cache_lesen, text: "aus dem Cache gelesen" } }
    - { name: einsaetze, label: "Einsätze", format: zahl }
  aufteilungen:
    - { name: projekt, label: "Je Projekt", filter: true, darunter: { name: ticket, label: "Je Ticket" } }
    - { name: modell, label: "Je Modell" }
  anteile:
    - { name: wert_geschaetzt, label: "geschätzt", text: "Anteil der Kosten aus geschätzten Tokens" }
    - { name: ohne_preis, label: "ohne Preis", format: anzahl }
  hinweise: v_modul_ki_verbrauch_hinweise
  rollen: [betreuer]
  eingriffe: []
  uebersicht: { titel: "KI-Verbrauch", reihenfolge: 20 }
```

| Feld | Regel | Bedeutung |
| --- | --- | --- |
| `spalten` | 1–4; die **erste heißt `wert`**; `format` `zahl` (Standard) oder `euro` | Die Kennzahlen: je Spalte die Summe über den Zeitraum. `wert` ist der Hauptwert — ihn zeigen Diagramm, Aufteilungen, Anteile und die Karte der Übersicht. Dazu kommt von selbst „Je Tag" (Tagesschnitt und höchster Tag des Hauptwerts). |
| `spalten[].davon` | optional; `name` (Spalte) und `text` (1–60 Zeichen) | Ein Teil dieser Kennzahl, gezeigt als „davon 95 % aus dem Cache gelesen". |
| `aufteilungen` | optional, höchstens 4; je `name` (Textspalte), `label` | Der Hauptwert je Wert der Spalte, größte zuerst, fünf Zeilen und „+ n weitere". Zeilen ohne Wert (`NULL`) heißen „nicht zugeordnet". |
| `aufteilungen[].filter` | optional, bei **höchstens einer** Aufteilung | Jede Zeile verlinkt auf die Seite, gefiltert auf ihren Wert (`?filter=<wert>`, `-` für „ohne Wert"). Der Filter gilt für alle Flächen der Seite. |
| `aufteilungen[].darunter` | optional, nur mit `filter: true`; `name`, `label` | Die Spalte, die gefiltert an die Stelle der Aufteilung tritt („Je Ticket" statt „Je Projekt"). |
| `anteile` | optional, höchstens 4; je `name` (numerische Spalte), `label`, optional `text` (bis 120 Zeichen) und `format` | Teilbeträge des Hauptwerts im Block „Wie belastbar sind die Zahlen?". `format: anteil` (Standard) zeigt Prozent des Hauptwerts, `format: anzahl` die Summe als Zahl — ab 1 als Warnung („Achtung:"). |
| `hinweise` | optional; Viewname wie `view` | Eine View mit Warnzeilen (siehe unten). |
| `uebersicht` | optional; nur `titel` und `reihenfolge` | Eine Karte auf der Übersicht: der Hauptwert des laufenden Monats, der Vormonat, die letzten 30 Tage. `kurztext` und `verlauf` gibt es hier nicht. Hat die Hinweis-View Zeilen, ist die Karte gelb und nennt die erste. |
| `eingriffe` | immer `[]` | Es gibt keine Zeile, an der man eingreifen könnte. |

`darstellung` gibt es bei Kennzahlen nicht. Jede Spalte der View darf im Block nur einmal vorkommen.

### Die Kennzahlen-View

| Spalte | Postgres-Typ (genau dieser) | Bedeutung |
| --- | --- | --- |
| `tag` | `date` | Der Kalendertag der Zeile. Das Cockpit summiert je Tag und je Zeitraum. |
| `wert` | `numeric` | Der Hauptwert. `NULL` zählt nicht mit (etwa Kosten ohne Preis). |
| jede Spalte aus `spalten`, `davon`, `anteile` | `numeric` | Wird summiert. Ganze Zahlen in der View casten (`einsaetze::numeric`). |
| jede Spalte aus `aufteilungen`, `darunter` | `text` | Wird gruppiert. |

Die View darf beliebig fein sein (eine Zeile je Tag und Kombination der Aufteilungen) — das Cockpit bildet die Summen
selbst. Anders als bei Liste+Detail **rechnet** das Cockpit hier über der View; deshalb wird der Typ **jeder
deklarierten Spalte** geprüft, beim Einspielen und vor jedem Lesen. Sonst gelten dieselben Regeln wie für jede
Modul-View: Schema `cockpit`, wirklich eine View, Eigentümer die Rolle `cockpit`, für Kundenrollen nur Tabellen als
Quelle und kein `text_intern`, 2 Sekunden Timeout. Ein Index auf dem Tag der Quelltabelle lohnt sich.

**Zeiträume** sind Berliner Kalendertage, heute eingeschlossen. Der Vergleich im Zusatz des Hauptwerts ist bei „Heute"
gestern, bei „7 Tage" und „30 Tage" der gleich lange Zeitraum davor, bei „Monat" der Vormonat bis zum selben Tag, bei
„Vormonat" der Monat davor. Gefiltert steht dort stattdessen der Anteil am ungefilterten Zeitraum.

### Die Hinweis-View

| Spalte | Postgres-Typ | Bedeutung |
| --- | --- | --- |
| `titel` | `text` | Überschrift der Warnung („37 Einsätze ohne Preis"). Die Seite setzt „Achtung:" davor. |
| `text` | `text` | Ein Satz dazu. |

Jede Zeile ist eine Warnung über den Zahlen; ohne Anlass ist die View leer. Gezeigt werden höchstens fünf. Scheitert
die Hinweis-View (Prüfung oder Lesen), erscheinen die Zahlen trotzdem, nur ohne Warnzeilen. Texte werden immer
maskiert und nie verlinkt.

Ein durchgespieltes Beispiel: [`docs/beispiele/v_modul_ki_verbrauch.sql`](beispiele/v_modul_ki_verbrauch.sql),
[`docs/beispiele/v_modul_ki_verbrauch_hinweise.sql`](beispiele/v_modul_ki_verbrauch_hinweise.sql) und
[`docs/beispiele/ki-verbrauch.cockpit.yaml`](beispiele/ki-verbrauch.cockpit.yaml). Reihenfolge beim Einspielen wie
immer: **erst die Views, dann der Block**.

## Fachmigrationen: `fach` (optional, COPI-107)

Hat ein Modul eigene **Fachtabellen** (z. B. `kommunikation.vorgang`), ändert sie der Einrichter — nie das Cockpit, und
im Pilot auch kein Agent (Empfehlung Alex zu COPI-106: dafür bräuchte er DDL- und Rollenrechte weit über
`cockpit-update` hinaus). Damit das nachvollziehbar und prüfbar bleibt:

- **Ablage:** je Fachschema ein Ordner, **der Ordnername ist das Schema**: `sql/<schema>/NNNN_<beschreibung>.sql` in
  agent-blueprints (Beispiel im Cockpit-Repo: `docs/demo/fach/eingang/0001_vorgang.sql`).
- **Buchführung:** `<schema>._migration` (`version int PRIMARY KEY`, `herkunft`, `angewendet_am`, `angewendet_von`),
  mit Löschsperre. 0001 legt sie an. Jede Datei ist **eine Transaktion** (`BEGIN … COMMIT`), bricht ab, wenn ihre
  Version schon gebucht ist, und schreibt am Ende ihre Buchungszeile. Die Herkunft
  (`agent-blueprints@<commit>:<schema>/<datei>`) kommt aus der Sitzungseinstellung `fach.herkunft`, sonst „unbekannt".
- **Einspielen:** in Nummernfolge, gebuchte Versionen überspringen, beim ersten Fehler aufhören —
  `agent-blueprints/sql/fach-migrieren.sh` (Server), `scripts/dev/fach-migrationen.ts` (lokal, Tests).
- **Nur hinzufügen:** neue Tabellen, neue Spalten (nullable oder mit Default), neue Indizes (ohne `CONCURRENTLY` — das
  geht nicht in einer Transaktion), neue Funktionen und Trigger. **Verboten:** `DROP TABLE`/`DROP COLUMN`, `TRUNCATE`,
  `DELETE`, ein umbenennendes `RENAME`, `ALTER … TYPE` (Regel „nie löschen"). Ein Trigger darf zum Neuanlegen
  gelöscht werden; Daten nie.
- **Keine Down-Migrationen:** Der Rückweg eines Moduls (Views und Block auf einen älteren Stand) muss auf dem neuen
  Schema laufen — deshalb nur hinzufügen. Neue Spalten einer View nur **am Ende** (sonst scheitert `CREATE OR REPLACE`).
- **Nie eine eingespielte Datei ändern:** eine Änderung ist die nächste Nummer.
- **Reihenfolge beim Einrichten:** Fachmigrationen → Rechte (der Rolle des Cockpits `SELECT` auch auf
  `<schema>._migration`) → View → Block.

Im Block nennt `fach` die Version, die View und Block brauchen:

```yaml
  fach: { schema: kommunikation, mindestens: 1 }
```

| Feld | Regel |
| --- | --- |
| `schema` | `^[a-z][a-z0-9_]{0,62}$`; nicht `cockpit`, `public`, `information_schema` oder `pg_*` |
| `mindestens` | ganze Zahl 1–9999 |

`modul-einspielen` liest vor der Katalogprüfung `max(version)` aus `<schema>._migration` und lehnt ab, wenn die
Buchführung fehlt, das Leserecht fehlt oder die Version nicht reicht — mit der fehlenden Nummer in der Meldung
(„Fachmigration 0002 fehlt: kommunikation ist bis 0001 eingespielt, der Block verlangt 0003."). Geprüft wird nur
beim Einspielen: gebuchte Migrationen verschwinden nie (Löschsperre).

## Einspielen

Reihenfolge: **erst die View, dann der Block** — der Block wird gegen die vorhandene View geprüft.

```bash
# 1. View anlegen und der Rolle cockpit übergeben (als Verwaltung, wie in docs/installation.md Abschnitt 2)
docker compose exec -T <postgres-dienst> psql -U postgres -v ON_ERROR_STOP=1 -d <datenbank> < v_modul_server_zustand.sql
docker compose exec -T <postgres-dienst> psql -U postgres -v ON_ERROR_STOP=1 -d <datenbank> <<'SQL'
ALTER VIEW cockpit.v_modul_server_zustand OWNER TO cockpit;
-- nur für Fachtabellen außerhalb des Schemas cockpit, je Quelltabelle:
-- GRANT SELECT ON <schema>.<tabelle> TO cockpit;
SQL

# 2. Block einspielen: die Block-Datei unter module/ (eine ganze Blueprint-YAML ginge auch, siehe unten)
docker compose exec -T cockpit node dist/cli/index.js modul-einspielen \
  --herkunft "agent-blueprints@<commit>:module/server-zustand.cockpit.yaml" < server-zustand.cockpit.yaml

# 3. Nachsehen, was aktiv ist
docker compose exec cockpit node dist/cli/index.js module-auflisten
```

`-T` ist nötig, damit `docker compose exec` die Standardeingabe durchreicht. Läuft das über `ssh host 'bash -s'`,
`</dev/null` an jedes andere `exec` hängen, sonst liest es das restliche Skript mit. `--herkunft` ist frei, aber empfohlen:
es steht in der Registry und beantwortet später „woher kam diese Version?". In der Form
`agent-blueprints@<commit>:<pfad>` lässt sich das Modul außerdem in den Einstellungen per Antrag aktualisieren (COPI-106),
und ein laufender Modul-Antrag auf diesen Commit ist mit dem Einspielen erledigt. Der Admin-Agent spielt per Antrag nur
Module ein, deren **aktive** Herkunft unter `module/<kennung>.cockpit.yaml` liegt, denn `einspielen` in agent-blueprints
(COPI-127) kennt nur diesen Pfad. Zieht ein Block dorthin um, läuft der erste Wechsel einmal von Hand auf dem Host
(`einspielen <kennung> <commit>`); so geschehen bei „Server & Dienste“, der bis COPI-143 in `agents/agent-admin.yaml` stand.

Was `modul-einspielen` tut, in **einer** Transaktion:

1. YAML lesen und den Block gegen die Regeln oben prüfen (ohne Datenbank).
2. Ist der Text unverändert zur aktiven Version derselben Kennung (gleiche Prüfsumme) **und** die Herkunft dieselbe
   (oder nicht angegeben): Meldung **„unverändert"**, nichts wird angelegt. Gleicher Text mit neuer Herkunft ist eine
   neue Version (COPI-106): die View kann sich geändert haben, die Katalogprüfung läuft erneut. Die Prüfsumme geht über den **ganzen** eingespielten Text: wer die ganze Blueprint-YAML
   einspielt, bekommt auch nach einer Änderung außerhalb des Blocks (etwa `version`) eine neue Modul-Version mit
   gleichem Block — harmlos, und die Registry zeigt so, aus welcher Fassung der Blueprint sie stammt.
3. Die View (und eine Verlaufs-View aus `uebersicht.verlauf`) gegen den Katalog prüfen (existiert, Pflichtspalten mit Typ, deklarierte Spalten, `text_intern`).
4. Eine neue Version anlegen (je Kennung fortlaufend ab 1), die bisher aktive deaktivieren, die neue aktivieren.

Scheitert ein Schritt, bleibt die bisher aktive Version aktiv. Exit-Codes: `0` eingespielt oder unverändert, `1`
abgelehnt (Grund auf stderr), `2` falsche Bedienung.

## Posteingang: `posteingang:` (optional, COPI-112)

Ein Modul, dessen Zeilen Nachrichten sind (etwa die Mails des Moduls Kommunikation), meldet sie für den **Posteingang**
an: das Badge rechts oben auf jeder Seite zählt ungelesene Zeilen mit, das Panel zeigt sie mit Titel, Anriss und Link,
und unter „Nachrichten" steht das Modul als **Postfach** neben Assistent und Team (`/chat/postfach/<kennung>`, jüngste
zuerst). Die Modulseite unter `/module/<kennung>` bleibt, wie sie ist.

```yaml
cockpit:
  # … wie oben …
  spalten:
    - { name: zusammenfassung, label: "Worum es geht" }
    - { name: eingang, label: "Eingang", format: zeitpunkt }
  posteingang: { anriss: zusammenfassung, zeit: eingang }
```

| Feld | Regel | Bedeutung |
| --- | --- | --- |
| `anriss` | eine deklarierte Spalte, kein `langtext` | Der Text unter dem Titel (die ersten 140 Zeichen, eine Zeile). Der Titel ist die Pflichtspalte `titel`. |
| `zeit` | eine deklarierte Spalte im Format `zeitpunkt`; in der View **Typ `timestamp with time zone`** (beim Einspielen und vor jedem Lesen geprüft) | Danach wird sortiert und „neu" bestimmt. |

**Gelesen** wird je Konto im Cockpit festgehalten, nie in der Fachtabelle (Migration 0036): eine Zeile ist gelesen,
sobald ihre Detailseite offen war oder jemand „Alle als gelesen" gewählt hat. Was beim ersten Laden des Posteingangs
schon in der View steht, gilt als gelesen — ein neues Konto beginnt nicht mit dem ganzen Bestand. Wer das Modul nicht
sehen darf (`rollen`), sieht seine Zeilen weder im Badge noch in der Zahl, und das Postfach ist für ihn die neutrale 404.

## Hauptnavigation: `navigation: haupt` (optional, COPI-121)

Ein Modul, das man täglich braucht (etwa die Akquise), steht mit `navigation: haupt` als **eigener Eintrag** in der
Hauptnavigation: am Desktop in der Sidebar direkt unter „Nachrichten", mobil in der Tab-Leiste anstelle von
„Meldungen" (die Tab-Leiste behält fünf Plätze; „Meldungen" steht dann unter „Mehr"). Unter „Module" bleibt es
trotzdem erreichbar. Sichtbar ist der Eintrag nur für Rollen, die das Modul sehen dürfen (`rollen`).

Trägt das Modul zusätzlich `posteingang:`, steht am Eintrag die Zahl seiner ungelesenen Zeilen. Diese Zeilen zählen dann
**nicht mehr** an „Nachrichten", und das Modul steht dort nicht als Postfach; Einträge im Posteingang im Kopf führen
direkt auf die Detailseite des Moduls. Das Badge im Kopf zählt weiter alles.

Mobil zeigt die Tab-Leiste nur das erste angeheftete Modul (nach Menüname), weitere stehen nur in der Sidebar.

## Rückweg

Eingespielte Versionen sind **unveränderlich und werden nie gelöscht** (Nachweis: wer hat wann was eingespielt). Einen
Befehl „Version zurücksetzen" gibt es deshalb nicht — zurück geht es nach vorn:

- **Auf eine frühere Fassung zurück:** den früheren Block (z. B. aus dem vorherigen Commit von `agent-blueprints`)
  erneut einspielen. Das wird eine neue Version mit dem alten Inhalt; die fehlerhafte bleibt als Nachweis stehen.
- **Modul vor dem Betreuer verbergen:** Das entscheidet der Betriebs-Admin unter Einstellungen („Betreuer-Zugriff"),
  ohne neue Version. Ein Fachmodul nur für den Betreuer gibt es seit COPI-134 nicht mehr.
- **View kaputt oder falsch:** View korrigieren (`CREATE OR REPLACE VIEW`). Bis dahin zeigt die Seite den neutralen
  Hinweis, nie falsche Daten.

Ein Modul ganz abzuschalten ist noch nicht vorgesehen; ein Ticket, wenn es gebraucht wird.

## Checkliste: Modul anbinden

1. View `cockpit.v_modul_<name>` mit `id`, `titel`, `status`, `aktualisiert_am` (Typen genau wie oben) schreiben.
2. Für Kundenrollen: nur Tabellen als Quelle, kein `text_intern`, nur `kundensichtbar`e Befunde.
3. Block in die Agent-Blueprint-YAML (`cockpit:`), `kennung`, `menuename`, `view`, `spalten`, `rollen`, `eingriffe: []`.
4. View anlegen, Block einspielen, `module-auflisten` prüfen.
5. Im Cockpit mit jeder freigegebenen Rolle und mit einer nicht freigegebenen ansehen (die muss eine 404 bekommen).
6. Optional Karten auf der Übersicht: `uebersicht:` mit `kurztext` (deklarierte Spalte) und, für die Bänder, eine
   Verlaufs-View (`id`, `zeitpunkt`, `status`, dieselben Regeln) — vor dem Block anlegen.
7. Optional Kacheln statt Liste auf der Modulseite: `darstellung: kacheln`. Ohne eigene Verlaufs-View (Schritt 6)
   entfällt dort nur der Block „Letzte 7 Tage", die Kacheln erscheinen trotzdem.
8. Optional Messwerte (COPI-83): `wert numeric` (+ `einheit text`, `wert_max numeric`, `wert_warnung numeric`) in
   der Modul-View, `wert numeric` in der Verlaufs-View — Typen genau, für Kundenrollen nur sichtbare Daten.
9. Statt Zeilen mit Zustand Summen über einen Zeitraum: `ansicht: kennzahlen` (COPI-98) — eigene View mit `tag date`
   und `wert numeric`, siehe „Ansichtstyp Kennzahlen". Die Schritte 1, 6, 7 und 8 gelten dann nicht.
10. Optional Posteingang (COPI-112): `posteingang:` mit `anriss` (deklarierte Spalte) und `zeit` (deklarierte Spalte,
    `format: zeitpunkt`, in der View `timestamptz`), siehe „Posteingang". Braucht Cockpit ab v0.12.0.
11. Optional Anhänge (COPI-110): eigene View mit `id`, `vorgang_id`, `dateiname`, `groesse`, `inhalt` (siehe „Anhänge"),
    vor dem Block anlegen, dann `anhaenge:` im Block. Braucht Cockpit ab v0.16.0.