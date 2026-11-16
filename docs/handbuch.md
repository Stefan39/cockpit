# cockpit

Betriebs-Cockpit der KI-Automatisierungs-Box — läuft als vierter Dienst neben `n8n`/PostgreSQL/Caddy in jeder Kundeninstanz. Node.js/TypeScript, Fastify, serverseitig gerendert. Details und Architekturgrenzen: [`docs/architektur-leitplanken.md`](architektur-leitplanken.md).

## So sieht es aus

![Das Cockpit: Übersicht, Antwort freigeben, Auswahl treffen, KI-Verbrauch, Agenten](bilder/cockpit-demo.gif)

Alle Bilder stammen aus einer lokalen Demo-Instanz mit erfundenen Daten (`./dev demo`, dann `./dev vorschau`):
[Übersicht](bilder/uebersicht.png) · [Eingang: Antwort freigeben](bilder/eingang-detail.png) ·
[Auswahl: entscheiden](bilder/auswahl-entscheidung.png) · [KI-Verbrauch je Projekt](bilder/ki-verbrauch.png) ·
[Agenten](bilder/agenten.png). Neue Bilder entstehen aus derselben Demo; der Seed ist wiederholbar und hat einen Test
(`test/demo-daten-datenbank.test.ts`).

## Voraussetzungen

- Node.js 24 (siehe `engines` in `package.json`)
- PostgreSQL erreichbar über `DATABASE_URL` (für Migrationen/lokalen Start)

### Umgebungsvariablen

| Variable | Pflicht | Bedeutung |
| --- | --- | --- |
| `DATABASE_URL` | ja | Vorhandene PostgreSQL, eigenes Schema `cockpit` |
| `TEST_DATABASE_URL` | nur für Tests | Datenbank der Datenbank-Tests; der Name muss auf `_test` enden (siehe „Quality Gates"). Die Anwendung liest sie nicht, die Tests lesen dafür **nie** `DATABASE_URL`. |
| `BETTER_AUTH_SECRET` | in Produktion | Geheimnis, mit dem Better Auth Sitzungen signiert und TOTP-Schlüssel verschlüsselt, mind. 32 Zeichen (`openssl rand -base64 32`). Ohne Wert startet das Cockpit in Produktion nicht; in der Entwicklung liegt ein Zufallsgeheimnis in `.cockpit-dev-secret` und bleibt über Neustarts gleich (siehe „Auth-Geheimnis"). |
| `COCKPIT_DOMAIN` | nein | Öffentliche Domain; bestimmt die Basis-URL (`https://…`) |
| `PORT`, `HOST` | nein | Default `3000` / `0.0.0.0` |
| `SMTP_HOST` | für Einladungen | Vorhandener mailcow-SMTP |
| `SMTP_PORT` | nein | Default `587` (STARTTLS erzwungen); `465` spricht TLS von Anfang an |
| `SMTP_USER`, `SMTP_PASS` | nein | Nur gesetzt, wenn der Server Authentifizierung verlangt |
| `SMTP_FROM` | für Einladungen | Absenderadresse. Ein Anzeigename wird verworfen — Mails gehen ohne ihn raus (Architektur-Vorschlag Abschnitt 7) |
| `COCKPIT_IMAGE_DIGEST` | in Produktion | Digest des laufenden Images (`sha256:…`), derselbe Wert wie in der `image:`-Zeile. Das Cockpit meldet ihn beim Start nach `cockpit.instanz` (COPI-39); ohne ihn lässt sich ein Update nicht bestätigen. Fehlt er oder ist er kaputt, bleibt er leer, mit Hinweis im Log |
| `COCKPIT_KOORDINATOR_URL`, `COCKPIT_KOORDINATOR_SECRET` | für den Assistenten | Webhook des Koordinator-Agenten in n8n und das gemeinsame Geheimnis der Signatur (mind. 32 Zeichen), beide oder keins (COPI-54). Ohne beide sagt der Chat, dass kein Assistent angebunden ist |
| `COCKPIT_PIPELINE_SECRET` | für die Entwicklungspipeline | Gemeinsames Geheimnis mit dem Runner (mind. 32 Zeichen), HMAC über den Rumpf (COPI-145, [`docs/pipeline-api.md`](pipeline-api.md)). Ohne Wert nimmt `/pipeline` nichts an |
| `COCKPIT_KOORDINATOR_FRIST` | nein | Sekunden, bis eine ausbleibende Antwort im Verlauf steht (Standard 120) |
| `COCKPIT_CHAT_TAGESLIMIT` | nein | Nachrichten an den Assistenten je Konto und Tag (Standard 50, COPI-57) |
| `COCKPIT_CHAT_MAIL_NACH_MINUTEN` | nein | Nach wie vielen Minuten eine dringende, ungelesene Nachricht per E-Mail gemeldet wird (Standard 15, COPI-60) |
| `COCKPIT_VAPID_PUBLIC_KEY`, `COCKPIT_VAPID_PRIVATE_KEY` | für Push | Das Paar aus `vapid-erzeugen` (COPI-59), beide oder keins. Ohne sie gibt es keinen Push, dringende Nachrichten kommen per E-Mail |
| `COCKPIT_VAPID_KONTAKT` | nein | `mailto:` oder `https:` für die Push-Dienste; ohne Angabe die Adresse des Cockpits |
| `COCKPIT_INSTANZ_NAME` | nein | Name der Instanz, etwa der des Betriebs (COPI-43). Steht wie im Prototyp unter der Wortmarke und mobil über dem Seitentitel; höchstens 40 Zeichen, ohne Angabe keiner |
| `COCKPIT_WARTUNGSFENSTER` | nein | Wann das Cockpit im Modus `automatisch` ein Image-Update beantragt (COPI-235): `di 07-09` (Standard, auch ohne Angabe oder leer) oder `jederzeit` (ohne Fenster, ohne Tagesgrenze; der Schutz je Ziel bleibt). Jeder andere Wert verhindert den Start. Module sind davon unberührt |
| `COCKPIT_VERSION`, `COCKPIT_COMMIT` | nein | Werden **beim Bauen** gesetzt (Build-Argumente), nicht in der Instanz. Ohne sie meldet sich das Cockpit mit der Version aus `package.json` und „lokal" |

Ohne `SMTP_HOST` und `SMTP_FROM` startet das Cockpit, verschickt aber keine
Mail und registriert die Einladungsroute gar nicht erst; beim Start steht ein
entsprechender Hinweis im Log.

## Lokal entwickeln und testen

Voraussetzung: Docker Desktop und Node 24 (`.nvmrc`). Den ganzen Stack steuert
das Skript `./dev` im Repo-Root — ohne Variablen zu setzen und ohne die
Reihenfolge der Schritte zu kennen:

```bash
./dev up      # alles starten; Strg+C beendet alles wieder
./dev down    # aufräumen, falls doch etwas hängen geblieben ist
```

| Befehl | Wirkung |
| --- | --- |
| `./dev up` | Legt `.env` aus `.env.example` an (falls sie fehlt) und lädt sie, erzeugt das Dev-Zertifikat, startet Postgres und Mailpit (wartet, bis beide gesund sind), führt `npm run migrate` und `npm run assets` aus und startet Dev-Server und Asset-Watcher im Vordergrund. **Strg+C beendet alles**, auch die Container; die Daten bleiben erhalten. |
| `./dev down` | Beendet alles, auch wenn das Terminal vorher weg war oder ein Prozess abgestürzt ist: erst die eigenen Dev-Prozesse, dann die Container. Meldet am Ende, ob die Ports 3000, 5432, 1025 und 8025 frei sind, und nennt sonst den Verursacher. Darf beliebig oft aufgerufen werden. |
| `./dev status` | Zeigt Container, belegte Ports (mit Verursacher) und die laufenden Dienste. |
| `./dev test [Argumente]` | `npm test` mit geladener `.env`; Argumente gehen an Vitest, z. B. `./dev test test/geheimnis-datenbank.test.ts`. Startet Postgres, falls es nicht läuft, und stoppt es danach wieder. |
| `./dev coverage` | Wie `./dev test`, aber `npm run coverage` (Gate 3). |
| `./dev reset` | Löscht die Dev-Datenbank (Docker-Volume) nach Rückfrage. Das nächste `./dev up` legt sie neu an, und der Dev-Server gibt ein frisches Erststart-Token aus. |
| `./dev demo` | Füllt die Dev-Datenbank mit realistischen Demodaten (COPI-80): sechs Wachen mit Befund-Verlauf über 7 Tage und dem Beispiel-Modul „Server & Dienste". Startet Postgres bei Bedarf, lässt es aber laufen. Wiederholbar — räumt vorher nur die eigenen Zeilen ab (Präfix `demo-`). |
| `./dev vorschau --rolle <rolle> [--port N]` | Startet das Cockpit gegen die Dev-Datenbank mit einer eingesetzten Sitzung für `betreuer`, `betriebs_admin` oder `betrieb_mitarbeiter` — angemeldet, zweiter Faktor aktiv, ohne Anmeldeformular und ohne Passkey. Standard-Port 3100 (nie 3000). |

Ist beim Start ein Port schon belegt — etwa weil der Stack eines anderen Projekts
noch läuft (Postgres auf 5432) —, bricht `./dev up` ab, statt zu scheitern, nachdem
schon etwas gestartet wurde. Die Meldung nennt den Verursacher (Container oder
Prozess); dort zuerst herunterfahren, dann erneut `./dev up`. Bei einer anderen
Node-Version als in `.nvmrc` warnt das Skript, startet aber trotzdem. Beim
Arbeiten an Views oder am Stylesheet ist der Asset-Watcher schon dabei (siehe
„Oberfläche und Stylesheet"): jede Änderung baut neu, ein Neuladen im Browser
genügt.

**Die `.env` wird per Shell geladen.** Werte mit Leerzeichen oder
Sonderzeichen (`$`, `!`, `#`, `;`, `"` …) gehören deshalb in **einfache**
Anführungszeichen; darin ist alles wörtlich. Doppelte Anführungszeichen mit
`$` darin, ein nicht geschlossenes Anführungszeichen oder eine Zeile ohne
`NAME=Wert` lassen `./dev up` und `./dev test` abbrechen, bevor etwas startet.
Die Meldung nennt Zeile und Namen, nie den Wert (COPI-63;
`docker/env-pruefen.sh`). Früher lief der Dev-Server dann mit einer halb
geladenen Umgebung an, etwa ohne VAPID-Schlüssel. Secrets am besten gleich
ohne Sonderzeichen erzeugen: `openssl rand -hex 32`. Halb eingerichtete Paare
(Koordinator-URL ohne `_SECRET`, nur ein VAPID-Schlüssel) meldet `./dev` als
Warnung.

**Einzelschritte ohne `./dev`** — etwa für eine IDE-Run-Konfiguration. Das ist
genau die Reihenfolge, die `./dev up` abarbeitet:

```bash
npm ci
npm run dev:stack                 # Postgres + Mailpit starten (erzeugt vorher das Dev-Zertifikat)
cp .env.example .env
set -a && . ./.env && set +a      # Variablen in die Shell laden — die Anwendung liest .env nicht selbst
npm run migrate                   # Schema `cockpit` anlegen
npm run assets                    # Stylesheet und Schriften bauen (ohne sie startet die Anwendung nicht)
npm run dev                       # Fastify-Dev-Server mit Autoreload
npm run assets:watch              # optional, zweites Terminal: baut bei Views-/Stylesheet-Änderungen neu
npm run dev:stack:down            # Postgres + Mailpit stoppen (Daten bleiben)
```

| Was | Wo |
| --- | --- |
| Cockpit | http://localhost:3000 |
| Erststart-Link | im Terminal des Dev-Servers: `http://localhost:3000/erststart/<TOKEN>` |
| Mailpit (empfangene Mails) | http://localhost:8025 |
| SMTP (STARTTLS) | `localhost:1025` |
| Postgres | `localhost:5432`, Benutzer `postgres`, Passwort `dev`, Datenbank `cockpit` |

Alle Ports sind nur an `127.0.0.1` gebunden. Der Mailversand erzwingt auch
lokal STARTTLS; Mailpit bietet es mit dem selbstsignierten Zertifikat aus
`docker/dev-certs.sh` an (gitignored, nur lokal), dem der Server über
`NODE_EXTRA_CA_CERTS` vertraut. Die Zertifikatsprüfung bleibt eingeschaltet.

**Erststart durchspielen:** Link aus dem Terminal öffnen, Konto anlegen,
TOTP mit einer Authenticator-App einrichten, Code bestätigen. Danach führt
http://localhost:3000 auf die Anmeldeseite; nach dem Abmelden geht es über
`/anmelden` mit Passwort und Code wieder hinein.

**Zurücksetzen** (leere Datenbank, neues Erststart-Token):

```bash
./dev reset   # löscht die Dev-Datenbank nach Rückfrage
./dev up      # legt sie neu an; der Dev-Server gibt beim Start ein frisches Token aus
```

Ohne `./dev reset` bleiben die Daten erhalten — auch über `./dev down` und
Neustarts des Rechners hinweg. (Manuell entspricht `reset` einem
`docker compose -f docker/compose.dev.yaml down -v`.)

Ohne Docker genügt ein beliebiger erreichbarer Postgres über `DATABASE_URL`;
dann entfallen Mailpit und die `SMTP_*`-Variablen, und die Einladungsroute
wird nicht registriert.

**Demodaten und Rollen-Vorschau (COPI-80).** Für Oberflächenänderungen, die
sich wie auf dem Pilotserver ansehen lassen sollen — in jeder Rolle, ohne
Erststart und ohne Passkey:

```bash
./dev demo                              # Demodaten einspielen (wiederholbar)
./dev vorschau --rolle betreuer         # Cockpit als Betreuer, http://localhost:3100
./dev vorschau --rolle betriebs_admin --port 3101   # mehrere Rollen parallel, je ein Port
```

`./dev demo` legt sechs Wachen mit einem Befund-Verlauf über 7 Tage an
(Container, Plattenplatz, Erreichbarkeit, Zertifikat, Datensicherung, dazu
eine rein interne, die nie kundensichtbar ist) und spielt das Beispiel-Modul
„Server & Dienste" ein (`docs/beispiele/`, COPI-78). Aktueller Stand:
Erreichbarkeit rot, Zertifikat überfällig (gelb), der Rest grün — dazwischen
ein paar gelbe/rote Episoden. Alle Kennungen tragen das Präfix `demo-`: ein
erneuter Lauf räumt vorher nur diese eigenen Zeilen ab, nichts sonst.

`./dev vorschau` startet den echten Server (`buildApp`) gegen die Dev-
Datenbank, aber mit einer eingesetzten Sitzung statt eines Logins — dieselbe
Technik wie in den Datenbank-Tests (`sitzungLesen`/`zugangLesen`,
`src/server/app.ts`). Es baut die Assets vorher frisch, genau wie `./dev up`.
Beide Werkzeuge liegen unter `scripts/dev/` (nicht in `src/`, nie im Image)
und brechen ab, sobald `NODE_ENV=production` ist oder `DATABASE_URL` nicht
auf `localhost`/`127.0.0.1`/`::1` zeigt — das gilt auch für den Löschschutz,
den `./dev demo` zum Abräumen der eigenen Demodaten kurz lokal aushebelt
(„Nie löschen, nur markieren").

## Quality Gates (siehe docs/architektur-leitplanken.md)

```bash
npm run typecheck  # Gate 1 — TypeScript strict
npm run lint        # Gate 2 — ESLint
npm run coverage    # Gate 3 — Vitest + Coverage
npm run dupes        # Gate 4 — jscpd, Schwelle ≤ 1 %
```

**Gate 3 nur mit Testdatenbank aussagekräftig:** Ohne `TEST_DATABASE_URL`
überspringt Vitest die Datenbank-Tests (1049 von 2213, darunter Erststart,
Einladung, Anmeldung, Konto-Verfall, Betreuer-Regeln, Protokoll, Server-Kommando,
zweiter Faktor, Passkey, Entsperrung, die E2-Abnahme, der Routen-Test, die Migrationen, das Schema des Zustandsbilds, die Agenten-API,
die Übersicht, Agenten und Zeitplan, die Einstellungen, die Selbstmeldung, die Meldungen und die Messreihe der rohen Auth-Endpunkte)
und meldet trotzdem grün; zu Beginn des Laufs steht dazu ein Hinweis. Lokal also
mit Testdatenbank prüfen — `./dev coverage` lädt die `.env` (mit `TEST_DATABASE_URL`),
startet Postgres bei Bedarf und stoppt es danach wieder:

```bash
./dev coverage
```

Die Datenbank-Tests **räumen ihre Datenbank ab** (Konten, Einladungen, Token).
Deshalb gilt:

- Sie lesen ausschließlich `TEST_DATABASE_URL`, **nie** `DATABASE_URL`, die
  Datenbank von `npm run dev`. Eine Shell mit geladener `.env` richtet die Tests
  also nicht versehentlich auf die Dev-Daten.
- Der Datenbankname muss auf `_test` enden (Buchstaben, Ziffern, Unterstrich),
  sonst bricht der Lauf ab, bevor ein Test etwas löscht. Das gilt auch für eine
  einzelne Testdatei.
- Die Testdatenbank `cockpit_test` wird beim ersten Lauf angelegt und migriert,
  falls sie fehlt (über die Wartungsdatenbank `postgres` desselben Servers; der
  Dev-Postgres erlaubt das). Ein `./dev reset` nimmt sie mit, der nächste Lauf
  legt sie neu an. `npm run migrate` ist dafür nicht nötig.
- Die Testdateien laufen **parallel** (COPI-73, `./dev test` ca. 70 s statt 215 s). Dazu legt das `globalSetup`
  nach dem Migrieren je Vitest-Worker eine Kopie an (`cockpit_w1_test` bis `cockpit_w6_test`, in der CI zwei;
  `CREATE DATABASE … TEMPLATE cockpit_test`, mit gesetztem `cockpit.testdaten_loeschen`). Jeder Worker arbeitet nur
  in seiner Kopie (`VITEST_POOL_ID`, gelesen in `test/testdatenbank.ts`); `cockpit_test` selbst ist nur die Vorlage.
  Die Kopien werden bei jedem Lauf ersetzt, weil sie den Stand der Vorlage haben müssen. Neue Tests lesen die URL
  darum über `testDatenbankUrl` aus `test/testdatenbank.ts`, nie aus `process.env`. Postgres braucht dafür die
  Standardgrenze von 100 Verbindungen.
- `.env.example` enthält die Variable; `./dev test` und `./dev coverage` laden die
  `.env` selbst. Wer `npm test` direkt aufruft, muss sie vorher in die Shell laden
  (`set -a && . ./.env && set +a`). Die CI setzt dieselbe Variable.

Der Dev-Postgres ist wie in der CI Version 16.

Docker-Build lokal (Sandbox hat kein Docker, daher nur in CI/lokal bei dir geprüft):

```bash
docker build -f docker/Dockerfile -t cockpit:lokal .
# Stylesheet und Schriften aus dem Image, unveränderlich ausgeliefert, keine Build-Werkzeuge darin:
sh docker/smoke-assets.sh cockpit:lokal
# Der Weg einer neuen Instanz gegen eine LEERE Datenbank (Nutzung im Kopf des Skripts):
SMOKE_URL=http://localhost:3105 sh docker/smoke-schema.sh cockpit:lokal \
  postgres://postgres:dev@host.docker.internal:5432/cockpit_smoke -p 3105:3000
```

## Oberfläche und Stylesheet (Epic E1, COPI-30)

Serverseitig gerenderte Seiten (Eta) mit **Tailwind CSS v4**. Gestaltet ist nach Stefans Prototyp
aus Claude Design (`.cowork/prototyp`, gitignoriert): Karten auf `page`-Grund, schmale Beschriftungen,
IBM Plex, Hell und Dunkel. Der Prototyp zeigt Übersicht, Chat, Buchungen, Meldungen und Einstellungen;
Anmelde- und Einrichtungsseiten sind aus derselben Sprache abgeleitet.

### Stylesheet bauen

```bash
npm run assets          # einmal bauen
npm run assets:watch    # neu bauen, sobald sich views/ oder assets/css/ ändern
```

`src/assets/bauen.ts` lässt die Tailwind CLI `assets/css/input.css` bauen (nur `views/` wird nach Klassen
durchsucht, `source(none)` plus `@source`), kopiert die Schriften aus `node_modules` und gibt **jeder Datei den
Hash ihres Inhalts im Namen**. Das Ergebnis liegt in `assets/gebaut/` (gitignoriert):

| Datei | Zweck |
| --- | --- |
| `cockpit.<hash>.css` | das Stylesheet, mit umgeschriebenen Schrift-Adressen (`/assets/<name>`) |
| `ibm-plex-sans-latin-wght-normal.<hash>.woff2` | IBM Plex Sans, variabel (400–700), Subset „latin" |
| `ibm-plex-mono-latin-500-normal.<hash>.woff2` | IBM Plex Mono 500, Subset „latin" |
| `manifest.json` | Name des Stylesheets und Inhaltstyp jeder Datei |

Im Image läuft der Schritt im Build-Stage (`RUN npm run assets`); die Laufzeit enthält nur das Ergebnis, kein
Tailwind und keine Schriftpakete (die Pakete sind `devDependencies`, das Image installiert mit `--omit=dev`).
Renovate hält Tailwind und die Schriften aktuell. Ohne gebaute Assets **startet die Anwendung nicht** und
sagt, dass `npm run assets` fehlt; in Tests baut `test/global-setup-assets.ts` sie einmal je Lauf.

**Auslieferung:** `GET /assets/<name>` (`src/server/routes/assets.ts`) mit
`cache-control: public, max-age=31536000, immutable` und `x-content-type-options: nosniff`. Der Name ist ein
Schlüssel im Manifest, kein Dateipfad: unbekannte Namen, das Manifest selbst und Pfadtricks ergeben 404. Die Route
steht **in jedem Zustand** offen (Tor-Kategorie „immer", Tabelle unter „E2: was erreichbar ist"), weil schon die
Anmeldeseite und die Einrichtung ohne zweiten Faktor ihr Stylesheet brauchen. Außerhalb von Produktion liest die
Anwendung das Manifest bei jeder Anfrage neu (Watch-Betrieb ohne Neustart), in Produktion einmal beim Start.

**Keine Fremdanfragen:** kein CDN, keine Google Fonts, kein Skript und kein Stil von außen. Der Build bricht ab,
wenn das Stylesheet auf etwas anderes als eine lokale `.woff2`-Datei zeigt; `test/layout.test.ts` und
`test/assets.test.ts` prüfen Views, gerenderte Seiten und Stylesheet auf fremde Hosts.

**Lizenz der Schriften:** IBM Plex steht unter der SIL Open Font License 1.1 (die Lizenztexte liegen in den
Paketen `@fontsource-variable/ibm-plex-sans` und `@fontsource/ibm-plex-mono`). Es ist kein Tailwind-Plus-Material
im Repo; wer Bausteine daraus übernehmen will, klärt vorher die Lizenz (Stefan).

### Layout und Bausteine

`views/layout.eta` ist das einzige Dokument: `lang="de"`, Viewport, `color-scheme`, Titel (`<Titel> · Cockpit`),
Stylesheet und `<main>`, in zwei Formen: **angemeldete Seiten** (sie übergeben `nav`) bekommen den App-Rahmen des
Prototyps (siehe „App-Rahmen und Navigation"), **Seiten ohne Konto** (Anmelden, Erststart, Einlösen) die Wortmarke
und eine schmale Karte. Jede Seite beginnt mit `<% layout('layout') %>` bzw. `<% layout('layout', { nav: it.nav }) %>`
und schreibt nur ihren Inhalt; `app.render` setzt Stylesheet und Instanznamen, eine Seite kann beides weder
vergessen noch überschreiben.

| Baustein | Datei | Angaben |
| --- | --- | --- |
| Kopf (ohne Konto) | `views/partials/kopf.eta` | — (Wortmarke) |
| App-Rahmen | `views/partials/rahmen.eta` | `nav`, `instanz` (setzt das Layout) |
| Seitenkopf | `views/partials/seiten-kopf.eta` | `titel`, `instanz`, `pfad`; optional `ansicht` („Ansicht: Betreuer") |
| Dark Mode | `views/partials/darstellung.eta` | `pfad`, `art` (`breit` oder `rund`) |
| Symbol | `views/partials/symbol.eta` | `name` (Strichzeichnung aus dem Prototyp) |
| Hinweisbox | `views/partials/hinweis.eta` | `art` (`fehler`, `info`, `ok`), `text` |
| Formularfeld | `views/partials/feld.eta` | `id`, `label`; optional `name`, `typ`, `wert`, `autocomplete`, `minlength`, `maxlength`, `inputmode`, `autocapitalize`, `spellcheck`, `nurLesen`, `mono`, `pflicht`, `hilfe` |
| Schaltfläche | `views/partials/knopf.eta` | `text`; optional `art` (`primaer`, `sekundaer`) |

**Neue Seite anlegen:** `views/<name>.eta` mit `<% layout('layout') %>` (angemeldet: mit `nav` und dem Seitenkopf,
der die `<h1>` trägt), genau einer `<h1>`, Feldern über `feld.eta`;
danach in `test/layout.test.ts` Beispieldaten eintragen (sonst schlägt der Test an). Regeln, die die Tests
durchsetzen: keine Seite am Layout vorbei, **kein `style=`, kein `<style>`, kein Inline-Skript, kein
`on…=`-Attribut** (eine strenge Content-Security-Policy bleibt so möglich; sie selbst ist nicht Teil von COPI-30),
jedes Formularfeld hat ein `<label for>`. Der QR-Code ist ein Inline-SVG ohne `style`; seine Größe setzt `.qr svg`.
Interaktive Teile kommen später mit Stimulus, nicht mit Alpine oder React.

### App-Rahmen und Navigation (COPI-38, COPI-43)

Die angemeldeten Seiten laufen im Rahmen des Prototyps (`.cowork/prototyp/Design.html`): **am Desktop** (ab 1024 px)
eine Sidebar mit Wortmarke, Instanzname, fünf Einträgen und unten Dark Mode und Abmelden; **mobil** nur die
Navigation als feste Tab-Leiste unten, darüber im Seitenkopf der Instanzname und ein runder Dark-Mode-Knopf. Ein
Markup für beide Größen, eine Navigation. Die Einträge liefert `navigation()` (`src/server/navigation.ts`, eine reine
Funktion); eine Seite übergibt `nav: navigationFuerZugang('<seite>', zugang)`.

| Eintrag | Ziel |
| --- | --- |
| Übersicht | `/` |
| Nachrichten | `/chat` mit dem Recht `chat_nutzen` (jede Rolle), sonst ausgegraut; Zahl ungelesener Chats und Postfach-Zeilen (E4, COPI-112) |
| Module | **ausgegraut**, kommt mit E5 |
| Meldungen | `/meldungen` |
| Mehr | `/mehr`: Agenten, Zeitplan, Einstellungen, Einladen (nur mit dem Recht), Abmelden |

- **Ausgegraut heißt: kein Link.** Module (und der Chat ohne Recht) stehen da, damit der Rahmen aussieht wie geplant,
  sind aber nicht fokussierbar und für Screenreader „folgt" — keine Seite, die auf eine `404` führt. Auf den Seiten unter „Mehr" ist
  „Mehr" markiert, wie im Prototyp bei den Einstellungen.
- **Ein Link ist keine Zugriffsregel.** Die Route prüft selbst (Tor, Rechte). Die Navigation zeigt nur, was diese Prüfung
  ohnehin durchlässt, und nutzt dafür dieselbe Regel (`hatRecht`): „Einladen" steht nur bei Konten mit dem Recht
  `einladen`.
- **Abmelden ist ein Formular** (`POST /abmelden`, die vorhandene Route), kein Link: ein GET dürfte nichts ändern. Am
  Desktop in der Sidebar, mobil unter „Mehr". Ohne Sitzung gibt es keins.
- **Neue Seite in die Navigation:** in `HAUPT` oder `MEHR` (`navigation.ts`) und in `test/navigation.test.ts`
  eintragen; ein neues Symbol in `views/partials/symbol.eta`.
- **Erweiterungen (COPI-193):** Ein Modul kann über `AppAbhaengigkeiten.erweiterungen` Routen (nur `GET`/`HEAD`) und höchstens
  einen Navigationseintrag anmelden: am Desktop an Position 2 hinter „Übersicht", mobil unter „Mehr", die Tab-Leiste bleibt
  bei fünf Plätzen. Im Kundenimage ist die Liste leer, dann ändert sich nichts. Regeln und Beispiel: `docs/erweiterungen.md`.
- **Am Desktop kein „Mehr" (COPI-108, Entscheidung Stefan, bewusste Abweichung vom Prototyp):** Die Sidebar zeigt die
  Einträge von „Mehr" (Benutzer, Agenten, Zeitplan, Einstellungen, Einladen) direkt als zweite Gruppe „Verwaltung"
  (`nav.mehr`, dieselbe Rechte-Regel), „Mehr" steht nur noch in der mobilen Tab-Leiste (`nurMobil`). `/mehr` bleibt
  erreichbar. Geprüft in `test/navigation.test.ts` und `test/verwaltungsnav.test.ts`.
- **Rückweg auf Unterseiten (COPI-100):** Jede Seite unterhalb der fünf Haupteinträge übergibt dem Seitenkopf
  `zurueck: { href, ziel }`. Mobil erscheint dann links neben dem Titel der runde Zurück-Knopf des Prototyps (in der
  installierten App gibt es keine Browserleiste); am Desktop führen Sidebar, Brotkrume und Listenspalte zurück. Die
  Karten der Übersicht hängen `?von=uebersicht` an, dann führt der Knopf zur Übersicht statt zur Liste
  (`src/module/rueckweg.ts`, nur dieser eine Wert zählt). Geprüft in `test/rueckweg.test.ts` und den Modultests.
- **Seiten aktualisieren sich selbst (COPI-105):** Übersicht, Meldungen und alle Modulseiten übergeben dem Seitenkopf
  `aktualisieren: 60` (→ `data-aktualisieren`) und zeigen „Stand: …". `assets/js/pwa.js` lädt sie neu, sobald der
  Stand älter als 60 s ist — geprüft alle 15 s und sofort beim Zurückkehren in die App. Nie, solange die Seite verborgen
  ist, das Gerät offline ist oder ein Formular bearbeitet wird (Fokus in einem Feld oder ein Feld geändert). Gecacht
  wird nichts (`no-store`, der Service Worker hat keinen `fetch`-Handler). Seiten mit Eingaben oder Einstellungen
  bekommen `aktualisieren` nie. Tests: `test/pwa-skript.test.ts`, `test/aktualisieren.test.ts`, die Modultests.

### Dark Mode (COPI-43)

Der Schalter „Dark Mode" ist ein Formular (`POST /darstellung`, `hell` oder `dunkel`), **kein Skript**. Das Cockpit
merkt sich die Wahl ein Jahr lang im Browser (Cookie `__Host-darstellung`, `HttpOnly`, `SameSite=Lax` — die Wahl hängt
am Browser, nicht am Konto) und setzt sie beim Ausliefern jeder HTML-Seite als `data-theme` auf `<html>` (ein
`onSend`-Haken vor dem ETag, mit `Vary: Cookie`). Ohne Wahl folgt die Seite dem Gerät. Der Rücksprung geht nur auf
eine eigene Seite, sonst zur Übersicht. Beide Knöpfe („Dark Mode", „Light Mode") stehen im Markup; welcher sichtbar
ist, entscheidet das CSS über die Variante `dunkel:`.

### Theme-Werte an einer Stelle

Alle Farben und Schriften stehen oben in `assets/css/input.css`, im Block `@theme static`: **je Farbe ein Wert**,
`light-dark(hell, dunkel)` oder einer für beide (seit COPI-43; vorher ein zweiter Block für Dunkel). Welcher gilt,
entscheidet `color-scheme`: ohne Wahl das Gerät, sonst der Dark-Mode-Schalter. Die Namen erscheinen als Klassen
(`bg-page`, `text-ink-2`, `border-line`). `light-dark()` verlangt Safari 17.5, Chrome 123 oder Firefox 120.

Abweichungen vom Prototyp sind reine **Kontrast-Korrekturen** (WCAG AA), im Kopf der Datei begründet:
`ink-3` hell `#9aa1af → #667085` und dunkel `#767c8a → #8a90a0`, `ok` hell `#1c8a4b → #187a41`,
`warn` hell `#a8620a → #9a5808`. Eingabefelder tragen den dunkleren Rand `field-line` (mindestens 3 : 1 gegen die
Fläche); die helle Kartenlinie des Prototyps bliebe für ein Formularfeld zu blass. Der Primärknopf ist seit COPI-214 in beiden Modi Orange `#ff6d20` mit Navy-Schrift `#000b20` (Weiß auf Orange erreicht
nur 2,8 : 1; vorher `#2954e0` mit weißem Text); die Seitenleiste ist in beiden Modi Navy (`--color-side*`). Eingaben haben auf dem Telefon 16 px, damit iOS nicht in das Feld
hineinzoomt.

### Barrierefreiheit (Grundprüfung)

- **Beschriftung:** jedes Formularfeld hat ein `<label for>` mit passender `id` (Test über alle gerenderten Seiten).
- **Fokus:** jedes bedienbare Element zeigt einen 2-px-Rahmen in `focus` (hell `#ed651e`, dunkel `#ff8a4c`; vorher `#2954e0` bzw. `#7da0ff`); ein
  Sprunglink „Zum Inhalt springen" führt an den Kopf vorbei.
- **Kontrast:** `test/kontrast.test.ts` liest die Farben aus `input.css` und misst jedes verwendete Paar in beiden
  Modi: Text mindestens 4,5 : 1, Feldrand und Fokus mindestens 3 : 1.
- **Meldungen:** Fehler sind `role="alert"`, Erfolg `role="status"`; das Symbol ist `aria-hidden`.

### Sicherheits-Header und CSP (COPI-93)

Das Cockpit setzt die Sicherheits-Header **selbst** (`src/server/sicherheit.ts`, ein `onSend`-Haken), nicht der
Proxy: so gelten sie hinter Caddy und hinter Traefik gleich. Sie stehen auf jeder Antwort, auch auf Fehlern, 404,
Weiterleitungen und den Antworten des Tors; der Chat-Strom (`reply.hijack()`) schreibt sie selbst.

| Header | Wert | Warum |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=31536000` | ohne `includeSubDomains`/`preload`: die Domain ist ein Parameter, daneben laufen andere Dienste |
| `Content-Security-Policy` | jede Quelle `'self'`; `object-src`, `base-uri`, `frame-ancestors` `'none'`; `form-action 'self'` | kein Inline, kein `eval`, keine fremden Quellen |
| `X-Frame-Options` | `DENY` | für Browser ohne `frame-ancestors` |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `same-origin` | |
| `Permissions-Policy` | Kamera, Mikrofon, Ortung, Zahlung, USB aus | Passkeys stehen nicht darin: ihr Standard ist schon „eigener Ursprung“ |

**Für neue Views gilt deshalb:** kein `<script>` ohne `src`, kein `style=`/`<style>`, keine `on…=`-Attribute, keine
`javascript:`-Links, keine fremden Quellen. Der Browser würde all das stumm blockieren; `test/views-csp.test.ts` fällt
schon vorher auf. Verhalten gehört in eine Skriptdatei, Aussehen in `input.css`.

## Schema und Migrationen (Epic E1)

Auf einer neuen Kundeninstanz entsteht das Schema `cockpit`, und bei einem Image-Update wird es
nachgezogen, **ohne dass jemand von Hand SQL ausführt**. Der Weg ist ein Befehl des Server-Kommandos
(COPI-31):

```bash
# Neue Instanz: einmal vor dem ersten Start. Update: nach jedem Wechsel des Images.
docker compose run --rm cockpit node dist/cli/index.js migrieren
docker compose up -d cockpit
```

`run --rm`, nicht `exec`: das Cockpit **startet ohne Schema nicht**, und in einem beendeten Container
lässt sich nichts ausführen. `run` startet einen einmaligen Container mit derselben Umgebung
(`DATABASE_URL` …) und räumt ihn danach weg. Ist die Datenbank auf dem Stand, tut `migrieren` nichts
(„Das Schema ist auf dem Stand: nichts zu tun.") — der Befehl ist beliebig oft wiederholbar.

| Aufruf | Wirkung |
| --- | --- |
| `migrieren` | wendet alle ausstehenden Migrationen an, in der Reihenfolge ihrer Nummern |
| `migrieren --status` | zeigt je Migration `angewendet`, `ausstehend` oder `unbekannt`, ändert nichts |
| `migrieren --zurueck --bestaetigt` | nimmt **nur die letzte** Migration zurück (siehe „Rückwärts") |

**Was das Image dafür enthält.** Der Runner (`src/datenbank/migrationen.ts`, im Build als
`dist/datenbank`) und die Migrationen (`db/migrations`, im Image `/app/db/migrations`). Bis COPI-31
fehlte beides; auf einer leeren Datenbank brach der Container mit `relation "cockpit.user" does not
exist` ab, und die Doku nannte keinen Weg. Es gibt **eine** Implementierung: `npm run migrate`
(Entwicklung, Testdatenbank, CI) ruft dieselbe Bibliothek.

**Die Start-Prüfung.** Als Erstes, vor jeder anderen Abfrage, vergleicht das Cockpit die Datenbank mit
den Migrationen des Images. Fehlt das Schema oder eine Migration, endet es mit **Exit-Code 3** und sagt,
was fehlt und was zu tun ist — statt mit einem SQL-Fehler:

```
COCKPIT STARTET NICHT
Das Schema cockpit fehlt in der Datenbank. Migration 0001_init ausstehend (und 15 weitere).
Bitte ausführen: docker compose run --rm cockpit node dist/cli/index.js migrieren
```

Mit `restart: unless-stopped` (Compose-Fragment) startet der Container in diesem Zustand immer wieder
neu und wiederholt die Meldung, bis migriert ist: das ist gewollt, es macht den fehlenden Schritt
sichtbar. Ist die Datenbank **neuer als das Image** (angewendete Migration, die das Image nicht kennt),
startet das Cockpit mit einer Warnung im Log: ein Rückbau auf ein älteres Image soll nicht am Schema
scheitern, additive Migrationen tragen das.

**Warum nicht automatisch beim Start?** Ein Image-Update würde die Datenbank sonst ohne Freigabe
verändern. Das widerspricht „Updates sind Anträge" (ADR 13.1): die Freigabe liegt außerhalb, die
Ausführung beim Werkzeug `cockpit-update` bzw. beim Betreuer, und der Schritt `migrieren` ist dabei
sichtbar und protokollierbar. Auch ein getrennter Init-Container wurde verworfen: er brauchte einen
zweiten Dienst je Kunde („ein Prozess, ein Container").

**Regeln des Runners.**

- **Nur ein Lauf zugleich.** Ein Advisory-Lock umschließt jeden Lauf: rufen Betreuer und Admin-Agent
  gleichzeitig `migrieren` auf, wartet der zweite und findet danach ein fertiges Schema vor.
- **Jede Migration in einer eigenen Transaktion**, samt dem Eintrag in `cockpit.schema_migrations`. Eine
  kaputte Migration hinterlässt nichts Halbes; die vorherigen bleiben angewendet, der Fehler nennt die
  Migration (`Migration 0007_… fehlgeschlagen: …`, Exit 1), und der nächste Aufruf setzt dort fort.
- **Nur gültige Paare.** Jede Migration braucht `NNNN_name.up.sql` und `NNNN_name.down.sql`, der Name
  in Kleinbuchstaben. Eine Migration ohne `down` wird abgewiesen: ohne `down` gäbe es keinen Rückweg.

### Rückwärts: wann, von wem, womit

`migrieren --zurueck --bestaetigt` nimmt **genau die letzte** Migration zurück, die das Image kennt
(mehrfach aufrufen für mehr). Es ist die Ausnahme, nicht der Weg, und deshalb bewusst unbequem:

- **Wann:** Nur wenn ein Update zurückgenommen werden muss **und** das Zurückgehen der Daten hinnehmbar ist.
  Die `.down.sql` **löschen Tabellen, Spalten und Daten** (etwa die Passkeys und Ersatzcodes bei `0012`,
  die offenen Wiederherstellungs-Links bei `0014`, bei `0001` das ganze Schema). Meist ist es besser, ein
  älteres Image auf der neueren Datenbank laufen zu lassen (siehe oben); die meisten Migrationen sind
  additiv.
- **Von wem:** Vom Betreuer am Server (später vom Admin-Agenten über `cockpit-update`, E3), **nie**
  automatisch und nie über die Oberfläche. Ohne `--bestaetigt` läuft der Befehl nicht (Exit 2), damit
  ihn kein Tippfehler auslöst.
- **Womit, in dieser Reihenfolge:** (1) Cockpit anhalten (`docker compose stop cockpit`), (2) eine
  Sicherung des Schemas ziehen, solange es die automatische Sicherung noch nicht gibt (E7):
  `pg_dump --schema=cockpit …`, (3) `docker compose run --rm cockpit node dist/cli/index.js migrieren
  --zurueck --bestaetigt`, so oft wie nötig, (4) das **ältere** Image eintragen und starten. Ein Image, das
  weniger Migrationen kennt, startet auf der zurückgenommenen Datenbank; eines, das mehr kennt, verweigert
  den Start mit der Meldung oben.
- **Getestet:** `test/migrationen-datenbank.test.ts` geht die ganze Kette rückwärts durch alle Migrationen
  bis zur leeren Datenbank und wieder vorwärts. Dabei fiel auf, dass der alte Runner `0001` nie
  zurücknehmen konnte (die `down` entfernt das Verzeichnis, das er danach fortschreiben wollte); der
  neue trägt den Eintrag nur nach, wenn das Verzeichnis noch da ist.

Nicht Teil: automatisches Zurückrollen bei fehlgeschlagenem Update (E3, Update-Antrag) und die Sicherung
vor der Migration (E7, Betrieb & Rückbau).

**CI (Gate 6).** Der Docker-Job startet eine leere PostgreSQL und lässt `docker/smoke-schema.sh` den Weg
einer neuen Instanz nachspielen: Start ohne Schema (Exit 3 mit Meldung), `migrieren`, zweiter Aufruf tut
nichts, `--status` zeigt nichts Offenes, danach Start und Antwort auf `/gesund`. Das Skript läuft auch
lokal (Nutzung im Kopf der Datei).

### Tabellen des Zustandsbilds (Epic E3, COPI-34)

Migration `0015_zustandsbild` legt fünf Tabellen an. Sie sind der Vertrag zwischen dem Admin-Agenten (der
meldet) und dem Cockpit (das zeigt und beantragt): **das Cockpit prüft nichts selbst** (ADR 4). Die Regeln
stehen als Constraint oder Trigger **in der Datenbank**, nicht nur in einer Route, damit ein späterer Fehler
im Anwendungscode sie nicht aufweichen kann.

| Tabelle | Inhalt | Regeln der Datenbank |
| --- | --- | --- |
| `wache` | Herzschlag je Wache: Kennung, erwarteter Takt, letzter Lauf; dazu der Anzeigename (COPI-37, Migration `0017`) | `letzter_lauf` ist NULL, solange nie gemeldet wurde (kein erfundener Zeitpunkt); Takt > 0; Anzeigename NULL oder 1–60 Zeichen mit mindestens einem sichtbaren Zeichen |
| `befund` | eine Meldung einer Wache: Status `gruen`/`gelb`/`rot`, Text intern, Klartext für den Kunden | `kundensichtbar` ist per Default `false`; sichtbar wird ein Befund nur mit Klartext (`text_kunde`), denn der Kunde sieht nie den Rohbefund |
| `agent` | Inventar, das der Admin-Agent liefert: Rolle, Version, Grenzen, Zeitplan | je Agent eine Zeile (neues Inventar überschreibt); Grenzen sind ein Objekt, Zeitplan eine Liste |
| `instanz` | genau eine Zeile: Version und Digest des laufenden Cockpits | `id` ist immer `true` (keine zweite Zeile); Digest nur als vollständiger `sha256:`-Wert oder NULL |
| `eingriff` | der Update-Antrag („das Cockpit beantragt, es aktualisiert nichts", ADR 13.1) | siehe unten |

**`eingriff`.** Die Kette ist `beantragt → freigegeben → laeuft → erledigt | fehlgeschlagen`; **jede andere
Kante lehnt die Datenbank ab** (Trigger `eingriff_kette`), auch Rückwärts und Überspringen. `haengt` (länger
als 15 Minuten in `laeuft`) wird nie gespeichert, sondern beim Lesen abgeleitet. Nach dem Antrag stehen Art,
Ziel-Digest, Rückweg (`digest_vorher`), Antragsteller und Antragszeitpunkt fest: die Freigabe lautet auf
Vorgangs-ID und Ziel-Digest, änderte sich der Digest, wäre sie wertlos. Die Zeitstempel je Übergang setzt die
Datenbank; wer sie von Hand mitgibt, wird abgelehnt statt stillschweigend überschrieben. In E3 gibt es nur die
Art `cockpit-image`, `modul` folgt mit der Modul-Registry (E5). `digest_vorher` steht in derselben Zeile, der
Rückweg ist damit ein Befehl und keine Recherche.

Seit Migration `0018_update_antrag` (COPI-40) gibt es eine fünfte Kante `beantragt → zurueckgezogen`: ein Antrag,
der noch nicht freigegeben ist, lässt sich zurücknehmen; ein freigegebener nicht mehr. Und es gibt **höchstens einen
offenen Antrag** je Art (`beantragt`, `freigegeben`, `laeuft`; partieller Unique-Index `eingriff_ein_offener_antrag`),
auch mit anderem Ziel — für den Admin-Agenten stehen nie zwei Updates des Cockpits zugleich an.

Seit Migration `0020_eingriff_lebenszyklus` (COPI-41) trägt ein Eingriff ab der Freigabe eine **Ziel-Version**
(`ziel_version`, SemVer ohne Build-Metadaten wie `1.5.0`): der Admin-Agent nennt sie mit der Freigabe, danach steht sie
fest (`eingriff_ziel_version_passt`, `eingriff_ziel_version`). Und **`laeuft → erledigt` gilt nur mit Beleg**: wenn
`cockpit.instanz` genau diesen Ziel-Digest und diese Version (ohne den Commit) meldet (`eingriff_ohne_beleg`). Warum die
Version zählt: der Digest der Selbstmeldung kommt aus der Umgebung — bliebe beim Update die `image:`-Zeile stehen,
meldete das alte Image den neuen Digest; die gebackene Version verrät es.

Seit Migration `0040_modul_update` (COPI-106) gibt es die Art **`modul`**: statt der Digests `modul_kennung`,
`ziel_commit` (7–40 Hex) und `herkunft_vorher` (der Weg zurück), beide Formen schließen einander aus
(`eingriff_art_passt`). Dazu `fehler_grund` für beide Arten (nur mit `fehlgeschlagen`, danach fest). Der offene Antrag
ist seitdem **je Art und Modul** eindeutig. `laeuft → erledigt` gilt beim Modul nur, wenn die aktive Version des Moduls
aus dem Ziel-Commit stammt (Trigger `eingriff_modul`); der Beleg des Images (`eingriff_lebenszyklus`) gilt nur für seine
Art.

**Der Digest kommt nicht aus dem Image.** Ein Image kann seinen eigenen Digest nicht enthalten (er ist ein Hash
über den Inhalt). Er wird deshalb beim Deployment mitgegeben (`COCKPIT_IMAGE_DIGEST`); lokal bleibt er leer. Die
Selbstmeldung selbst steht unter „Einstellungen und Versionen". Getestet ist das Schema in `test/zustandsbild-schema-datenbank.test.ts` (Regeln der Tabellen, jede
erlaubte und jede verbotene Kante der Kette, Up und Down gegen eine leere Datenbank).

## Agenten-API (Epic E3, COPI-35)

Der Admin-Agent meldet dem Cockpit, statt dass das Cockpit selbst prüft (ADR 4): Befunde, Inventar, Anträge.
Das geschieht per HTTP unter `/intern`, **maschinell mit einem Bearer-Token** und nicht von einem Konto — also
ohne Sitzung und ohne zweiten Faktor. Das ist die **einzige Ausnahme** von „Sitzung und zweiter Faktor vor
jeder Route", und sie liegt auf dem einzigen öffentlich erreichbaren Dienst mit Login. Deshalb ist sie eng
gebaut und mehrfach abgesichert (unten). Endpunkte: `GET /intern/ping` (ein Agent prüft, ob Adresse, Token und
Rechte stimmen), `POST /intern/befund`, `PUT /intern/agenten` sowie `GET /intern/eingriffe`, `GET /intern/eingriffe/:id`
und `POST /intern/eingriffe/:id/status` (siehe unten). Den Update-Antrag stellt der Betreuer in den Einstellungen
(COPI-40); der Agent holt ihn über die Agenten-API ab und meldet seinen Stand (COPI-41).

**Der Vertrag steht in [`docs/agenten-api.md`](agenten-api.md)** (COPI-42): Zugang, Antworten und Fehler, Befunde
und Wachen samt der Regel „wann eine Wache ausbleibt", Versions-Wache, Inventar, Update-Anträge mit dem Ablauf für das
Werkzeug `cockpit-update`, Protokoll. Er ist so geschrieben, dass die Agenten-Seite (`agent-blueprints`) keinen Blick in
diesen Code braucht; wer hier eine Route ändert, ändert ihn mit. Hier steht, wie die API innen abgesichert ist.

| Recht | Wofür | Ticket |
| --- | --- | --- |
| `befund_schreiben` | Befunde und Herzschlag der Wachen melden (`POST /intern/befund`) | COPI-36 |
| `agenten_schreiben` | Inventar der Agenten liefern (`PUT /intern/agenten`) | COPI-38 |
| `eingriff_verwalten` | Anträge lesen und ihren Status setzen (`/intern/eingriffe`) | COPI-41 |
| `chat_antworten` | Agenten schreiben in den Chat: der Koordinator antwortet auf eine Frage (`POST /intern/chat/antwort`), Agenten schreiben einander (`POST /intern/chat/agenten`, COPI-113) | COPI-55 |
| `zustand_lesen` | Koordinator: den Zustand lesen, genau die Kundensicht (`GET /intern/zustand`); Budget-Wache: Verbrauch des Chats (`GET /intern/chat/verbrauch`, COPI-57) | COPI-55 |
| `vorgang_lesen` | Fachagenten: vor jedem Senden an einen Gast fragen, ob ein Mensch den Vorgang übernommen hat (`GET /intern/vorgaenge/sperre`) und ob die Antwort freigegeben ist (`GET /intern/vorgaenge/freigabe`, COPI-90) | COPI-85 |
| `verbrauch_schreiben` | Werkzeuge (Claude-Code-Hook, Cowork, n8n): KI-Verbrauch melden — Modell und Tokens je Einsatz; die Kosten rechnet das Cockpit aus `cockpit.preis` (`POST /intern/verbrauch`); dazu der tägliche Wechselkurs für die Summe in Euro (`POST /intern/wechselkurs`, COPI-99) | COPI-97 |
| `verbrauch_lesen` | Täglicher Abgleich mit Jira: die Summen des KI-Verbrauchs je Ticket lesen (`GET /intern/verbrauch/tickets`) | COPI-98 |
| `pipeline_verwalten` | Koordinator: Jobs der Entwicklungspipeline anlegen und lesen, abgelaufene Leases aufräumen (`/intern/pipeline/*`, [`docs/pipeline-api.md`](pipeline-api.md)) | COPI-145 |

Zugänge legt nur das Server-Kommando an (`api-token-erzeugen`, `-auflisten`, `-widerrufen`), nie die Oberfläche; das
Token erscheint genau einmal auf der Konsole, gespeichert wird nur sein SHA-256-Hash, ein Widerruf ist endgültig. Die
Zeitlogik einer Wache (`wachenZustand`, `src/status/zustand.ts`) ist eine reine Funktion mit dem Zeitpunkt als Parameter:
das Cockpit rechnet beim Ansehen, ob eine Wache ausgeblieben ist — ohne Scheduler.

**Messwert je Befund (COPI-83):** `POST /intern/befund` nimmt optional **einen** Hauptmesswert an
(`"messwert": {"wert": 86, "einheit": "%", "max": 100, "warnung": 85}`), streng geprüft wie der Rest (unbekanntes Feld,
unendliche Zahl, leere Einheit, `max` ≤ 0 → `400` mit Feldname) und in der Datenbank noch einmal
(`befund_messwert_form`, Migration 0029, Spalte `befund.messwert jsonb`). Für den Kunden zählt er nur über einen
kundensichtbaren Befund; `GET /intern/zustand` liefert ihn deshalb nur aus dem jüngsten kundensichtbaren Befund (sonst
`null`). Getestet in `test/befund-messwert-datenbank.test.ts`.

**Update-Ziel je Befund (COPI-140):** Versions-Wachen (`version-cockpit`, `version-modul-<kennung>`) melden mit einem gelben
Befund optional das neuere Ziel (`"update": {"art", "ziel", "version", "hinweis", "seit"}`), streng geprüft (Art passt
zur Wache, Digest bzw. voller Commit, Version nur beim Cockpit, nur gelb; sonst `400` mit Feldname, gespeichert wird
nichts) und in der Datenbank noch einmal (`befund_update_ziel_form`, Migration 0049, Spalte `befund.update_ziel jsonb`).
Daraus wird „Update installieren" (unten). Getestet in `test/intern-befund-datenbank.test.ts`.

### Was abgesichert ist

- **Das Tor lässt `/intern` durch, liest aber nie eine Sitzung.** Freigegeben nur, wenn **jede** Schreibweise des
  Pfades (roh, klein, prozent-dekodiert) auf `/intern` zeigt: `/INTERN/x`, `/%69ntern/x`, `/intern%2Fx` und
  `/intern/../api/auth/…` bleiben zu. Ein Cookie schaltet dort nichts frei und kostet keine Abfrage; umgekehrt
  macht das Token nichts außerhalb von `/intern` auf (`/`, `/api/auth/…` bleiben ohne Sitzung zu). Der Routen-Test
  führt die Ausnahme als eigene Kategorie `maschinell` und verlangt, dass jede Route unter `/intern` in ihr steht
  und keine andere.
- **Die Prüfung läuft für das ganze Plugin, vor dem Rumpf.** Ein kaputter Rumpf ohne Token ist ein `401`, kein
  `400`. Routen entstehen nur über den `InternerRouter` und **müssen** ein Recht nennen (oder `null` für „jedes
  gültige Token"); eine Route ohne Rechteprüfung gibt es nicht.
- **Nur ein wohlgeformtes Token löst eine Datenbankabfrage aus** (Präfix, Länge, base64url). Der Vergleich läuft
  über den Hash eines 256-Bit-Zufallswerts.
- **Begrenzung:** je Client-IP höchstens 20 gescheiterte Versuche in 15 Minuten (wer besteht, bekommt die
  Reservierung zurück, ein Agent verbraucht also nie Budget), je Zugang höchstens 300 Anfragen in der Minute.
- **Kein Token im Log:** Fastify loggt keine Kopfzeilen, und unter `/intern` geht nur der Pfad in den Log, nie die
  Abfrage — hängt ein Client das Token versehentlich an (`?token=…`), steht es nirgends. Auch nicht in Antworten
  und nicht im Protokoll.
- **Protokoll (COPI-23):** Erzeugen und Widerrufen stehen in **derselben Transaktion** wie die Änderung. Ein
  widerrufener Zugang oder ein fehlendes Recht (`api_zugriff_abgelehnt`, Grund `widerrufen` bzw. `scope`) ist ein
  Zeichen für ein durchgesickertes Token oder einen Fehler im Agenten und kommt ins Protokoll — je Zugang und
  Grund höchstens einmal je Stunde.

### Bewusste Entscheidungen

- **Der Zähler liegt im Arbeitsspeicher, nicht in der Datenbank** wie bei der Anmeldung. Dort schützt er ein
  Geheimnis, das sich raten lässt, und eine Sperre muss einen Neustart überstehen. Ein Token hat 256 Bit und lässt
  sich nicht erraten; der Zähler schützt hier nur Ressourcen. Ein Neustart setzt ihn zurück, das ist harmlos, und
  ein Datenbankzugriff je Anfrage würde einen Angriff verstärken statt ihn zu bremsen.
- **Ein fehlendes, kaputtes oder unbekanntes Token kommt nicht ins Protokoll.** Es lässt sich nicht bereinigen
  (COPI-23), und der offene Endpunkt würde es mit Rauschen füllen. Der Log der Anwendung zeigt diese Anfragen.
- **Nur JSON.** Das Plugin kennt keinen anderen Inhaltstyp (kein Formular, kein Text): ein anderer ist eine `415`,
  keine Auslegung. Jeder Fehler wird zu einer knappen JSON-Antwort ohne Text der Datenbank.
- **Rechte mit Unterstrich** (`befund_schreiben`), nicht mit Doppelpunkt: sie stehen im Protokoll, und dort passt
  nur eine Kennung.
- **Erreichbarkeit:** `/intern` liegt hinter derselben Adresse wie das Cockpit (Caddy leitet alles außer
  `/webhook/*` und `/n8n/*` an das Cockpit). Läuft der Agent im selben Docker-Netz, lässt sich `/intern/*` am Caddy
  sperren und der Agent spricht `cockpit:3000` direkt an — eine Härtung, keine Voraussetzung. Die Anwendung
  verlässt sich nicht darauf.

Getestet in `test/intern-token.test.ts` (Format, Kopfzeile), `test/intern-ratenbegrenzung.test.ts` (Zähler),
`test/zwei-faktor-tor.test.ts` (die Ausnahme im Tor), `test/api-token-datenbank.test.ts` (Tabelle, Speicher,
Protokoll), `test/intern-zugang-datenbank.test.ts` (echte Anfragen: Antworten, Rechte, Cookie, Protokoll,
Begrenzung, Log, Datenbankausfall) und `test/cli-api-token-datenbank.test.ts` (die Kommandos, bis zu einem Token,
das die API wirklich öffnet). `POST /intern/befund`: `test/status-zustand.test.ts` (die Zeitlogik),
`test/befund-speicher-datenbank.test.ts` (Transaktion, Nebenläufigkeit) und `test/intern-befund-datenbank.test.ts`
(gültig, ungültig, zu groß, ohne Recht, Fälschungsversuche, Fehlerfälle). `PUT /intern/agenten`:
`test/agenten-speicher-datenbank.test.ts` (Ersetzen, Entfernen, alles oder nichts, Nebenläufigkeit) und
`test/intern-agenten-datenbank.test.ts` (dieselben Fälle wie beim Befund, dazu: eine abgewiesene Meldung lässt das
Inventar unangetastet). Eingriffe: `test/intern-eingriffe-datenbank.test.ts` (jede erlaubte und jede verbotene Kante
über die API, kein `erledigt`, fremdes Ziel, doppelter und gleichzeitiger Wechsel, ohne und mit falschem Recht,
`haengt` nach 15 Minuten, Fehlschlag abfragbar, Transaktion).

## Entwicklungspipeline: Job-Queue (COPI-145)

Die operative Queue der autonomen Entwicklungspipeline (Epic JAC-732, Konzept TEAM 127172609): Koordinator (n8n) legt Jobs an,
der Runner auf dem Mini-PC holt sie per Lease, meldet und schließt ab. **Der Vertrag steht in
[`docs/pipeline-api.md`](pipeline-api.md).**

- **Runner:** `POST /pipeline/claim`, `/heartbeat`, `/event`, `/complete` — eigener Präfix, angemeldet per HMAC über den
  rohen Rumpf mit Zeitstempel (Fenster 5 Minuten, Geheimnis `COCKPIT_PIPELINE_SECRET`). Das Tor lässt den Präfix wie
  `/intern` ohne Sitzung durch; ohne Signatur 401, auch für einen Pfad, den es nicht gibt (`src/pipeline/api.ts`).
- **Koordinator:** `POST /intern/pipeline/jobs`, `GET /intern/pipeline/jobs/:id`, `POST /intern/pipeline/aufraeumen` — Agenten-API
  mit Recht `pipeline_verwalten`. Der Runner kann keine Jobs anlegen.
- **Betreuer:** `pipeline-repo` (YAML von der Standardeingabe) und `pipeline-repos` — Phase, Auto-Merge, Reviewer je Repo.
  Repos auf der Sperrliste (`COCKPIT_AUTO_MERGE_SPERRLISTE`, kommagetrennt, Standard leer) nie mit Auto-Merge.
- **Vergabe** (`src/pipeline/queue.ts`): eine Transaktion mit Advisory-Sperre, `FOR UPDATE SKIP LOCKED`, Lease 15 Minuten;
  `rework` vor `implement`, dann Fälligkeit, Priorität, Alter; höchstens ein Umsetzungsjob je Repo (auch per eindeutigem
  Index); erschöpfte Anbieter bekommen nichts. Abgelaufene Leases räumt jede Vergabe auf (`attempt + 1`, nach
  `max_attempts` `parked`), ein Abo-Limit zählt nicht als Versuch.
- **Tabellen** `cockpit.pipeline_*` (Migration 0051) statt eines eigenen Schemas: die Rolle `cockpit` legt keine Schemas
  an (COPI-66). Audit und Verbrauch nur anhängen, nichts löschen.

Tests: `test/pipeline-queue-datenbank.test.ts` (gleichzeitige Vergaben, Leases, Abschluss, Idempotenz),
`test/pipeline-api-datenbank.test.ts` (Signatur, Replay-Fenster, Endpunkte), `test/pipeline-signatur.test.ts`,
`test/cli-pipeline-datenbank.test.ts`.

## Übersicht (Epic E3, COPI-37)

Die Startseite `/` ist aufgebaut wie im Prototyp (seit COPI-43): oben ein Satz zum Betrieb mit dem Text dazu und bei
Rot oder Gelb „Jetzt ansehen" (zu den Meldungen), darunter je Wache eine kompakte Kachel — Name und „Läuft · vor 4 Min.
geprüft" (Zustand als Farbe **und Wort**: `Läuft`, `Achtung`, `Störung`; Farbe allein ist keine Auskunft) —, ab
1280 px rechts, darunter unten die **drei letzten Meldungen** (siehe „Meldungen"). Die schwerste Farbe steht zuerst,
danach nach Namen. Das Cockpit **übersetzt nichts**: der Text ist der
Klartext, den der Schreiber des Befunds mitgeliefert hat (später der Koordinator, E4). Angesprochen wird mit „Sie".

| Sicht | Wer | Was sie zeigt |
| --- | --- | --- |
| Kunde | Betriebs-Admin, Mitarbeiter — und jedes Konto mit unbekannter Rolle | nur Wachen mit einem **kundensichtbaren** Befund, und von ihm allein Farbe, Klartext und „zuletzt geprüft" |
| Betreuer | Recht `rohbefunde_sehen` (nur der Betreuer) | jede Wache mit dem jüngsten Befund gleich welcher Sichtbarkeit: Rohbefund, Kennung, „für Kunden sichtbar"/„nur intern", der Klartext des Kunden |

| Statuskarte | Wenn |
| --- | --- |
| „Noch keine Meldungen" | keine Kachel |
| „Alles läuft" | alle grün |
| „Alles läuft, N Sache(n) im Blick" | mindestens eine gelb, keine rot |
| „N Sache(n) braucht/brauchen Ihre Aufmerksamkeit" | mindestens eine rot |

Darunter steht der Text der ersten Kachel der schwersten Farbe; das Cockpit erfindet keinen.

- **Die Trennung liegt in der Abfrage, nicht in der Vorlage.** Die Kundenabfrage (`src/status/uebersicht-speicher.ts`)
  liest keinen Rohbefund und keine Herkunft und liefert eine Wache ohne kundensichtbaren Befund gar nicht erst — der
  Kunde erfährt nicht, dass es sie gibt. Die Eingabe der Kundensicht (`KundenZeile`) hat kein Feld für einen Rohbefund,
  und die Kachel hat keins für die Kennung (sie dient nur der festen Reihenfolge).
  Ein interner Befund ändert die Kundenseite deshalb nicht, auch nicht Farbe oder „zuletzt geprüft"; die Seite ist mit
  und ohne interne Befunde **byteidentisch** (getestet).
- **Der jüngste Befund ist der zuletzt eingetroffene** (`id`), nicht der mit dem spätesten Zeitpunkt: springt die
  Uhr zurück, gilt der neueste Befund trotzdem.
- **Die Farbe folgt `wachenZustand`:** eine ausbleibende Wache wird gelb (Kachel und „zuletzt geprüft" in Warnfarbe),
  ein gemeldetes Rot bleibt rot. Bei der Kundensicht zählt der Herzschlag des sichtbaren Befunds, beim Betreuer der der
  Wache selbst.
- **Alles wird maskiert, nichts verlinkt** (Text vom Agenten kann Fremdtext enthalten). Die Seite hat
  `Cache-Control: no-store`; die Sicht wird bei jeder Anfrage aus der **frisch gelesenen** Rolle bestimmt, ein
  entzogenes Recht wirkt also sofort.
- **Nicht enthalten:** das Kontingent des Prototyps (dafür gibt es bis E4 keine Daten). Den Update-Antrag gibt es in den
  Einstellungen (COPI-40).

Getestet in `test/status-uebersicht.test.ts` (die reinen Funktionen), `test/status-uebersicht-datenbank.test.ts`
(die Abfragen), `test/uebersicht-datenbank.test.ts` (die Seite je Rolle, mit echten Sitzungen), dazu
`test/layout.test.ts` und `test/kontrast.test.ts` (Vorlagen und Farbpaare).

### Dashboard aus Modul-Karten (COPI-81)

Sieht ein Zugang mindestens ein aktives Modul mit dem Abschnitt `uebersicht:` im `cockpit:`-Block (Vertrag:
`docs/modul-vertrag.md`; dieselbe Sichtbarkeit wie die Modulseiten), wird `/` ein Dashboard. Ohne ein solches Modul
bleibt die Seite genau wie oben beschrieben.

- **Aufbau:** „Stand: heute, 10:02", das **Zustandsband** (die Statuskarte mit `band`: „1 Störung, 1 Hinweis" oder
  „Alles in Ordnung", die Kurztexte der roten und gelben Karten, „Jetzt ansehen" zur schlimmsten Karte bzw. — wenn
  mehrere gleich schlimm sind — zu ihrem Modul), **vier Kennzahlen** (Dienste in Ordnung, Verfügbarkeit 24 Std.,
  Offene Punkte, Letzte Prüfung), je Modul ein **Kartenraster** (1/2/3/4 Spalten ab mobil/md/lg/xl, rot → gelb →
  grün, höchstens 24 Karten, sonst „+ n weitere"), darunter **Zustand der letzten 7 Tage** (2/3) und „Letzte
  Meldungen" (1/3). Die Wachen-Kacheln sieht dann **nur noch der Betreuer** („Alle Wachen · nur Betreuer").
- **Bänder:** 24 gleitende Stunden je Karte, Status je Stunde der schlimmste Verlaufspunkt, leere Stunden übernehmen
  den zuletzt bekannten Status, der jüngste Eimer zusätzlich den aktuellen Kartenstatus. Ohne lesbaren Verlauf (keine
  Verlaufs-View, Katalog oder Lesen gescheitert) bleiben die Bänder ganz neutral; die Karten erscheinen trotzdem.
  Verfügbarkeit = Anteil grüner unter den belegten Stunden, abgerundet. Das Wochendiagramm zählt je Kalendertag
  (Europe/Berlin, 23/24/25 Stunden) den schlimmsten Status über alle Karten.
- **Diagramme ohne Skript und ohne `style`:** Bänder und Säulen sind serverseitig gerenderte Inline-SVGs
  (`partials/band.eta`, `partials/woche-diagramm.eta`), Lage und Höhe nur als SVG-Attribute, Farbe über Klassen mit
  eigenen Theme-Werten (`band-ok`, `band-warn`, `band-danger`, `danger-hauch`/`-rand`, `warn-hauch`/`-rand`, hell und
  dunkel). Jede Farbe hat ein Wort daneben, jedes Band und das Diagramm eine Textalternative (`<title>`, `aria-label`).

- **Messwerte (COPI-83):** trägt eine Zeile der Modul-View die optionale Spalte `wert` (dazu `einheit`, `wert_max`,
  `wert_warnung`; Verlaufs-View optional `wert`), zeigt die Karte groß den Wert, bei `wert_max` Bezug und Füllbalken
  und statt des Bands eine 24-Std.-Kurve (Fläche + Linie) mit „vor 24 Std. · 80 – 86 % · jetzt". Karten ohne Wert
  bleiben unverändert. Kurve und Balken sind Inline-SVG ohne `style`: Pfade als `d`-Attribut, der Balken mit einer
  Prozentbreite als Attribut (`width="86%"`, ohne `viewBox`, damit die runden Enden rund bleiben), Farbe, Strichstärke
  und Strichelung per Klasse, `vector-effect: non-scaling-stroke` gegen die gedehnte `viewBox`.

Rechnung in `src/module/zeitraster.ts`, `src/module/uebersicht-karten.ts` und `src/module/messwert-kurve.ts` (reine
Funktionen; Skalierung, Pfade mit Lücken, Karte und Kachel teilen den Code), Lesen in
`src/module/uebersicht-lesen.ts`. Getestet in `test/modul-uebersicht-rechnung.test.ts`,
`test/modul-uebersicht-block.test.ts` und `test/modul-uebersicht-datenbank.test.ts`.

## Meldungen (Epic E3, COPI-43)

Die Seite **Meldungen** (`/meldungen`) und „Letzte Meldungen" auf der Übersicht zeigen, was sich im Betrieb geändert
hat, aufgebaut wie im Prototyp: Suche, Filter (Alle, Warnung, Fehler, Info), je Zeile ein Symbol in der Farbe des Status,
der Text und „vor 2 Std. · Rechnungs-Agent".

- **Eine Meldung ist ein Wechsel:** ein Befund, dessen Status oder Text sich gegenüber dem vorigen derselben Wache
  geändert hat. Eine Wache, die alle fünf Minuten „Alles läuft." meldet, ergibt eine Meldung, nicht hundert.
- **Getrennt je Sicht, in der Abfrage** (`src/status/meldungen-speicher.ts`): Betriebs-Admin und Mitarbeiter lesen nur
  kundensichtbare Befunde, ihren Klartext und den Anzeigenamen — keine Kennung, auch nicht für die Suche; auch der
  Wechsel wird nur unter den sichtbaren bestimmt. Der Betreuer (Recht `rohbefunde_sehen`) liest alle, mit Rohbefund,
  Kennung und der Marke „nur intern".
- **Ohne Skript:** die Filter sind Links, die die Suche mitnehmen; die Suche ist ein GET-Formular, das den Filter behält.
  „Warnung" ist Gelb, „Fehler" Rot, „Info" Grün. Die Suche ist `ILIKE`, `%`, `_` und `\` gelten wörtlich; höchstens 100
  Zeichen. Die Seite zeigt die 50 neuesten, die Übersicht die drei neuesten.
- Alles wird maskiert, nichts verlinkt; `no-store`.

Getestet in `test/status-meldungen.test.ts` (Filter, Anzeige), `test/meldungen-speicher-datenbank.test.ts` (Wechsel,
Trennung, Suche, Filter) und `test/meldungen-datenbank.test.ts` (die Seite je Rolle, mit echten Sitzungen).

## Antwort freigeben (COPI-90)

Module mit `eingriffe: [antwort_freigeben]` und `freigabe:` (`docs/modul-vertrag.md`) zeigen auf der Detailseite oben den
**Antwortentwurf** des Agenten (jüngste Fassung aus der View). „Freigeben" führt ohne Skript auf eine Rückfrage
(`?bestaetigen=freigabe`), „Ja, freigeben" speichert die Freigabe dieser Fassung mit SHA-256 ihres Texts
(`cockpit.freigabe`, Migration 0038; Herkunft und signierte Bestätigung wie bei der Übernahme). Bis zum Versand lässt sie
sich zurückziehen; danach zeigt die Karte den Nachweis. Ändert der Agent den Entwurf, verfällt die Freigabe. Der Agent
fragt vor dem Senden `GET /intern/vorgaenge/freigabe` (Recht `vorgang_lesen`): nur die jüngste, ungesendete Fassung mit
genau diesem Text, nie in einem übernommenen Vorgang. Offene Freigaben stehen als Aufgabe oben im Posteingang.

## Demo-Modul Auswahl: Links, Statuswörter und Entscheiden (COPI-91)

Das neutrale Demo-Modul „Auswahl" (`docs/demo/auswahl.cockpit.yaml`, Fachschema `auswahl`) zeigt Vorschläge eines
Assistenten: ein Workflow meldet sie an einen Webhook, der in `auswahl.treffer` schreibt. Nur für den Betreuer. Dafür neu im Vertrag (`docs/modul-vertrag.md`):

- **`format: link`** mit Pflicht-Liste `domains`: Die Detailseite verlinkt eine URL nur bei `https` und erlaubtem Host,
  Text ist der Host, `noopener noreferrer`. Sonst bleibt sie Text. Die einzige Ausnahme von „nie verlinken".
- **`statuswoerter`**: eigene Wörter je Statusfarbe („Offen" statt „Achtung").
- **Spalte `marke`** (optional in der Modul-View): eine kurze Marke neben der Zeit in der Liste, etwa „Grenzfall".

**Entscheiden** (`eingriffe: [entscheiden]`, Abschnitt `entscheidung:`): eine Karte oben auf der Detailseite mit
Optionen je Stand (`wenn`), dem Entwurf des Agenten zum Kopieren und „Zurücknehmen". Gespeichert in
`cockpit.entscheidung` (Migration 0045, nie löschen, Protokoll), abgefragt vom Agenten über
`GET /intern/vorgaenge/entscheidungen` (Recht `vorgang_lesen`). In der Liste die Marke „Vorgemerkt · Name".

Getestet in `test/modul-ansicht.test.ts`, `test/modul-block.test.ts`, `test/modul-entscheidung-datenbank.test.ts` und `test/betreuer-zugriff-datenbank.test.ts`.

## Anhänge (COPI-110)

Module mit `anhaenge:` (`docs/modul-vertrag.md`, „Anhänge") zeigen auf der Detailseite unter dem Mailtext die **Anhänge**
der Zeile. Das Cockpit stuft jeden nach Endung **und** ersten Bytes ein (`src/module/anhang-pruefung.ts`):

| Klasse | Wann | Was geht |
| --- | --- | --- |
| normal | alles andere | Warnseite, eine Bestätigung, Download |
| Warnung | Archive, Office mit Makros (auch das alte Format), HTML, SVG, **Widerspruch** zwischen Endung und Inhalt | Warnseite mit Pflicht-Haken, „Abbrechen" ist der primäre Knopf |
| gesperrt | ausführbar nach Endung (`.exe`, `.js`, `.lnk`, …) oder Inhalt (MZ/PE, ELF, Mach-O) | nichts — nie auslieferbar, auch nicht per Formular |
| liegt im Postfach | kein Inhalt im Cockpit (über 10 MB, oder nach der Frist entfernt, COPI-102) | nichts |

Der Download geht nur über die Warnseite (`GET /module/:kennung/:id/anhang/:anhang`) und deren Formular (`POST` auf
dieselbe Adresse): Herkunft, signierte Bestätigung (an Konto, Modul, Vorgang, Anhang und SHA-256 gebunden, 10 Minuten),
die Zeile muss in der Modul-View stehen. Höchstens 10 MB, höchstens zwei Downloads gleichzeitig, 10 s Zeitgrenze. Die
Antwort ist immer `attachment` (`application/octet-stream`, bereinigter Name nach RFC 5987, `nosniff`, `no-store`, CSP
`sandbox; default-src 'none'`, `Cross-Origin-Resource-Policy: same-origin`). Jeder Download steht in
`cockpit.anhang_download` (Migration 0044, unveränderlich) und im Protokoll (`anhang_heruntergeladen`).

Getestet in `test/anhang-pruefung.test.ts` (Einstufung, Bereinigung, Header) und `test/modul-anhaenge-datenbank.test.ts`
(Liste, Warnseiten, Download, jede Abweisung, Größe, Parallelität, Nachweis).

## Agenten-Detailseite (COPI-113)

Jede Karte unter `/agenten` öffnet `/agenten/<schlüssel>` — der Schlüssel sind die ersten 16 Hex-Zeichen von SHA-256 der
Kennung: die Kundensicht zeigt die Kennung nirgends, auch nicht in einem Link (COPI-38). Ein entfernter Agent bleibt
erreichbar. Reiter als Links (`?bereich=`), ohne Skript:

| Bereich | Was | Wer |
| --- | --- | --- |
| Steckbrief | Kennzahlen (offene Mails, Nachrichten 7 Tage, Kosten des Monats, letzte Meldung), Grenzen, Zeitplan, Module, Zuletzt | jeder; Kennung, Version und Kosten nur mit `technik_sehen` |
| Chats | Gespräche: mit anderen Agenten (Kanal-Art `agent`, nur lesen), dazu Team-Kanal und **eigener** Assistenten-Kanal, wenn der Agent dort schrieb | Agentenkanäle nur mit `technik_sehen`; fremde Assistenten-Kanäle nie |
| Mails | Zeilen der Module mit `agent: <kennung>` und `posteingang:` | nur Module, die das Konto sieht |
| Protokoll | letzte 30 Tage: Mails, Übernahmen, Nachrichten zwischen Agenten, Befunde seiner Wachen und **gemeldete Ereignisse** (COPI-114, `POST /intern/agenten/ereignis`; `?art=` filtert, bei Ereignissen `?stufe=`) | Sicht der Seite Meldungen, Ereignisse für Kunden nur kundensichtbar im Klartext; **keine Container-Logs** (ADR) |
| Verbrauch | Kosten des Monats, je Tag (30 Tage), je Modell, aus Einsätzen mit `agent` | nur `technik_sehen` |

Die Zuordnung kommt aus Meldungen (Migration 0037): `agent` am Befund (gehört zur Wache), am KI-Verbrauch und an der
Antwort des Koordinators, `agent:` im Modul-Block, und `POST /intern/chat/agenten` für Nachrichten zwischen Agenten
(`docs/agenten-api.md`). Was ein Agent getan hat, meldet er selbst als Ereignis (COPI-114, Migration 0039, höchstens 50 je
Agent und Stunde); der Steckbrief zählt die gemeldeten Fehler der letzten sieben Tage.

## Chat (Epic E4, COPI-52 bis COPI-61)

Der Vertrag für den Koordinator-Agenten steht in [`docs/koordinator-api.md`](koordinator-api.md) (COPI-61).

Der Chat (ADR 6) hat zwei Kanäle: je Benutzer den eigenen **Assistenten**-Kanal mit dem Koordinator-Agenten und einen
gemeinsamen **Team**-Kanal der Instanz. Threads je Vorgang kommen mit E5 (Entscheidung Stefan, 23.09.2026: E4 vor E5).

- **Seiten** wie „Chat" und „Chat – Desktop" im Prototyp: `GET /chat` (Assistent) und `GET /chat/team`; am Desktop die
  Liste „Verlauf" mit Vorschau und Ungelesenem, mobil eine Umschaltung Assistent/Team im Kopf. `?vor=<id>` blättert zu
  älteren Nachrichten (50 je Seite). Die Navigation zeigt am Chat die Zahl ungelesener Nachrichten.
- **Nachrichten und Posteingang (COPI-112):** In der Navigation heißt der Chat „Nachrichten". In „Verlauf" stehen unter
  den Kanälen die **Postfächer** — Module mit `posteingang:` (`docs/modul-vertrag.md`), etwa die Nachrichten des Demo-Moduls
  Eingang — unter `/chat/postfach/<kennung>`. Rechts oben auf jeder angemeldeten Seite zeigt ein **Badge** alles
  Ungelesene (Chat, Postfächer, Meldungen auf Gelb/Rot seit dem letzten Besuch der Seite Meldungen) und klappt eine Liste
  mit Titel, Anriss und Link auf; „Alle als gelesen" (`POST /posteingang/gelesen`, Herkunft Pflicht) setzt alles auf
  gelesen. `GET /posteingang` liefert nur das Badge; `pwa.js` holt es jede Minute, solange es zugeklappt ist. Der
  Lesestand steht in `posteingang_stand` und `modul_gelesen` (Migration 0036), nie in einer Fachtabelle.
- **Schreiben** per Formular, ohne Skript: `POST /chat`, `POST /chat/team`; gespeichert, dann `303` zurück. Herkunft
  Pflicht (`herkunftBelegt`, sonst `403`), leer oder über 4000 Zeichen ergibt `400` mit Hinweis, die Eingabe bleibt im
  Feld. **Enter schickt ab**, Strg+Enter (oder Umschalt+Enter) macht eine neue Zeile — nicht während einer IME-Eingabe,
  nicht bei leerem Feld; auf Touch-Geräten bleibt Enter eine neue Zeile (COPI-64). Ohne Skript sendet der Knopf.
- **Koordinator (COPI-54):** Eine Nachricht im Assistenten-Kanal geht nach dem Speichern signiert an den n8n-Webhook
  (HMAC-SHA256 über `<zeitpunkt>.<rumpf>`, Kopfzeilen `x-cockpit-zeitpunkt` und `x-cockpit-signatur`); das Cockpit
  wartet höchstens 5 Sekunden auf die Quittung, nie auf den Agentenlauf. Scheitert sie, steht eine Meldung des Cockpits
  im Verlauf. Solange die letzte Frage unbeantwortet ist, steht „arbeitet an einer Antwort …" darunter, nach der Frist
  „antwortet gerade nicht" — berechnet beim Anzeigen, ohne Scheduler. Der Team-Kanal geht nicht an den Koordinator.
  Ohne konfigurierten Webhook nimmt der Assistenten-Kanal nichts an (`409`).
- **Antwortweg (COPI-55):** Der Koordinator antwortet über die Agenten-API, `POST /intern/chat/antwort` (Recht
  `chat_antworten`), je Frage genau einmal; den Zustand liest er über `GET /intern/zustand` (Recht `zustand_lesen`) —
  genau die Kundensicht der Übersicht, nie ein Rohbefund. Jede gespeicherte Nachricht geht an den Verteiler im Prozess
  (`src/chat/ereignisse.ts`), an dem SSE (COPI-56) und Push (COPI-59) hängen.
- **Ohne Neuladen (COPI-56):** `GET /chat/ereignisse` und `GET /chat/team/ereignisse` sind Server-Sent Events des
  Kanals; jede neue Nachricht kommt als fertig escaptes HTML-Fragment (dasselbe Partial wie die Seite) mit ihrer ID.
  Beim Wiederverbinden liefert `Last-Event-ID` (beim ersten Öffnen `?seit=`) das Verpasste nach, in Reihenfolge und ohne
  Doppelte; mehr als eine Seite verpasst heißt „neu laden". Heartbeat alle 25 s, höchstens fünf Streams je Konto
  (`429`). `/chat/skript.js` hängt die Nachrichten an; ohne Skript bleibt die Seite, wie sie ist. Caddy reicht
  `text/event-stream` von selbst sofort durch (geprüft mit `caddy reverse-proxy`, Ereignis nach 0,06 s).
- **Tageslimit (COPI-57, ADR 1):** Nachrichten an den Assistenten zählen je Konto und Berliner Kalendertag
  (`COCKPIT_CHAT_TAGESLIMIT`, Standard 50), atomar in `cockpit.chat_verbrauch` — auch parallele Anfragen kommen nicht
  darüber. Am Limit wird nichts gespeichert und nichts weitergeleitet (`429`, die Eingabe bleibt im Feld), die Seite
  nennt den Zeitpunkt, ab dem es wieder geht (Mitternacht, sommerzeitfest); ab 80 % zeigt sie den Rest. Der Team-Kanal
  zählt nicht. Die Budget-Wache liest den Verbrauch über `GET /intern/chat/verbrauch` — Summen je Tag, keine Kennungen.
- **E-Mail-Zweitkanal (COPI-60, ADR 6):** Eine dringende Nachricht im Assistenten-Kanal, die sein Besitzer nach der
  Frist (`COCKPIT_CHAT_MAIL_NACH_MINUTEN`, Standard 15) nicht gelesen hat, meldet das Cockpit per E-Mail — Pflicht,
  nicht Fallback, auch neben Push. Die Mail nennt nur Anzahl und Link auf `/chat`, **nie den Inhalt**; höchstens eine
  je Konto und Stunde, sie fasst alles Fällige zusammen. Vermerk (`cockpit.chat_mail`), Protokoll
  (`chat_mail_gesendet`, nur die Anzahl) und Versand laufen in einer Transaktion: scheitert SMTP, versucht es der
  nächste Lauf (jede Minute) wieder, und auch nach einem Neustart geht keine Nachricht doppelt. Ohne SMTP gibt es den
  Zweitkanal nicht; der Start weist darauf hin. Die Auswahl ist eine reine Funktion (`faelligeMails` in
  `src/chat/zweitkanal.ts`).
- **Wer:** Recht `chat_nutzen` (jede Rolle; der Betreuer sieht damit auch den Team-Kanal). Ohne das Recht die neutrale
  404. Den Assistenten-Kanal sieht nur sein Besitzer.
- **Inhalte bleiben Text:** escaped, nie verlinkt, kein Markdown (ADR 10, Regel wie JAC-577). Antworten des Koordinators
  tragen „KI", der Assistenten-Kanal die Marke „KI-gestützt" (Art. 50 KI-VO). Als gelöscht markierte Nachrichten
  erscheinen als „Nachricht gelöscht", ohne Inhalt.
- **Lesestand:** wer die jüngste Seite eines Kanals ansieht, hat ihn gelesen; Blättern ändert daran nichts.
- **Häkchen und Trenner „Neu" (COPI-69), nur im Assistenten-Kanal:** Eigene Nachrichten tragen in der Meta-Zeile einen
  Haken (**gesendet**: gespeichert, keine Quittung), zwei Haken (**angenommen**: der Webhook des Koordinators hat
  quittiert; die Route setzt `cockpit.nachricht.zugestellt_am`, Migration 0031, einmalig und danach unveränderlich) oder
  zwei Haken in Akzentfarbe (**beantwortet**: im Verlauf steht nach der Nachricht eine Antwort des Koordinators; abgeleitet,
  keine Spalte — Meldungen des Cockpits zählen nicht). Scheitert die Weiterleitung, bleibt es beim Haken, dazu der
  bestehende Hinweis im Verlauf. Das Symbol ist dekorativ, ein Text nur für Screenreader nennt den Stand. Trifft per SSE
  eine Antwort ein, springen die eigenen Nachrichten davor ohne Neuladen auf „beantwortet"; „angenommen" steht schon beim
  Neuladen nach dem Absenden, weil die Quittung vor der Weiterleitung (303) gespeichert wird. Vor der ersten ungelesenen
  fremden Nachricht steht der Trenner „Neu" (`role="separator"`): dafür liest die Seite den alten Lesestand, bevor sie ihn
  neu setzt; beim Blättern nur, wenn diese Nachricht auf der Seite liegt. Der Team-Kanal bleibt ohne beides.

## Installierbare App (COPI-58)

Das Cockpit ist eine installierbare Web-App (ADR 6): Web Push geht auf iPhone und iPad erst ab iOS 16.4 und **nur**
nach „Zum Home-Bildschirm".

- **Manifest** `GET /manifest.webmanifest`: Name der Instanz, `display: standalone`, Start und Geltungsbereich `/`,
  Symbole in 192 und 512 px (auch `maskable`), dazu `apple-touch-icon` (180 px) und ein Favicon (32 px, auch unter
  `/favicon.ico`). Das Standard-Symbol — ein Rundinstrument in Weiß auf dem Akzent — zeichnet das Cockpit selbst
  (`src/pwa/icon.ts`), ohne Binärdatei im Repo.
- **Eigenes Symbol (COPI-101):** Betreuer und Betriebs-Admin (Recht `erscheinungsbild_aendern`) laden in den
  Einstellungen unter „Erscheinungsbild" ein Logo hoch (PNG, JPEG oder WebP, längere Seite mindestens 512 px, höchstens 5 MB; nie
  SVG) oder setzen auf den Standard zurück. Der Browser schneidet zu (mit Rand: das ganze Logo in der sicheren Zone für
  `maskable`; ohne: Ausschnitt aus der Mitte), legt es auf eine Hintergrundfarbe und schickt ein PNG mit 512 × 512 px
  (`POST /einstellungen/app-symbol`, JSON, Herkunft Pflicht). Das Cockpit liest es streng (`src/pwa/png.ts`: nur 8 Bit
  RGB/RGBA, genau diese Größe, gedeckelt entpackt), rechnet die kleineren Größen selbst und speichert nur, was es neu
  kodiert hat (`cockpit.app_symbol`, Migration 0035; nie gelöscht, Zurücksetzen markiert). Protokoll
  `erscheinungsbild_geaendert`. Seiten und Manifest verweisen auf `/icons/<name>.<hash>.png` (ein Jahr
  zwischenspeicherbar); die Adressen ohne Hash liefern immer das aktuelle. Installierte Apps übernehmen ein neues
  Symbol erst nach dem Neu-Hinzufügen (iOS) bzw. irgendwann (Android) — Plattformverhalten.
- **Service Worker** `GET /sw.js`, Geltungsbereich `/`. **Er speichert nichts**, auch keine statischen Dateien: nach dem
  Abmelden liegt nichts vom Cockpit im Gerät. Push nimmt er mit COPI-59 an.
- **Vor dem Tor:** Manifest, Service Worker, Favicon und Symbole (`APP_DATEIEN` und `SYMBOL_PFAD`), weil der Browser
  das Manifest ohne Cookie holt — genau diese Pfade, exakt, kein Unterpfad. Sie tragen keine Daten außer dem Namen der
  Instanz. `GET /pwa.js` (Anmeldung des Service Workers) bleibt dahinter und lädt nur auf angemeldeten Seiten.
- **Benachrichtigungen** in den Einstellungen: ob sie auf diesem Gerät gehen — möglich, erlaubt, abgelehnt, nicht
  unterstützt, oder (iPhone/iPad im Safari-Tab) mit der Anleitung „Zum Home-Bildschirm". Die Erkennung ist eine reine
  Funktion (`pushZugang` in `assets/js/pwa.js`); ein iPad, das sich als Mac ausgibt, verrät sich über den Touchscreen.
- **Web Push (COPI-59):** das VAPID-Paar erzeugt `vapid-erzeugen` einmal; es steht in der Umgebung der Instanz, nie in
  der Datenbank. In den Einstellungen schaltet jedes Gerät Push an und aus (`POST /push/abo`, `/push/abmelden`, JSON,
  Herkunft Pflicht); die Liste der eigenen Geräte (Name aus dem Push-Dienst abgeleitet) entfernt eines auch ohne
  Skript. Push geht bei jeder Antwort des Koordinators und bei allem Dringenden an die Geräte des Kanalbesitzers — nur
  „Neue Antwort des Assistenten" bzw. „Dringende Nachricht im Chat", **nie der Text**; der Klick öffnet immer `/chat`.
  Abos, die der Dienst nicht mehr kennt (404/410), werden abgemeldet, nicht gelöscht; ins Log kommt nur der Dienst, nie
  der Endpoint. Verschlüsselung und Signatur übernimmt `web-push`.
- **Push bei neuen Einträgen im Posteingang (COPI-116):** ein Takt im Prozess (eine Minute, nur mit VAPID, kein eigener
  Dienst) liest je Konto mit aktivem Abo den Posteingang wie der Badge — dieselben Abfragen, dieselben Rechte — und
  vergleicht mit dem zuletzt gemeldeten Stand (`cockpit.posteingang_push`, Migration `0041`: Gesamtzahl und gekürzte
  Kennzeichen der gesehenen Einträge, kein Inhalt). Neu ist, was noch nicht gesehen wurde, oder ein Zuwachs der Zahl.
  Höchstens ein Push je Konto und Minute, zusammengefasst; der erste Lauf und ein Neustart melden nichts; nach einem
  Sofort-Push (Antwort, dringend) wird der Stand festgehalten. Der Push nennt nie Absender oder Betreff, nur etwa
  „Freigabe nötig: eine Antwort wartet auf dich." oder „2 neue Einträge im Posteingang.", und trägt die Zahl für das
  App-Symbol. Ziele stehen fest im Service Worker (`chat` → `/chat`, `posteingang` → `/#posteingang`, der den Posteingang
  aufklappt). Keine Ruhezeiten, Quellen nicht einzeln abschaltbar (Entscheidung Stefan, 02.10.2026).
  `POST /push/test` (Formular in den Einstellungen) schickt einen Test-Push an alle eigenen Geräte, höchstens einen je
  Konto und 30 Sekunden.

## Betreuer-Zugriff auf Fachmodule (COPI-134)

Module und agent-blueprints gelten für jede Kundeninstanz. Dort ist der Kunde **Betriebs-Admin** und Verantwortlicher
für seine Daten, Stefan der **Betreuer**. Entscheidung Stefan, 09.10.2026: **Ob der Betreuer die Fachdaten eines
Moduls sieht, legt der Betriebs-Admin fest** — je Modul, Standard „kein Zugriff", jede Änderung protokolliert.

| Stufe | Der Betreuer … |
| --- | --- |
| `aus` (Standard) | sieht das Modul nirgends: Navigation, Liste, Detail, Übersicht, Posteingang, Anhänge — dieselbe neutrale 404 wie ohne Rolle |
| `lesen` | sieht Inhalte, Sperren und Entscheidungen, aber ohne Aktionen; eine Aktion endet mit 403 und einem Hinweis; offene Freigaben erscheinen nicht als seine Aufgaben |
| `entscheiden` | darf zusätzlich übernehmen, freigeben und entscheiden wie ein Betriebs-Admin |

- **Technische Module** (`art: betrieb` im Block: Server-Zustand, KI-Verbrauch) sieht der Betreuer immer; ohne sie kann
  er nicht betreuen. Für sie gibt es keine Stufe. Ein **Fachmodul** (Standard, `art: fach`) muss in `rollen` mindestens
  eine Kundenrolle nennen, sonst lehnt das Einspielen es ab — `betreuer` in `rollen` gilt für Fachmodule nicht mehr.
- **Wer setzt:** der Betriebs-Admin unter Einstellungen → „Betreuer-Zugriff" (`POST /einstellungen/betreuer-zugriff`,
  Recht `betreuer_zugriff_freigeben`, Herkunft Pflicht). Der Betreuer sieht dort nur den Stand: das Recht ist das
  einzige, das er nicht per Konstruktion hat (`NIE_FUER_BETREUER` in `src/auth/berechtigung.ts`). Für eine Instanz
  ohne Betriebs-Admin des Kunden (Stefans eigene) setzt das Server-Kommando `modul-freigabe` die Stufe; es steht als
  `konsole` im Protokoll und ist für einen späteren Betriebs-Admin sichtbar.
- **Nachweis:** `cockpit.modul_betreuer_zugriff` (Migration 0048), nur anhängen — die jüngste Zeile je Modul gilt —,
  dazu der Protokolleintrag `betreuer_zugriff_geaendert` in derselben Transaktion. Beim Update auf diese Version bekommt
  jedes schon aktive Modul einmal `entscheiden` (Weg `migration`): bis dahin sah der Betreuer alles, so bleibt Stefans
  eigene Instanz unverändert. Eine neue Instanz startet ohne Zeilen, also mit `aus`.

Getestet in `test/modul-sichtbarkeit.test.ts` (alle Rollen und Stufen), `test/betreuer-zugriff-datenbank.test.ts`
(Speicher, Seiten, Aktionen, Einstellungen), `test/cli-modul-datenbank.test.ts` und `test/berechtigung.test.ts`.

## Nie löschen, nur markieren (COPI-62)

Entscheidung Stefan, 23.09.2026, wegen möglicher Dokumentationspflichten: **Daten werden nie aus dem Bestand gelöscht,
sondern als gelöscht markiert** — auch wenn ein Konto entfernt wird.

- **Die Datenbank sichert es:** `cockpit.nie_loeschen()` weist jedes `DELETE` an den Nachweistabellen ab (Chat, Konten,
  Einladungen, Adressänderungen, Wiederherstellung, Erststart- und API-Token, Wachen, Befunde, Agenten, Instanz,
  Eingriffe, Archiv der Zugangsmittel, Vermerke des E-Mail-Zweitkanals, Modul-Registry, Betreuer-Zugriff, die Queue der
  Entwicklungspipeline samt Audit und Verbrauch; Migrationen `0024`, `0025`, `0027`, `0028`, `0048`, `0051`). Eine Nachricht ist nach dem Schreiben unveränderlich, eine Löschmarke endgültig.
- **Konten** (`geloescht_am`, `geloescht_von`, `geloescht_email`): beim Entfernen, beim 72-h-Verfall und beim
  zurückgenommenen Erststart wird der Zugang entwertet und die Adresse durch `geloescht-<id>@geloescht.invalid` ersetzt.
  Keine Anmeldung, Einladung oder Adressprüfung findet das Konto mehr; die Adresse lässt sich neu einladen. Dazu gibt
  ein Sitzungs-Hook einem markierten Konto keine Sitzung, und es hat keine Rolle mehr. Der aktivierte Betreuer lässt
  sich nicht markieren, nur übergeben.
- **Zugangsmittel** (TOTP, Passkeys, Ersatzcodes): Die Tabellen, aus denen die Anmeldung liest, enthalten nur
  benutzbare. Wird eines entfernt, hält `cockpit.zugangsmittel_archiv` fest, welche Art, wessen, seit wann und bis
  wann — **ohne Geheimnis**.
- **Agenten**, die nicht mehr im Inventar stehen, bekommen `entfernt_am`; meldet sich einer wieder, gilt er wieder.
- **Ausgenommen** (Stefan, 23.09.2026) sind technische Kurzzeitdaten ohne Dokumentationswert: Sitzungen, Better Auths
  `verification`, `anmeldevorgang`, `passkey_vorgang`, `anmeldeversuch`. Was dort geschieht, steht im Protokoll.
- **Ausgenommen** (Stefan, 30.09.2026) sind außerdem die Tageswerte des KI-Verbrauchs (`cockpit.verbrauch_tag`,
  COPI-98): abgeleitete Summen, die bei jeder Meldung je Tag verworfen und neu geschrieben werden. Der Nachweis ist
  das Protokoll `cockpit.verbrauch`, und dort wird nie gelöscht.
- **Tests** räumen trotzdem ab: die Sperre lässt `DELETE` nur zu, wenn `cockpit.testdaten_loeschen = 'ja'` gesetzt ist
  **und** der Name der Datenbank auf `_test` endet (`test/global-setup.ts` setzt es für die Testdatenbank). Nachweise,
  dass die Sperre greift, laufen über `wieImBetrieb` (`test/hilfen.ts`).
- **`./dev demo`** (COPI-80) räumt beim erneuten Einspielen seine eigenen Zeilen ab (Präfix `demo-` in
  `cockpit.wache`/`cockpit.befund`), aber die Dev-Datenbank heißt nicht `..._test` — der Weg über
  `cockpit.testdaten_loeschen` greift dort nicht. Das Skript setzt statt dessen innerhalb einer Transaktion
  `session_replication_role = replica`, was **jeden** Trigger abschaltet und nur einer Superuser-Verbindung gelingt
  (`postgres` im lokalen Dev-Stack; eine Kundeninstanz verbindet sich nie so). Siehe „Lokal entwickeln und testen".
- **Offen (E7):** markierte Konten behalten Name und Adresse. Löschpflicht (DSGVO Art. 17) gegen Aufbewahrungspflicht
  regelt die Aufbewahrungsfrist — dort ggf. Anonymisieren nach Fristablauf statt Löschen.

## Benutzer (Epic E2, COPI-45)

Die Seite **Benutzer** (`/benutzer`, unter „Mehr" an erster Stelle) zeigt jedes Konto — echte Menschen, keine Agenten
(ADR Abschnitt 5) — und die offenen Einladungen. Bearbeiten (Name, E-Mail-Adresse, Rolle, entfernen, zweiten Faktor
zurücksetzen) steht unten unter „Konten bearbeiten" (COPI-46, COPI-47).

| Wer | Was |
| --- | --- |
| Betreuer, Betriebs-Admin (Recht `benutzer_sehen`) | alle Konten, **auch den Betreuer-Zugang** (der Betrieb soll sehen, wer Zugriff auf sein System hat), und alle offenen Einladungen, gleich wer eingeladen hat; mit dem Recht `einladen` dazu der Knopf „Jemanden einladen" |
| Mitarbeiter, unbekannte Rolle | die neutrale 404 wie bei „Einladen", kein Eintrag unter „Mehr" |
| ohne Sitzung / ohne zweiten Faktor | das Tor wie bei jeder geschützten Seite: zur Anmeldung bzw. zur Einrichtung |

Je Konto eine Karte (Muster der Seite Agenten; der Prototyp hat keinen Benutzer-Bildschirm), geordnet nach Rolle
(Betreuer, Betriebs-Admin, Mitarbeiter), darin nach Name; das eigene Konto trägt „Sie":

| Angabe | Quelle |
| --- | --- |
| Name, E-Mail, Rolle | das Konto; die Rolle in Betriebssprache |
| Stand | aus dem zweiten Faktor (`cockpit.zweiter_faktor_aktiv`): **aktiv**; **Einrichtung offen** mit „verfällt in …" (72 Stunden nach der Anlage, COPI-17); **wird wiederhergestellt**, wenn ein aktives Konto entsperrt wurde (COPI-28) — es verfällt nicht |
| Zweiter Faktor | „Passkey" (oder „2 Passkeys"), „Authenticator-App", beides mit „und", sonst „keiner" — die Passkeys aus ihrer Tabelle, TOTP aus der Funktion `cockpit.totp_aktiv` (Migration `0021`): die Spalte des Better-Auth-Plugins liest der Code nie selbst (COPI-25) |
| Angelegt, zuletzt angemeldet | „vor …"; die Anmeldung aus dem Protokoll (`anmeldung_erfolgreich`, gelesen über `letzteAnmeldungen` in `protokoll.ts`), ohne je eine „noch nie" |
| Offene Einladung | Adresse, Rolle, wer eingeladen hat, „läuft ab in …"; eingelöste und abgelaufene stehen nicht da |

- **Gelesen wird nur, was die Seite zeigt** (`src/auth/benutzer-liste-speicher.ts`): kein Passwort-Hash, kein
  TOTP-Geheimnis, kein Ersatzcode, kein Token, keine Sitzung, keine IP. Alles wird maskiert, nichts verlinkt; die Seite
  ist `no-store`.
- Die Rolle kommt aus der Datenbank, nicht aus der Sitzung: eine Herabstufung nimmt die Seite sofort.

Getestet in `test/benutzer-liste.test.ts` (Stand, Faktor, Reihenfolge, „Sie", Zeiten), `test/benutzer-datenbank.test.ts`
(je Rolle mit echten Sitzungen: Betreuer und Admin sehen alles, der Mitarbeiter bekommt 404 und keinen Eintrag; nur
offene Einladungen; kein Geheimnis auf der Seite; Maskierung; Herabstufung wirkt sofort), `test/berechtigung.test.ts`
und `test/navigation.test.ts`.

### Konten bearbeiten (COPI-46)

Auf der Seite Benutzer trägt jedes Konto, an dem der Ansehende etwas darf, den Knopf **Bearbeiten** (`/benutzer/:id`).
Stefans Entscheidungen vom 22.09.2026:

| Aktion | Betreuer | Betriebs-Admin |
| --- | --- | --- |
| Name ändern (nur die Anzeige; angemeldet wird mit der E-Mail) | Admins und Mitarbeiter | Mitarbeiter |
| E-Mail-Adresse ändern (COPI-47, siehe unten) | Admins und Mitarbeiter | Mitarbeiter |
| Rolle ändern (Recht `rollen_aendern`) | Admin ↔ Mitarbeiter | – |
| Konto entfernen | Admins und Mitarbeiter | Mitarbeiter |
| Zweiten Faktor zurücksetzen | Admins und Mitarbeiter | Mitarbeiter |

- **Grundregel** (`src/auth/benutzer-bearbeiten.ts`, Recht `benutzer_bearbeiten`): man bearbeitet nur Konten mit
  **niedrigerer** Rolle als der eigenen. Den Betreuer bearbeitet in der Oberfläche niemand (seine Übergabe bleibt beim
  Server-Kommando, ADR 13.1), das eigene Konto auch nicht, und Betreuer wird niemand. Passwörter setzt niemand für andere
  (ADR 7). Die Datenbank schützt den Betreuer zusätzlich (0008).
- **Zwei Schritte:** `POST /benutzer/:id/aendern` zeigt nur die Bestätigungsseite; erst `POST /benutzer/:id/bestaetigen`
  ändert. Beide verlangen **Herkunft** (`Origin`/`Referer` ist die eigene Adresse) und **frische Anmeldung** (Sitzung
  höchstens 15 Minuten alt; sonst zeigt die Seite keine Formulare, nur „Abmelden und neu anmelden"). Die Ausführung
  verlangt die **signierte Bestätigung** (Handelnder, Ziel, Aktion, Wert, zehn Minuten; `src/auth/bestaetigung.ts`, dieselbe
  wie beim Update-Antrag).
- **Dreimal geprüft:** auf der Seite (welche Formulare), vor der Bestätigung und bei der Ausführung — dort an der
  gesperrten Zeile, in derselben Transaktion wie Änderung und Protokolleintrag (`benutzer-bearbeiten-speicher.ts`). Wird
  das Konto dazwischen befördert oder der Handelnde herabgestuft, ändert sich nichts.
- **Nichts verraten:** ohne Recht, zu einem unbekannten Konto oder einem, an dem der Zugang nichts darf, antwortet jede
  der drei Routen mit derselben neutralen 404.
- **Zurücksetzen** ist das Entsperren aus COPI-28 (ADR 7, seit COPI-46 auch in der Oberfläche; Nachtrag in der ADR):
  alle Faktoren, das Passwort und die Sitzungen entwertet, und der Link zur Wiederherstellung (3 Stunden) erscheint
  **genau einmal** auf der Ergebnisseite (`no-store`), zur persönlichen Übergabe.
- **Entfernen** löscht nie physisch, es markiert (COPI-62, siehe „Nie löschen, nur markieren"): der Zugang wird
  entwertet (Faktoren ins Archiv, Sitzungen beendet, Passwort ohne Urbild), die Adresse durch einen Platzhalter ersetzt
  und damit wieder frei. Das Konto bleibt im Bestand, das Protokoll auch; Einladungen des Kontos bleiben gültig.
- **Protokoll:** `name_geaendert`, `rolle_geaendert` (`von`, `an`), `konto_entfernt` (`rolle`), `konto_entsperrt` mit
  `weg: oberflaeche` — Akteur das handelnde Konto, Ziel das bearbeitete (Migration `0022`).
- **E-Mail-Adresse ändern** (COPI-47, Migration `0023`): angemeldet wird mit der E-Mail, deshalb **beantragt** die Aktion
  nur. Der erste Schritt prüft die Form und ob die Adresse frei ist (nicht die bisherige, kein anderes Konto, keine offene
  Einladung, kein offener Antrag eines anderen Kontos). Die Ausführung legt den Antrag an (Tabelle `email_aenderung`, nur
  der Hash des Tokens, 24 Stunden, je Konto und je Adresse höchstens einer offen), schickt an die **neue** Adresse den
  Link `/email-bestaetigen/<token>` und an die **bisherige** einen Hinweis ohne Adresse und ohne Link. Geht die erste Mail
  nicht raus, wird der Antrag verworfen; geht nur der Hinweis nicht raus, gilt der Antrag, und die Seite sagt es. Ohne
  Mailversand (SMTP) oder feste Basis-URL gibt es die Aktion nicht. Die Seite des Kontos zeigt eine offene Adresse.
- **Bestätigen** (`/email-bestaetigen/<token>`, ohne Anmeldung, in der Allowlist des Tors; ohne Token neutral): `GET`
  zeigt nur die neue Adresse und einen Knopf — Mailprogramme öffnen Links oft von selbst —, erst `POST` (mit Herkunft)
  löst ein, mit einer einzigen bedingten Anweisung, genau einmal. Dann gilt die neue Adresse, offene Einladungen an sie
  verfallen, und das Protokoll hält `email_geaendert` fest (Akteur `email_bestaetigung`). Hat die Adresse inzwischen ein
  anderes Konto, ändert sich nichts. Kaputte, unbekannte, abgelaufene, eingelöste Links: die neutrale 404. Im Protokoll
  steht nie eine Adresse.

Getestet in `test/benutzer-bearbeiten.test.ts` (die Regel: jede Kombination aus Rolle, Ziel und Aktion; frische
Anmeldung), `test/bestaetigung.test.ts`, `test/benutzer-bearbeiten-speicher-datenbank.test.ts` (Transaktion, Prüfung an
der gesperrten Zeile, Schutz des Betreuers) und `test/benutzer-bearbeiten-datenbank.test.ts` (der ganze Weg mit echten
Sitzungen: Matrix, Ausführung, Link zur Wiederherstellung; ohne frische Anmeldung, fremde oder fehlende Herkunft,
geänderter Wert, fremdes Ziel, fremde Aktion, fremder Handelnder, Beförderung und Herabstufung dazwischen ändern nichts).
E-Mail-Adresse: `test/email-aenderung-mail.test.ts` (Mailtexte), `test/email-aenderung-datenbank.test.ts` (Antrag, belegte
Adressen, einmaliges und gleichzeitiges Einlösen, Ablauf) und `test/email-aendern-datenbank.test.ts` (der ganze Weg mit
echten Sitzungen und abgefangenen Mails, ohne und mit defektem Mailversand).

## Agenten und Zeitplan (Epic E3, COPI-38)

Zwei Seiten, beide **nur lesend**: **Agenten** (`/agenten`) zeigt je Agent Rolle und Grenzen, **Zeitplan** (`/zeitplan`)
alle Takte, je Agent unter seiner Rolle. Sie zeigen, was der Admin-Agent per `PUT /intern/agenten` gemeldet hat
(siehe „Inventar melden"); oben steht der Stand („gemeldet vor 5 Minuten"), ohne Inventar ein Leerzustand. Den
Zeitplan ändern, Agenten pausieren oder fortsetzen sind Eingriffe über `cockpit.eingriff` und kommen später.

| Sicht | Wer | Was sie zeigt |
| --- | --- | --- |
| Kunde | jedes angemeldete Konto — auch eines mit unbekannter Rolle | Rolle, Grenzen, Zeitplan |
| Betreuer | Recht `technik_sehen` (nur der Betreuer) | zusätzlich **Kennung und Version** der Agenten |

- **Der Unterschied liegt in der Form der Daten** (`src/status/agenten.ts`): die Karte der Kundensicht hat kein Feld für
  Kennung und Version, sie kann sie also nicht zeigen. Der Zeitplan ist für alle Rollen derselbe Inhalt. `technik_sehen`
  ist ein eigenes Recht und nicht `rohbefunde_sehen` (Übersicht): es sind zwei verschiedene Dinge.
- **`rolle`, `grenzen` und `zeitplan` sind Klartext für den Kunden.** Das Inventar kennt keine Sichtbarkeit je Agent
  (anders als ein Befund mit `kundensichtbar`); der Vertrag mit dem Admin-Agenten ist deshalb, dort nichts
  Internes hineinzuschreiben. Wer die Seite vorerst nur dem Betreuer geben will, ändert die Sicht in
  `src/server/routes/agenten.ts`.
- **Grenzen in Betriebssprache:** Ja/Nein für einen Schalter, Zahlen mit deutscher Schreibweise (`5.000`, `0,5`), Text
  unverändert; sortiert nach Namen. Die Agenten sind nach Rolle sortiert, die Takte in der Reihenfolge der Meldung.
- **Alles wird maskiert, nichts verlinkt** (Text vom Agenten kann Fremdtext enthalten). Die Seiten sind `no-store`; die
  Sicht kommt bei jeder Anfrage aus der **frisch gelesenen** Rolle, ein entzogenes Recht wirkt sofort.
- **Das Cockpit rechnet nichts aus dem Zeitplan:** `wann` ist Freitext („täglich 07:00"), kein Cron, kein „nächster
  Lauf" (ADR 4).

Getestet in `test/status-agenten.test.ts` (die reinen Funktionen), `test/agenten-seiten-datenbank.test.ts` (die Seiten
je Rolle, mit echten Sitzungen), `test/layout.test.ts` und `test/kontrast.test.ts` (Vorlagen und Farbpaare).

## Module (Epic E5, COPI-78)

Drei Seiten, alle **nur lesend**, für die aktiven Module der Registry (`cockpit.modul`, COPI-77): **`GET /module`**
zeigt die für die Rolle sichtbaren Module als Liste ihrer Menünamen; **`GET /module/:kennung`** die Zeilen der
Modul-View (Pflichtspalten `titel` als Zeilentext, `status` als Punkt + Wort, `aktualisiert_am` formatiert); **`GET
/module/:kennung/:id`** eine einzelne Zeile mit allen deklarierten Spalten und ihrem Label. Die vollständige
Vertragsdoku des `cockpit:`-Blocks — Felder, Pflichtspalten, Regeln für die View, Einspielen und Rückweg — steht in
[`docs/modul-vertrag.md`](modul-vertrag.md) (COPI-79); hier steht nur, was die drei Seiten selbst tun.

### Demo-Modul „Eingang" (COPI-88)

Das erste Fachmodul im Pilot, hier als neutrales Demo: die Nachrichten an einen Assistenten, je eingegangener Nachricht
von einem Menschen eine Zeile mit der Triage des Assistenten. Dateien in `docs/demo/`:

- `fach/eingang/0001_vorgang.sql` — die **Fachtabelle** `eingang.vorgang` im eigenen Schema (nicht `cockpit`), als
  Fachmigration 0001 (COPI-107, siehe unten). Kein Text, nur Absender, Betreff, Eingang, Zuordnung, Zusammenfassung,
  Vorschlag, Anhangnamen und der Stand (`neu` → `entwurf` → `freigegeben` → `gesendet` / `erledigt`). `DELETE` weist ein
  eigener Trigger ab; dieselbe Message-ID kommt nur einmal an. Es schreibt der Workflow des Assistenten, nie das Cockpit.
- `v_modul_eingang.sql` — `neu`/`entwurf` gelb, alles danach grün; die Anhang-View `v_modul_eingang_anhaenge.sql`.
- `fach/eingang/0002_text.sql` bis `0005_frist.sql` — der **Nachrichtentext** (`text`, höchstens 10.000 Zeichen, und
  `text_gekuerzt`, COPI-103), der Antwortentwurf, die Anhänge und die Aufbewahrungsfristen.
- `eingang.cockpit.yaml` — Liste und Detail, Übernehmen und Antwort freigeben, nur Betreuer und Betriebs-Admin; der Text
  als `format: langtext` (eigener Abschnitt „Nachricht“ nur auf der Detailseite, Vertrag: „Langtext“).

`./dev demo` spielt die Fachmigrationen ein (`docs/demo/fach/<schema>/`, vor den Views) und vier Beispielnachrichten.
Absender, Betreff und Triage sind Fremdtext bzw. KI-Text über Fremdtext: die Seiten maskieren sie und verlinken nichts
(`test/freigabe-datenbank.test.ts`, `test/modul-anhaenge-datenbank.test.ts`).

### Fachmigrationen (COPI-107)

Fachtabellen ändert der Einrichter, nie das Cockpit und (vorerst) nie ein Agent (Empfehlung Alex zu COPI-106). Damit
das nachvollziehbar bleibt: je Fachschema ein Ordner `fach/<schema>/` mit Dateien `NNNN_<beschreibung>.sql`. Jede ist
eine Transaktion, bucht sich in `<schema>._migration` (Version, Herkunft aus `fach.herkunft`, Zeit, Rolle) und bricht ab,
wenn sie schon gebucht ist. Eingespielt wird in Nummernfolge, Gebuchtes übersprungen: lokal von
`scripts/dev/fach-migrationen.ts`, auf dem Server von `agent-blueprints/sql/fach-migrieren.sh`. Ein Block nennt mit
`fach: { schema, mindestens }` die Version, die er braucht; `modul-einspielen` lehnt ihn sonst ab
(`src/module/fach-migration.ts`). Die Regeln (nur hinzufügen, nie löschen) stehen im Vertrag,
[`docs/modul-vertrag.md`](modul-vertrag.md#fachmigrationen-fach-optional-copi-107). Tests:
`test/fach-migration-datenbank.test.ts`.

### Kennzahlen statt Zeilen (COPI-98)

Mit `ansicht: kennzahlen` zeigt `GET /module/:kennung` Summen über einen Zeitraum statt Zeilen mit Zustand —
freigegebener Entwurf „Kennzahlen-Seite KI-Verbrauch": Zeitraum-Chips ohne Skript (`?zeitraum=heute|7|30|monat|vormonat`,
ohne Angabe 30 Tage), die Kennzahlen mit Vergleich zum Zeitraum davor, ein Balkendiagramm des Hauptwerts je Tag
(Inline-SVG mit Textalternative, ohne `style`), Aufteilungen mit Anteil (eine davon als Filter, `?filter=<wert>`),
der Block „Wie belastbar sind die Zahlen?" und Warnzeilen aus einer Hinweis-View. Das Cockpit **rechnet** hier über
der Fach-View (`sum`, `GROUP BY`, `src/module/kennzahlen-lesen.ts`), deshalb prüft die Katalogprüfung den Typ jeder
deklarierten Spalte. Eine Detailseite und Eingriffe gibt es nicht (neutrale 404). Mit `uebersicht:` meldet das Modul
eine Karte an: Hauptwert des laufenden Monats, Vormonat, die letzten 30 Tage; sie trägt keinen Zustand und zählt nicht
in Zustandsband und Kennzahlen des Dashboards. Erstes Modul: „KI-Verbrauch" (`docs/beispiele/ki-verbrauch.cockpit.yaml`)
über den Tageswerten `cockpit.verbrauch_tag`, Kosten in Euro. `./dev demo` spielt es mit 35 Tagen Beispielverbrauch ein.
Preise mit Staffel nach Prompt-Länge (Haiku 5.5 über 100.000 Tokens, COPI-223) sind eigene Zeilen in `cockpit.preis` mit `prompt_ab`;
es gilt die höchste passende Staffel.

### Kacheln statt Liste (COPI-82)

Mit `darstellung: kacheln` im Block (Standard `liste`, nur bei `ansicht: liste-detail`) zeigt `GET
/module/:kennung` ein Kartenraster statt der Liste — freigegebener Entwurf „Module › Server & Dienste": Kopf mit
Pfad („Module / <Menüname>") und „Stand: …", Filter-Chips ohne Skript (`?status=gruen|gelb|rot`, mit der Anzahl
**aller** Zeilen je Zustand), je Kachel Kürzel/Titel/Status, die deklarierten Spalten außer `titel`/`status`/
`aktualisiert_am`, ein 7-Tage-Band (28 Sechs-Stunden-Eimer) mit Verfügbarkeit — nur mit `uebersicht.verlauf`
(COPI-81), sonst entfällt der Block ganz — und eine Fußzeile mit `aktualisiert_am`. Kartenrahmen (Hauch-Grund +
Rand-Token bei Rot/Gelb), Kürzel und Band sind dieselben Bausteine wie das Dashboard der Übersicht
(`src/module/zeitraster.ts`: die Eimer-Rechnung mit Eimergröße/-anzahl als Parameter, `partials/dienst-kuerzel`,
`partials/band`), nur eine andere Kartenform, kein zweiter Code für dieselbe Rechnung. Die Detailseite bleibt
unverändert. Vertragsdoku: `docs/modul-vertrag.md`, Abschnitt „Darstellung der Modulseite". Getestet in
`test/modul-kacheln-rechnung.test.ts` (reine Funktionen) und `test/modul-kacheln-datenbank.test.ts` (die Seite
gegen eine echte Datenbank).

Mit Messwert (COPI-83) zeigt die Kachel den aktuellen Wert rechts im Kopf, über dem (dann schmaleren) 7-Tage-Band eine
7-Tage-Kurve mit Tageskürzeln, „min. … · max. …" und — nur bei `wert_warnung` — einer gestrichelten Warnlinie.
Derselbe Code wie die Dashboard-Karte (`src/module/messwert-kurve.ts`), nur Zeitfenster und Maße sind Parameter.
Die optionalen Spalten prüft der Katalog genau (`wert text` wird abgelehnt, Fehlen ist erlaubt), vor jedem Lesen
erneut. Getestet in `test/messwert-kurve.test.ts` und `test/modul-messwert-datenbank.test.ts`.

- **Eine Regel für alles, was nicht verraten werden soll** (`src/module/sichtbarkeit.ts`, `modulZugriffErlaubt`):
  Sitzung und zweiter Faktor wie bei jeder anderen Seite, dazu die Rolle des Kontos in `block.rollen`. Der Betreuer
  sieht ein technisches Modul (`art: betrieb`) immer, ein Fachmodul nur mit dem Zugriff, den der Kunde freigibt
  (COPI-134, siehe „Betreuer-Zugriff auf Fachmodule"). Eine unbekannte oder ungültige Kennung, ein inaktives Modul, eine Rolle ohne
  Zugriff und eine unbekannte `id` enden alle in derselben neutralen **404**, nicht in vier verschiedenen
  Antworten. Dieselbe Regel filtert auch die Liste unter `/module` und den Eintrag „Module" der Navigation.
- **Vor jedem Lesen erneut geprüft** (`src/module/liste-detail.ts`): eine View kann sich nach dem Einspielen per
  `CREATE OR REPLACE VIEW` verändert haben, ohne dass die Registry (die den Block speichert, nicht die View
  selbst) etwas davon weiß. Scheitert die erneute Katalogprüfung oder das Lesen selbst, zeigt die Seite **keine
  Daten**, sondern den neutralen Hinweis „Dieses Modul ist gerade nicht verfügbar." — mit `200`, wie jeder andere
  Leerzustand im Cockpit (Agenten, Meldungen, Übersicht); der Grund landet nur im Log, nie auf der Seite.
- **Bezeichner nur aus dem geprüften Block, immer über `escapeIdentifier`** (`pg`), Schema fest `cockpit`; Werte (die
  gesuchte `id`) ausschließlich als Parameter. Jede Abfrage läuft in einer eigenen `BEGIN READ ONLY`-Transaktion mit
  `SET LOCAL statement_timeout = '2s'` und `LIMIT 200` — eine langsame oder fehlerhafte Fach-View hält das Cockpit
  nie länger als zwei Sekunden auf.
- **Navigation ohne Cache:** der Eintrag „Module" wird zum Link, sobald für die Rolle mindestens ein aktives Modul
  sichtbar ist, sonst bleibt er wie bisher ausgegraut (`folgt`) — die Tab-Leiste behält so immer ihre fünf Plätze.
  Berechnet wird das bei **jeder** Anfrage neu (`zugangLesenMitModulen`, wie `chatUngelesen` bei COPI-53), nie
  zwischengespeichert.
- **Moduldaten werden nie automatisch verlinkt und immer escaped** (dieselbe Regel wie bei Gästeinhalten im Chat,
  JAC-577): sie kommen aus einer Fach-View, nicht aus dem Cockpit selbst.
- Ein durchgespieltes Beispiel (View, Block, Übereinstimmung mit `wachenZustand`) steht unter
  `docs/beispiele/v_modul_server_zustand.sql` und `docs/beispiele/server-zustand.cockpit.yaml`; seit COPI-81 mit
  `uebersicht:` und der Verlaufs-View `docs/beispiele/v_modul_server_zustand_verlauf.sql` (Karten auf der Übersicht,
  siehe „Dashboard aus Modul-Karten").

Getestet in `test/modul-sichtbarkeit.test.ts` und `test/modul-ansicht.test.ts` (die reinen Funktionen) sowie
`test/modul-seiten-datenbank.test.ts` und `test/modul-server-zustand-datenbank.test.ts` (die Seiten gegen eine
echte Datenbank: Rollen, Escaping, Injection, eine nachträglich veränderte View, die Sortierung, die
Übereinstimmung mit `wachenZustand`).

### Übernahme-Sperre (COPI-85)

Ein Mensch übernimmt einen Vorgang, und die Agenten antworten dort nicht mehr, bis er ihn zurückgibt. **Ein Vorgang ist
eine Zeile einer Modul-View** — (Modul-Kennung, `id`), kein eigenes Vorgangsmodell. Angeboten wird das nur in Modulen,
deren Block `eingriffe: [uebernehmen]` trägt (`docs/modul-vertrag.md`, Abschnitt „Übernahme").

- **Wirkt sofort,** nicht über `cockpit.eingriff` und die Freigabekette (Entscheidung Stefan): `POST
  /module/:kennung/:id/uebernehmen` schreibt eine Zeile in `cockpit.vorgang_sperre` (Migration 0030) samt Protokoll
  `vorgang_uebernommen` in einer Transaktion. **Die Agenten fragen ab** (`GET /intern/vorgaenge/sperre`, Recht
  `vorgang_lesen`); das Cockpit schickt ihnen nichts. Kein automatischer Ablauf; der Gast merkt nichts.
- **Wer:** übernehmen darf jede Rolle, die das Modul sieht (`modulZugriffErlaubt`). **Zurückgeben** (`POST
  …/zurueckgeben`, Protokoll `vorgang_zurueckgegeben`, Ziel: wer übernommen hatte) darf, wer übernommen hat, dazu
  Betriebs-Admin und Betreuer immer; ein anderer Mitarbeiter sieht das Band, aber keinen Knopf, und bekommt `403`.
  Zurückgeben geht auch, wenn das Modul den Eingriff inzwischen nicht mehr anbietet.
- **Genau einer gewinnt:** ein partieller Unique-Index hält höchstens eine aktive Sperre je Vorgang; `INSERT … ON
  CONFLICT DO NOTHING` entscheidet gleichzeitige Übernahmen in der Datenbank. Wer verliert, sieht „Dieser Vorgang wurde
  bereits von <Name> übernommen." Nach der Rückgabe ist eine neue Übernahme eine neue Zeile; eine Sperre ist nach der
  Anlage bis auf die einmalige Rückgabe unveränderlich (Trigger) und wird nie gelöscht.
- **Prüfungen vor jeder Änderung:** Sitzung und zweiter Faktor, Zugriff auf das Modul und die Rolle frisch aus der
  Datenbank; **CSRF** zweifach (Herkunft Pflicht, dazu eine signierte Bestätigung je Konto, Modul, Vorgang und Aktion,
  zehn Minuten — abgelaufen führt ohne Änderung zurück auf die Detailseite); die Zeile muss in der View existieren. Eine
  unbekannte Kennung oder `id`, ein Modul ohne den Eingriff und eine Rolle ohne Zugriff enden in derselben neutralen 404.
- **Oberfläche** (Entwurf „Übernahme"): auf der Detailseite der Knopf „Übernehmen" mit Hinweis bzw. das Band in der
  Akzentfarbe (`role="status"`, Schloss, „Von <Name> übernommen seit <Zeit>", ggf. „Zurückgeben"); in Liste, Kacheln
  und Dashboard-Karten die Marke „übernommen · <Vorname>". Der Name kommt aus dem Konto (gelöscht: „ehemaliges Konto"),
  nie die E-Mail, immer escaped. Neues Farb-Token `accent-rand` (Light/Dark) für den Rand des Bands.
- **Lokal ausprobieren:** `./dev demo` legt das Demo-Modul „Anfragen" (`demo-anfragen`) mit vier Gästeanfragen an —
  Fachtabelle im Schema `demo`, nur lokal (`scripts/dev/demo-anfragen.ts`, nie im Image, nie in einer Migration).
  `./dev vorschau` legt dazu ihr Vorschau-Konto an, damit „Übernehmen" dort geht.

Getestet in `test/vorgang-sperre-datenbank.test.ts` (Tabelle und Speicher: Unique, Unveränderlichkeit, nie löschen,
CHECK, zehn gleichzeitige Übernahmen → genau eine, Rückgaberechte, Protokoll), `test/vorgang-sperre-seiten-datenbank.test.ts`
(Routen und Oberfläche: Tor, CSRF, Eingriff, Rolle, unbekannte `id`, Escaping), `test/intern-vorgaenge-datenbank.test.ts`
(Agenten-API) und `test/layout.test.ts` (Band, Knopf und Marke ohne Inline-Stil).

## Einstellungen und Versionen (Epic E3, COPI-39)

Die Seite **Einstellungen** (`/einstellungen`) ist aufgebaut wie der Bildschirm „Einstellungen" des Prototyps: oben
„Ansicht: <Rolle>", darunter der Abschnitt **Versionen** mit einer Karte je Bereich. Ein Bereich ist eine Komponente,
die sich aktualisieren lässt — heute das Cockpit-Image, mit E5 die Module. Der Betreuer beantragt hier Updates
(COPI-40, unten). Die Stammdaten des Prototyps (Benachrichtigungs-E-Mail) fehlen noch.

| Sicht | Wer | Was sie zeigt |
| --- | --- | --- |
| Kunde | Betriebs-Admin, Mitarbeiter, unbekannte Rolle | ein Satz je Bereich: „Aktuell.", „Update angefragt." oder „Update fehlgeschlagen, Betreuer ist informiert." — **keine Digests, keine Versionsnummern** (ADR 13.1) |
| Betreuer | Recht `technik_sehen` | Marke „Nur Betreuer"; je Bereich Version, laufender Digest, gestartet, Soll-Digest, verfügbare Version, Stand der Versions-Wache, eine Plakette und der letzte Antrag |

| Angabe | Quelle |
| --- | --- |
| Version, laufender Digest, gestartet | die **Selbstmeldung** in `cockpit.instanz` (siehe unten) |
| Soll-Digest | das Ziel eines **offenen** Antrags (`beantragt`, `freigegeben`, `laeuft`) in `cockpit.eingriff`; sonst „kein Update beantragt" |
| Verfügbar | der Text des jüngsten Befunds der Wache `version-cockpit`, **unverändert** — das Cockpit wertet ihn nicht aus und fragt GHCR nie selbst (ADR 4) |
| Versions-Wache | „zuletzt geprüft vor …" dieser Wache; bleibt sie aus (Takt eine Woche), in Warnfarbe |
| Plakette | hängender Antrag (länger als 15 Minuten in `laeuft`, COPI-41): Rot „Update hängt", das geht allem vor; offener Antrag: „Update angefragt"; gescheiterter: „Update fehlgeschlagen"; sonst (auch nach einem zurückgezogenen) der Status der Wache: Grün „Aktuell", Gelb „Update verfügbar", Rot „Prüfung gestört" |
| Letzter Antrag | der jüngste Antrag, gleich in welchem Stand (COPI-41): Stand („wartet auf Freigabe", „freigegeben", „läuft", „hängt", „erledigt", „fehlgeschlagen", „zurückgezogen"), Ziel, Ziel-Version, **Weg zurück** (`digest_vorher`) und wann jede erreichte Stufe war — auch nach dem Abschluss, denn dann braucht man den Weg zurück |
| Satz der Kundensicht | nur der Status des jüngsten Antrags (ein zurückgezogener: „Aktuell.", ein hängender: „Update angefragt.") |

- **Die Trennung liegt in der Abfrage** (`src/status/versionen-speicher.ts`): die Kundensicht liest nur den Status des
  jüngsten Antrags. Die Kundenseite ist mit und ohne Selbstmeldung und Befund der Versions-Wache **byteidentisch**
  (getestet).
- **Versions-Wache:** je Bereich eine; für das Cockpit-Image `version-cockpit`. Wie der Agent sie meldet (Takt, Farben,
  Text unter „Verfügbar"), steht im Vertrag [`docs/agenten-api.md`](agenten-api.md#die-versions-wache).
- Digests werden gekürzt angezeigt, stehen aber vollständig im Dokument (markieren und kopieren liefert den ganzen
  Wert). Alles wird maskiert, nichts verlinkt; die Seite ist `no-store`.

### Update beantragen (COPI-40)

„Das Cockpit aktualisiert nichts. Es beantragt." (ADR 13.1) Nur wer das Recht `update_beantragen` hat — der
Betreuer —, sieht in der Karte „Cockpit" das Feld **Ziel-Digest** und den Knopf **Update beantragen**. Betriebs-Admin
und Mitarbeiter sehen weder Feld noch Knopf, und ein „Jetzt aktualisieren" gibt es für niemanden.

1. `POST /einstellungen/update` prüft die Eingabe und zeigt eine **Bestätigungsseite** mit beiden Digests vollständig
   (läuft jetzt / Ziel). Angelegt wird hier noch nichts — ein Schritt gegen Fehlklicks.
2. `POST /einstellungen/update/bestaetigen` (das Formular der Bestätigungsseite) schreibt **eine** Zeile
   `cockpit.eingriff` (`art: cockpit-image`, `ziel_digest`, `digest_vorher` = der laufende Digest, `beantragt_von` = das
   Konto, Status `beantragt`) und den Protokolleintrag `update_beantragt` — in einer Transaktion — und kehrt zu den
   Einstellungen zurück („Antrag gestellt. Die Freigabe erfolgt außerhalb des Cockpits.").
3. Solange der Antrag auf die Freigabe wartet, steht dort „Antrag Nr. … wartet auf die Freigabe." mit **Antrag
   zurückziehen** (`POST /einstellungen/update/zurueckziehen`, Status `zurueckgezogen`, Protokoll
   `update_zurueckgezogen`). Ist er freigegeben oder läuft, gibt es hier nichts mehr zu tun.

| Regel | Wie |
| --- | --- |
| nur der Betreuer | Recht `update_beantragen`, geprüft als `preHandler` vor jeder der drei Routen und noch einmal im Handler; sonst `403`, es entsteht nichts. Anonyme schickt das Tor vorher zur Anmeldung |
| Ziel-Digest streng | genau `sha256:` und 64 Zeichen `0–9a–f` (nur Leerraum an den Rändern fällt weg); kein Tag, keine Version, kein gekürzter Digest, keine Großbuchstaben, kein Bildname davor |
| kein Antrag ohne Rückweg | ohne laufenden Digest (Selbstmeldung ohne `COCKPIT_IMAGE_DIGEST`) bietet die Seite keinen Antrag an und die Route stellt keinen (`409`) |
| kein Leerlauf | ein Ziel, das schon läuft, wird abgewiesen |
| CSRF | **Herkunft Pflicht:** `Origin` oder `Referer` muss die eigene Adresse sein (`herkunftBelegt`) — strenger als bei der Anmeldung, denn unter `<kuerzel>.example.com` ist jede Nachbar-Subdomain für `SameSite` „same site". Dazu eine **signierte Bestätigung** (HMAC über Konto, Ziel, laufenden Digest, Ablauf; zehn Minuten; Schlüssel nur im Speicher des Prozesses) |
| kein Doppelantrag | höchstens ein offener Antrag, festgehalten in der Datenbank (Migration `0018`): auch ein doppelt oder gleichzeitig abgeschicktes Formular ergibt genau eine Zeile (`409` für die übrigen) |
| Fehler beim Schreiben | Transaktion zurückgenommen, nach außen ein fester Satz (`500`), keine Meldung der Datenbank |

**Die Freigabe geschieht außerhalb des Cockpits** (Stefans Meldekanal), die Ausführung übernimmt der Admin-Agent mit
seinem eng gefassten Werkzeug. Das Cockpit bekommt dafür weder Docker-Socket noch SSH noch GHCR-Zugriff und
benachrichtigt niemanden: der Agent holt offene Anträge über die Agenten-API ab und meldet ihren Stand (Ablauf im
Vertrag, [`docs/agenten-api.md`](agenten-api.md#der-ablauf-eines-updates-cockpit-update)).

Getestet in `test/update-antrag.test.ts` (Digest-Form und Bestätigung), `test/herkunft.test.ts`,
`test/update-antrag-datenbank.test.ts` (der ganze Weg, je Rolle mit echten Sitzungen: Betriebs-Admin und Mitarbeiter
bekommen beim direkten POST `403`, und es entsteht keine Zeile; ungültiger Digest, fehlende oder veränderte Bestätigung,
fremde Herkunft, Doppelantrag, Rückzug, Transaktion) und `test/zustandsbild-schema-datenbank.test.ts` (Kette,
Rückzug, ein offener Antrag, Migration `0018` hin und zurück). Dass die Rolle `betreuer` in der Oberfläche nicht
vergebbar ist, prüfen `test/berechtigung.test.ts` und `test/einladung-datenbank.test.ts`.

### Modul-Update beantragen (COPI-106)

Unter „Versionen" steht neben „Cockpit" je aktives Modul eine Karte (nur Betreuersicht): Version in der Registry und
seit wann sie aktiv ist, **Herkunft** (`bibliothek@<commit>:<pfad>`), „Verfügbar" aus der Versions-Wache
`version-modul-<kennung>` (Text unverändert, vom Admin-Agenten) und der letzte Antrag mit Stand, Grund eines
Fehlschlags, Ziel, Weg zurück und Stufen. Der Antrag läuft wie beim Image, mit eigenen Routen:

1. `POST /einstellungen/modul-update` (`modul`, `ziel`) prüft und zeigt die **Bestätigungsseite** mit Herkunft und
   Ziel-Commit. Abgewiesen werden ein unbekanntes oder inaktives Modul, eines ohne Herkunft aus agent-blueprints (`409`,
   ohne sie kein Pfad und kein Weg zurück), ein Ziel, das kein Commit ist (7–40 Zeichen `0–9a–f`, keine Branches, keine
   Großbuchstaben), der schon eingespielte Commit und ein zweiter offener Antrag für dasselbe Modul.
2. `POST /einstellungen/modul-update/bestaetigen` schreibt die Zeile (`art: modul`) mit `update_beantragt`. Die
   signierte Bestätigung hat einen eigenen Zweck und bindet Konto, Modul, Ziel und die Herkunft von Schritt 1: hat sich
   das Modul inzwischen geändert, gilt sie nicht mehr.
3. Zurückziehen wie beim Image (`POST /einstellungen/update/zurueckziehen`, die Nummer genügt).

Rückmeldungen stehen an der Karte des betroffenen Moduls (`?antrag=…&modul=<kennung>`, nur eine gültige Kennung). Das
Cockpit spielt nichts ein: nach der Freigabe spielt der Admin-Agent erst die View, dann den Block ein; **erledigt** setzt
das Cockpit selbst, wenn `modul-einspielen` eine Version aus dem Ziel-Commit aktiviert. Gleicher Block mit neuer
Herkunft ergibt dafür seit COPI-106 eine neue Version (die Katalogprüfung läuft erneut). Fachmigrationen bleiben
Handarbeit, ein Wartungsfenster gilt nicht (Entscheidungen Stefan/Alex, 01.–02.10.2026; Ablauf im Vertrag,
[`docs/agenten-api.md`](agenten-api.md#modul-updates-art-modul-copi-106)).

Getestet in `test/modul-update-datenbank.test.ts` (der ganze Weg mit Rollen, Bestätigung, Freigabe per Commit,
Erledigt-Beleg, Grund, Rückweg, Regeln der Migration) und `test/status-versionen.test.ts` (die Karte).

### Update mit einem Klick (COPI-140)

Meldet die Versions-Wache ein Ziel (`update`, siehe oben und Vertrag), zeigt die Karte „Cockpit" bzw. die des Moduls
„Update verfügbar: <Version bzw. Kurz-Commit> · <Hinweis> · seit <Datum>" und den Knopf **„Update installieren"**. Er
schickt an dieselben Routen nur `quelle=wache`, kein Ziel: das Ziel liest der Server aus dem jüngsten Befund der Wache.
Die Bestätigungsseite bleibt (signiert, Herkunft, ein offener Antrag, Rückzug, Protokoll wie oben) und trägt die Quelle
weiter; beim Bestätigen prüft der Server das Ziel noch einmal. Meldet die Wache inzwischen ein anderes, kommt die
Bestätigung mit dem neuen Ziel und einem Hinweis zurück (`409`), meldet sie keins mehr, entsteht kein Antrag (`409`).

- **Kein Knopf**, solange ein Antrag offen ist (die Karte zeigt dessen Stand), wenn das Ziel schon läuft, und bei einem
  Modul, dessen Herkunft nicht unter `module/<kennung>.cockpit.yaml` liegt: dort steht „Herkunft nicht unter module/:
  Update nur per Server-Konsole", und die Routen nehmen keinen Antrag an (`409`, Anlass COPI-143).
- **Notweg:** die Eingabe von Digest bzw. Commit steht eingeklappt unter „Bestimmten Stand wählen" (etwa für den Weg
  zurück); nach einer falschen Eingabe ist sie offen.
- **Hinweispunkt:** solange mindestens eine Karte „Update installieren" anbietet, trägt „Einstellungen" (Desktop) bzw.
  „Mehr" (mobil, dort auch „Einstellungen") einen Punkt, nur mit `technik_sehen` (`status/update-hinweis.ts`).

Getestet in `test/status-versionen.test.ts` (Zeile, Knopf, offener Antrag, laufendes Ziel, nur Server-Konsole),
`test/layout.test.ts` (Formulare ohne Ziel, Notweg, Punkt), `test/modul-update-datenbank.test.ts` und
`test/update-antrag-datenbank.test.ts` (Klick → Bestätigung mit Ziel, veraltetes Ziel, kein Ziel, offener Antrag,
Kundenrollen) und `test/versionen-anzeige-datenbank.test.ts` (Punkt je Rolle).

### Freigabemodus: Rückfrage oder direkt (COPI-141)

Unter „Versionen" steht für den Betreuer (Recht `update_beantragen`) der Block **Freigabe von Updates**: getrennt für
**Cockpit** und **Module** (nicht je Modul) entweder **Rückfrage in Slack** (Standard, der Ablauf oben) oder **Direkt
installieren**. Bei „direkt" ist die Bestätigung im Cockpit die Freigabe: der Antrag steht in derselben Transaktion auf
`freigegeben` (beim Image mit der Version aus dem Wachen-Ziel, Protokoll `update_freigegeben` mit `weg: direkt`), und
der Admin-Agent spielt ihn ohne Rückfrage ein. Ausgeführt wird weiterhin nur vom Agenten
([ADR 0002](adr/0002-freigabe-direkt.md), Entscheidung Stefan 13.10.2026).

- **Umschalten:** `POST /einstellungen/freigabe` (`bereich`, `modus`). Auf „direkt" folgt eine Bestätigungsseite, zurück
  auf die Rückfrage gilt sofort. Jede Änderung ist eine neue Zeile in `cockpit.update_freigabemodus` (nur anhängen,
  Migration `0050`) und ein Protokolleintrag `update_freigabemodus_geaendert` (alt → neu), wer und wann steht am Schalter.
- **Snapshot:** der Modus wird beim Antrag in `eingriff.freigabe_modus` festgeschrieben; ein späterer Wechsel ändert
  keinen laufenden Antrag. Die Agenten-API liefert ihn mit.
- **Nur mit Ziel der Wache:** der Notweg „Bestimmten Stand wählen" bleibt immer bei der Rückfrage (ein von Hand gewählter
  Stand, oft der Weg zurück, bekommt eine zweite Prüfung; beim Image fehlte die Version für den Erfolgsbeleg). Die
  Bestätigungsseite sagt, was gilt („Freigeben und installieren" bzw. „Antrag stellen"); wurde inzwischen umgeschaltet,
  entsteht nichts, und sie kommt mit dem geltenden Modus zurück (`409`).
- **Rückzug:** ein direkt freigegebener Antrag lässt sich zurückziehen, bis der Agent `laeuft` meldet (neue Kante
  `freigegeben → zurueckgezogen`, nur bei `direkt`, in der Datenbank geprüft). Mit Rückfrage freigegeben bleibt wie
  bisher.

Getestet in `test/freigabe-modus-datenbank.test.ts` (Umschalten mit Bestätigung und Protokoll, nur Betreuer, beide Modi je
Art, Notweg, Snapshot, geänderter Modus, Rückzug, Regeln der Migration) und `test/status-versionen.test.ts` (Karte).

### Automatisch installieren (COPI-142)

Der dritte Freigabemodus **Automatisch installieren**, getrennt für Cockpit und Module, Standard bleibt die Rückfrage
([ADR 0003](adr/0003-update-automatisch.md), Entscheidung Stefan 13.10.2026). Dann stellt das Cockpit den Antrag
**selbst**, sobald die Versions-Wache ein Update meldet, und gibt ihn wie bei „direkt" sofort frei. Ausgeführt wird
weiterhin nur vom Admin-Agenten; Slack meldet nur das Ergebnis.

- **Der Planer** (`src/status/update-planer.ts`) läuft jede Minute im Server-Prozess, ein Lauf überholt den anderen nicht.
  Er nutzt denselben Antragsweg wie der Klick (Sperre des Bereichs, höchstens ein offener Antrag, Protokoll), nur ohne
  Bestätigungsseite: `update_beantragt` und `update_freigegeben` tragen `weg: automatisch`, Antragsteller ist das Konto,
  das den Bereich auf „automatisch" gestellt hat (nur solange es ein aktiver Betreuer ist).
- **Wann:** das Cockpit-Image nur **dienstags 07:00–09:00** (Europe/Berlin, das Wartungsfenster aus dem Vertrag), nur mit
  Ziel-Version und bekanntem laufendem Digest; Module jederzeit, nur mit Herkunft unter `module/`.
- **Schleifenschutz:** höchstens ein automatischer Antrag je Cockpit bzw. Modul und Kalendertag. Kein neuer für ein Ziel,
  auf das ein Antrag `fehlgeschlagen` ist (gleich ob von Hand oder automatisch) oder dessen automatischer Antrag
  zurückgezogen wurde — bis die Wache ein anderes Ziel meldet. Ein hängender Antrag ist offen und verhindert jeden neuen;
  Fehlschlag und Hängen meldet weiter die Wache des Agenten (rot, Slack). Die Karte sagt, was die Automatik gerade tut
  („Wird automatisch installiert …", „frühestens morgen", „Automatik für dieses Ziel gesperrt"); der Knopf „Update
  installieren" bleibt.
- **Datenbank** (Migration `0052`): `update_freigabemodus.modus` kennt `automatisch`; `eingriff.automatisch` (nach dem
  Antrag fest, nur mit `freigabe_modus = direkt`). Die Agenten-API liefert das Feld mit; für den Agenten ist ein
  automatischer Antrag ein direkter.
- **Ein Klick** im Modus „automatisch" verhält sich wie bei „direkt"; der Notweg bleibt bei der Rückfrage.

Getestet in `test/update-planer-datenbank.test.ts` (Modi, Wartungsfenster, Tageslimit je Modul, Sperre nach Fehlschlag
und Rückzug, offener Antrag, ohne Update, Herkunft, Konto, Idempotenz, Regeln der Migration), `test/update-planer.test.ts`
(Zeitgrenzen, Sommer-/Winterzeit), `test/freigabe-modus-datenbank.test.ts` (Umschalten, Klick, Karte, Agenten-API) und
`test/status-versionen.test.ts` (Sätze der Karte).

### Selbstmeldung beim Start

Beim Start schreibt das Cockpit **Version und Digest** nach `cockpit.instanz` — eine Zeile, jeder Start ersetzt sie —,
**bevor** es lauscht: wer auf `/gesund` antwortet, hat sich gemeldet.

**Erfolgsbeleg (COPI-41).** In derselben Transaktion belegt die Meldung ein Update: steht ein Eingriff `cockpit-image`
in `laeuft`, dessen Ziel-Digest der gemeldete Digest ist und dessen Ziel-Version die gemeldete Version ohne den Commit
(`1.5.0+89abcde` → `1.5.0`), setzt das Cockpit ihn auf `erledigt` und schreibt `update_erledigt` (Akteur `system`); im
Log steht „Update belegt". Erfolg heißt „ein Cockpit mit dem Ziel hat sich gemeldet", nicht „der Befehl lief durch" —
und das sagt nur das Cockpit selbst, nie ein Agent. Ein anderer Digest, das alte Image mit dem neuen Digest aus der
Umgebung, ein fehlender Digest, eine Vorabversion derselben Nummer oder eine Zeile, die nicht `laeuft` ist: nichts wird
belegt, und die Zeile hängt nach 15 Minuten. Meldung, Beleg und Eintrag gelten zusammen oder gar nicht.

- **Version** = Build-Argument `COCKPIT_VERSION` (SemVer) + `+` + die ersten 7 Zeichen von `COCKPIT_COMMIT`, etwa
  `1.4.0+0123456`. Ohne Build-Argumente `<package.json>+lokal`. Eine kaputte Beschriftung hält den Start nicht auf
  (dann gilt `package.json`, mit Hinweis).
- **Digest** = `COCKPIT_IMAGE_DIGEST` aus der Compose-Datei. Ein Image kann seinen eigenen Digest nicht enthalten
  ([`docs/adr/0001-digest-aus-der-umgebung.md`](adr/0001-digest-aus-der-umgebung.md)). **Nie erfunden:** fehlt
  er oder ist er kaputt, bleibt er NULL, mit Hinweis im Log (ohne den Wert).
- Scheitert das Schreiben, startet das Cockpit nicht (Exit 1).

Getestet in `test/status-instanz.test.ts` (die Regeln), `test/instanz-speicher-datenbank.test.ts`,
`test/start-pruefung-prozess-datenbank.test.ts` (der echte Serverprozess meldet sich), `test/image-version.test.ts`
(Dockerfile, `release.yaml`, `ci.yaml` und Compose-Fragment passen zueinander) und im Smoke-Test des Images
(`docker/smoke-schema.sh`, Gate 6: das gestartete Image meldet genau die gebaute Version und den Digest). Die Seite:
`test/status-versionen.test.ts` und `test/einstellungen-datenbank.test.ts` (je Rolle, mit echten Sitzungen).

## Erststart (Epic E2)

Solange in der Datenbank kein Benutzer existiert, erzeugt das Cockpit bei
**jedem** Start ein Erststart-Token (32 Byte Zufall) und gibt es als
abgegrenzten Block auf `stdout` aus — ausgegeben wird ein Token, nie ein
fertiges Passwort, und ausschließlich auf der Konsole:

```
docker compose logs cockpit
```

Der Link `<basis-url>/erststart/<token>` führt einmalig zum Anlegen des ersten
Zugangs. Das Token gilt 24 Stunden, verfällt bei der ersten Nutzung und sobald
ein Benutzer existiert; ein Neustart entwertet ein noch offenes Token und gibt
ein neues aus. Gespeichert wird nur der SHA-256-Hash. Die Wurzelseite zeigt
währenddessen die Anmeldeseite, die das Verfahren mit keinem Wort nennt.

Direkt nach dem Anlegen verlangt das Cockpit die Einrichtung eines zweiten
Faktors (Passkey oder TOTP, siehe „Passkey einrichten"). Die Seite zeigt dafür einen **QR-Code**, den die
Authenticator-App scannt; Geheimnis und Einrichtungs-Adresse stehen nirgends
als Text auf der Seite. Der Code entsteht serverseitig als inline-SVG (kein
externer Dienst, kein JavaScript), die Antwort trägt `Cache-Control: no-store`.
Bis der Faktor einmal erfolgreich geprüft wurde, leitet eine zentrale Weiche
jede Route auf die Einrichtungsseite um. Eine
Selbstregistrierung gibt es nicht — weitere Zugänge entstehen später per
E-Mail-Einladung.

Das Konto, das so entsteht, ist der **Betreuer** (siehe „Rollen"): der Zugang
für Stefan bzw. wer die Betreuung der Instanz übernimmt, nicht der des
Betriebs-Admins beim Kunden. Scheitert die Vergabe der Rolle, wird das eben
angelegte Konto wieder zurückgenommen, und der Erststart lässt sich mit einem
Neustart (neues Token) wiederholen.

## Anmeldung (Epic E2)

Die Wurzelseite ist **nicht** öffentlich: ohne Sitzung führt jede geschützte
Adresse mit `303` auf `/anmelden`. Ein zentrales Tor
(`torEntscheidung` in `src/auth/zwei-faktor-tor.ts`) entscheidet das an genau
einer Stelle und arbeitet *deny by default* — ohne Sitzung ist nur eine
ausdrückliche Liste erreichbar: `/anmelden*`, `/erststart/<token>`,
`/einladung/<token>`, `/zugang-wiederherstellen/<token>`, `/gesund`, `/abmelden`. Zwei Ausnahmen bekommen ohne
Sitzung bewusst keine Umleitung, sondern dieselbe neutrale 404-Seite wie eine
fehlende Route:

- `/einladung` (das Formular) — Vertrag aus COPI-11: dieselbe Antwort für
  „nicht angemeldet", „falsche Rolle" und „kein Token". Ebenso `/zugang-wiederherstellen`
  ohne Token (COPI-28).
- `/api/auth/*` (die rohen Better-Auth-Endpunkte) — in **jedem** Zustand, auch
  mit Sitzung; siehe den folgenden Abschnitt.

### Rohe Better-Auth-Endpunkte (`/api/auth/*`)

Das serverseitig gerenderte Cockpit braucht sie im Browser nicht; die Seiten
arbeiten mit `auth.api.*` im Serverprozess. Erreichbar wären sie eine zweite
Tür an den Seiten vorbei — etwa `/two-factor/disable` mit gestohlener Sitzung
und Passwort oder `/sign-in/email` an der eigenen Ratenbegrenzung vorbei.
Deshalb gilt *deny by default*, auch für angemeldete Konten:

| Zustand | erreichbar |
| --- | --- |
| ohne Sitzung | nichts |
| Sitzung ohne zweiten Faktor | `/api/auth/get-session`, `/api/auth/sign-out` |
| Sitzung mit zweitem Faktor | `/api/auth/get-session`, `/api/auth/sign-out` |

Alles andere unter `/api/auth` — auch `/api/auth/two-factor/*` — antwortet mit
derselben neutralen 404 wie für Anonyme, ohne ablesbaren Unterschied. Freigegeben
sind **exakte Pfade**, keine Präfixe: `/api/auth/get-session/x`, der Pfad mit
abschließendem Schrägstrich, abweichende Groß-/Kleinschreibung und
Prozent-Kodierung bleiben zu.

**Einen weiteren Endpunkt freigeben** (etwa für die PWA; die Passkey-Einrichtung braucht keinen, sie läuft über eigene Routen) ist
eine bewusste, einzelne Entscheidung:

1. Im Ticket begründen und beantworten, was der Endpunkt mit einer gestohlenen
   Sitzung anrichten kann.
2. Den Pfad in `AUTH_ERLAUBT` (`src/auth/zwei-faktor-tor.ts`) eintragen.
3. Die Erwartung in den Tests nachziehen: `AUTH_FREIGEGEBEN` in
   `test/zwei-faktor-tor.test.ts` und `ERREICHBAR_MIT_SITZUNG` in
   `test/auth-endpunkte-datenbank.test.ts`.

Eine Profil- oder Passwortseite im Cockpit bekommt dagegen eine eigene
serverseitige Route mit `auth.api.*`, nicht den rohen Endpunkt.

`test/auth-endpunkte-datenbank.test.ts` misst gegen die **installierte**
better-auth-Version: die Kandidaten stammen aus `auth.api`, ein Versionssprung
mit neuen Endpunkten wird also mitgemessen. Nach einem Update dieses Pakets
lohnt der Blick, ob ein neuer Endpunkt dazugekommen ist, der Zustand ändert.

Angemeldet wird in **zwei Schritten**:

1. `/anmelden` — E-Mail-Adresse und Passwort. Hat das Konto einen zweiten
   Faktor, entsteht hier **keine** Sitzung.
2. `/anmelden/code` — sechsstelliger TOTP-Code **oder** ein Ersatzcode aus der
   Einrichtung. Ein Ersatzcode gilt genau einmal. Erst dieser Schritt legt die
   Sitzung an.

Es gibt keinen Rücksprung-Parameter: nach der Anmeldung geht es immer auf `/`
(kein Ziel aus der Anfrage, also keine offene Weiterleitung). Falsches
Passwort, unbekannte Adresse und laufende Sperre liefern denselben Text mit
demselben Status — die Antwort verrät nicht, ob es ein Konto gibt.

### Auth-Geheimnis (COPI-32)

`BETTER_AUTH_SECRET` ist das Geheimnis, mit dem Better Auth **Sitzungs-Cookies signiert** und den **TOTP-Schlüssel
samt dessen Ersatzcodes verschlüsselt**. Ändert es sich, geschieht Folgendes:

| Was | hängt am Geheimnis? | Folge bei einem anderen Geheimnis |
| --- | --- | --- |
| Sitzungen (Cookie-Signatur) | ja | alle abgemeldet, neu anmelden genügt |
| TOTP-Schlüssel und Ersatzcodes eines TOTP-Kontos | ja | Codes werden abgelehnt (der Schlüssel lässt sich nicht mehr entschlüsseln); nur `entsperren` hilft |
| Passkey (öffentlicher Schlüssel, Challenge) | nein | unverändert anmeldbar |
| Ersatzcodes eines Passkey-Kontos (eigene Tabelle, Argon2id) | nein | unverändert gültig |
| Passwort (Argon2id-Hash) | nein | unverändert |

Woher das Geheimnis kommt:

1. **`BETTER_AUTH_SECRET` gewinnt immer.**
2. **Produktion:** Pflicht, ohne startet das Cockpit nicht. Die Datei der Entwicklung wird dort nie gelesen oder angelegt.
3. **Tests:** ein Zufallswert je Aufruf; jeder Test setzt sein Geheimnis selbst.
4. **Entwicklung ohne Variable:** `.cockpit-dev-secret` in der Wurzel des Repos (gitignoriert und in `.dockerignore`, Rechte
   `0600`). Der erste Start legt sie mit 32 Zufallsbytes an und schreibt einen Hinweis in den Log, jeder weitere Start liest
   sie. Vor COPI-32 wurde bei **jedem** Start neu gewürfelt: nach einem Neustart (mit `tsx watch` nach jeder Dateiänderung)
   war ein TOTP-Konto der Entwicklungs-Datenbank unbrauchbar. Angelegt wird die Datei atomar (Zwischendatei, dann harter
   Link), gleichzeitig startende Prozesse teilen sich also dasselbe Geheimnis. Eine zu kurze oder leere Datei bricht den
   Start mit einer Anleitung ab, statt still ein neues Geheimnis zu würfeln. Lässt sich die Datei nicht anlegen (Ordner
   nicht beschreibbar), gilt ein Zufallswert für diesen Prozess, und der Log sagt, was das kostet.

**Woran man ein falsches Geheimnis erkennt:** Die Anmeldeseite sagt in jedem Fall nur „Der Code stimmt nicht." (nichts
verraten). Der Log der Anwendung unterscheidet: bei einem falschen Code steht `Anmeldung: Codeschritt abgelehnt` mit dem
`grund` der Ablehnung, bei einer gescheiterten Prüfung (typisch `"grund":"invalid tag"`) zusätzlich ein `hinweis`, der auf
`BETTER_AUTH_SECRET` verweist. Weder Code noch Schlüssel noch Geheimnis stehen im Log.

**Wiederherstellen:** Ein TOTP-Konto, dessen Geheimnis verloren oder gewechselt ist, öffnet nur noch das Server-Kommando
`entsperren` (siehe „Zweiter Faktor verloren"): Es entfernt die Faktoren, macht das Passwort ungültig und gibt einen Link
aus, über den Passwort und zweiter Faktor neu eingerichtet werden. Ein Passkey-Konto braucht das nicht. Wer in der
Entwicklung `.cockpit-dev-secret` löscht oder `BETTER_AUTH_SECRET` neu setzt, wechselt das Geheimnis. Eine Rotation in Produktion
ist nicht vorgesehen; ein Wechsel dort hätte dieselben Folgen für alle TOTP-Konten.

### Zweiter Faktor aktiv — eine Quelle

Ob ein Konto einen aktiven zweiten Faktor hat, entscheidet **eine** Stelle: die
Datenbank-Funktion `cockpit.zweiter_faktor_aktiv` (Migration `0011`). Tor,
Rechteprüfung, Einrichtungsseite, Betreuerübergabe und der Trigger, der
`aktiviert_am` setzt, fragen alle sie und nicht die Spalte `twoFactorEnabled`.

Warum: Die Spalte setzt das Better-Auth-Plugin nur für TOTP. Ein Passkey (COPI-26)
würde sie nicht setzen. Wer sie direkt liest, hielte ein Konto mit Passkey für
ungeschützt, und der 72-h-Verfall (COPI-17) löschte es. Mit der einen Funktion hat COPI-26
nur sie erweitert (`CREATE OR REPLACE`, Migration `0012`: TOTP **oder** ein Passkey), ohne
eine der Stellen anzufassen: Ein Konto mit Passkey kommt durch das Tor, die
Einrichtungsseite schickt es weiter, der Trigger setzt `aktiviert_am`.

- Im Code liest **niemand** die Spalte; `test/zweiter-faktor.test.ts` prüft das per
  Quelltext-Scan (Kommentare ausgenommen). Nur die Migrationen dürfen sie nennen.
- Die Funktion bekommt die **Zeile** (`cockpit."user"`), nicht die Konto-ID: Der Trigger
  prüft den neuen Zustand (`NEW`) einer noch nicht geschriebenen Zeile; eine Funktion, die
  per ID nachschlägt, sähe dort noch den alten. Sie liefert immer wahr oder falsch, nie
  NULL.
- Der Wert kommt bei jeder Anfrage aus der Datenbank, nicht aus dem Sitzungsobjekt: eine
  Änderung wirkt sofort, auch bei einer laufenden Sitzung.
- **Kosten** (gemessen, Abfragen je Anfrage mit Sitzung, vorher → nachher): Seite hinter
  dem Tor 2 → 3, Einladungsformular 8 → 9, Einrichtungsseite 4 → 6, ohne Sitzung 0 → 0. Es
  sind Zugriffe über den Primärschlüssel. Das Einladungsformular prüft Tor, Haken und
  Handler je für sich (bewusst unabhängig), Rolle und Faktor kommen dort in einer Abfrage.
- Auch der **Anmeldeschritt** fragt sie (COPI-27): ob nach dem Passwort ein zweiter Schritt
  folgt, entscheidet nicht mehr allein `twoFactorRedirect` des Plugins (das kennt nur TOTP),
  sondern `zweiter_faktor_aktiv` (siehe „Anmeldung mit Passkey").

### Passkey einrichten

Die Einrichtungsseite `/zwei-faktor` bietet neben der Authenticator-App (TOTP) einen
**Passkey** an: gleichwertig, empfohlen (ADR Abschnitt 7 Punkt 6). Ablauf:

1. Das Passwort bestätigen. Ein kleines Skript holt die Optionen
   (`POST /zwei-faktor/passkey/optionen`).
2. Das Gerät verlangt PIN oder Biometrie und signiert die Challenge.
3. `POST /zwei-faktor/passkey/pruefen` prüft die Antwort. Bei Erfolg entsteht der Passkey, das
   Konto hat einen aktiven zweiten Faktor (`aktiviert_am` gesetzt, das Tor lässt es durch), und die
   Seite zeigt **einmal** zehn Ersatzcodes an (`Cache-Control: no-store`). Im Protokoll steht
   `zweiter_faktor_eingerichtet` mit `faktor: passkey`, ohne Adresse, Namen oder Kennung des Geräts.

Was dabei gilt:

- **Bibliothek:** `@simplewebauthn/server` direkt, nicht das Better-Auth-Plugin
  `@better-auth/passkey`. Das Plugin zielt auf die Anmeldung *ohne* Passwort und öffnet rohe
  Endpunkte; die Registrierung läuft stattdessen über eigene Routen im Prozess. Die Freigabeliste
  unter `/api/auth` (COPI-20) bleibt unverändert.
- **rpID und Herkunft** kommen ausschließlich aus der festen Basis-URL (ADR 13.3): die Domain ohne
  Port, die Herkunft mit Port. **Ein Domainwechsel macht jeden Passkey ungültig** — er ist eine
  Migration, keine Einstellung; die Konten müssen ihre Passkeys danach neu einrichten. Eine
  Basis-URL mit IP-Adresse oder mit `http` außerhalb von `localhost` weist das Cockpit beim Start
  ab (der Browser lehnte WebAuthn dort ohnehin ab). Ohne Basis-URL gibt es keine Passkey-Routen.
- **`userVerification: required`**, Attestation `none`: der Passkey soll allein ein zweiter Faktor
  sein. Ein Gerät, das keine Benutzerprüfung kann, nimmt TOTP.
- **Challenge** in der Datenbank (`cockpit.passkey_vorgang`): eine je Konto, fünf Minuten gültig,
  **einmal** — sie wird beim Prüfen verbraucht, auch bei einem Fehlschlag.
- **Nur für Konten ohne aktiven zweiten Faktor.** Sonst genügten Sitzung und Passwort, um einen
  fremden Passkey neben TOTP zu hängen. Mehrere Passkeys je Konto, Umbenennen und Entfernen
  kommen mit einer Verwaltungsseite, die den vorhandenen Faktor verlangt; der letzte Faktor
  bleibt dort nie entfernbar.
- **Ersatzcodes** aus einer eigenen Tabelle (`cockpit.ersatzcode`, nur Argon2id-Hash, einmal
  gültig): die Better-Auth-Codes gibt es nur bei aktivem TOTP (gemessen:
  `TWO_FACTOR_NOT_ENABLED`). Sie einzulösen geschieht bei der Anmeldung (COPI-27); die Entsperrung bei Verlust aller
  Faktoren ist COPI-28.
- **Browser-Skript:** `assets/js/passkey.js`, vom Cockpit selbst unter
  `/zwei-faktor/passkey/skript.js` ausgeliefert (hinter dem Tor, kein zusätzliches Paket; für die
  Anmeldung dieselbe Datei unter `/anmelden/passkey/skript.js`). Ohne
  JavaScript oder ohne WebAuthn bleibt das Passkey-Formular verborgen; TOTP funktioniert weiter.
  Das Image bringt den Ordner `assets` mit, fehlt er, startet die Anwendung nicht.

Von Hand ausprobieren, ohne Gerät: in Chrome die Entwicklerwerkzeuge öffnen, den Tab
„WebAuthn" wählen, „Enable virtual authenticator environment" einschalten und einen
Authenticator mit „Supports user verification" anlegen (Protokoll `ctap2`, Transport
`internal`, „Supports resident keys" an).

### Anmeldung mit Passkey

Nach dem Passwort gibt es einen **Anmeldevorgang ohne Sitzung** (`cockpit.anmeldevorgang`), sobald
das Konto **irgendeinen** aktiven zweiten Faktor hat. Auf der Codeseite `/anmelden/code` stehen
dann Passkey (wenn das Konto einen hat), TOTP-Code und Ersatzcode zur Wahl. Eine Sitzung entsteht
erst nach dem erfolgreichen zweiten Schritt; zwischen den Schritten gibt es nirgends eine.

- **Der zweite Schritt hängt an `zweiter_faktor_aktiv`, nicht nur an `twoFactorRedirect`.** Ein
  Konto nur mit Passkey bekommt von Better Auth nach dem Passwort trotzdem eine Sitzung angelegt;
  die Anwendung beendet sie selbst, bevor der Browser sie sieht (`signOut`), und legt den
  Anmeldevorgang an. Ein Konto mit TOTP behält den `two_factor`-Cookie von Better Auth.
- **Ablauf des Passkeys:** `POST /anmelden/passkey/optionen` (die Challenge steht in der Zeile des
  Vorgangs, Migration `0013`), das Gerät signiert, `POST /anmelden/passkey/pruefen` prüft. Die
  Challenge ist **einmal** verbrauchbar (auch bei einem Fehlschlag), fünf Minuten gültig und an den
  Vorgang gebunden. Der Passkey muss zum Konto des Vorgangs gehören; Herkunft, rpID und
  Benutzerprüfung wie bei der Einrichtung.
- **Signaturzähler:** Er muss steigen. Ein zurückgegangener oder gleicher Zähler wird abgelehnt und
  als `anmeldung_fehlgeschlagen` mit `schritt: passkey_zaehler` protokolliert — möglicherweise ein
  kopierter Passkey. Der Vergleich ist eine einzige Datenbankanweisung (atomar). Ein Gerät ohne
  Zähler (synchronisierte Passkeys liefern immer 0) bleibt zulässig: 0 gespeichert, 0 geliefert.
  Die Bibliothek vergleicht den Zähler nicht selbst, damit der Fall protokolliert werden kann.
- **Ratenbegrenzung:** derselbe Zähler `code-konto` für Passkey, TOTP und Ersatzcode: fünf
  Fehlversuche in 15 Minuten je Konto, dieselbe neutrale Meldung („Der Code stimmt nicht."), erst
  reservieren, dann prüfen. Optionen zu holen zählt nicht, jeder Prüfversuch schon; eine Eingabe von
  falscher Form (kein JSON, leer) verbraucht kein Budget.
- **Ersatzcode:** für ein Konto mit Passkey aus `cockpit.ersatzcode`, jeder Code einmal, das
  Verbrauchen eine einzige bedingte Anweisung. Die Better-Auth-Codes eines TOTP-Kontos gelten
  unverändert.
- **Protokoll:** Erfolg `anmeldung_erfolgreich` mit `schritt: code`, `faktor: passkey`; Fehlschlag
  `anmeldung_fehlgeschlagen` mit `faktor: passkey`. Nie eine Kennung des Geräts.
- **Die Sitzung nach dem Passkey** legt ein nur-serverseitiger Endpunkt an
  (`src/auth/sitzung-anlegen.ts`, `createAuthEndpoint.serverOnly`, so definiert Better Auth auch
  `generateTOTP`): Better Auths eigene Bausteine, derselbe Cookie und dieselben Attribute wie bei
  jeder Sitzung. Er ist über HTTP nicht erreichbar (gemessen: 404, auch über Better Auths eigenen
  Router), die Liste unter `/api/auth` bleibt unverändert. **Er legt für jedes Konto ohne weitere
  Prüfung eine Sitzung an;** deshalb darf ihn nur `routes/anmelden.ts` aufrufen, nach einem
  geprüften Nachweis (`test/sitzung-anlegen.test.ts` prüft das per Quelltext-Scan).
- **Ohne JavaScript** bleibt das Passkey-Formular verborgen; TOTP und Ersatzcode funktionieren.
  Nicht Teil: Anmeldung ohne Passwort, Conditional UI/Autofill. Die Verwaltung folgt im nächsten
  Abschnitt.

### Zweite Faktoren verwalten (`/sicherheit`)

„Anmeldung & Sicherheit" (COPI-94), erreichbar über den Abschnitt oben in den Einstellungen, für
jede Rolle (es ist das eigene Konto): die Passkeys mit Name und Datum, die Authenticator-App, die
Zahl offener Ersatzcodes und die letzten Änderungen aus dem Protokoll. Von dort: einen weiteren
Passkey auf diesem Gerät anlegen (etwa am iPhone neben dem iMac), die App einrichten oder
entfernen, einen Passkey entfernen, zehn neue Ersatzcodes erzeugen.

- **Frische Bestätigung vor jeder Änderung**, durch einen Faktor, den das Konto schon hat: Passkey,
  Code der App oder Ersatzcode — **nie das Passwort allein**. Ein signiertes Cookie
  (`__Host-faktor-bestaetigt`, HMAC über Sitzung, Konto und Faktor, `SameSite=Strict`) gilt zehn
  Minuten und nur für diese Sitzung (`src/auth/faktor-bestaetigung.ts`). Seiten ohne Bestätigung
  führen zu `/sicherheit/bestaetigen` und danach zurück; Formulare ohne sie ändern nichts.
- **Fehlversuche** zählen auf `code-konto`, dasselbe Budget wie der Codeschritt der Anmeldung (Better
  Auth begrenzt die TOTP-Prüfung mit Sitzung nicht). Jedes Formular verlangt die eigene Herkunft.
- **Am iPhone mit einem iMac-Passkey:** dort mit Passwort und Ersatzcode anmelden, mit einem
  weiteren Ersatzcode bestätigen, Passkey anlegen. Ein Passkey vom Mac lässt sich am Telefon nicht
  per QR-Code verwenden (das geht nur vom Telefon aus); ein synchronisierter (iCloud-Schlüsselbund)
  steht dort ohnehin bereit.
- **Nie der letzte Faktor:** Passkeys und eine geprüfte App zählen, Ersatzcodes nicht. Gezählt und
  entfernt wird in einer Transaktion nach einer Sperre auf das Konto (`src/auth/faktoren.ts`).
- **Nie löschen:** Passkey und App gehen über den Trigger aus `0025` ohne Geheimnis ins
  `zugangsmittel_archiv`, wer entfernt hat, steht im Protokoll. Ersatzcodes werden entwertet
  (`entwertet_am`, Migration `0042`), nicht gelöscht.
- **Ersatzcodes in einer Tabelle:** „Neu erzeugen" entwertet alle bisherigen, auch die der App
  (Better Auth; nur-serverseitiger Endpunkt `src/auth/app-ersatzcodes.ts`). Beim Einrichten der App
  neben einem Passkey entstehen keine sichtbaren neuen Codes; die bisherigen gelten weiter.
- **Protokoll:** `faktor_bestaetigt`, `zweiter_faktor_hinzugefuegt`, `zweiter_faktor_entfernt`,
  `ersatzcodes_erneuert` (jeweils mit `faktor`, nie der Gerätename). **Hinweis-Mail** an die eigene
  Adresse nach jeder Änderung, ohne Link und ohne Code.
- `/zwei-faktor` bleibt die Einrichtung für Konten **ohne** Faktor: mit aktivem Faktor leitet sie auch
  beim Absenden um (vorher ließ sich dort mit Sitzung und Passwort eine App neben einen Passkey hängen).

### Ratenbegrenzung

Die Anmeldung zählt Fehlversuche **selbst**, in der Tabelle
`cockpit.anmeldeversuch` (Migration `0005_anmeldeversuch`):

| Schritt | Kennung | Grenze | Folge |
| --- | --- | --- | --- |
| Passwort | normalisierte E-Mail-Adresse, auch unbekannte | 5 in 15 min | 15 min Sperre |
| Passwort | Client-IP | 20 in 15 min | 15 min Sperre |
| Code | Konto | 5 in 15 min | 15 min Sperre |

Gespeichert wird nur der SHA-256-Hash der Kennung; die Tabelle sammelt also
keine Adressen. Gezählt wird ausdrücklich auch für Adressen ohne Konto — eine
Sperre, die nur bei existierenden Konten greift, wäre selbst die Auskunft
„dieses Konto gibt es". **Bewusst akzeptierter Preis:** wer eine Adresse kennt,
kann das zugehörige Konto 15 Minuten aussperren; laufende Sitzungen bleiben
davon unberührt.

**Reservieren, dann prüfen:** Ein Versuch wird in einer einzelnen atomaren
Anweisung gezählt, **bevor** Passwort oder Code geprüft werden, und die Prüfung
läuft nur innerhalb der Grenze. Andersherum — lesen, prüfen, dann zählen —
liefen gleichzeitige Anfragen gemeinsam durch, weil alle denselben Stand lesen,
bevor der erste Fehlversuch gezählt ist (gemessen: 40 von 40 Passwortprüfungen
statt 5). Eine erfolgreiche Anmeldung löscht den Zähler je Adresse bzw. Konto
und schreibt die Reservierung je IP wieder gut, damit rechtmäßige Anmeldungen
das IP-Budget des Büros nicht verbrauchen.

Warum nicht die Ratenbegrenzung von Better Auth: sie hängt im Router-Haken und
greift damit nur für Anfragen über `auth.handler`, nicht für die direkten
`auth.api.*`-Aufrufe der Anmeldeseite; sie ist von sich aus nur in Produktion
aktiv; sie hält ihre Zähler im Arbeitsspeicher und verliert sie bei jedem
Neustart; und sie kennt nur Burst-Regeln über wenige Sekunden. Gemessen in
`test/better-auth-ratenbegrenzung.test.ts`.

### Client-IP hinter dem Proxy

Der Cockpit-Dienst hat in `docker/compose.fragment.yaml` **keinen**
`ports`-Eintrag und ist nur über Caddy erreichbar. Caddy setzt
`X-Forwarded-For` selbst. Gemessen mit Caddy 2.11.4 und einem einfachen
`reverse_proxy` (wie im Fragment): ein vom Client mitgeschickter Wert wird
**ersetzt**, beim Cockpit kommt nur die Adresse der Gegenstelle an. Würde Caddy
einmal mit `trusted_proxies` betrieben, hängte es die Adresse **rechts** an.
Vertrauenswürdig ist deshalb in beiden Fällen genau der rechte Eintrag, alles
links davon hätte der Client geschrieben. Genau das wertet
`src/auth/client-ip.ts` aus; Fastifys `trustProxy` bleibt bewusst aus (es würde
den linken, also gewählten Wert liefern). Dieselbe Adresse bekommt Better Auth
über `advanced.ipAddress.ipAddressHeaders`, damit auch `session.ipAddress`
stimmt.

Ohne Proxy davor (direkt exponiert, kein vorgesehener Betriebszustand) kann ein
Client sich mit selbst gesetztem `X-Forwarded-For` beliebige IP-Kennungen
verschaffen; der Zähler je Adresse greift davon unabhängig weiter.

Formulare der Anmeldung prüfen zusätzlich die **Herkunft** (`Origin`/`Referer`
gegen `Host`). `SameSite=Lax` schützt nur Anfragen, die einen vorhandenen
Cookie brauchen — die Anmeldung braucht keinen, eine fremde Seite könnte sonst
jemanden unbemerkt in ein fremdes Konto setzen.

### Token stehen nicht im Log

`/erststart/<token>`, `/einladung/<token>` und `/zugang-wiederherstellen/<token>` tragen ein
Einmal-Token im Pfad, und Fastify schreibt die Adresse jeder Anfrage in den Log. Wer ihn liest —
auf dem Server, in einem Log-Sammler, in einem Support-Ausschnitt —, hätte sonst ein gültiges
Token (Erststart 24 Stunden, sonst 3). Deshalb geht die Adresse nur maskiert hinein
(`src/server/logging.ts`): nach dem Präfix steht `<token>`, auch bei anderer Schreibweise (Groß-/
Kleinschreibung, Prozent-Kodierung, doppelte Schrägstriche, `..`) und samt Abfrage. Das galt bis
COPI-28 für Erststart und Einladung **nicht**; es wurde beim Bau der Wiederherstellung gefunden und
für alle drei behoben. Passwörter stehen nie im Log: Fastify loggt keine Rümpfe, die Routen loggen nur
Meldungen. Tests prüfen den aufgefangenen Log der echten Anwendung (`test/logging.test.ts`,
`test/entsperrung-datenbank.test.ts`).

## E2: was erreichbar ist

Das zentrale Tor (`src/auth/zwei-faktor-tor.ts`) entscheidet vor jedem Handler, und zwar nach
drei Zuständen: **anonym**, **Sitzung ohne aktiven zweiten Faktor**, **Sitzung mit aktivem zweitem
Faktor**. Die Tabelle nennt für jede Route der Anwendung, was in jedem Zustand geschieht.
`erreichbar` heißt: die Anfrage erreicht den Handler; `→` ist die Umleitung (`303`) des Tors;
`404 (neutral)` die eine neutrale Seite („Diese Seite gibt es nicht."), die weder verrät, dass es die
Route gibt, noch, warum sie abweist; `404` die von Fastify für einen Pfad, den es nicht gibt;
`401 (Bearer-Token nötig)` die Agenten-API (siehe „Agenten-API"): das Tor lässt `/intern` ohne Sitzung durch,
die Route verlangt ein Token — in jedem der drei Zustände dieselbe Antwort.

Die Tabelle wird **geprüft, nicht nur behauptet** (COPI-29):

- `test/routen-tor-datenbank.test.ts` sammelt über Fastifys `onRoute` **jede Route** ein, die die
  fertige Anwendung kennt, und fragt sie in allen drei Zuständen mit echten Sitzungen an. Ein Haken
  beantwortet die Anfrage mit einer Marke, wenn sie den Handler erreicht, und verhindert, dass er
  läuft: so zeigt sich, was das Tor tut und was die Route.
- **Eine neue Route muss sich einordnen.** Steht sie nicht in `test/routen-kategorien.ts`, wird der
  Test rot; die Person, die sie ergänzt, entscheidet damit, ob sie für Anonyme, für Konten ohne Faktor
  oder nur mit Faktor erreichbar ist. Ebenso ein Eintrag, den es nicht mehr gibt. Die Erwartung dort
  ist unabhängig von der Weiche geschrieben (Literale, nicht `torEntscheidung`).
- `test/routen-readme.test.ts` vergleicht diese Tabelle Zeichen für Zeichen mit der aus den Daten:
  ändert sich das Tor oder eine Route, muss das Handbuch mit.

Zwei Dinge fallen an der Tabelle auf. Die Freigaben sind Präfixe: ein unbekannter Pfad unter
`/anmelden/…` (für Anonyme) oder unter `/erststart`, `/gesund/…`, `/abmelden/…` (in jedem Zustand)
erreicht das Tor als freigegeben und bekommt Fastifys `404`, nicht die Umleitung. Es öffnet sich damit
nichts, aber die Antwort unterscheidet sich von der für einen Pfad ohne Präfix. Und
`/einladung` (das Formular) ist für Anonyme neutral `404` statt einer Umleitung (Vertrag aus COPI-11).
HEAD verhält sich wie GET.

<!-- e2-routen:start -->
| Route | anonym | Sitzung ohne zweiten Faktor | Sitzung mit zweitem Faktor |
| --- | --- | --- | --- |
| `GET /gesund` | erreichbar | erreichbar | erreichbar |
| `GET /assets/:datei` | erreichbar | erreichbar | erreichbar |
| `GET /manifest.webmanifest` | erreichbar | erreichbar | erreichbar |
| `GET /sw.js` | erreichbar | erreichbar | erreichbar |
| `GET /icons/:datei` | erreichbar | erreichbar | erreichbar |
| `GET /favicon.ico` | erreichbar | erreichbar | erreichbar |
| `GET /pwa.js` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /push/abo` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /push/abmelden` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /push/geraete/:id/entfernen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /push/test` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /agenten` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /agenten/:schluessel` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /benutzer` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /benutzer/:id` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /benutzer/:id/aendern` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /benutzer/:id/bestaetigen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /zeitplan` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /module` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /module/:kennung` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /module/:kennung/:id` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /module/:kennung/:id/uebernehmen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /module/:kennung/:id/zurueckgeben` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /module/:kennung/:id/freigeben` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /module/:kennung/:id/freigabe-zurueckziehen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /module/:kennung/:id/anhang/:anhang` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /module/:kennung/:id/anhang/:anhang` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /module/:kennung/:id/anhang/:anhang/bild` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /module/:kennung/:id/entscheiden` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /module/:kennung/:id/entscheidung-zuruecknehmen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /einstellungen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /einstellungen/update` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /einstellungen/update/bestaetigen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /einstellungen/update/zurueckziehen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /einstellungen/modul-update` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /einstellungen/modul-update/bestaetigen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /einstellungen/app-symbol/skript.js` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /einstellungen/app-symbol` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /einstellungen/app-symbol/zuruecksetzen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /einstellungen/betreuer-zugriff` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /einstellungen/freigabe` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /sicherheit` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /sicherheit/bestaetigen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/bestaetigen/code` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/bestaetigen/passkey/optionen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/bestaetigen/passkey` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /sicherheit/skript.js` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /sicherheit/passkey` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/passkey/optionen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/passkey/pruefen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /sicherheit/passkey/:id/entfernen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/passkey/:id/entfernen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /sicherheit/totp/entfernen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/totp/entfernen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /sicherheit/totp` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/totp` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/totp/pruefen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /sicherheit/ersatzcodes` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /sicherheit/ersatzcodes` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /darstellung` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /mehr` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /meldungen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /chat` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /chat` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /chat/team` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /chat/team` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /chat/ereignisse` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /chat/team/ereignisse` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /chat/skript.js` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /chat/postfach/:kennung` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /posteingang` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `POST /posteingang/gelesen` | → `/anmelden` | → `/zwei-faktor` | erreichbar |
| `GET /anmelden` | erreichbar | → `/zwei-faktor` | erreichbar |
| `POST /anmelden` | erreichbar | → `/zwei-faktor` | erreichbar |
| `GET /anmelden/code` | erreichbar | → `/zwei-faktor` | erreichbar |
| `POST /anmelden/code` | erreichbar | → `/zwei-faktor` | erreichbar |
| `GET /anmelden/passkey/skript.js` | erreichbar | → `/zwei-faktor` | erreichbar |
| `POST /anmelden/passkey/optionen` | erreichbar | → `/zwei-faktor` | erreichbar |
| `POST /anmelden/passkey/pruefen` | erreichbar | → `/zwei-faktor` | erreichbar |
| `POST /abmelden` | erreichbar | erreichbar | erreichbar |
| `GET /erststart/:token` | erreichbar | erreichbar | erreichbar |
| `POST /erststart/:token` | erreichbar | erreichbar | erreichbar |
| `GET /einladung/:token` | erreichbar | → `/zwei-faktor` | erreichbar |
| `POST /einladung/:token` | erreichbar | → `/zwei-faktor` | erreichbar |
| `GET /zugang-wiederherstellen/:token` | erreichbar | → `/zwei-faktor` | erreichbar |
| `POST /zugang-wiederherstellen/:token` | erreichbar | → `/zwei-faktor` | erreichbar |
| `GET /email-bestaetigen/:token` | erreichbar | → `/zwei-faktor` | erreichbar |
| `POST /email-bestaetigen/:token` | erreichbar | → `/zwei-faktor` | erreichbar |
| `GET /einladung` | 404 (neutral) | → `/zwei-faktor` | erreichbar |
| `POST /einladung` | 404 (neutral) | → `/zwei-faktor` | erreichbar |
| `GET /zwei-faktor` | → `/anmelden` | erreichbar | erreichbar |
| `POST /zwei-faktor/einrichten` | → `/anmelden` | erreichbar | erreichbar |
| `POST /zwei-faktor/pruefen` | → `/anmelden` | erreichbar | erreichbar |
| `GET /zwei-faktor/passkey/skript.js` | → `/anmelden` | erreichbar | erreichbar |
| `POST /zwei-faktor/passkey/optionen` | → `/anmelden` | erreichbar | erreichbar |
| `POST /zwei-faktor/passkey/pruefen` | → `/anmelden` | erreichbar | erreichbar |
| `GET /intern/ping` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/befund` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `PUT /intern/agenten` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/eingriffe` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/eingriffe/:id` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/eingriffe/:id/status` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/chat/antwort` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/chat/agenten` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/agenten/ereignis` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/zustand` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/chat/verbrauch` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/vorgaenge/sperre` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/vorgaenge/freigabe` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/vorgaenge/entscheidungen` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/verbrauch` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/verbrauch/tickets` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/wechselkurs` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/pipeline/jobs` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/pipeline/jobs` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/pipeline/jobs/:id` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/pipeline/freigaben` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/pipeline/jobs/:id/freigabe-erledigt` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /intern/pipeline/aufraeumen` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `GET /intern/pipeline/verbrauch` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| `POST /pipeline/claim` | 401 (Signatur nötig) | 401 (Signatur nötig) | 401 (Signatur nötig) |
| `POST /pipeline/heartbeat` | 401 (Signatur nötig) | 401 (Signatur nötig) | 401 (Signatur nötig) |
| `POST /pipeline/event` | 401 (Signatur nötig) | 401 (Signatur nötig) | 401 (Signatur nötig) |
| `POST /pipeline/complete` | 401 (Signatur nötig) | 401 (Signatur nötig) | 401 (Signatur nötig) |
| `GET`/`POST` `/api/auth/get-session` | 404 (neutral) | erreichbar | erreichbar |
| `GET`/`POST` `/api/auth/sign-out` | 404 (neutral) | erreichbar | erreichbar |
| `GET`/`POST` jeder andere Pfad unter `/api/auth` | 404 (neutral) | 404 (neutral) | 404 (neutral) |
| jeder Pfad, den es nicht gibt | → `/anmelden` | → `/zwei-faktor` | 404 |
| jeder Pfad, den es nicht gibt, unter `/anmelden/…` | 404 | → `/zwei-faktor` | 404 |
| jeder Pfad, den es nicht gibt, unter `/erststart`, `/gesund/…`, `/abmelden/…`, `/assets` | 404 | 404 | 404 |
| jeder Pfad, den es nicht gibt, unter `/intern` | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) | 401 (Bearer-Token nötig) |
| jeder Pfad, den es nicht gibt, unter `/pipeline` | 401 (Signatur nötig) | 401 (Signatur nötig) | 401 (Signatur nötig) |
<!-- e2-routen:ende -->

## Server-Kommando (Epic E2)

Für alles, was nicht über die Oberfläche gehen darf, gibt es ein Kommando auf dem
Server. Die Vertrauensgrenze ist der **Serverzugang**: wer `docker compose exec`
ausführen kann, darf es, es gibt keine eigene Anmeldung — und das öffentlich
erreichbare Cockpit kennt diese Befehle nicht (Architektur-Vorschlag 13.2).

```bash
docker compose exec cockpit node dist/cli/index.js <befehl> [optionen]
npm run cli -- <befehl> [optionen]        # lokal, mit geladener .env
```

| Befehl | Zweck |
| --- | --- |
| `erststart` | neues Erststart-Token (entwertet offene), **nur solange noch kein Benutzer existiert** |
| `einladung --email <adresse> --rolle <betriebs_admin\|betrieb_mitarbeiter>` | Einladung **ohne Mail**, für Kunden ohne Mail oder mit heikler Adresse; der Link kommt auf stdout |
| `betreuer-uebergeben --an <adresse> [--bisheriger-wird <betriebs_admin\|betrieb_mitarbeiter>]` | Betreuer-Rolle an ein anderes Konto übergeben (siehe „Rollen") |
| `migrieren [--status \| --zurueck --bestaetigt]` | Schema anlegen und nachziehen (siehe „Schema und Migrationen"); **mit `docker compose run --rm`**, nicht `exec`, weil das Cockpit ohne Schema nicht startet |
| `entsperren --konto <adresse>` | Zugang bei **verlorenem zweitem Faktor** wiederherstellen (siehe „Zweiter Faktor verloren"); der Link kommt auf stdout |
| `api-token-erzeugen --name <name> --scope <recht> [--scope …]` | Zugang der **Agenten-API** anlegen (siehe „Agenten-API"); das Token kommt einmalig auf stdout |
| `api-token-auflisten` | alle Zugänge mit Nummer, Name, Rechten und Stand — nie ein Token |
| `api-token-widerrufen --id <nummer>` | einen Zugang sofort und endgültig widerrufen |
| `modul-einspielen [--herkunft <text>]` | Modul-Block (YAML) von stdin einspielen (siehe unten) |
| `module-auflisten` | die aktiven Module mit Kennung, Version, Zeitpunkt des Einspielens und Betreuer-Zugriff |
| `modul-freigabe --modul <kennung> --stufe <aus\|lesen\|entscheiden>` | Betreuer-Zugriff auf ein Fachmodul setzen, für Instanzen ohne Betriebs-Admin (COPI-134) |
| `verbrauch-kosten-neu` | die Kosten im KI-Verbrauchsprotokoll neu aus der Preistabelle rechnen (nach einem nachgetragenen oder berichtigten Preis, COPI-97). Seit Migration 0058 rechnet ein Trigger auf cockpit.preis automatisch nach; das Kommando ist nur noch für den Notfall. |

`--hilfe` zeigt die Nutzung und braucht keine Datenbank. Die Befehle brauchen
`DATABASE_URL`; die Adresse in den Links kommt aus `COCKPIT_DOMAIN` (ohne sie
`http://localhost:PORT`), beides sind im Container schon die Werte der Anwendung.

**Ausgabe und Exit-Codes.** Ergebnis und Token stehen **nur auf stdout**, Fehler
und Hinweise auf stderr, nichts davon in einem Log: die Ausgabe von
`docker compose exec` landet nicht in `docker logs`. Der Link mit dem Token steht
genau einmal in der Ausgabe und wird nirgends gespeichert (in der Datenbank nur der
Hash). Exit-Codes: `0` erledigt, `1` abgelehnt oder fehlgeschlagen, `2` falsche
Bedienung (auch ein fehlendes `DATABASE_URL`).

**Modul-Einspielen (Epic E5, COPI-77).** `modul-einspielen` liest einen `cockpit:`-Block (YAML) von der
Standardeingabe — direkt oder unter dem Schlüssel `cockpit:`, wie er in einer Agent-Blueprint-YAML steht
(sodass sich der Abschnitt direkt aus so einer Datei herauspipen lässt). Geprüft wird streng, bevor sich
etwas ändert: erst das Schema (Kennung, Ansichtstyp — von den fünf der ADR sind `liste-detail` und `kennzahlen`
umgesetzt, jeder andere scheitert mit einer eigenen Meldung —, View-Name, Spalten, Rollen), dann der
Katalog (die genannte View muss im Schema `cockpit` existieren, die Pflichtspalten `id`/`titel`/`status`/
`aktualisiert_am` im richtigen Typ tragen und jede deklarierte Spalte besitzen; ist eine andere Rolle als
`betreuer` freigegeben, darf die View nirgends die Spalte `text_intern` verwenden). Eine erfolgreiche
Prüfung legt eine neue, sofort aktive Version in `cockpit.modul` an — Versionen zählen je Kennung ab 1,
und die bisher aktive Version wird in derselben Transaktion deaktiviert. Ein unveränderter Block (gleiche
Prüfsumme wie die aktive Version) meldet „unverändert" und legt nichts an. Scheitert irgendein Schritt,
bleibt die bisher aktive Version aktiv (Rollback). Die Registry lebt in der Datenbank, nicht im Image
(„Modulseiten sind deklariert, nicht programmiert") — ein Modul-Update kommt ohne Image-Wechsel und ohne
Neustart aus. `module-auflisten` zeigt, was gerade aktiv ist.

**Token verloren?**

- Erststart-Token: `erststart`. Ohne Kommando bleibt nur ein Neustart der
  Anwendung, der bei jedem Start ohne Benutzer ein neues Token ausgibt (lokal: den
  Dev-Server neu starten). Mit einem vorhandenen Benutzer lehnt `erststart` ab und
  erzeugt nichts: das Token wäre wertlos.
- Einladung ohne Mail: `einladung`, der Link gilt 3 Stunden und ist einmal
  einlösbar; eine frühere offene Einladung an dieselbe Adresse wird entwertet. Die
  Rolle `betreuer` ist nie einladbar.

**Betreuer wechseln.** Die neue Person braucht zuerst ein eigenes, aktiviertes Konto:

1. `einladung --email <adresse> --rolle betriebs_admin` (oder `betrieb_mitarbeiter`),
   die Person löst den Link ein und richtet ihren zweiten Faktor ein.
2. `betreuer-uebergeben --an <adresse>`. Der bisherige Betreuer wird Mitarbeiter,
   mit `--bisheriger-wird betriebs_admin` Betriebs-Admin. Danach gibt es genau
   einen Betreuer; lehnt das Kommando ab (Konto unbekannt, nicht aktiviert, schon
   Betreuer), bleibt alles unverändert.

**Zweiter Faktor verloren (Runbook).** Wer sein Gerät verliert und keine Ersatzcodes mehr hat,
kommt nicht mehr an. Es gibt bewusst **keinen E-Mail-Reset** (ADR Abschnitt 7): das Ende der
Kette ist der Betreuer am Server.

1. **Erst die Person prüfen**, nicht das Konto: Rückruf über einen bekannten Weg (Telefon,
   persönlich), nie über die Adresse des Kontos. Wer den Link bekommt, kann das Konto übernehmen.
2. `docker compose exec cockpit node dist/cli/index.js entsperren --konto <adresse>`
3. Das Kommando entfernt in **einer** Transaktion alle Faktoren (TOTP, Passkeys, Ersatzcodes,
   offene Anmeldungen), beendet alle Sitzungen, **entwertet das Passwort** und gibt einen Link aus:
   3 Stunden gültig, einmal einlösbar, in der Datenbank nur als Hash. Scheitert etwas, bleibt das
   Konto unverändert.
4. Den Link **persönlich übergeben**, nicht per Mail oder Chat: er steht nirgends sonst.
5. Die Person öffnet `/zugang-wiederherstellen/<token>`, setzt ein neues Passwort und richtet
   **sofort** einen neuen zweiten Faktor ein (Passkey oder TOTP). Die Einrichtung ist nicht
   optional: bis dahin hat das Konto keinen Faktor.
6. Wird der Link nicht innerhalb der 3 Stunden eingelöst, bleibt das Konto gesperrt (das alte
   Passwort ist ungültig). Dann noch einmal `entsperren`: der alte Link wird entwertet.

Warum das Passwort mit entwertet wird: Würde das Kommando nur den Faktor entfernen, könnte danach
**jeder, der das Passwort kennt,** ein eigenes Gerät binden (der Angriff aus COPI-17). Bei einem
neuen Konto begrenzt ihn der 72-h-Verfall; bei einem aktivierten Konto (`aktiviert_am` gesetzt,
bleibt beim Entsperren erhalten, das Konto verfällt also nicht) greift der Verfall bewusst nicht.
Das Passwort ist deshalb ein **gültiger Argon2id-Hash eines verworfenen Zufallswerts**, kein
Marker: ein Marker ließe die Anmeldung messbar schneller scheitern und verriete „dieses Konto ist
in Wiederherstellung".

- **Der Betreuer ist entsperrbar** (sonst sperrt ein verlorener Faktor die Instanz aus). Das Kommando
  warnt auf stderr, bricht nicht ab; sein Zugang ist bis zum Einlösen gesperrt.
- **Eine unbekannte Adresse** endet mit Exit-Code 1 und einer klaren Meldung: wer das Kommando
  ausführt, hat Serverzugang, eine Auskunft ist hier richtig.
- **Bekanntes Restrisiko:** Nach dem Einlösen hat das Konto bis zur Einrichtung des neuen Faktors
  keinen zweiten Faktor, und `aktiviert_am` verhindert den 72-h-Verfall. Bricht die Person die
  Einrichtung ab, gilt wieder „wer das neue Passwort kennt, kann ein Gerät binden". Dann erneut
  entsperren.
- **Nicht Teil:** Selbstbedienungs-Reset per E-Mail (bewusst nicht), Entsperren durch den
  Betriebs-Admin in der Oberfläche.
- Die Route `/zugang-wiederherstellen/<token>` liegt in der Anonym-Allowlist des Tors, nicht unter
  `/api/auth`; ohne Token, mit unbekanntem, abgelaufenem oder verbrauchtem Token antwortet sie mit
  derselben neutralen 404 wie die Einladung. Den Faktor-Zustand liest niemand aus der Spalte des
  Plugins: `cockpit.zweite_faktoren_entfernen` (Migration `0014`) ist die Gegenstelle zu
  `zweiter_faktor_aktiv` und die einzige Stelle, die weiß, was ein Faktor ist. Kommt ein weiterer Faktor
  hinzu, gehört er in beide.

Jeder Aufruf steht im Protokoll (Akteur `konsole`), nie mit Token oder Adresse.

## Rollen (Epic E2)

Jedes Konto hat genau **eine** Rolle:

| Rolle | Wer | Rechte | Wie sie entsteht |
| --- | --- | --- | --- |
| `betreuer` | Stefan bzw. wer die Betreuung übernimmt | vollständig, für das gesamte System; als einziger `rohbefunde_sehen` (Rohbefunde auf der Übersicht), `technik_sehen` (Kennung und Version der Agenten, Digests und Versionen des Cockpits) und `update_beantragen` (Update des Cockpits beantragen und zurückziehen, COPI-40) | nur durch den Erststart und die Übergabe |
| `betriebs_admin` | Betriebs-Admin beim Kunden | Mitarbeiter einladen; `benutzer_sehen` (Seite Benutzer, COPI-45); `benutzer_bearbeiten` an Mitarbeitern (COPI-46); `erscheinungsbild_aendern` (App-Symbol, COPI-101); als einziger `betreuer_zugriff_freigeben` (COPI-134) | Einladung durch den Betreuer oder Rollenwechsel durch ihn |
| `betrieb_mitarbeiter` | alle weiteren Zugänge | keine besonderen | Einladung durch Betreuer oder Betriebs-Admin |

Jedes Recht setzt **Sitzung und aktiven zweiten Faktor** voraus, auch beim
Betreuer: „vollständige Rechte" heißt nicht „ohne Tor". Die Regeln stehen an
einer Stelle, in reinen Funktionen (`hatRecht`, `einladbareRollen`,
`darfEinladen` in `src/auth/berechtigung.ts`). Der Betreuer besteht jede
Rechtsprüfung, auch jede künftige, per Konstruktion — dort gibt es keinen Eintrag
je Recht, den man vergessen könnte. Einzige Ausnahme: `betreuer_zugriff_freigeben`
(COPI-134) — ob der Betreuer Fachdaten sieht, entscheidet der Kunde. Die Rolle wird bei jeder Anfrage frisch aus
der Datenbank gelesen, eine Änderung wirkt also sofort, auch für laufende
Sitzungen.

**Wer wen einladen darf:**

| Einladender | darf einladen |
| --- | --- |
| `betreuer` | `betriebs_admin`, `betrieb_mitarbeiter` |
| `betriebs_admin` | `betrieb_mitarbeiter` (kleinstes Recht; die ADR schweigt dazu) |
| `betrieb_mitarbeiter` | niemanden |

Die Rolle `betreuer` ist **nie einladbar** und in der Oberfläche nicht vergebbar
(Architektur-Vorschlag 13.1) — sonst könnte sich der Betriebs-Admin selbst
befördern. Das Einladungsformular bietet nur an, was der Einladende vergeben
darf; ein anderer Wert, auch ein von Hand manipulierter, wird wie fehlende
Berechtigung mit der neutralen 404 beantwortet.

### Höchstens ein Betreuer, und er bleibt bestehen

Diese Regeln stehen in der Datenbank (Migration `0008_betreuer`), nicht nur im
Anwendungscode:

- **Nie zwei Betreuer.** Ein partieller Unique-Index (`user_hoechstens_ein_betreuer`)
  lässt keine zweite Zeile mit der Rolle zu, weder bei `INSERT` noch bei `UPDATE`.
- **Ein aktivierter Betreuer** (`aktiviert_am` gesetzt, also mit eingerichtetem
  zweitem Faktor) lässt sich weder löschen noch herabstufen noch „deaktivieren"
  (Trigger `user_betreuer_bleibt_bestehen`), außer in der Übergabe. Ein Erststart-Konto, das nie
  aktiviert wurde, ist nicht geschützt: der 72-h-Verfall entfernt es weiter, sonst könnte ein
  abgebrochener Erststart die Instanz dauerhaft blockieren.
- **Ein Wechsel ist die Ausnahme und geschieht bewusst.** `betreuerUebergeben`
  (`src/auth/betreuer.ts`) läuft in **einer Transaktion**: der bisherige Betreuer wird
  `betrieb_mitarbeiter` (auf Wunsch `betriebs_admin`), das Zielkonto wird Betreuer. Das
  Zielkonto muss existieren, aktiviert sein und einen aktiven zweiten Faktor haben.
  Gleichzeitige Übergaben laufen nacheinander, und zu keinem Zeitpunkt sind zwei Betreuer
  sichtbar. Ausgelöst wird sie nicht in der Oberfläche, sondern per Server-Kommando
  (`betreuer-uebergeben`, folgt mit COPI-24).

Die Sperre ist ein Schutz gegen Versehen, keine Zugriffskontrolle: sie erkennt eine
Änderung, die ausdrücklich als Übergabe gekennzeichnet ist, an der transaktionslokalen
Einstellung `cockpit.betreuer_aenderung`. Wer SQL auf dieser Datenbank ausführen kann,
kann sie setzen; das ist gewollt, denn sie ist der eine, bewusste Handgriff für Wartung und
Wiederherstellung:

```sql
BEGIN;
SELECT set_config('cockpit.betreuer_aenderung', 'ja', true);
-- Änderung am Betreuer-Konto; danach muss genau ein Betreuer existieren
COMMIT;
```

Die Testaufräumung nutzt denselben Griff (`kontenLoeschen` in `test/hilfen.ts`); ein
einfaches `DELETE FROM cockpit."user"` scheitert bei einem aktivierten Betreuer mit Absicht.

Beim Einspielen der Migration auf eine Instanz **mit genau einem Konto und ohne
Betreuer** wird dieses Konto zum Betreuer. Bei mehreren Konten rät die Migration nichts
zusammen, die Rolle wird von Hand vergeben.

## Einladungen (Epic E2)

Weitere Zugänge entstehen ausschließlich per E-Mail-Einladung; eine
Selbstregistrierung gibt es nicht. Das Formular unter `/einladung` erreicht
nur, wer **angemeldet** ist, einen **aktiven zweiten Faktor** besitzt und laut
„Rollen" jemanden einladen darf (Betreuer, Betriebs-Admin) — jeder andere
Zustand bekommt dieselbe neutrale 404-Antwort. Die Regel steht an einer Stelle
(`einladbareRollen`/`darfEinladen` in `src/auth/berechtigung.ts`) und wird vor
jeder Route dieses Bereichs erzwungen.

Die Einladung trägt ein Token aus 32 Byte Zufall und die **Rolle** des
Eingeladenen (Spalte `einladung.rolle`, nie `betreuer`); gespeichert wird vom Token
nur der SHA-256-Hash. Sie gilt **3 Stunden** (nicht 24 wie das Erststart-Token), lässt
sich genau einmal einlösen und wird durch eine neue Einladung an dieselbe
Adresse entwertet. Unter `/einladung/<token>` legt die eingeladene Person Name
und Passwort fest; das Konto entsteht mit der Rolle **aus der Einladung**, nie mit einem
Wert aus dem Formular. Ohne Rollenangabe gilt `betrieb_mitarbeiter`.
Anschließend greift dieselbe 2FA-Pflicht wie beim Erststart.

Rollen sind seit Migration `0003_rollen` ein Feld des Benutzers, unbekannte Werte lässt eine
CHECK-Bedingung nicht zu; `0008_betreuer` ergänzt `betreuer`.

## Protokoll (Epic E2)

Jede sicherheitsrelevante Änderung im Zugang hinterlässt einen Eintrag in
`cockpit.protokoll` (Migration `0009_protokoll`). Das ist die Grundlage für das
„revisionssichere Protokoll" der ADR (Seite „Meldungen", E3) und für
nachvollziehbare Wechsel und Entsperrungen. Angezeigt wird es hier noch nicht.

**Nur anhängen.** Trigger in der Datenbank lassen `UPDATE`, `DELETE` und
`TRUNCATE` scheitern (`protokoll_nur_anhaengen`), auch für die Anwendung und ohne
Ausnahme oder Markierung — anders als beim Betreuer: ein Protokoll, das sich
„bewusst" ändern ließe, wäre keines. Es gibt keinen Fremdschlüssel auf `user`,
ein verfallenes Konto lässt seine Einträge stehen. Geschrieben wird nur über
`protokollSchreiben` (`src/auth/protokoll.ts`); ein Test stellt sicher, dass keine
andere Datei die Tabelle anfasst.

**Was drinsteht:**

| Art | Wann | Akteur | Ziel | Einzelheiten |
| --- | --- | --- | --- | --- |
| `konto_angelegt` | Erststart oder Einladung eingelöst | `erststart`, `einladung` | das Konto | `weg`, `rolle` |
| `einladung_erzeugt` | Einladung angelegt | Konto des Einladenden | — | `rolle`, `einladung_id` |
| `einladung_eingeloest` | Einladung eingelöst | `einladung` | — | `einladung_id`, `rolle` |
| `anmeldung_erfolgreich` | Anmeldung vollständig (Code geprüft, bei einem Konto ohne Faktor das Passwort) | das Konto | — | `schritt`, `faktor` |
| `anmeldung_fehlgeschlagen` | falsches Passwort oder falscher Code bei bekanntem Konto | `system` | das Konto | `schritt` |
| `sperre_ausgeloest` | Ratenbegrenzung greift bei bekanntem Konto | `system` | das Konto | `sperre` |
| `zweiter_faktor_eingerichtet` | erste Aktivierung des Faktors | das Konto | — | `faktor` |
| `ersatzcode_verwendet` | Ersatzcode eingelöst | das Konto | — | — |
| `abmeldung` | Abmelden mit Sitzung | das Konto | — | — |
| `konto_verfallen` | 72-h-Verfall | `system` | das Konto | — |
| `betreuer_uebergeben` | Betreuerwechsel | `konsole` | neuer Betreuer | `von`, `an`, `bisherige_rolle` |
| `erststart_token_erzeugt` | neues Erststart-Token (Start ohne Benutzer, Server-Kommando) | `system`, `konsole` | — | — |
| `konto_entsperrt` | Server-Kommando `entsperren` oder „Zweiten Faktor zurücksetzen" (COPI-46): Faktoren entfernt, Sitzungen beendet, Passwort entwertet | `konsole` bzw. das handelnde Konto | das Konto | `rolle`, aus der Oberfläche dazu `weg: oberflaeche` |
| `name_geaendert` | Name eines Kontos geändert (COPI-46) | das handelnde Konto | das Konto | — |
| `rolle_geaendert` | Rolle eines Kontos geändert (COPI-46) | der Betreuer | das Konto | `von`, `an` |
| `konto_entfernt` | Konto entfernt (COPI-46) | das handelnde Konto | das Konto | `rolle` |
| `email_aenderung_beantragt` | neue E-Mail-Adresse beantragt (COPI-47); die Adresse steht nicht im Protokoll | das handelnde Konto | das Konto | — |
| `email_geaendert` | neue E-Mail-Adresse per Link bestätigt (COPI-47) | `email_bestaetigung` | das Konto | — |
| `zugang_wiederhergestellt` | Link aus `entsperren` eingelöst, neues Passwort gesetzt | `wiederherstellung` | das Konto | — |
| `api_token_erzeugt` | Server-Kommando `api-token-erzeugen` (Agenten-API) | `konsole` | `api_token_<nr>` | `token_id`, `name` |
| `api_token_widerrufen` | Server-Kommando `api-token-widerrufen` | `konsole` | `api_token_<nr>` | `token_id` |
| `api_zugriff_abgelehnt` | Agenten-API: widerrufener Zugang oder fehlendes Recht; je Zugang und Grund höchstens einmal je Stunde | `api_token_<nr>` | — | `token_id`, `grund` (`widerrufen`, `scope`), `scope` |
| `update_beantragt` | Update-Antrag gestellt (COPI-40); die Digests stehen unveränderlich in der Zeile des Antrags | das Konto des Betreuers | — | `eingriff_id` |
| `update_zurueckgezogen` | noch nicht freigegebener Antrag zurückgezogen (COPI-40) | das Konto des Betreuers | — | `eingriff_id` |
| `update_freigegeben` | der Admin-Agent meldet die Freigabe mit Ziel-Digest und Ziel-Version (COPI-41) | `api_token_<nr>` | — | `eingriff_id` |
| `update_gestartet` | der Admin-Agent beginnt das Update (`laeuft`) | `api_token_<nr>` | — | `eingriff_id` |
| `update_erledigt` | ein Cockpit mit Ziel-Digest und Ziel-Version hat sich beim Start gemeldet: der Erfolgsbeleg | `system` | — | `eingriff_id` |
| `update_fehlgeschlagen` | der Admin-Agent meldet das Update als gescheitert | `api_token_<nr>` | — | `eingriff_id` |
| `vorgang_uebernommen` | ein Vorgang eines Moduls übernommen (COPI-85); Modul und Vorgang stehen unveränderlich in der Zeile der Sperre | das handelnde Konto | — | `vorgang_sperre_id` |
| `vorgang_zurueckgegeben` | eine Übernahme zurückgegeben (COPI-85), auch durch Betriebs-Admin oder Betreuer | das handelnde Konto | wer übernommen hatte | `vorgang_sperre_id` |
| `erscheinungsbild_geaendert` | App-Symbol hochgeladen oder auf den Standard zurückgesetzt (COPI-101) | das handelnde Konto | — | `weg` (`hochgeladen`, `zurueckgesetzt`), `app_symbol_id` |

**Was bewusst nicht drinsteht.** Weil sich ein Eintrag nie mehr entfernen lässt
(auch nicht auf Antrag), gilt Datensparsamkeit schon beim Schreiben:

- **Keine Adresse, kein Token, kein Passwort, keine IP** — nur Kennungen und feste
  Begriffe. `pruefeEreignis` erzwingt das: Kennungen bis 40 Zeichen aus
  `A–Z a–z 0–9 _ -` (eine Konto-ID passt, eine Adresse, IP, ein Satz oder ein
  Token mit 43 Zeichen nicht) und eine feste Liste erlaubter Schlüssel.
- **Unbekannte Adressen hinterlassen nichts**, und Sperren einer IP oder einer
  unbekannten Adresse ebenso. Sonst gäbe das Protokoll Auskunft über Adressen, und
  ein Angreifer könnte die nicht abräumbare Tabelle mit erfundenen Adressen füllen.
  Während einer Sperre abgewiesene Versuche schreiben ebenfalls nichts: je Sperre
  ein Eintrag, je Konto höchstens einer je 15 Minuten.
- **Blockierte und abgewiesene Aufrufe** (fremde Herkunft, erfundenes Token, nicht
  erlaubte Rolle) schreiben nichts. Ebenso ein **fehlendes, kaputtes oder unbekanntes
  Token der Agenten-API**: der Endpunkt ist offen erreichbar und würde die nicht
  abräumbare Tabelle mit Rauschen füllen (siehe „Agenten-API").

**Transaktion.** Wo die Anwendung ohnehin eine eigene hat — Einladung anlegen und
einlösen, Konto-Verfall, Betreuerübergabe —, läuft der Eintrag in **derselben
Transaktion**: scheitert er, gilt die Änderung nicht (Tests erzwingen das mit
einem absichtlich scheiternden Eintrag). Wo Better Auth die Änderung macht —
Anmeldung, zweiter Faktor, Abmeldung, Konto anlegen —, folgt der Eintrag
unmittelbar danach; ein Fehler dabei wird laut geloggt (`Protokoll: Eintrag …
konnte nicht geschrieben werden`), bricht aber weder Anmeldung noch Abmeldung ab.
Bewusst akzeptiert: Ein Absturz genau zwischen Änderung und Eintrag lässt dort
einen Eintrag fehlen; eine gemeinsame Transaktion über die Bibliotheksgrenze ist
nicht erreichbar.

**Zeitunterschied gemessen.** Ein Eintrag beim falschen Passwort entsteht nur für
bekannte Konten. Gemessen (300 Anfragen je Seite, feste Uhr, Zähler geleert):
bekannt gegen unbekannt +1,3 bis +1,4 ms im Median, ohne tatsächliches Schreiben
+1,0 ms, bei einer Streuung (p10 bis p90) von mehreren Millisekunden und höchstens
fünf Versuchen je Adresse in 15 Minuten. Das Schreiben trägt rund 0,3 ms bei. Das
ist zu klein, um daraus ein Konto abzulesen, und als akzeptiert festgehalten.

**Eine neue Art** braucht drei Dinge: den Eintrag in `PROTOKOLL_ARTEN`, eine
Migration, die sie in `cockpit.protokoll_art` einträgt, und einen Test, der sie
„genau einmal" nachweist. Seit Migration `0019_protokoll_arten` (COPI-41) sind die
Arten eine Tabelle, auf die `protokoll.art` per Fremdschlüssel verweist (Name weiter
`protokoll_art_bekannt`) — vorher eine Liste in einer CHECK-Bedingung, die jede
Migration hin und zurück vollständig wiederholen musste. Jetzt heißt es:
`INSERT INTO cockpit.protokoll_art (art) VALUES ('neue_art') ON CONFLICT (art) DO NOTHING`,
zurück ein `DELETE` derselben Art, soweit kein Eintrag sie nutzt (das Protokoll lässt
sich nicht bereinigen; eine genutzte Art bleibt stehen). Ein Test vergleicht die
Tabelle mit `PROTOKOLL_ARTEN`.

**Testdatenbank.** Das Protokoll lässt sich nicht abräumen, die Testdatenbank
wächst also von Lauf zu Lauf; die Tests zählen deshalb nie „alle Einträge",
sondern die seit einer Marke (`protokollMarke`, `protokollSeit` in `test/hilfen.ts`).
Zurücksetzen: `DROP DATABASE cockpit_test`, der nächste Lauf legt sie neu an.

**Aufbewahrung** und ein Löschkonzept sind offen (ADR Abschnitt 10). Dass sich
Einträge nicht entfernen lassen, ist der Grund für die Datensparsamkeit oben.

Schema-Änderungen an den Better-Auth-Tabellen nicht von Hand pflegen, sondern
neu erzeugen und in eine Migration übernehmen:

```bash
npx auth@latest generate --config src/auth/auth.ts
```

## Struktur

```
src/{server,module,chat}                       Fachliche Bereiche: Seiten-Rahmen (server/navigation.ts, darstellung.ts: App-Rahmen und Dark Mode, COPI-43), Chat (chat, E4), Modul-Registry (module: Block, Katalogprüfung, Einspielen, E5, COPI-77)
src/status/                                     Zustandsbild: Befund und Herzschlag, Zustand einer Wache, Übersicht, Meldungen, Inventar der Agenten, Selbstmeldung und Versionen, Update-Antrag und Eingriffe samt Erfolgsbeleg (E3, COPI-36 bis 41, 43)
src/intern/                                     Agenten-API: Token, Zugänge, Prüfung und Zähler unter /intern; Befund, Inventar, Eingriffe (E3, COPI-35 bis 41)
src/auth/                                       Better Auth, Erststart, zentrales Tor, Anmeldung/Ratenbegrenzung, Rollen/Einladung (E2); Benutzer sehen und bearbeiten, Adressänderung, signierte Bestätigung (COPI-45 bis 47)
src/cli/                                        Server-Kommando: Erststart-Token, Einladung ohne Mail, Betreuerübergabe, Entsperren (E2), Migrieren (E1)
src/datenbank/                                  Migrations-Runner und Start-Prüfung (im Image, COPI-31)
src/mail/                                       SMTP-Versand und Mailinhalte: Einladung (E2), Adressänderung (COPI-47)
src/assets/                                     Asset-Build (Tailwind, Hash im Namen) und Manifest-Leser (COPI-30)
src/agenten/                                     Agenten-Detailseite und Ereignis-Strom (COPI-113, COPI-114)
src/pipeline/                                    Pipeline-Queue und -API für den Runner, HMAC-Signatur, Einstellungen je Repo (COPI-145)
src/posteingang/                                 Posteingang im Kopf, „Zu tun“ im Dashboard, Push bei Neuem (COPI-112, COPI-116, COPI-122)
src/pwa/                                         Symbole der installierbaren App: gezeichnet, eigenes PNG, Satz mit Hash (COPI-58, COPI-101)
src/verbrauch/                                   KI-Verbrauch: Protokoll, Summen je Ticket und Wechselkurs (COPI-97, COPI-98, COPI-99)
views/                                          Eta-Templates (SSR): layout.eta, partials/, eine Datei je Seite
assets/css/input.css                            Tailwind-Quelle mit allen Theme-Werten (Farben hell/dunkel, Schriften)
assets/gebaut/                                  Ergebnis von `npm run assets` (gitignoriert; im Image gebaut)
assets/js/                                       Browser-Skripte ohne Build: Passkey (E2), Chat, App und Service Worker (E4)
db/migrations/                                  Numerierte .up.sql/.down.sql-Paare
config/cockpit.default.yaml                     Default-Konfiguration, ENV überschreibt
dev                                              `./dev up|down|status|test|coverage|reset` — Dev-Stack lokal steuern (COPI-33)
docker/                                          Dockerfile, compose.dev.yaml, compose.fragment.yaml, Caddyfile.fragment
docs/agenten-api.md                              Der Vertrag der Agenten-API für agent-blueprints (Werkzeuge cockpit-api, cockpit-update; COPI-42)
docs/koordinator-api.md                          Der Vertrag für agent-koordinator: Webhook, Signatur, Antwort, Zustand, Verbrauch (COPI-61)
docs/installation.md                             Der Weg auf eine Kundeninstanz: Lese-Token, Datenbank, Start, Prüfungen, Update von Hand, Rückweg (COPI-49)
docs/pipeline-api.md                             Der Vertrag der Job-Queue der Entwicklungspipeline: Runner-API, Intake durch Koordinator, Server-Kommando (COPI-145)
docs/modul-vertrag.md                            Der Vertrag für Fachmodule: der `cockpit:`-Block und die SQL-View mit festen Spalten
.github/scripts/release-version.sh               Entscheidet, ob der Stand auf main ein Release wird (COPI-49)
.github/scripts/release-pr.sh                    Legt den Release-PR an oder aktualisiert ihn, nach jedem Merge auf main (COPI-236)
docs/adr/                                        Kleinere technische Einzelentscheidungen (ADR lebt primär in Confluence), etwa 0001: Digest aus der Umgebung
test/e2-abnahme-datenbank.test.ts, e3-…          Die Abnahmen der Epics als durchgehende Abläufe (COPI-29, COPI-42)
test/chat-ende-zu-ende-datenbank.test.ts         Die Abnahme von E4: Frage → Webhook → Antwort → SSE → Push → Lesestand → Tageslimit (COPI-61)
```

## Release

**Ein Release entsteht per Release-PR** (COPI-49). Die Version steht in `package.json`; ein PR hebt sie an, Stefan
gibt ihn frei, und erst der Merge veröffentlicht. Danach erledigt `.github/workflows/release.yaml` auf `main` den
Rest: Es prüft die Version, und ist ihr Tag noch nicht da, baut es das Image, pusht es nach GHCR und legt Tag und
GitHub-Release mit Notizen und Digest an. **Tags setzt niemand von Hand** — ein Tag ist das Ergebnis einer
Freigabe, nicht ihr Anfang. Steht die Version schon als Tag, tut der Workflow nichts; eine Version kleiner als das
jüngste Release lehnt er ab (`.github/scripts/release-version.sh`, geprüft in `test/release-version.test.ts`).

**Den Release-PR legt `.github/workflows/release-pr.yaml` von selbst an** (COPI-236, ADR COPI-211). Nach jedem Merge
auf `main` öffnet er `release: X.Y.Z` (immer ein Minor-Sprung gegenüber dem letzten Tag, die Version per `sed` in
`package.json` und beiden Stellen von `package-lock.json`) von `jacomeit-dev[bot]`, mit der Liste der gemergten PRs
seit dem letzten Tag. Ist schon ein Release-PR offen, aktualisiert er dessen Text und bringt den Zweig auf den Stand
von `main`, statt einen zweiten anzulegen. Stefan gibt den Release-PR frei und merged ihn; das ist der eine Klick, der
„live gehen“ freigibt. Weil der Release-PR per Merge-Commit gemergt wird, beginnt sein Head-Commit nicht mit
`release: `; deshalb bremst vor allem die Version: Steht in `package.json` eine Version ohne Tag, läuft ein Release,
und es entsteht kein weiterer PR (`.github/scripts/release-pr.sh`, geprüft in `test/release-pr.test.ts`). Hängt ein
Zweig `release/X.Y.Z` ohne offenen PR herum, bricht der Lauf mit dieser Meldung ab: den Zweig löschen.

Der Workflow arbeitet mit dem Installations-Token der App `jacomeit-dev`, nie mit dem `GITHUB_TOKEN`, sonst liefen die
Pflicht-Checks am Release-PR nicht. Als Repository-Secrets (Settings › Secrets and variables › Actions) braucht das
Cockpit-Repo:

| Secret | Inhalt |
| --- | --- |
| `JACOMEIT_DEV_CLIENT_ID` | Client-ID der App `jacomeit-dev` (beginnt mit `Iv`, nicht geheim) |
| `JACOMEIT_DEV_APP_PRIVATE_KEY` | der private Schlüssel der App, die ganze `.pem`-Datei |
| `COCKPIT_NACH_DEPLOY_TOKEN` | Header-Token für den Webhook „Nach Deploy“ von n8n „Cockpit-Befunde“ |

**Nach dem Release stößt `release.yaml` die Versions-Wache an:** Der letzte Schritt von `veroeffentlichen` ruft den
Webhook „Nach Deploy“ auf (`Authorization: Bearer` mit `COCKPIT_NACH_DEPLOY_TOKEN`). So steht „Verfügbar“ im Cockpit
sofort richtig und nicht erst um 06:20 am nächsten Morgen. Der Schritt läuft mit `continue-on-error`: Scheitert der
Aufruf, bleibt das Release grün, und die Zusammenfassung des Laufs nennt den Grund.

Versionen sind `X.Y.Z` ohne Zusatz: bis der Pilot FEWOTEST bestanden ist `0.x`, die mittlere Zahl für neue
Funktionen und Migrationen, die letzte für Fehlerbehebungen. Vorabversionen veröffentlicht der Workflow nicht.

Das Image trägt genau ein Tag, die Version — kein `latest`, kein `X.Y`: Kundeninstanzen ziehen SemVer+Digest, nie
ein bewegliches Tag (Architektur-Vorschlag Abschnitt 8/13.1). Version und Commit werden ins Image gebacken
(`COCKPIT_VERSION`, `COCKPIT_COMMIT`). Den Digest aus dem Release trägt man **zweimal** ins Compose-Fragment ein:
in die `image:`-Zeile und nach `COCKPIT_IMAGE_DIGEST` — derselbe Platzhalter `<DIGEST>` (COPI-39,
[`docs/adr/0001-digest-aus-der-umgebung.md`](adr/0001-digest-aus-der-umgebung.md)).

Seit COPI-86 gibt es das Image für **amd64 und arm64** (etwa ein Hetzner cax21). Beide bauen nativ auf ihrem eigenen
Runner (`ubuntu-24.04-arm` für arm64) und werden nur per Digest gepusht. Erst danach fasst der Workflow sie zu
einem Manifest mit dem Versions-Tag zusammen. Der Digest im Release ist der dieses Manifests: eine einzige Angabe
für beide Architekturen, Docker wählt beim Ziehen die passende. Scheitert einer der Builds, entsteht weder Manifest
noch Tag.

Das Paket in GHCR ist **privat**; jeder Kundenserver meldet sich mit einem eigenen Lese-Token an. Der ganze Weg
auf einen Server steht in [`docs/installation.md`](installation.md); `docker/compose.fragment.yaml` und
`docker/Caddyfile.fragment` sind die einzige Wahrheit für Dienstblock und Routing.

## Status

Grundgerüst aus Epic E1 (COPI-8). Auth-Grundlage aus E2 (COPI-10): Better Auth
mit Argon2id, Datenbank-Sitzungen, Erststart-Bootstrap und TOTP-Pflicht.
Rollenmodell, E-Mail-Einladung und Mailversand aus E2 (COPI-11). Anmeldung mit
zweitem Faktor, Sitzungspflicht und eigene Ratenbegrenzung aus E2 (COPI-13).
Betreuer-Rolle (höchstens einer, dauerhaft, übergebbar) aus E2 (COPI-22).
Protokoll der Sicherheitsereignisse (nur anhängen) aus E2 (COPI-23). Server-Kommando
und korrigierter Build-Pfad des Images aus E2 (COPI-24). „Zweiter Faktor aktiv" aus einer
Quelle, Vorbereitung der Passkeys, aus E2 (COPI-25). Passkey (WebAuthn) als zweiter
Faktor einrichten aus E2 (COPI-26), Anmeldung mit Passkey im zweiten Schritt aus E2 (COPI-27),
Entsperrung bei verlorenem zweitem Faktor per Server-Kommando aus E2 (COPI-28). E2-Abnahme
(Ende-zu-Ende-Ablauf und „jede Route ohne zweiten Faktor zu" über alle Routen) aus E2 (COPI-29). Layout-Grundlage aus E1 (COPI-30): Tailwind-Build
im Image, Basis-Layout, alle vorhandenen Seiten gestaltet. Beständiges Auth-Geheimnis in der Entwicklung
(COPI-32): TOTP-Konten und Sitzungen überstehen einen Neustart. Lokaler Dev-Stack aus einer Hand
(COPI-33): `./dev up` und `./dev down` starten und beenden Container, Migration, Assets und Server
samt Aufräumen; die Container starten nicht mehr von selbst mit Docker Desktop. Schema des Zustandsbilds aus E3
(COPI-34): `wache`, `befund`, `agent`, `instanz` und `eingriff` mit den Regeln der Update-Kette in der Datenbank.
Zugang der Agenten-API aus E3 (COPI-35): Bearer-Token je Zugang, angelegt und widerrufen per Server-Kommando, eine
benannte Ausnahme im zentralen Tor für `/intern`. Befund und Herzschlag aus E3 (COPI-36): `POST /intern/befund`
und die Zeitlogik, die eine ausbleibende Wache gelb werden lässt. Übersicht aus E3 (COPI-37): Klartext-Status und
Agentenkacheln, für Kunden nur aus kundensichtbaren Befunden, für den Betreuer mit Rohbefunden; dazu der optionale
Anzeigename einer Wache. Inventar und Seiten aus E3 (COPI-38): `PUT /intern/agenten` ersetzt das Inventar der Agenten
als Ganzes (alles oder nichts), die Seiten Agenten und Zeitplan zeigen es lesend; dazu eine Navigation mit Abmelden auf
den angemeldeten Seiten. Versionen aus E3 (COPI-39): das Cockpit meldet beim Start Version (gebacken) und Digest (aus
der Umgebung) nach `cockpit.instanz`; die Einstellungen zeigen dem Betreuer Digests und Versionen, allen anderen einen
Klartextsatz. App-Rahmen wie im Prototyp aus E3 (COPI-43): Sidebar bzw. Tab-Leiste, Instanzname, „Mehr", Dark Mode
ohne Skript, die Übersicht mit kompakten Kacheln und „Letzte Meldungen", die Seite Meldungen (Wechsel der Befunde,
Suche, Filter). Update-Antrag aus E3 (COPI-40): nur der Betreuer beantragt in den Einstellungen ein Update, mit
Bestätigungsschritt, strenger Digest-Prüfung und CSRF-Schutz; das Cockpit schreibt nur die Zeile `cockpit.eingriff` und
den Protokolleintrag, höchstens ein offener Antrag, zurückziehen bis zur Freigabe. Lebenszyklus der Eingriffe aus E3
(COPI-41): der Admin-Agent liest und schaltet über die Agenten-API (freigegeben mit Ziel-Version, läuft, fehlgeschlagen),
`erledigt` setzt nur das Cockpit selbst, wenn es sich mit Ziel-Digest und Ziel-Version meldet; `haengt` nach 15 Minuten;
dazu die Protokollarten als Tabelle statt als Liste in einer Bedingung. **E3-Abnahme (COPI-42): Epic E3 ist
abgeschlossen** — ein durchgehender Ablauf entlang der Epic-DoD (gestoppter Container als Kachel, ausbleibende Wache gelb,
Update-Antrag bis `erledigt` und bis zum Fehlschlag) und der Vertrag [`docs/agenten-api.md`](agenten-api.md) für
`agent-blueprints`. Nachträge zu E2: die Seite Benutzer (COPI-45), Konten bearbeiten — Name, Rolle, entfernen, zweiten
Faktor zurücksetzen, mit frischer Anmeldung und signierter Bestätigung (COPI-46) — und die E-Mail-Adresse ändern mit
Bestätigung per Link (COPI-47). **E4 (COPI-52 bis COPI-61):** der Chat mit Assistenten- und Team-Kanal, Koordinator
per signiertem Webhook und Agenten-API, Server-Sent Events, Tageslimit, installierbare App, Web Push und E-Mail-Zweitkanal,
dazu „nie löschen, nur markieren" für alle Nachweisdaten (COPI-62); Vertrag für `agent-koordinator` in
[`docs/koordinator-api.md`](koordinator-api.md). Den Nachweis auf echten Geräten führt FEWOTEST-69.
Modul-Registry aus E5 (COPI-77): `cockpit.modul` mit Versionierung und Unveränderlichkeit je Zeile, der geprüfte
`cockpit:`-Block (Schema für alle fünf Ansichtstypen, umgesetzt `liste-detail` und seit COPI-98 `kennzahlen`), die Katalogprüfung gegen
die Datenbank (View, Pflichtspalten, `text_intern` nur für den Betreuer) und das Server-Kommando `modul-einspielen`.
Die Modulseiten mit dem Ansichtstyp Liste+Detail (COPI-78) und der Vertrag für Fachmodule
[`docs/modul-vertrag.md`](modul-vertrag.md) (COPI-79); die übrigen drei Ansichtstypen und Eingriffe aus
Modulseiten sind offen.
