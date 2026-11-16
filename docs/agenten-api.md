# Agenten-API des Cockpits — der Vertrag

Stand: COPI-42 (Abschluss von Epic E3), 22.09.2026; Messwert je Befund: COPI-83, Übernahme-Sperre: COPI-85, 28.09.2026; KI-Verbrauch: COPI-97, Wechselkurs: COPI-99, Summen je Ticket: COPI-98, 30.09.2026. Grundlage für die Werkzeuge `cockpit-api` und `cockpit-update` des
Admin-Agenten im Repo `agent-blueprints` (dort eigene PRs). Dieses Dokument soll genügen, um den Agenten zu bauen, ohne
in den Code des Cockpits zu sehen. Weicht der Code davon ab, ist das ein Fehler — im Code oder hier.

Architektur: Betriebs-Cockpit (Architektur-Vorschlag),
Abschnitte 4 (das Cockpit prüft nichts selbst), 13.1 (Update beantragen statt ausführen) und 14.1 (Werkzeug
`cockpit-update`).

## Worum es geht

Das Cockpit **prüft nichts selbst** und **ändert nichts am Server**. Es zeigt, was der Admin-Agent meldet, und hält fest,
was Menschen beantragen. Der Agent hat dafür drei Aufgaben:

| Aufgabe | Endpunkt | Recht |
| --- | --- | --- |
| Befunde seiner Wachen melden — und damit den Herzschlag jeder Wache | `POST /intern/befund` | `befund_schreiben` |
| Das Inventar der Agenten liefern (Rolle, Version, Grenzen, Zeitplan) | `PUT /intern/agenten` | `agenten_schreiben` |
| Update-Anträge abholen, nach Stefans Freigabe ausführen, den Stand melden | `GET /intern/eingriffe`, `GET /intern/eingriffe/:id`, `POST /intern/eingriffe/:id/status` | `eingriff_verwalten` |

Dazu `GET /intern/ping`: prüft Adresse, Token und Rechte, ohne etwas zu schreiben.

Seit E4 nutzt auch der **Koordinator-Agent** die API, mit einem **eigenen Zugang** (Abschnitt „Koordinator" unten):

| Aufgabe | Endpunkt | Recht |
| --- | --- | --- |
| Auf eine Frage im Chat antworten | `POST /intern/chat/antwort` | `chat_antworten` |
| Einem anderen Agenten schreiben (COPI-113) | `POST /intern/chat/agenten` | `chat_antworten` |
| Melden, was ein Agent getan hat (COPI-114) | `POST /intern/agenten/ereignis` | `agenten_schreiben` |
| Den Zustand der Instanz lesen — nur, was der Kunde sieht | `GET /intern/zustand` | `zustand_lesen` |

Die **Budget-Wache** des Admin-Agenten liest den Verbrauch des Chats über `GET /intern/chat/verbrauch` (Recht
`zustand_lesen`, Abschnitt „Koordinator" unten) — mit einem eigenen Zugang, der nur dieses Recht trägt.

Seit E5 fragen die **Fachagenten** (Buchungs-, Anfrage-Agent …) vor jedem Senden an einen Gast, ob ein Mensch den
Vorgang übernommen hat (Abschnitt „Übernahme-Sperre" unten, **Pflichtregel**):

| Aufgabe | Endpunkt | Recht |
| --- | --- | --- |
| Vor jedem Senden in einem Vorgang die Übernahme-Sperre abfragen | `GET /intern/vorgaenge/sperre` | `vorgang_lesen` |

Seit E6 melden **Werkzeuge** (der Claude-Code-Hook, Cowork, der tägliche LiteLLM-Import in n8n) den KI-Verbrauch
(Abschnitt „KI-Verbrauch" unten), jedes mit einem eigenen Zugang:

| Aufgabe | Endpunkt | Recht |
| --- | --- | --- |
| Melden, welches Modell mit wie vielen Tokens gearbeitet hat | `POST /intern/verbrauch` | `verbrauch_schreiben` |
| Den Wechselkurs des Tages melden (für die Summe in Euro) | `POST /intern/wechselkurs` | `verbrauch_schreiben` |
| Die Summen je Ticket lesen (täglicher Abgleich mit Jira) | `GET /intern/verbrauch/tickets` | `verbrauch_lesen` |

Seit COPI-145 steuert **Koordinator** die Job-Queue der Entwicklungspipeline; der Vertrag samt der Runner-Seite steht in
[`pipeline-api.md`](pipeline-api.md):

| Aufgabe | Endpunkt | Recht |
| --- | --- | --- |
| Einen Job anlegen (idempotent je Ticket und Art) | `POST /intern/pipeline/jobs` | `pipeline_verwalten` |
| Jobs als Liste lesen (Filter `status`, `ticket_key`, `limit`) | `GET /intern/pipeline/jobs` | `pipeline_verwalten` |
| Einen Job mit Verlauf lesen | `GET /intern/pipeline/jobs/:id` | `pipeline_verwalten` |
| Offene Freigabe-Anfragen lesen | `GET /intern/pipeline/freigaben` | `pipeline_verwalten` |
| Eine Freigabe-Anfrage als erledigt markieren | `POST /intern/pipeline/jobs/:id/freigabe-erledigt` | `pipeline_verwalten` |
| Abgelaufene Leases aufräumen, geparkte Jobs erfahren | `POST /intern/pipeline/aufraeumen` | `pipeline_verwalten` |
| KI-Verbrauch eines Tickets über alle Jobs summiert lesen | `GET /intern/pipeline/verbrauch` (Abfrage `ticket`) | `pipeline_verwalten` |

## Verbindung

- **Adresse:** die Domain der Instanz, `https://<kuerzel>.example.com/intern/…` (oder die Kundendomain). Läuft der
  Agent im selben Docker-Netz, geht auch `http://cockpit:3000/intern/…`.
- **Nur JSON:** `Content-Type: application/json` für jeden Rumpf. Formulare und Text werden abgewiesen (`415`).
- **Zeiten** kommen als ISO-8601 in UTC (`2026-09-22T10:00:00.000Z`). Zeitpunkte setzt immer das Cockpit, nie der Agent —
  mit einer Ausnahme: `zeitpunkt` in `POST /intern/verbrauch` (Abschnitt „KI-Verbrauch").

### Zugang

Ein Zugang ist ein Bearer-Token. Angelegt wird er **nur** auf dem Server, per Kommando, nie in der Oberfläche:

```bash
docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name admin-agent \
  --scope befund_schreiben --scope agenten_schreiben --scope eingriff_verwalten
docker compose exec cockpit node dist/cli/index.js api-token-auflisten
docker compose exec cockpit node dist/cli/index.js api-token-widerrufen --id 3
```

- Das Token hat die Form `cpk_` und 43 Zeichen (base64url). Es erscheint **genau einmal** auf der Konsole; im Cockpit
  liegt nur sein Hash. Es gehört in den Tresor der Instanz (Zugangsdatenblatt), nie in ein Repo, nie in einen Log.
- Es gilt bis zum Widerruf; ein Widerruf ist endgültig. **Wechsel ohne Ausfall:** neuen Zugang (gleicher Name erlaubt)
  anlegen, Agent umstellen, alten widerrufen.
- Der Name: Kleinbuchstaben, Ziffern, `_` und `-`, höchstens 40 Zeichen. Er erscheint im Protokoll und als `quelle` jedes
  Befunds.
- **Empfehlung:** je Werkzeug ein eigener Zugang mit genau den Rechten, die es braucht — `cockpit-api` mit
  `befund_schreiben` und `agenten_schreiben`, `cockpit-update` mit `eingriff_verwalten`. Dann kann ein Token, das für
  die Wachen im Umlauf ist, keinen Update-Status setzen.

```bash
curl -H "Authorization: Bearer <token>" https://<kuerzel>.example.com/intern/ping
# 200 {"status":"ok","name":"admin-agent","scopes":["befund_schreiben","agenten_schreiben","eingriff_verwalten"]}
```

Das Token steht **nur** in der Kopfzeile `Authorization: Bearer <token>` — nie in der Adresse (Adressen landen in Logs).

### Antworten und Fehler

Jede Antwort trägt `Cache-Control: no-store`. Fehler sind JSON der Form `{"fehler": "<code>"}`, manchmal mit Zusatz.

| Status | `fehler` | Wann | Was der Agent tut |
| --- | --- | --- | --- |
| `401` | `nicht_angemeldet` | Token fehlt, ist kaputt, unbekannt oder widerrufen (immer dieselbe Antwort, mit `WWW-Authenticate: Bearer`) | nicht wiederholen; Stefan melden (Token prüfen) |
| `403` | `nicht_erlaubt` | Token gültig, das Recht der Route fehlt | nicht wiederholen; Zugang mit dem richtigen Recht anlegen |
| `400` | `ungueltige_anfrage` | kein gültiges JSON oder ungültige Eingabe; `felder` nennt die fehlerhaften Felder — nur Namen, nie Werte (`["agenten.2.zeitplan.0.name"]`) | nicht wiederholen; Eingabe korrigieren |
| `404` | `nicht_gefunden` | Pfad (nur mit gültigem Token) oder Eingriff gibt es nicht | nicht wiederholen |
| `409` | siehe Eingriffe | Zustand passt nicht | siehe Eingriffe |
| `413` | `zu_gross` | Rumpf größer als die Grenze der Route | nicht wiederholen; kleiner melden |
| `415` | `inhaltstyp_nicht_unterstuetzt` | nicht `application/json` | Kopfzeile setzen |
| `429` | `zu_viele_anfragen` | Begrenzung erreicht; `Retry-After` nennt die Sekunden | nach `Retry-After` wiederholen |
| `500` | `interner_fehler` | Fehler bei der Bearbeitung (ohne Einzelheiten) | später wiederholen; bleibt es, melden |
| `503` | `nicht_verfuegbar` | die Datenbank des Cockpits ist nicht erreichbar | später wiederholen |

**Begrenzung:** je Zugang höchstens 300 Anfragen in der Minute; je Client-Adresse höchstens 20 **gescheiterte** Versuche in
15 Minuten (gelungene zählen nicht). Ein Agent, der alle paar Minuten meldet, kommt nie in die Nähe.

Unbekannte Felder im Rumpf sind **immer ein Fehler** (`400`), keine stillschweigend verworfenen Werte — ein Tippfehler wie
`kundensichtbar_` fällt so auf, statt einen Befund zu verstecken.

## Befunde und Wachen: `POST /intern/befund`

Recht `befund_schreiben`, Rumpf höchstens 32 KiB.

Eine **Wache** ist eine regelmäßige Prüfung des Agenten (Container, Datensicherung, Zertifikat, Versionen …). Jeder
Befund ist zugleich ihr **Herzschlag**: das Cockpit merkt sich, wann sie zuletzt gemeldet hat, und rechnet beim Ansehen
aus, ob sie ausgeblieben ist. Es hat keinen eigenen Zeitplan und prüft nichts selbst.

```bash
curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"wache":"buchung-container","status":"rot","text_intern":"container buchung: exited (137)","takt_sekunden":300,"anzeigename":"Buchungs-Agent","kundensichtbar":true,"text_kunde":"Die Buchungen sind gerade nicht erreichbar."}' \
  https://<kuerzel>.example.com/intern/befund
# 201 {"id":12,"wache":"buchung-container","gemeldet_am":"2026-09-22T12:00:00.000Z"}

# mit Messwert (COPI-83):
curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"wache":"plattenplatz","status":"gelb","text_intern":"/: 86 % belegt","takt_sekunden":3600,"anzeigename":"Plattenplatz","kundensichtbar":true,"text_kunde":"Plattenplatz wird knapp: 86 % belegt.","messwert":{"wert":86,"einheit":"%","max":100,"warnung":85}}' \
  https://<kuerzel>.example.com/intern/befund
```

| Feld | Angabe | Bedeutung |
| --- | --- | --- |
| `wache` | Pflicht | Kennung: Kleinbuchstaben, Ziffern, `_ . -`, beginnt mit Buchstabe oder Ziffer, höchstens 63 Zeichen. Eine Maschinenkennung, kein Anzeigename |
| `status` | Pflicht | `gruen`, `gelb` oder `rot` |
| `text_intern` | Pflicht | der Rohbefund für den Betreuer, 1–4000 Zeichen |
| `text_kunde` | optional | der Klartext für den Kunden, 1–500 Zeichen, in Betriebssprache („Die Buchungen sind gerade nicht erreichbar.") |
| `kundensichtbar` | optional, ohne Angabe `false` | `true` nur zusammen mit `text_kunde` (sonst `400`, Feld `text_kunde`) |
| `takt_sekunden` | bei einer **neuen** Wache Pflicht, sonst optional | wie oft die Wache meldet, 1 Sekunde bis 366 Tage; ein genannter Wert ersetzt den bisherigen |
| `anzeigename` | optional | wie der Kunde die Wache nennt („Buchungs-Agent"), 1–60 Zeichen; ohne Angabe bleibt der bisherige |
| `messwert` | optional | **ein** Hauptmesswert des Befunds (COPI-83), Objekt, siehe unten |
| `agent` | optional | Kennung des Agenten, dem die Wache gehört (COPI-113, Form wie `wache`); gehört zur Wache wie der Anzeigename: ohne Angabe bleibt die bisherige Zuordnung. Seine Befunde stehen dann im Protokoll seiner Detailseite |
| `update` | optional | nur bei Versions-Wachen: das neuere Ziel, maschinenlesbar (COPI-140), siehe „Die Versions-Wache" |

**Der Messwert** (`messwert`, COPI-83) — genau ein Wert je Befund, aus dem das Cockpit Zahl, Balken und Kurve zeichnet:

```json
"messwert": { "wert": 86, "einheit": "%", "max": 100, "warnung": 85 }
```

| Feld | Angabe | Bedeutung |
| --- | --- | --- |
| `wert` | Pflicht im Objekt | endliche Zahl (auch negativ, mit Nachkommastellen) |
| `einheit` | Pflicht im Objekt | 1–12 Zeichen, an den Rändern gekürzt: `%`, `ms`, `Tage`, `von 5` |
| `max` | optional | Obergrenze, größer als 0 (etwa `100` bei Prozent) — ergibt den Füllbalken |
| `warnung` | optional | die Schwelle, ab der die Wache gelb meldet — ergibt die Warnlinie der Kurve |

- **Streng wie der Rest:** ein unbekanntes Feld im Objekt ist ein `400` mit dem Feldnamen (`messwert.minimum`), ebenso
  eine unendliche Zahl (`1e999`), eine leere Einheit oder `max` ≤ 0 (`messwert.wert`, `messwert.einheit`,
  `messwert.max`). Dieselbe Form prüft die Datenbank (`befund_messwert_form`).
- **Für den Kunden nur über kundensichtbare Befunde.** Ein Messwert gehört zu seinem Befund und teilt dessen
  Sichtbarkeit: der Kunde sieht ihn nur, wenn der Befund `kundensichtbar` ist — der Messwert eines internen Befunds
  erscheint nie beim Kunden, weder als Zahl noch als Kurvenpunkt. Eine Wache, deren Kurve der Kunde sehen soll,
  meldet ihren Messwert deshalb mit jedem **sichtbaren** Befund.
- Ohne `messwert` ändert sich nichts; der Befund zeigt dann keinen Wert.
- Ein Punkt ohne Messwert unterbricht die Kurve (etwa: Health-Check ohne Antwort, also keine Antwortzeit).

- **Der Kunde sieht nie den Rohbefund.** Auf der Übersicht sehen Betriebs-Admin und Mitarbeiter nur Wachen mit
  mindestens einem `kundensichtbar`en Befund, und davon nur den **jüngsten sichtbaren**: seine Farbe, `text_kunde` und
  „zuletzt geprüft". Eine Wache ohne je einen sichtbaren Befund existiert für den Kunden nicht. Der Betreuer sieht jeden
  Befund.
- **Für den Kunden zählt der Herzschlag der sichtbaren Befunde:** meldet eine Wache nur noch interne Befunde, wird ihre
  Kachel beim Kunden nach Takt und Toleranz gelb. Eine Wache, die der Kunde sieht, meldet deshalb **jeden** Lauf
  kundensichtbar — auch den grünen, mit einem Klartext wie „Die Buchungen laufen.".
- **Eine neue Wache ohne `takt_sekunden`** wird abgewiesen (`400`, `felder: ["takt_sekunden"]`): ohne Takt ließe sich nie
  sagen, ob sie ausbleibt.
- **Nicht fälschbar:** Quelle (der Name des Zugangs), Zeitpunkt und Nummer setzt das Cockpit; Felder `quelle`,
  `gemeldet_am` oder `id` im Rumpf sind ein Fehler.
- **Texte** werden unverändert gespeichert (nur Leerraum an den Rändern fällt weg) und in der Oberfläche immer maskiert,
  nie verlinkt. HTML oder Links im Text erscheinen als Text.

**Wann eine Wache als ausgeblieben gilt** (sie wird dann gelb, „zuletzt geprüft vor …" in Warnfarbe):

| Regel | Wirkung |
| --- | --- |
| letzter Befund länger her als **Takt + Toleranz** (Toleranz: halber Takt, mindestens 60 Sekunden) | überfällig: **gelb** |
| letzter Befund war **rot** | bleibt **rot**, auch überfällig — eine Störung wird durch Schweigen nicht besser |
| die Wache hat nie gemeldet | gelb, „noch nie geprüft" |

Folgerung für den Agenten: **jede Wache meldet in jedem Lauf**, auch wenn alles grün ist, und mit einem Takt, der zum
tatsächlichen Zeitplan passt. Die häufigste stille Fehlfunktion ist die ausbleibende Meldung (ADR 13.1).

### Die Versions-Wache

Je aktualisierbarem Bereich eine Wache; für das Cockpit-Image heißt sie **`version-cockpit`**:

- `takt_sekunden` ein Tag (86400), `kundensichtbar` weglassen (der Kunde sieht Versionen nie).
- Nach jedem Wechsel des Cockpit-Images meldet der Agent **sofort einmal**, angestoßen von Hand oder vom
  Update-Ablauf. Sonst zeigt „Verfügbar" bis zum nächsten Tageslauf den Stand von vor dem Update.
- `status`: **gelb** = es gibt eine neuere Version, **grün** = aktuell, **rot** = die Prüfung selbst ist gestört.
- `text_intern` ist genau das, was der Betreuer in den Einstellungen unter „Verfügbar" liest, etwa
  `verfügbar: 1.5.0 (sha256:e77b40…)`. Das Cockpit wertet den Text nicht aus und fragt GHCR nie selbst.

Für jedes Modul mit Herkunft aus agent-blueprints (COPI-106) eine eigene Wache **`version-modul-<kennung>`**, gleiche
Regeln: der Agent vergleicht den Commit der eingespielten Herkunft (`bibliothek@<commit>:<pfad>`, Seite
Einstellungen bzw. `module-auflisten`) mit `main` von agent-blueprints. **Gelb** heißt: es gibt einen neueren Commit, der
Block oder View dieses Moduls ändert. `text_intern` nennt ihn, etwa `Commit 8d41e07 · Block und View geändert` — den
Commit übernimmt der Betreuer als Ziel in den Antrag.

**Das Ziel maschinenlesbar (`update`, COPI-140).** Mit einem gelben Befund meldet die Wache das neuere Ziel zusätzlich als
Objekt. Daraus bietet die Karte unter Einstellungen › Versionen „Update verfügbar: <Version bzw. Kurz-Commit> · <hinweis>
· seit <Datum>" und den Knopf **„Update installieren"** an. Der Betreuer tippt nichts mehr, das Ziel nimmt das Cockpit
aus dem jüngsten Befund der Wache, beim Anzeigen der Bestätigung und noch einmal beim Bestätigen. Ohne neues Ziel fehlt
das Feld.

```json
"update": { "art": "cockpit", "ziel": "sha256:e77b40…(64 Zeichen)", "version": "1.5.0",
            "hinweis": "Updates mit einem Klick", "seit": "2026-10-12T04:25:00+02:00" }
"update": { "art": "modul", "ziel": "8d41e07b2c9a4f10e5d6c7b8a9f0e1d2c3b4a5f6", "version": null,
            "hinweis": "Block und View geändert", "seit": "2026-10-12T04:25:00+02:00" }
```

| Feld | Angabe | Bedeutung |
| --- | --- | --- |
| `art` | Pflicht | `cockpit` nur an der Wache `version-cockpit`, `modul` nur an einer Wache `version-modul-<kennung>` |
| `ziel` | Pflicht | bei `cockpit` der Digest (`sha256:` und 64 Zeichen `0–9a–f`), bei `modul` der **volle** Commit aus `main` von agent-blueprints (40 Zeichen `0–9a–f`) |
| `version` | bei `cockpit` Pflicht, bei `modul` weglassen oder `null` | die Version des Images, etwa `1.5.0` (Form wie `ziel_version` eines Eingriffs) |
| `hinweis` | optional | 1–200 Zeichen, was sich ändert; erscheint auf der Karte (maskiert) |
| `seit` | Pflicht | ISO-8601 mit Zeitzone: seit wann es das Ziel gibt |

- **Nur an einem gelben Befund**, sonst `400` (Feld `update`). Eine falsche Wache für die Art ist `update.art`.
- **Streng wie der Rest:** ein ungültiges oder unbekanntes Feld ist ein `400` mit dem Feldnamen (`update.ziel`,
  `update.version`, `update.seit`, …), und **der ganze Befund wird nicht gespeichert**. Dieselbe Form prüft die
  Datenbank (`befund_update_ziel_form`, Migration 0049). Abweichend vom Ticket (422) bleibt es beim `400` aller anderen
  Eingabefehler dieser API.
- **Nur das jüngste Ziel zählt.** Meldet die Wache grün oder ohne `update`, gibt es kein Update mehr; ein schon
  beantragter Antrag bleibt davon unberührt. Meldet sie inzwischen ein anderes Ziel, gilt eine offene Bestätigungsseite
  nicht mehr und kommt mit dem neuen Ziel zurück.
- **Kein Knopf** bei einem offenen Antrag (die Karte zeigt dessen Stand), bei einem Ziel, das schon läuft, und bei einem
  Modul, dessen Herkunft nicht unter `module/<kennung>.cockpit.yaml` liegt (dort nur Server-Konsole, siehe
  „Modul-Updates").

## Inventar: `PUT /intern/agenten`

Recht `agenten_schreiben`, Rumpf höchstens 512 KiB. **PUT ersetzt das ganze Inventar:** wer in der Liste fehlt, fällt
heraus; eine leere Liste leert es. Alles oder nichts — eine abgewiesene Meldung lässt das Inventar unangetastet.

```bash
curl -X PUT -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"agenten":[{"kennung":"rechnung","rolle":"Rechnungs-Agent","version":"2.3.1","grenzen":{"Betrag je Rechnung":5000,"darf löschen":false},"zeitplan":[{"name":"Rechnungslauf","wann":"täglich 07:00"}]}]}' \
  https://<kuerzel>.example.com/intern/agenten
# 200 {"agenten":1,"entfernt":0}
```

| Feld | Angabe | Bedeutung |
| --- | --- | --- |
| `agenten` | Pflicht | Liste, höchstens 30; leer erlaubt; jede Kennung höchstens einmal |
| `kennung` | Pflicht | wie bei Wachen (Kleinbuchstaben, Ziffern, `_ . -`, höchstens 63 Zeichen) |
| `rolle` | Pflicht | 1–100 Zeichen: wie der Agent dem Kunden heißt |
| `version` | Pflicht | 1–64 Zeichen; nur der Betreuer sieht sie |
| `grenzen` | optional | flaches Objekt, höchstens 20 Einträge: Name (1–60 Zeichen) → Text (1–200 Zeichen), Zahl oder `true`/`false` |
| `zeitplan` | optional | Liste, höchstens 20 Takte `{"name": 1–80 Zeichen, "wann": 1–120 Zeichen}`, beides Freitext (kein Cron) |

- **`rolle`, `grenzen` und `zeitplan` sieht jedes angemeldete Konto** (Seiten Agenten und Zeitplan): nichts Internes
  hineinschreiben. Kennung und Version sieht nur der Betreuer.
- Die Antwort nennt die Zahl der gemeldeten Agenten und wie viele herausgefallen sind (`entfernt`). Herausgefallene werden nie gelöscht, nur als entfernt markiert (COPI-62); meldet der Agent sie wieder, gelten sie wieder.
- Bei einem Fehler nennt `felder` nur Feldnamen; innerhalb von `grenzen` endet der Pfad bei `grenzen`, denn die
  Schlüssel dort sind Inhalt.

## Update-Anträge: `/intern/eingriffe`

Recht `eingriff_verwalten`. „Das Cockpit aktualisiert nichts. Es beantragt." (ADR 13.1) Der Betreuer stellt in den
Einstellungen einen Antrag; der Agent holt ihn ab, lässt ihn von Stefan freigeben, führt ihn aus und meldet den Stand.
**Den Erfolg stellt das Cockpit selbst fest.**

### Ein Eingriff

```json
{
  "id": 7,
  "art": "cockpit-image",
  "status": "laeuft",
  "haengt": false,
  "ziel_digest": "sha256:b2b2…",
  "ziel_version": "1.5.0",
  "digest_vorher": "sha256:a1a1…",
  "freigabe_modus": "rueckfrage",
  "beantragt_am": "2026-09-22T10:00:00.000Z",
  "freigegeben_am": "2026-09-22T10:05:00.000Z",
  "laeuft_seit": "2026-09-22T10:30:00.000Z",
  "abgeschlossen_am": null
}
```

| Feld | Bedeutung |
| --- | --- |
| `id` | die **Vorgangs-ID** — darauf lautet die Freigabe |
| `art` | `cockpit-image` oder `modul` (COPI-106, Abschnitt „Modul-Updates" unten) |
| `status` | `beantragt`, `freigegeben`, `laeuft`, `erledigt`, `fehlgeschlagen`, `zurueckgezogen` |
| `haengt` | `true`, wenn der Eingriff länger als 15 Minuten in `laeuft` steht (berechnet beim Lesen, nie gespeichert) |
| `ziel_digest` | das Image, auf das aktualisiert wird: immer ein vollständiger `sha256:`-Digest, nie ein Tag |
| `ziel_version` | die Version, die der Agent mit der Freigabe genannt hat (vorher `null`); bei `freigabe_modus: direkt` setzt sie das Cockpit aus dem Ziel der Versions-Wache |
| `digest_vorher` | **der Weg zurück**: das Image, das vorher lief |
| `modul`, `ziel_commit`, `herkunft_vorher` | nur bei `art: modul`, sonst `null` (Abschnitt „Modul-Updates") |
| `grund` | was der Agent mit `fehlgeschlagen` als Grund genannt hat, sonst `null` |
| `freigabe_modus` | `rueckfrage` (Freigabe außerhalb des Cockpits, wie bisher) oder `direkt` (die Bestätigung des Betreuers im Cockpit war die Freigabe, COPI-141); beim Antrag festgeschrieben, Abschnitt „Freigabemodus" unten |
| `automatisch` | `true`, wenn das Cockpit den Antrag selbst gestellt hat (Modus „Automatisch installieren", COPI-142); dann immer mit `freigabe_modus: direkt`. Nur zur Information: der Agent behandelt ihn wie jeden direkten |
| `…_am`, `laeuft_seit` | die Zeitpunkte der Stufen; `null`, solange nicht erreicht |

Beim Modul sind `ziel_digest`, `ziel_version` und `digest_vorher` immer `null`.

Die Kette: `beantragt → freigegeben → laeuft → erledigt | fehlgeschlagen`; dazu `beantragt → zurueckgezogen` (nur der
Betreuer in der Oberfläche) und, nur bei `freigabe_modus: direkt`, `freigegeben → zurueckgezogen`. Höchstens **ein** offener Eingriff je Art, bei Modulen je Modul. Die Konto-ID des
Antragstellers gibt die API nicht heraus.

### Endpunkte

| Route | Was |
| --- | --- |
| `GET /intern/eingriffe` | die jüngsten zuerst, höchstens 50: `{"eingriffe":[…]}`. `?status=` filtert: ein Status der Kette, `offen` (beantragt, freigegeben, laeuft) oder `haengt` |
| `GET /intern/eingriffe/:id` | ein Eingriff: `{"eingriff":{…}}` |
| `POST /intern/eingriffe/:id/status` | ein Übergang, Rumpf höchstens 4 KiB, Antwort `{"eingriff":{…}}` |

Der Agent kennt **genau drei Übergänge**:

| Rumpf | von | wann |
| --- | --- | --- |
| `{"status":"freigegeben","ziel_digest":"sha256:…","ziel_version":"1.5.0"}` | `beantragt` | Stefan hat freigegeben — auf **diese** Vorgangs-ID und **diesen** Ziel-Digest |
| `{"status":"freigegeben","ziel_commit":"8d41e07"}` | `beantragt` | dasselbe beim Modul: auf **diese** Vorgangs-ID und **diesen** Ziel-Commit, Zeichen für Zeichen wie beantragt |
| `{"status":"laeuft"}` | `freigegeben` | unmittelbar **bevor** das Image gezogen bzw. die View eingespielt wird |
| `{"status":"fehlgeschlagen","grund":"…"}` | `laeuft` | das Update ist gescheitert (oder hängt, und der Agent hat es geprüft); `grund` freiwillig, Klartext, 1–300 Zeichen, steht in den Einstellungen |

`erledigt` gibt es für den Agenten nicht (`400`, `felder: ["status"]`), ebenso wenig `beantragt` und `zurueckgezogen`.

| Status | `fehler` | Wann |
| --- | --- | --- |
| `200` | — | gelesen bzw. weitergeschaltet |
| `400` | `ungueltige_anfrage` | anderes Ziel als die drei, fehlende oder falsch geformte Angabe (Digest nicht `sha256:` + 64 hex, Version kein SemVer ohne Build-Metadaten), unbekanntes Feld, unbekannter Filter, ungültige Nummer |
| `404` | `nicht_gefunden` | kein Eingriff mit dieser Nummer |
| `409` | `status_passt_nicht` | der Eingriff steht nicht dort, woher der Übergang führt — Antwort `{"fehler":"status_passt_nicht","status":"<aktueller Stand>"}`. Auch ein **doppelter** Wechsel ist ein `409`, kein Nichtstun |
| `409` | `ziel_passt_nicht` | die Freigabe nennt einen anderen Digest bzw. Commit als der Eingriff, oder sie passt nicht zu seiner Art (Commit beim Image, Digest beim Modul) |

Ein Übergang ist atomar: Zeile und Protokolleintrag gelten zusammen oder gar nicht; von zwei gleichzeitigen Wechseln kommt
genau einer durch. Bei jedem Fehler ändert sich nichts.

### Freigabemodus (COPI-141)

Der Betreuer stellt unter Einstellungen › Versionen getrennt für **Cockpit** und **Module** ein, wie freigegeben wird
(Entscheidung Stefan, 13.10.2026, [ADR 0002](adr/0002-freigabe-direkt.md)). Jeder Eingriff trägt den Modus, der beim
Antrag galt (`freigabe_modus`); ein späterer Wechsel ändert ihn nicht.

| `freigabe_modus` | Status nach dem Antrag | was der Agent tut |
| --- | --- | --- |
| `rueckfrage` (Standard) | `beantragt` | wie bisher: Stefan fragen, `freigegeben` melden, ausführen (Schritte 1–7 unten) |
| `direkt` | `freigegeben` (Ziel-Version beim Image schon gesetzt) | **keine Rückfrage**, kein eigenes `freigegeben`: direkt mit `laeuft` weiter (Schritt 4) und nur das Ergebnis melden |

- Abholen: `GET /intern/eingriffe?status=freigegeben` und nur Zeilen mit `freigabe_modus: direkt` ausführen, ohne zu
  fragen. Ein `freigegeben` mit `rueckfrage` hat der Agent selbst gemeldet und kennt es schon.
- **Bis der Agent `laeuft` meldet, kann der Betreuer einen direkt freigegebenen Antrag zurückziehen.** Dann antwortet
  `laeuft` mit `409 status_passt_nicht` (`status: zurueckgezogen`): nichts ausführen. Deshalb `laeuft` immer **vor** dem
  ersten Handgriff melden, wie bisher.
- Ein `freigegeben`, das der Agent für einen direkten Eingriff schickt, ist ein `409 status_passt_nicht` (er steht schon
  dort).
- Der Notweg (ein getipptes Ziel) ist immer `rueckfrage`, auch wenn der Bereich auf `direkt` steht.
- **Automatisch installieren (COPI-142, [ADR 0003](adr/0003-update-automatisch.md)):** steht ein Bereich auf
  `automatisch`, stellt das Cockpit den Antrag selbst, sobald die Versions-Wache ein `update` meldet, und gibt ihn sofort
  frei (`freigabe_modus: direkt`, `automatisch: true`). Für den Agenten ändert sich nichts: abholen, `laeuft`, ausführen,
  Ergebnis melden. Das Cockpit-Image beantragt es nur im Wartungsfenster (Di 07:00–09:00), höchstens einmal am Tag je
  Image bzw. Modul, und nie wieder für ein Ziel, das `fehlgeschlagen` ist. Ein Fehlschlag meldet der Agent wie bisher
  (Wache rot, Slack); einen zweiten automatischen Versuch auf dasselbe Ziel gibt es nicht.

### Der Ablauf eines Updates (`cockpit-update`)

1. **Abholen:** `GET /intern/eingriffe?status=beantragt`. Für jeden neuen Eingriff Stefan melden: Kürzel der Instanz,
   Vorgangs-ID, `ziel_digest`, `digest_vorher`, Version und Änderungsnotiz des Ziel-Images (aus der Registry; das
   Cockpit fragt sie nie selbst).
2. **Freigabe prüfen — außerhalb des Cockpits.** Sie muss auf **Vorgangs-ID und Ziel-Digest** lauten, nicht auf „ja".
   Das Cockpit kann nicht wissen, ob Stefan freigegeben hat; es prüft nur, dass der Digest zum Eingriff passt.
3. **`freigegeben`** melden, mit `ziel_digest` und `ziel_version` (SemVer ohne Build-Metadaten, wie das Tag des Release,
   z. B. `1.5.0`). Die Version gehört zum Erfolgsbeleg: das neue Cockpit meldet sie beim Start.
4. **Im Wartungsfenster** (Vorgabe: Di 07:00–09:00): **zuerst `laeuft` melden**, dann nur den Dienst `cockpit` mit dem
   Digest aus dem Eingriff ziehen und starten (`image:` **und** `COCKPIT_IMAGE_DIGEST` in der Compose-Datei auf denselben
   Digest setzen; nie ein Tag). Andersherum startet das neue Cockpit, während der Eingriff noch `freigegeben` ist, und
   bestätigt nichts.
5. **Erfolg** stellt das Cockpit selbst fest: meldet sich beim Start ein Cockpit mit genau diesem Digest **und** dieser
   Version, setzt es den laufenden Eingriff auf `erledigt`. Der Agent liest das nach (`GET /intern/eingriffe/:id`) und
   meldet Stefan den Ausgang.
6. **Fehlschlag:** startet das neue Cockpit nicht oder meldet es sich mit anderem Digest oder anderer Version, bleibt der
   Eingriff in `laeuft` und **hängt** nach 15 Minuten (`haengt: true`). Der Agent prüft, meldet `fehlgeschlagen`, stellt
   auf `digest_vorher` zurück (derselbe Befehl, anderer Digest) und meldet Stefan — **über seinen eigenen Meldekanal**, denn
   ein misslungenes Update kann genau die Oberfläche zerstören, die es anzeigen würde.
7. **Wache:** eine Wache des Agenten fragt regelmäßig `?status=haengt` und `?status=fehlgeschlagen` ab und meldet, was sie
   findet (z. B. als Befund der Wache `version-cockpit` mit `rot`).

Warum die Version zählt, obwohl der Digest ein Image eindeutig benennt: der Digest der Selbstmeldung kommt aus der
Umgebung (`COCKPIT_IMAGE_DIGEST`), die Version ist ins Image gebacken. Wird beim Update nur die Umgebung geändert und die
`image:`-Zeile vergessen, meldet das **alte** Image den **neuen** Digest — die Version verrät es, und der Eingriff wird
nicht fälschlich `erledigt`.

### Modul-Updates (`art: modul`, COPI-106)

Wie beim Image beantragt der Betreuer in den Einstellungen, nur nennt er statt eines Digests einen **Commit in
agent-blueprints** (7–40 Zeichen `0–9a–f`, wie die Versions-Wache ihn meldet; seit COPI-140 per Knopf aus `update`, getippt
nur noch im Notweg „Bestimmten Stand wählen"). Ein Antrag geht nur für ein Modul, dessen aktive Version mit Herkunft
`bibliothek@<commit>:module/<kennung>.cockpit.yaml` eingespielt ist (COPI-140): nur diesen Pfad kennt `einspielen`
in agent-blueprints. Bei jeder anderen Herkunft nimmt das Cockpit keinen Antrag an (`409`); das erste Einspielen auf den
Pfad unter `module/` läuft einmal von Hand auf dem Host (`einspielen <kennung> <commit>`, so bei „Server & Dienste",
COPI-143).

```json
{
  "id": 13,
  "art": "modul",
  "status": "beantragt",
  "modul": "kommunikation",
  "ziel_commit": "8d41e07",
  "herkunft_vorher": "bibliothek@3f2a9c1e0b7d44c2a9f1c0de5b6a7d8e9f0a1b2c:module/kommunikation.cockpit.yaml",
  "ziel_digest": null, "ziel_version": null, "digest_vorher": null, "grund": null,
  "beantragt_am": "2026-10-02T13:40:00.000Z", "freigegeben_am": null, "laeuft_seit": null, "abgeschlossen_am": null
}
```

`herkunft_vorher` ist zugleich der **Weg zurück** und der **Pfad** des Blocks im Repo. Der Ablauf (Entscheidungen
Stefan/Alex, 01.–02.10.2026):

1. **Abholen und freigeben lassen** wie beim Image; die Freigabe lautet auf Vorgangs-ID und Ziel-Commit.
   **`freigegeben`** mit `ziel_commit`, genau wie im Eingriff. Ein Wartungsfenster gilt für Modul-Updates nicht.
2. **Vorbedingung prüfen, bevor `laeuft`:** Block und SQL des Ziel-Commits holen. Nennt der Block im Feld `fach` eine
   Mindestversion der Fachmigrationen, lesend `max(version)` in `<schema>._migration` prüfen. Reicht sie nicht: nichts
   einspielen, `laeuft` und dann `fehlgeschlagen` mit `grund` „Fachmigration NNNN fehlt" melden und Stefan Bescheid
   geben. Fachmigrationen spielt der Einrichter von Hand ein (nur hinzufügend, `docs/modul-vertrag.md`).
3. **`laeuft`** melden, dann **erst die View** einspielen (`CREATE OR REPLACE VIEW`, neue Spalten nur am Ende) — als
   Login-Rolle `cockpit_modul` mit `SET ROLE cockpit`, damit `cockpit` Eigentümer bleibt (kein Superuser, kein
   `CREATEROLE`; Rechte- und Rollenänderungen bleiben Handarbeit) —, **dann den Block** mit
   `modul-einspielen --herkunft bibliothek@<voller Commit>:<pfad>`.
4. **Erfolg** stellt das Cockpit selbst fest: aktiviert die Registry eine Version, deren Herkunft auf den Ziel-Commit
   lautet (einer ist Präfix des anderen), steht der Eingriff in derselben Transaktion auf `erledigt`
   (`modul-einspielen` nennt die Nummer). Aktiv wird eine Version nur mit bestandener Katalogprüfung; scheitert sie,
   bleibt die alte aktiv und der Eingriff in `laeuft`.
5. **Fehlschlag:** View des Commits aus `herkunft_vorher` wieder einspielen, dann den Block mit
   `--herkunft <herkunft_vorher>` (der Block wird dabei als neue Version aktiv), `fehlgeschlagen` mit `grund` melden.
   Die Expand-Regel (nur hinzufügende Fachmigrationen) sorgt dafür, dass der alte Stand auf dem neuen Schema läuft.

## Koordinator: `POST /intern/chat/antwort` und `GET /intern/zustand`

Der Koordinator-Agent (Rolle `agent-koordinator.yaml`, ADR 6) bekommt Fragen aus dem Assistenten-Kanal über den
n8n-Webhook (signiert, COPI-54; der ganze Weg samt Webhook und Signatur steht in
[`koordinator-api.md`](koordinator-api.md), COPI-61) und antwortet hierher. Er
bekommt einen eigenen Zugang, nie den des Admin-Agenten:

```bash
docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name koordinator \
  --scope chat_antworten --scope zustand_lesen
```

### Antworten: `POST /intern/chat/antwort`

Recht `chat_antworten`, Rumpf höchstens 20 KiB.

```json
{ "nachricht_id": 17, "text": "Heute reisen 3 Gäste an.", "dringend": false }
```

| Feld | Pflicht | Regel |
| --- | --- | --- |
| `nachricht_id` | ja | die `nachricht_id` aus dem Webhook: die Frage, auf die geantwortet wird |
| `text` | ja | Klartext, höchstens 4000 Zeichen, nicht nur Leerraum. Wird escaped angezeigt, nie verlinkt, kein Markdown |
| `dringend` | nein | Default `false`. Dringend löst Push und — ungelesen — den E-Mail-Zweitkanal aus (COPI-59, COPI-60) |
| `agent` | nein | Kennung des antwortenden Agenten (COPI-113). Damit steht die Antwort auf seiner Detailseite — dort sieht jedes Konto nur seinen eigenen Assistenten-Kanal |

Antwort `201 {"id": <nr>, "nachricht_id": 17, "erstellt_am": "…"}`. Der Kanal ist der der Frage, nie eine Angabe des
Agenten.

### Agenten untereinander: `POST /intern/chat/agenten` (COPI-113)

Recht `chat_antworten`, Rumpf höchstens 20 KiB. Ein Agent schreibt einem anderen; der Kanal der beiden entsteht beim
ersten Mal (je Paar genau einer). Menschen lesen ihn nur mit — auf den Detailseiten der Agenten, und nur mit dem Recht
`technik_sehen` (Rohtext, nicht vom Koordinator übersetzt). Kein Push, kein E-Mail-Zweitkanal.

```json
{ "von": "koordinator", "an": "assistent", "text": "Bitte prüf das Vorschlags-Laufs." }
```

| Feld | Pflicht | Regel |
| --- | --- | --- |
| `von` | ja | Kennung des schreibenden Agenten (Form wie im Inventar) |
| `an` | ja | Kennung des anderen Agenten, nicht `von` |
| `text` | ja | Klartext wie bei der Antwort, höchstens 4000 Zeichen |

Antwort `201 {"id": <nr>, "kanal_id": <nr>, "erstellt_am": "…"}`. Unbekannte Felder, eine falsche Kennung oder `an`
gleich `von` ergeben `400`.

| Status | `fehler` | Wann | Was der Agent tut |
| --- | --- | --- | --- |
| `404` | `nicht_gefunden` | keine Frage eines Menschen im Assistenten-Kanal zu dieser ID — auch eine Nachricht im Team-Kanal oder eine eigene Antwort | nicht wiederholen |
| `409` | `schon_beantwortet` | auf diese Frage gibt es schon eine Antwort (je Frage genau eine) | nicht wiederholen; der Lauf war schon erfolgreich |

### Zustand: `GET /intern/zustand`

Recht `zustand_lesen`. Liefert **genau die Kundensicht der Übersicht** — dieselbe Abfrage, dieselbe Aufbereitung. Ein
Befund, der nicht `kundensichtbar` ist, kommt gar nicht erst vor, auch kein Rohbefund und keine Kennung. Was der Kunde
nicht sieht, kann der Koordinator nicht weitersagen (ADR 6).

```json
{
  "stand": "2026-09-23T10:00:00.000Z",
  "status": { "farbe": "gelb", "satz": "Alles läuft, 1 Sache im Blick", "detail": "Zustellung verzögert." },
  "bereiche": [
    { "name": "Rechnungs-Agent", "farbe": "gelb", "status_wort": "Achtung", "text": "Zustellung verzögert.",
      "geprueft": "vor 1 Min. geprüft", "ueberfaellig": false,
      "messwert": { "wert": 12, "einheit": "offen", "warnung": 10 } }
  ]
}
```

`messwert` (seit COPI-83) ist der Messwert **desselben** jüngsten kundensichtbaren Befunds, ohne einen `null` — ein
zusätzliches Feld, das Bisherige bleibt, wie es war. Der Messwert eines internen Befunds kommt so wenig vor wie
dessen Rohbefund.

### Verbrauch des Chats: `GET /intern/chat/verbrauch`

Recht `zustand_lesen`. Für die Budget-Wache: wie viele Nachrichten an den Assistenten je Tag geschickt wurden, von
wie vielen Konten, und wie viele davon ihr Tageslimit erreicht haben. Nur Summen — keine Kennung, kein Name, kein
Inhalt. `?tage=` (1–31, ohne Angabe 7) sagt, wie weit zurück; Tage sind Berliner Kalendertage. Ein unbekannter
Parameter ist ein `400`.

```json
{ "limit": 50, "heute": "2026-09-23",
  "tage": [ { "tag": "2026-09-23", "nachrichten": 7, "benutzer": 2, "am_limit": 1 } ] }
```

## Übernahme-Sperre: `GET /intern/vorgaenge/sperre`

Ein Mensch kann im Cockpit einen Vorgang **übernehmen** (COPI-85): Ein Vorgang ist eine Zeile einer Modul-View —
Modul-Kennung und `id` —, übernehmen lässt er sich in Modulen, deren `cockpit:`-Block `eingriffe: [uebernehmen]` trägt
(`modul-vertrag.md`). Die Übernahme wirkt **sofort** und gilt, bis ein Mensch den Vorgang zurückgibt — es gibt keinen
Ablauf. Das Cockpit schickt den Agenten nichts; **sie fragen selbst**.

> **Pflichtregel für jeden Agenten, der an Gäste oder Kunden schreibt:** Vor **jedem** Senden an einen Gast/Kunden in
> einem Vorgang diesen Endpunkt abfragen. Bei `gesperrt: true` **oder jedem Fehler** — Timeout, Netzfehler, `5xx`,
> `401`, `403`, `404`, `429`, unlesbare Antwort — **nicht senden**. Gesendet wird nur nach einer Antwort `200` mit
> `"gesperrt": false`, und nur in diesem Vorgang.

Ein eigener Zugang je Fachagent mit genau diesem Recht:

```bash
docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name buchungs-agent --scope vorgang_lesen
```

Recht `vorgang_lesen`. Abfrage `?modul=<kennung>&id=<id>` — `modul` die Kennung aus dem Block (`^[a-z0-9][a-z0-9-]{0,62}$`),
`id` die Spalte `id` der Modul-View (1–200 Zeichen, URL-kodiert). Ein anderer Parameter ist ein `400`.

```bash
curl -H "Authorization: Bearer <token>" \
  "https://<kuerzel>.example.com/intern/vorgaenge/sperre?modul=anfragen&id=anfrage-4711"
# 200 {"gesperrt": true, "von": "Stefan Jacomeit", "seit": "2026-09-28T12:02:00.000Z"}
# 200 {"gesperrt": false}
```

- `von` ist der Anzeigename aus dem Konto (ein gelöschtes Konto heißt „ehemaliges Konto") — **nie** eine E-Mail-Adresse
  oder Konto-ID. `seit` ist der Zeitpunkt der Übernahme (ISO-8601, UTC).
- **Unbekannter Vorgang:** `gesperrt: false`. Der Endpunkt prüft nicht, ob es die Zeile in der View gibt — der Agent
  kennt seine Vorgänge.
- **Unbekanntes oder inaktives Modul:** `404` `nicht_gefunden`, nie `gesperrt: false`. Eine falsch geschriebene Kennung
  soll nicht als „frei" durchgehen; nach der Pflichtregel sendet der Agent dann nicht.
- Eine Sperre gilt auch, wenn das Modul den Eingriff `uebernehmen` inzwischen nicht mehr anbietet (im Zweifel gesperrt).

| Status | `fehler` | Wann | Was der Agent tut |
| --- | --- | --- | --- |
| `400` | `ungueltige_anfrage` | `modul` oder `id` fehlt, hat die falsche Form, oder ein unbekannter Parameter; `felder` nennt die Namen | nicht senden; Aufruf korrigieren |
| `404` | `nicht_gefunden` | kein aktives Modul mit dieser Kennung | nicht senden; Kennung prüfen, Stefan melden |

**Das Restfenster.** Zwischen der Abfrage und dem Senden liegt eine kurze Zeit, in der ein Mensch übernehmen kann, ohne
dass der Agent es noch merkt. Das Cockpit kann dieses Fenster nicht schließen (es sendet nicht selbst). Deshalb:
**unmittelbar vor dem Senden** abfragen, nicht zu Beginn eines langen Laufs; keine Antwort zwischenspeichern; zwischen
Abfrage und Senden keine weitere lange Arbeit (Sprachmodell, Rückfragen). Wer übernimmt, sieht im Cockpit den Hinweis
„Mit „Übernehmen“ antworten Agenten hier nicht mehr" — eine Nachricht, die im Restfenster schon unterwegs war, kann
trotzdem noch ankommen.

## Ereignisse: `POST /intern/agenten/ereignis` (COPI-114)

Was ein Agent **getan** hat, meldet er selbst — das Cockpit holt keine Logs (kein Docker-Socket, kein SSH). Die Meldung
steht im Protokoll seiner Detailseite (Verwaltung › Agenten), Fehler zählen dort als Kennzahl „Fehler 7 Tage". Recht
`agenten_schreiben` (derselbe Zugang wie das Inventar).

```json
{ "agent": "wache", "stufe": "fehler", "titel": "Fehler im Lauf Datensicherung",
  "text": "pg_dump brach nach 4 min ab: /backup voll (98 %). Wiederholung 05:00.",
  "kundensichtbar": true, "text_kunde": "Die nächtliche Datensicherung ist ausgefallen und wird wiederholt.",
  "zeitpunkt": "2026-10-02T04:16:00+02:00" }
```

| Feld | Pflicht | Regel |
| --- | --- | --- |
| `agent` | ja | Kennung wie im Inventar |
| `stufe` | ja | `info`, `warnung` oder `fehler` |
| `titel` | nein | Überschrift, ≤ 80 Zeichen — nur für den Betreuer; die Kundensicht zeigt „Fehler gemeldet" o. ä. |
| `text` | ja | was passiert ist, ≤ 500 Zeichen, Klartext (escaped, nie verlinkt). **Keine Geheimnisse, keine Rohdaten von Kunden** |
| `kundensichtbar` | nein | Default `false`; `true` nur mit `text_kunde` |
| `text_kunde` | nein | Klartext für den Kunden, ≤ 500 Zeichen |
| `zeitpunkt` | nein | ISO-8601 mit Offset, höchstens 5 Minuten voraus und 7 Tage zurück; ohne Angabe jetzt |

Antwort `201 {"id": <nr>, "zeitpunkt": "…"}`. Höchstens **50 Ereignisse je Agent und Stunde**, darüber `429` mit
`zu_viele_ereignisse` und `Retry-After: 3600` — melden, was zählt (gescheiterte Läufe, eingespielte Updates, Berichte),
nicht jeden Schritt. Ereignisse sind Nachweise: unveränderlich, nie gelöscht.

## Antwort freigeben: `GET /intern/vorgaenge/freigabe` (COPI-90)

In Modulen mit `eingriffe: [antwort_freigeben]` (`modul-vertrag.md`) schreibt der Agent einen **Entwurf** (als neue
Fassung in seine Fachtabelle, nie überschreiben) und **sendet erst, wenn ein Mensch genau diese Fassung im Cockpit
freigegeben hat.** Die Freigabe im Cockpit ersetzt jede andere (Slack, Entscheidung Stefan 29.09.2026).

> **Pflichtregel:** Unmittelbar vor dem Senden diesen Endpunkt mit der Fassung und dem SHA-256 (Hex, UTF-8) **des Texts,
> der rausgeht**, abfragen. Gesendet wird nur nach `200` mit `"freigegeben": true` — bei allem anderen (auch jedem
> Fehler, `404`, `503`, Timeout) **nicht**. Danach den Versand in die Fachtabelle eintragen (`versand`), damit das
> Cockpit „gesendet" zeigt und die Freigabe kein zweites Mal gilt. Außerdem gilt weiter die Übernahme-Sperre.

Recht `vorgang_lesen` (derselbe Zugang wie für die Sperre). Abfrage `?modul=<kennung>&id=<id>&fassung=<n>&hash=<sha256>`.

```bash
HASH=$(printf '%s' "$TEXT" | sha256sum | cut -d' ' -f1)
curl -H "Authorization: Bearer <token>" \
  "https://<kuerzel>.example.com/intern/vorgaenge/freigabe?modul=kommunikation&id=17&fassung=2&hash=$HASH"
# 200 {"freigegeben": true, "fassung": 2, "von": "Stefan Jacomeit", "am": "2026-10-02T10:42:00.000Z"}
# 200 {"freigegeben": false}                        noch nicht freigegeben
# 200 {"freigegeben": false, "grund": "nicht_aktuell"}  Fassung oder Text ist nicht die jüngste Fassung der View
# 200 {"freigegeben": false, "grund": "gesendet"}       diese Fassung ist schon gesendet
# 200 {"freigegeben": false, "grund": "uebernommen"}    ein Mensch hat den Vorgang übernommen
```

- Der Hash bindet die Freigabe an den Text: Der Agent darf nur genau den Text senden, den die Seite gezeigt hat (aus
  der View, Zeilenumbrüche wie gespeichert). Eine neue Fassung braucht eine neue Freigabe.
- `404 nicht_gefunden`: kein aktives Modul mit dieser Kennung **oder** ohne den Eingriff `antwort_freigeben`.
- `503 nicht_verfuegbar`: die View ließ sich nicht lesen — nicht senden, später erneut.

## Entscheidungen: `GET /intern/vorgaenge/entscheidungen` (COPI-91)

In Modulen mit `eingriffe: [entscheiden]` (`modul-vertrag.md`, etwa „Akquise") entscheidet ein Mensch im Cockpit über
einen Vorgang („Interessant", „Passt nicht", „Beworben"). Das Cockpit schreibt nichts in die Fachtabelle und schickt dem
Agenten nichts — der Agent **fragt die geltenden Entscheidungen ab** und gleicht sie mit seinem eigenen Stand ab.

Recht `vorgang_lesen`. Abfrage `?modul=<kennung>`.

```bash
curl -H "Authorization: Bearer <token>" "https://<kuerzel>.example.com/intern/vorgaenge/entscheidungen?modul=akquise"
# 200 {"entscheidungen": [{"id": "17", "wert": "interessant", "von": "Stefan Jacomeit", "am": "2026-10-07T08:12:00.000Z"}]}
```

- Je Vorgang (`id` der Modul-View) die **geltende** Entscheidung: die jüngste nicht zurückgenommene. Eine
  zurückgenommene verschwindet aus der Liste; ein Vorgang ohne Eintrag ist offen. Jüngste zuerst, höchstens 500.
- Der Agent handelt nur einmal je Entscheidung — er erkennt es an seinem eigenen Stand (Akquise: „interessant" ohne
  Schritt `bewerbung` → Bewerbungsentwurf schreiben; „beworben" ohne Schritt `beworben` → Lead über die Intake-API der
  Admin des Lead-Systems anlegen und den Schritt mit `adminUrl` schreiben; „passt_nicht" → Schritt `aussortiert`).
- `404 nicht_gefunden`: kein aktives Modul mit dieser Kennung **oder** ohne den Eingriff `entscheiden`.

**Beispiel „Wahlkarten" (COPI-146).** Zwei Arten von `id`:

| `id` | Vorgang | Werte |
| --- | --- | --- |
| `k<woche>-<kanal>`, etwa `k2026-W43-linkedin` | Wahlkarte je Woche und Kanal (`linkedin`, `facebook`) mit den Vorschlägen auf Position 1 bis 3 | `thema_eins`, `thema_zwei`, `thema_drei` (Position des gewählten Vorschlags), `keins` |
| Nummer des Posts, etwa `17` | ein Post | `freigeben`, `aenderung`, `gepostet`, `verwerfen` |

Der Agent übernimmt eine Wahl, indem sie für den gewählten Vorschlag den Schritt `gewaehlt` und für die übrigen der Karte
`nicht_gewaehlt` schreibt (bei `keins` alle `nicht_gewaehlt`), und legt den Post nur für diesen Kanal an
(`post.vorschlag_id`). Die Wahl auf einer Karte berührt die andere nicht. Ältere Entscheidungen mit `id` `v<nummer>`
(`waehlen`, `nicht_jetzt`, COPI-128, KW 42) bleiben in der Liste, neue entstehen so nicht mehr.

## KI-Verbrauch: `POST /intern/verbrauch`

Für jedes Ticket soll feststehen, welche KI-Modelle mit wie vielen Tokens zu welchen Kosten gearbeitet haben — egal ob
in Cowork, Claude Code oder n8n (COPI-97, Epic E6). Die Werkzeuge melden **Tokens**, das Cockpit rechnet die **Kosten**.

```bash
docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name claude-code-hook --scope verbrauch_schreiben

curl -sS -X POST https://<domain>/intern/verbrauch -H "Authorization: Bearer $COCKPIT_TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "schluessel": "claude-code:062e0ba4-15ba-517f-bff5-79a4d8bb86d3:msg_011CfZR1rZKGfTqD66mXDhQh",
    "zeitpunkt": "2026-09-30T09:49:23.698Z", "quelle": "claude-code", "modell": "claude-opus-5-5",
    "ticket": "COPI-97", "jira_projekt": "COPI", "sitzung": "062e0ba4-15ba-517f-bff5-79a4d8bb86d3",
    "qualitaet": "gemessen", "zuordnung": "branch", "subagent": false,
    "tokens_eingabe": 2, "tokens_ausgabe": 521, "tokens_cache_schreiben_5m": 0,
    "tokens_cache_schreiben_1h": 43708, "tokens_cache_lesen": 90397 }'
# 200 {"eintraege":1,"neu":1,"ersetzt":0,"ohne_preis":0}
```

Recht `verbrauch_schreiben`. Der Rumpf ist **ein Eintrag** (wie oben) oder **ein Stapel** `{"eintraege": [ … ]}` mit
1 bis 500 Einträgen, höchstens 512 KiB. Ein Stapel gilt ganz oder gar nicht: ist ein Eintrag ungültig, wird keiner
gespeichert, und `felder` nennt die Stelle (`["eintraege.3.quelle"]`).

| Feld | Pflicht | Inhalt |
| --- | --- | --- |
| `schluessel` | ja | der Schlüssel des Eintrags, 1–255 Zeichen aus Buchstaben, Ziffern, `_ . : -`. Vorgesehen: `cowork:<sitzung>:<message-id>`, `claude-code:<sitzung>:<message-id>`, `n8n:<id des LiteLLM-Aufrufs>` |
| `zeitpunkt` | ja | wann das Modell gearbeitet hat, ISO-8601 mit Zeitzone (`Z` oder `+02:00`); höchstens einen Tag in der Zukunft. Er bestimmt, welcher Preis gilt |
| `quelle` | ja | `cowork`, `claude-code` oder `n8n` |
| `modell` | ja | der Name des Modells, wie ihn der Anbieter meldet (`claude-opus-5-5`, `openai/gpt-oss-120b`), höchstens 100 Zeichen aus Buchstaben, Ziffern, `_ . : / -` |
| `tokens_eingabe`, `tokens_ausgabe` | ja | ganze Zahlen ab 0 |
| `tokens_cache_schreiben_5m`, `tokens_cache_schreiben_1h` | ja | Cache-Schreiben, **nach Laufzeit getrennt** (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`): die 1-Stunden-Laufzeit kostet das 2-fache, die 5-Minuten-Laufzeit das 1,25-fache des Eingabepreises. Ohne Cache `0` |
| `tokens_cache_lesen` | ja | Cache-Lesen (`cache_read_input_tokens`). Ohne Cache `0` |
| `ticket` | nein | Jira-Schlüssel (`JAC-630`). Ohne Angabe oder `null`: nicht zugeordnet |
| `jira_projekt` | nein | Jira-Projekt (`JAC`). Ohne Angabe folgt es aus dem Ticket; passt es nicht zum Ticket, ist das ein `400` |
| `sitzung` | nein | Sitzungs- bzw. Lauf-ID, höchstens 200 Zeichen |
| `qualitaet` | nein | `gemessen` (ohne Angabe) oder `geschaetzt` |
| `zuordnung` | nein | wie das Ticket gefunden wurde: `branch`, `repo-map`, `prompt`, `auftrag`, `tag` oder `keine` (ohne Angabe) |
| `subagent` | nein | `true`, wenn ein Subagent gearbeitet hat; ohne Angabe `false` |
| `agent` | nein | Kennung des Agenten, der den Einsatz hatte (COPI-113); ohne Angabe oder `null`: keinem zugeordnet. Zählt im Verbrauch seiner Detailseite |

**Idempotent über `schluessel`.** Dieselbe Meldung ein zweites Mal legt keinen zweiten Eintrag an, sondern **ersetzt**
den ersten — ganz, mit allen Feldern (ein Feld, das die neue Meldung weglässt, fällt auf seinen Vorgabewert zurück).
Ein Werkzeug darf also aus einem lokalen Puffer nachliefern und nach einem Fehler oder einer unklaren Antwort den
ganzen Stapel wiederholen. Die Antwort zählt `neu` und `ersetzt`. Zwei Einträge mit demselben Schlüssel **in einem
Stapel** sind ein `400` (`["eintraege"]`).

**`zeitpunkt` kommt vom Werkzeug** — die einzige Ausnahme von „Zeitpunkte setzt das Cockpit": nachgelieferte Einträge
gehören zu dem Tag, an dem gearbeitet wurde. Wer gemeldet hat (der Name des Zugangs) und wann, hält das Cockpit selbst
fest.

**Die Kosten rechnet das Cockpit**, nie das Werkzeug: ein Feld `kosten` ist ein unbekanntes Feld (`400`). Grundlage ist
die Preistabelle `cockpit.preis` — je Modell ein Listenpreis je Tokenart für eine Million Tokens, in der Währung des
Anbieters (Anthropic USD, IONOS EUR), mit Quelle, Prüfdatum und Gültigkeit von/bis. Es gilt der Preis zum `zeitpunkt`
des Eintrags; ein Datums-Anhang am Modellnamen (`claude-haiku-4-5-20251001`) zählt für die Suche nicht. Staffeln nach Prompt-Länge sind eigene Zeilen mit `prompt_ab`
(Eingabe + Cache-Schreiben + Cache-Lesen je Eintrag); es gilt die höchste passende Staffel. Ein neuer Preis
kommt als neue Zeile per Migration, die alte bekommt ihr Enddatum. Die Kosten sind jederzeit neu berechenbar
(`verbrauch-kosten-neu`, siehe README „Server-Kommandos").

**Ein Eintrag ohne Preis wird trotzdem gespeichert** — mit Kosten `NULL`, und die Antwort zählt ihn in `ohne_preis`.
Das ist eine Warnung, kein Fehler: das Werkzeug wiederholt nicht, sondern meldet Stefan das Modell; nach dem
Nachtragen des Preises rechnet `verbrauch-kosten-neu` den Eintrag nach. Die Antwort nennt das Modell nicht (nie Werte);
es steht im Log des Cockpits.

Einträge werden nie gelöscht. Eine falsche Meldung berichtigt das Werkzeug, indem es denselben Schlüssel mit den
richtigen Werten noch einmal meldet.

### Wechselkurs: `POST /intern/wechselkurs`

Die Kosten stehen im Protokoll in der Währung des Anbieters (USD oder EUR); die Auswertung zeigt **eine Summe in Euro**
(COPI-99). Den Kurs dafür ruft das Cockpit nie selbst ab — der tägliche Lauf in n8n meldet den Referenzkurs der EZB.

```bash
curl -sS -X POST https://<domain>/intern/wechselkurs -H "Authorization: Bearer $COCKPIT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"tag": "2026-09-30", "usd_je_eur": 1.1712}'
# 200 {"kurse":1,"neu":1,"ersetzt":0}
```

Recht `verbrauch_schreiben` (dasselbe wie für den Verbrauch, derselbe Lauf meldet beides). Der Rumpf ist **ein Kurs**
oder `{"kurse": [ … ]}` mit 1 bis 100 Tagen, zum Nachtragen; mehrere gelten ganz oder gar nicht.

| Feld | Pflicht | Inhalt |
| --- | --- | --- |
| `tag` | ja | der Kalendertag des Kurses, `YYYY-MM-DD`; höchstens der morgige |
| `usd_je_eur` | ja | **US-Dollar je 1 Euro**, so wie die EZB den Kurs veröffentlicht (etwa `1.1712`) — nicht der Kehrwert. Zwischen 0,5 und 2 |
| `quelle` | nein | woher der Kurs stammt, höchstens 100 Zeichen; ohne Angabe `EZB` |

**Idempotent je Tag:** derselbe Tag ein zweites Mal ersetzt den Kurs (`ersetzt` in der Antwort). Zwei Kurse zum selben
Tag in einer Meldung sind ein `400` (`["kurse"]`).

**Wie umgerechnet wird.** Ein Betrag in USD wird durch den Kurs seines Tages geteilt. **Fehlt der Kurs eines Tages**
(Wochenende, Feiertag, Meldung ausgeblieben), gilt der letzte davor. Gibt es bis zu diesem Tag gar keinen Kurs, hat
der Eintrag keinen Euro-Betrag und erscheint in der Auswertung als „ohne Kurs" — nie mit einem geratenen Wert. Ein
nachgetragener oder berichtigter Kurs wirkt sofort: umgerechnet wird beim Lesen, nichts ist gespeichert.

### Summen je Ticket: `GET /intern/verbrauch/tickets`

Für den täglichen Abgleich mit Jira (COPI-98): was ein Ticket bisher an KI-Verbrauch gekostet hat.

```bash
docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name jira-abgleich --scope verbrauch_lesen

curl -sS "https://<domain>/intern/verbrauch/tickets?seit=2026-09-29" -H "Authorization: Bearer $COCKPIT_TOKEN"
```

```json
{ "tickets": [ { "ticket": "JAC-630", "jira_projekt": "JAC",
    "modelle": ["claude-haiku-4-5", "claude-sonnet-5"], "einsaetze": 3,
    "tokens_eingabe": 3000000, "tokens_ausgabe": 1000000, "tokens_cache": 5,
    "kosten_eur": 6.55, "kosten_usd": 8, "geschaetzt": 1, "ohne_preis": 0, "ohne_kurs": 0,
    "letzter_tag": "2026-09-30" } ],
  "weitere": false }
```

Recht `verbrauch_lesen` — ein eigenes: ein Zugang, der nur meldet (`verbrauch_schreiben`), liest nicht.

- **Die Summen sind Gesamtsummen des Tickets**, über alle Tage — der Stand, nicht der Zuwachs. Der Abgleich schreibt
  sie so in die Jira-Felder und ist damit wiederholbar.
- `?seit=YYYY-MM-DD` (optional) wählt nur aus, **welche** Tickets kommen: die mit einem Einsatz an oder nach diesem
  Tag (Berliner Kalendertag). Für den täglichen Lauf: der Vortag. Weil nachgelieferte Einträge ältere Tage verändern
  können, gelegentlich ohne `seit` alles abgleichen.
- `?projekt=JAC` (optional) wählt ein Projekt. Ein unbekannter Parameter ist ein `400`.
- `tokens_cache` ist Cache-Schreiben (beide Laufzeiten) und Cache-Lesen zusammen.
- `kosten_eur` sind alle Kosten in Euro, USD-Anteile zum Kurs ihres Tages. `kosten_usd` ist der Anteil, der in
  US-Dollar anfiel, zum Listenpreis.
- `ohne_preis` und `ohne_kurs` zählen die Einsätze, die in `kosten_eur` **fehlen**, weil kein Preis bzw. kein
  Wechselkurs vorlag. Sind sie nicht 0, ist der Betrag zu niedrig — nie geschätzt.
- Einsätze ohne Ticket kommen hier nicht vor. Höchstens 500 Tickets, sortiert nach Projekt und Nummer; `weitere: true`
  heißt, es gibt mehr — dann mit `projekt` oder `seit` einschränken.

Gelesen wird aus den Tageswerten (`cockpit.verbrauch_tag`), die das Cockpit bei jeder Meldung für die betroffenen Tage
neu rechnet — sie sind immer auf dem Stand des Protokolls.

## Entwicklungspipeline: `/intern/pipeline` (COPI-145)

Für Koordinator (n8n), Recht `pipeline_verwalten`: Jobs anlegen (`POST /intern/pipeline/jobs`), einen Job mit Verlauf lesen
(`GET /intern/pipeline/jobs/:id`), offene Freigabe-Anfragen lesen (`GET /intern/pipeline/freigaben`) und als erledigt
markieren (`POST /intern/pipeline/jobs/:id/freigabe-erledigt`, COPI-180), abgelaufene Leases aufräumen (`POST /intern/pipeline/aufraeumen`). Ein Repo ohne
Einstellungen ist `409` mit `repo_unbekannt`. Rümpfe, Antworten und die Runner-Seite (`/pipeline/*`, HMAC statt
Bearer-Token) stehen in [`pipeline-api.md`](pipeline-api.md).

## Was der Agent im Protokoll hinterlässt

Das Cockpit führt ein Protokoll, das sich nicht ändern lässt. Aus der Agenten-API entstehen:

| Ereignis | Akteur |
| --- | --- |
| `update_freigegeben`, `update_gestartet`, `update_fehlgeschlagen` | `api_token_<nr>` |
| `update_erledigt` (der Erfolgsbeleg beim Start) | `system` |
| `api_zugriff_abgelehnt` (widerrufener Zugang oder fehlendes Recht; je Zugang und Grund höchstens einmal je Stunde) | `api_token_<nr>` |

Im Protokoll stehen nur Nummern und Kennungen — nie ein Digest, ein Text, ein Token.

## Kurz: was der Agent nie tun soll

- Das Token in eine Adresse, einen Log oder ein Repo schreiben.
- `erledigt` melden oder einen Eingriff ohne Stefans Freigabe auf Vorgangs-ID und Digest ausführen.
- Ein Image per Tag ziehen oder anderes als den Dienst `cockpit` neu starten.
- Etwas Internes in `text_kunde`, `rolle`, `grenzen`, `zeitplan` oder den `messwert` eines kundensichtbaren Befunds
  schreiben — das liest der Kunde.
- Eine Wache nur im Fehlerfall melden: ohne regelmäßige Meldung wird sie gelb.
- An einen Gast oder Kunden senden, ohne unmittelbar davor `GET /intern/vorgaenge/sperre` mit `"gesperrt": false`
  bekommen zu haben — bei einer Sperre oder einem Fehler wird nicht gesendet.
