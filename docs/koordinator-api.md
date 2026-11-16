# Koordinator-Agent und Cockpit — der Vertrag

Stand: COPI-61 (Abschluss von Epic E4), 23.09.2026. Grundlage für die Rolle `agent-koordinator.yaml` im Repo
`agent-blueprints` (dort eigene PRs) und den Koordinator-Workflow in n8n. Dieses Dokument soll genügen, um den Agenten
zu bauen, ohne in den Code des Cockpits zu sehen. Weicht der Code davon ab, ist das ein Fehler — im Code oder hier;
`test/koordinator-vertrag.test.ts` und `test/chat-ende-zu-ende-datenbank.test.ts` halten beides zusammen.

Die Agenten-API allgemein — Zugang, Fehler, Begrenzung — steht in [`agenten-api.md`](agenten-api.md); hier steht der
ganze Weg einer Frage, und was davon der Koordinator tun muss. Architektur:
Betriebs-Cockpit (Architektur-Vorschlag),
Abschnitt 6 (Chat und Koordinator).

## Der Weg einer Frage

```text
Browser ──POST /chat──▶ Cockpit ──(1) Webhook, signiert──▶ n8n: Koordinator-Workflow
   ▲                       │  speichert die Frage,          │  quittiert sofort (2xx),
   │                       │  antwortet dem Browser sofort  │  dann läuft der Agent
   │                       │                                ▼
   │   (4) SSE + Push      ◀──(3) POST /intern/chat/antwort── Agentenlauf (liest ggf. (2) GET /intern/zustand)
   └───────────────────────┘
```

1. Ein Mensch schreibt im **Assistenten-Kanal** (`/chat`). Das Cockpit speichert die Frage, zählt sie aufs Tageslimit
   und ruft den Webhook des Koordinators. Es wartet **nur auf die Quittung** (höchstens 5 Sekunden), nie auf den
   Agentenlauf.
2. Der Agent liest, wenn er den Zustand der Instanz braucht, `GET /intern/zustand` — genau die Kundensicht.
3. Der Agent antwortet über `POST /intern/chat/antwort`, mit der `nachricht_id` aus dem Webhook. Je Frage genau eine
   Antwort.
4. Das Cockpit zeigt die Antwort im offenen Chat (Server-Sent Events), schickt Push an die Geräte der Fragenden und —
   wenn die Antwort `dringend` ist und ungelesen bleibt — nach der Frist eine E-Mail. Nichts davon muss der Agent tun.

Der **Team-Kanal** (`/chat/team`) geht nie an den Koordinator; dort schreiben nur Menschen.

## 1. Der Webhook: Cockpit → n8n

Konfiguriert in der Umgebung des Cockpits (`docs/installation.md`, Abschnitt 3):

| Variable | Bedeutung |
| --- | --- |
| `COCKPIT_KOORDINATOR_URL` | Adresse des Webhooks, `http(s)://…`, etwa `http://n8n:5678/webhook/koordinator` im Docker-Netz |
| `COCKPIT_KOORDINATOR_SECRET` | gemeinsames Geheimnis, mindestens 32 Zeichen, je Instanz eigen. Dasselbe prüft der Workflow |
| `COCKPIT_KOORDINATOR_FRIST` | Sekunden, bis der Chat „antwortet gerade nicht" zeigt (Standard 120) |

URL und Geheimnis gehören zusammen: nur eines von beiden hält den Start des Cockpits an. Ohne beide sagt der Chat,
dass kein Assistent angebunden ist, und nimmt im Assistenten-Kanal nichts an.

### Anfrage

`POST` an `COCKPIT_KOORDINATOR_URL`, keine Weiterleitungen (ein `3xx` gilt als Fehler).

| Kopfzeile | Inhalt |
| --- | --- |
| `content-type` | `application/json` |
| `x-cockpit-zeitpunkt` | Unix-Zeit in Sekunden, zu der das Cockpit signiert hat |
| `x-cockpit-signatur` | `sha256=<hex>`: HMAC-SHA256 mit dem Geheimnis über `<x-cockpit-zeitpunkt>.<rumpf>` |

Rumpf (genau diese Felder, in dieser Form):

```json
{"nachricht_id":17,"kanal":"assistent","benutzer":{"id":"k3Hq9ZtVbN2mXr7Lw4Pd8sYc1Ef6Gu0A","rolle":"betrieb_mitarbeiter","name":"Anna Berg"},"text":"Wer reist heute an?","zeitpunkt":"2026-09-23T08:15:00.000Z"}
```

| Feld | Bedeutung |
| --- | --- |
| `nachricht_id` | die Frage; genau diese Zahl geht mit der Antwort zurück |
| `kanal` | immer `assistent` (E5 bringt Vorgangs-Threads; dann kommt ein weiterer Wert dazu) |
| `benutzer.id` | Konto-ID der Fragenden, fest über die Lebensdauer des Kontos |
| `benutzer.rolle` | `betrieb_mitarbeiter`, `betriebs_admin` oder `betreuer` — für Ton und Tiefe der Antwort, **nie** als Berechtigung für etwas außerhalb des Cockpits |
| `benutzer.name` | Anzeigename oder `null` |
| `text` | die Frage, Klartext, höchstens 4000 Zeichen, Zeilenumbrüche als `\n` |
| `zeitpunkt` | wann die Frage gespeichert wurde, ISO-8601 in UTC |

Nie im Rumpf: Zugangsdaten, Sitzungen, Tokens, E-Mail-Adressen, der Verlauf. Der Verlauf früherer Fragen steht dem
Agenten (noch) nicht über die API zur Verfügung; braucht der Workflow Gesprächskontext, hält er ihn selbst je
`benutzer.id`.

### Prüfen im Workflow — Pflicht

Der Webhook ist aus dem Docker-Netz erreichbar und womöglich über Caddy auch von außen. Der Workflow nimmt eine Anfrage
nur an, wenn **beides** stimmt:

1. **Signatur:** `sha256=` + HMAC-SHA256(Geheimnis, `<x-cockpit-zeitpunkt>` + `.` + roher Rumpf) als Hex, verglichen
   in konstanter Zeit. Über den **rohen** Rumpf, wie er ankam — nicht über ein neu serialisiertes JSON.
2. **Frische:** `x-cockpit-zeitpunkt` liegt höchstens 5 Minuten neben der Uhr des Servers. Ältere Anfragen sind
   Wiederholungen und werden abgewiesen.

Sonst: `401`, nichts tun. Beispiel zum Nachrechnen, mit dem Geheimnis `beispiel-geheimnis-nur-fuer-die-doku-0123456789`,
dem Zeitpunkt `1790151300` und dem Rumpf oben:

```text
sha256=1fb21a0c954140348dcf5f47e463acde063201b333ea9b32de4df439fd0670fd
```

In Node (etwa im Code-Knoten von n8n):

```js
const { createHmac, timingSafeEqual } = require('crypto');
const erwartet = 'sha256=' + createHmac('sha256', geheimnis).update(`${zeitpunkt}.${roherRumpf}`).digest('hex');
const gueltig = erwartet.length === signatur.length && timingSafeEqual(Buffer.from(erwartet), Buffer.from(signatur));
const frisch = Math.abs(Date.now() / 1000 - Number(zeitpunkt)) <= 300;
```

Der Code-Knoten von n8n darf `crypto` nur laden, wenn die n8n-Instanz `NODE_FUNCTION_ALLOW_BUILTIN=crypto` in ihrer
Umgebung hat (bei aktivem Task-Runner in der Umgebung des Runners). Ohne diese Variable scheitert **jeder** Lauf mit
`Module 'crypto' is disallowed` — erst zur Laufzeit im Webhook, nicht beim Speichern des Workflows. Den Modulnamen
**ohne** `node:`-Präfix schreiben: n8n vergleicht ihn wörtlich, `require('node:crypto')` bleibt auch mit der Variable
gesperrt (geprüft auf n8n 2.39.4, FEWOTEST-71).

### Antwort des Webhooks

- **Sofort `2xx`**, bevor der Agent läuft (in n8n: Antwort über einen eigenen Knoten, siehe
  [Umsetzung in n8n](#umsetzung-in-n8n)). Den Rumpf liest das Cockpit nicht.
- Kommt binnen **5 Sekunden** kein `2xx` — Zeitlimit, Netzfehler oder anderer Status —, schreibt das Cockpit diese
  Meldung in den Verlauf; die Frage bleibt gespeichert und zählt aufs Tageslimit, das Cockpit **wiederholt nicht**:

  > „Der Assistent ist gerade nicht erreichbar. Ihre Nachricht ist gespeichert; bitte versuchen Sie es später noch einmal."

- Hat der Webhook quittiert, aber es kommt keine Antwort, zeigt der Chat nach `COCKPIT_KOORDINATOR_FRIST`, dass die
  Antwort ausbleibt. Eine spätere Antwort wird trotzdem angenommen.

## 2. Zustand lesen: `GET /intern/zustand`

Recht `zustand_lesen`. Genau die Kundensicht der Übersicht: nur Befunde mit `kundensichtbar`, nur deren Klartext, keine
Kennungen, keine Rohbefunde. Was der Kunde nicht sieht, kann der Koordinator nicht weitersagen (ADR 6). Form der
Antwort in [`agenten-api.md`](agenten-api.md#zustand-get-internzustand).

## 3. Antworten: `POST /intern/chat/antwort`

Recht `chat_antworten`, Rumpf höchstens 20 KiB, `content-type: application/json`, Bearer-Token in `authorization`.

```json
{ "nachricht_id": 17, "text": "Heute reisen 3 Gäste an.", "dringend": false }
```

| Feld | Pflicht | Regel |
| --- | --- | --- |
| `nachricht_id` | ja | die `nachricht_id` aus dem Webhook |
| `text` | ja | Klartext, höchstens 4000 Zeichen, nicht nur Leerraum. Das Cockpit zeigt ihn escaped, verlinkt nie, kennt kein Markdown — `**fett**` erscheint als `**fett**` |
| `dringend` | nein | Default `false`. Nur, wenn die Fragende handeln muss: dringend löst Push mit „Dringende Nachricht im Chat" aus und — nach der Frist ungelesen — den E-Mail-Zweitkanal |
| `agent` | nein | Kennung des Koordinators im Inventar (etwa `koordinator`, COPI-113). Bitte immer mitschicken: dann steht die Antwort auf seiner Detailseite |

Unbekannte Felder sind ein Fehler (`400`, `felder` nennt nur Feldnamen). Den Kanal bestimmt die Frage, nie der Agent.

| Status | Rumpf | Bedeutung | Was der Workflow tut |
| --- | --- | --- | --- |
| `201` | `{"id": 18, "nachricht_id": 17, "erstellt_am": "…"}` | gespeichert und zugestellt | fertig |
| `400` | `{"fehler": "ungueltige_anfrage", "felder": [...]}` | Rumpf passt nicht | nicht wiederholen; Workflow korrigieren |
| `401` | `{"fehler": "nicht_angemeldet"}` | Token fehlt, ist falsch oder widerrufen | nicht wiederholen; Stefan melden |
| `403` | `{"fehler": "nicht_erlaubt"}` | Token ohne `chat_antworten` | nicht wiederholen; Zugang prüfen |
| `404` | `{"fehler": "nicht_gefunden"}` | keine Frage eines Menschen im Assistenten-Kanal zu dieser ID | nicht wiederholen |
| `409` | `{"fehler": "schon_beantwortet"}` | auf diese Frage gibt es schon eine Antwort | nicht wiederholen; ein früherer Lauf war erfolgreich |
| `429`, `5xx`, Netzfehler | | Begrenzung oder Störung | mit Pause wiederholen (nach `Retry-After`); `409` beim Wiederholen heißt „kam schon an" |

Weil je Frage nur eine Antwort gilt, darf der Workflow nach einem Netzfehler **gefahrlos wiederholen**.

## 4. Verbrauch: `GET /intern/chat/verbrauch`

Recht `zustand_lesen`, für die **Budget-Wache des Admin-Agenten**, nicht für den Koordinator. Summen je Berliner
Kalendertag; Form in [`agenten-api.md`](agenten-api.md#verbrauch-des-chats-get-internchatverbrauch). Das Tageslimit
(`COCKPIT_CHAT_TAGESLIMIT`, Standard 50 je Konto) setzt das Cockpit selbst durch: am Limit wird nichts gespeichert und
nichts weitergeleitet — der Koordinator bekommt die Frage gar nicht erst.

## Zugänge

Zwei getrennte Zugänge, keiner teilt sich ein Token mit dem Admin-Agenten:

```bash
# Koordinator: antworten und den Zustand lesen
docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name koordinator \
  --scope chat_antworten --scope zustand_lesen
# Budget-Wache des Admin-Agenten: nur lesen
docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name budget-wache --scope zustand_lesen
```

Das Token erscheint einmal auf der Konsole und gehört als Credential in n8n bzw. ins Zugangsdatenblatt — nie in einen
Workflow-Export, ein Repo oder einen Log. Das Geheimnis des Webhooks (`COCKPIT_KOORDINATOR_SECRET`) ist etwas anderes
als dieses Token: Das Geheimnis beweist n8n, dass die Frage vom Cockpit kommt; das Token beweist dem Cockpit, dass die
Antwort vom Koordinator kommt.

## Umsetzung in n8n

Erprobt auf n8n 2.39.4 mit dem AI-Agent v3 (FEWOTEST-71, 27.09.2026). Der Vertrag oben gilt unabhängig davon; dieser
Abschnitt sammelt, was man in n8n sonst nur durch Ausprobieren findet.

**Aufbau des Workflows:**

```text
Webhook ──▶ Code: Signatur prüfen ──▶ IF gültig ──ja──▶ Respond 200 ──▶ AI Agent ──▶ Code: Rumpf bauen ──▶ HTTP: POST /intern/chat/antwort
                                               └─nein─▶ Respond 401
                                                          AI Agent ◀── Werkzeug zustand_lesen (HTTP Request Tool)
```

- **Webhook:** `POST`, Antwortmodus „Using 'Respond to Webhook' Node" (`responseMode: responseNode`), nicht „Immediately"
  — sonst kann der Workflow eine ungültige Anfrage nicht mehr mit `401` abweisen. Der Knoten „Respond 200" steht **vor**
  dem Agenten, damit das Cockpit seine Quittung binnen 5 Sekunden bekommt.
- **Raw Body:** In den Optionen des Webhooks „Raw Body" einschalten. Der rohe Rumpf kommt dann base64-kodiert als
  Binärfeld `data` an, nicht als `json.body`:

  ```js
  const roherRumpf = Buffer.from($input.first().binary.data.data, 'base64').toString('utf8');
  ```

  Ohne die Option gibt es nur das geparste JSON, und eine Signatur über neu serialisiertes JSON stimmt nicht zuverlässig.
- **Werkzeug `zustand_lesen`:** den normalen HTTP-Request-Knoten als Werkzeug nehmen, `n8n-nodes-base.httpRequestTool`
  (getestet mit typeVersion 4.2), `authentication: genericCredentialType`, `genericAuthType: httpHeaderAuth`, Credential
  „Header Auth" mit `Authorization: Bearer <Token koordinator>`. **Nicht** `@n8n/n8n-nodes-langchain.toolHttpRequest`:
  der hat nur `supplyData`, der AI-Agent v3 führt Werkzeuge aber als Knoten aus. Der Aufruf scheitert dann mit
  `has a "supplyData" method but no "execute" method` — und der Agent gibt diesen Fehler **als Antwort im Chat** aus.
  Er sieht dort aus wie eine inhaltliche Antwort und fällt nur im Execution-Log auf.
- **Antworten:** normaler HTTP-Request-Knoten mit demselben Credential, Rumpf aus einem Code-Knoten, der
  `nachricht_id` aus dem Prüf-Knoten übernimmt, Markdown-Reste entfernt und `text` auf 4000 Zeichen begrenzt.

**Wo das Geheimnis liegt:** Der Code-Knoten kommt nicht an `$env` (`access to env vars denied`). Das mit
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` aufzuheben, gibt **jedem** Code-Knoten der Instanz alle Env-Werte, auch
`N8N_ENCRYPTION_KEY` und das Postgres-Passwort — das tun wir nicht. Stattdessen steht im Workflow ein Platzhalter
(etwa `__GEHEIMNIS__`), den der Ausroll-Schritt beim Einspielen über die Public API von n8n durch
`COCKPIT_KOORDINATOR_SECRET` aus der `.env` des Servers ersetzt. Das Geheimnis verlässt den Server nicht und steht in
keinem Repo und keinem Workflow-Export. Zwei Fallen dabei:

- Eine Prüfung „Platzhalter noch drin?" darf den Platzhalter nicht selbst enthalten: `geheimnis === '__GEHEIMNIS__'`
  wird beim Ersetzen mitgetroffen und ist danach immer wahr. Stattdessen die Länge prüfen — der Vertrag verlangt
  mindestens 32 Zeichen:

  ```js
  if (geheimnis.length < 32) throw new Error('Geheimnis fehlt oder ist zu kurz — Ausroll-Schritt übersprungen?');
  ```

- Nach jedem Import oder Bearbeiten in der Oberfläche steht wieder der Platzhalter drin, wenn der Workflow aus dem
  Export stammt. Also immer über den Ausroll-Schritt einspielen, nicht von Hand.

Ein vollständiges Muster (Workflow und Ausroll-Skript) liegt bei FEWOTEST-71; es ist die Vorlage für
`agent-koordinator.yaml` in `agent-blueprints`.

## Was der Koordinator nie tun soll

- Einen Rohbefund, eine Kennung oder etwas aus einer anderen Quelle als `GET /intern/zustand` über den Zustand der
  Instanz weitersagen.
- Einen Webhook ohne gültige, frische Signatur bearbeiten.
- Mit dem Token des Admin-Agenten antworten oder sein eigenes Token irgendwo ausgeben.
- HTML, Markdown oder Links als Formatierung erwarten — der Text bleibt Text.
- Alles `dringend` markieren: dringend weckt Menschen per Push und E-Mail.

## Nachweis auf echten Geräten

Der Ende-zu-Ende-Test läuft mit Fakes für n8n und den Push-Dienst. Dass Push auf einem echten Android-Gerät und einem
iPhone (iOS ≥ 16.4, **nach „Zum Home-Bildschirm"**) ankommt, weist die Integration auf FEWOTEST nach (FEWOTEST-69) —
dort, nicht in diesem Repo.
