# Pipeline-API: Job-Queue der Entwicklungspipeline — der Vertrag

Stand: COPI-145 / JAC-757, 16.10.2026. Grundlage: Autonome Entwicklungspipeline – Architekturkonzept,
Abschnitte 3 und 9 (Story 7). Dieses Dokument soll genügen, um den Runner (JAC-742) und Tims Intake (JAC-741, JAC-758) zu
bauen, ohne in den Code des Cockpits zu sehen. `test/pipeline-api-datenbank.test.ts` und
`test/pipeline-queue-datenbank.test.ts` halten Code und Vertrag zusammen.

```text
Koordinator (n8n) ──POST /intern/pipeline/jobs──────▶ Cockpit ◀──POST /pipeline/claim──── Runner (Mini-PC)
          ──POST /intern/pipeline/aufraeumen─▶  Queue  ◀──POST /pipeline/heartbeat──
          ──GET  /intern/pipeline/jobs/:id───▶ (Postgres)◀─POST /pipeline/event────
                Bearer-Token                             ◀──POST /pipeline/complete─  HMAC-Signatur
```

## Datenmodell

Tabellen im Schema `cockpit` mit Präfix `pipeline_` (Migration 0051). Ein eigenes Schema `pipeline`, wie das Konzept es
skizziert, gibt es nicht: die Rolle `cockpit` darf keine Schemas anlegen (COPI-66), und die ADR sieht genau eines vor.

| Tabelle | Inhalt |
| --- | --- |
| `pipeline_repo_config` | je Repo: `quelle` (`jira`/`github`), `jira_project` (Pflicht bei `jira`), `base_branch`, `auto_merge`, `phase` (0–2), `reviewers`, `protected_paths`. Pflegt nur der Betreuer der Instanz (Server-Kommando `pipeline-repo`). Repos auf der Sperrliste (`COCKPIT_AUTO_MERGE_SPERRLISTE`) nie mit `auto_merge` |
| `pipeline_job` | `ticket_key` (frei: `COPI-123` oder `owner/repo#12`), `repo`, `kind` (`implement`, `rework`, `review:codex`, `review:gemini`, `review:copilot`), `provider` (abgeleitet: Umsetzung `claude`, sonst der Reviewer), `status` (`queued`, `leased`, `done`, `failed`, `parked`), `priority` (1 dringend … 5), `due_date`, `attempt`, `max_attempts` (Standard 2), Lease, `payload`, `result` |
| `pipeline_job_event` | das Audit: jede Statusänderung (vom Cockpit, ohne `event_id`) und jede Meldung des Runners. Nur anhängen |
| `pipeline_usage` | ein Lauf eines Werkzeugs: Tokens, rechnerische und reale Kosten. Nur anhängen |
| `pipeline_provider_state` | je Anbieter `ok`, `exhausted` (bis `until`) oder `disabled` |

Nichts wird gelöscht (Handbuch „Nie löschen, nur markieren").

## Regeln der Queue

- **Vergabe atomar:** zwei gleichzeitige `claim`s bekommen nie denselben Job. Lease: **15 Minuten**.
- **Reihenfolge:** `rework` vor allem anderen, dann Fälligkeit (ohne Fälligkeit zuletzt), dann Priorität, dann Alter.
- **Höchstens ein `implement`/`rework` je Repo gleichzeitig.** Reviews desselben Repos laufen daneben.
- **Anbieter:** ist er `exhausted` (und `until` nicht vorbei, ohne `until` bis zum Zurücksetzen) oder `disabled`, gibt es
  keine Jobs dieses Anbieters.
- **Abgelaufene Lease:** `attempt + 1`, zurück auf `queued`; ist `attempt` danach größer als `max_attempts`, `parked`.
  Das geschieht bei jedem `claim` und bei `POST /intern/pipeline/aufraeumen`.
- **Abo-Limit (`quota`) zählt nicht als Versuch.**

## Teil 1: der Runner — `/pipeline/*`

### Anmeldung: HMAC

Wie der Koordinator-Webhook (`docs/koordinator-api.md`), nur in die andere Richtung:

| Kopfzeile | Inhalt |
| --- | --- |
| `content-type` | `application/json` (alles andere: `415`) |
| `x-cockpit-zeitpunkt` | Unix-Zeit in **Sekunden** |
| `x-cockpit-signatur` | `sha256=<hex>`: HMAC-SHA256 mit `COCKPIT_PIPELINE_SECRET` über `<x-cockpit-zeitpunkt>.<roher Rumpf>` |

Signiert wird **genau die gesendete Zeichenfolge** (erst serialisieren, dann signieren, dann diese Bytes senden). Der
Zeitpunkt darf höchstens **5 Minuten** von der Uhr des Cockpits abweichen, in beide Richtungen. Fehlt etwas, stimmt die
Signatur nicht oder ist das Geheimnis im Cockpit nicht eingerichtet: `401 {"fehler":"nicht_angemeldet"}` mit
`WWW-Authenticate: HMAC-SHA256` — auch für einen Pfad, den es nicht gibt. Nach 20 Fehlversuchen in 15 Minuten je
Client-IP: `429` mit `Retry-After`.

Beispiel (Shell):

```sh
rumpf='{"runner":"mini-pc"}'
zeit=$(date +%s)
sig=$(printf '%s.%s' "$zeit" "$rumpf" | openssl dgst -sha256 -hmac "$COCKPIT_PIPELINE_SECRET" -hex | sed 's/^.* //')
curl -sS https://cockpit.example.com/pipeline/claim -H 'content-type: application/json' \
  -H "x-cockpit-zeitpunkt: $zeit" -H "x-cockpit-signatur: sha256=$sig" --data "$rumpf"
```

**Wiederholungen** innerhalb des Fensters richten nichts an: `event` ist über `event_id` idempotent, ein wiederholter
`complete` mit `done`/`failed` antwortet `wiederholt: true`, ein wiederholter `heartbeat` verlängert nur erneut. Ein
wiederholter `claim` kann einen weiteren Job für denselben Runner leasen; der läuft dann ab und kommt zurück.

`runner` ist in jedem Rumpf der Name des Runners (`^[a-z0-9][a-z0-9_.-]{0,62}$`, etwa `mini-pc`, je Slot eigen
möglich: `mini-pc.slot1`). Er ist die Lease-Kennung: nur wer die Lease hält, kann sie verlängern und abschließen.

Fehler sind knapp: `400 {"fehler":"ungueltige_anfrage","felder":[…]}` nennt nur Feldnamen, nie Werte; unbekannte Felder
sind ein Fehler.

### `POST /pipeline/claim`

```json
{"runner":"mini-pc","arten":["implement","rework"]}
```

`arten` ist optional (ohne: alle) — etwa nur Reviews für den Review-Slot. Antwort `200`:

```json
{
  "job": {
    "id": "7bfe87d7-3d39-4a1d-b1f2-73529c7566e6", "ticket_key": "COPI-145", "repo": "Stefan39/cockpit",
    "kind": "implement", "provider": "claude", "status": "leased", "priority": 3, "due_date": "2026-10-16",
    "attempt": 0, "max_attempts": 2, "lease_owner": "mini-pc", "lease_until": "2026-10-16T08:15:00.000Z",
    "payload": {}, "result": null, "created_at": "…", "updated_at": "…"
  },
  "repo_config": {
    "quelle": "jira", "jira_project": "COPI", "base_branch": "main", "auto_merge": false, "phase": 0,
    "reviewers": ["codex"], "protected_paths": [".github/**"]
  }
}
```

Kein passender Job: `200 {"job":null}`. Alle 30 Sekunden fragen genügt.

### `POST /pipeline/heartbeat`

```json
{"runner":"mini-pc","job_id":"7bfe87d7-…"}
```

`200 {"lease_until":"…"}` (jetzt + 15 Minuten). Alle 60 Sekunden. `409 {"fehler":"lease_verloren"}`: die Lease gehört
nicht mehr diesem Runner (abgelaufen und neu vergeben, oder abgeschlossen) — den Job sofort abbrechen, nichts pushen.

### `POST /pipeline/event`

```json
{"runner":"mini-pc","job_id":"7bfe87d7-…","event_id":"0b7a3c52-9d1e-4f7a-8c2b-5e6d7f8a9b0c","type":"job.pr_opened","data":{"pr":170}}
```

`event_id` ist eine UUID, die der Runner je Meldung **einmal** erzeugt und bei einer Wiederholung gleich lässt. `type`:
`^[a-z][a-z0-9_.]{0,62}$`. Das meldet der Runner heute:

| Typ | Wann | Wichtigste Felder in `data` |
| --- | --- | --- |
| `job.started` | Der Runner hat den Job übernommen und beginnt. | — |
| `job.pr_opened` | Der Pull Request ist angelegt. | `pr` |
| `job.ci_green` | Die CI des Pull Requests ist grün. | — |
| `job.ready_for_review` | Der Pull Request ist bereit für das Review. | `pr` |
| `job.rework_pushed` | Die Nacharbeit nach einem Review ist gepusht. | — |
| `review.round_done` | Eine Review-Runde ist abgeschlossen. | `reviewer`, `round`, `pr`, `head_sha` |
| `review.clean` | Das Review hat keine Befunde mehr. | `reviewer`, `round`, `pr`, `head_sha` |
| `merge.approval_requested` | In Phase 0 die Freigabe-Anfrage an den Betreuer. | `pr`, `pr_url`, `head_sha` |
| `ticket.escalated` | Nach der dritten Review-Runde ohne `review.clean`. | — |

Das Cockpit speichert die Ereignisse im Audit (`pipeline_job_event`) und wertet sie bisher nicht aus (Anzeige der
Freigabe-Anfragen: COPI-172). `data` ist ein beliebiges Objekt (höchstens 256 KiB Rumpf, keine Logs,
keine Geheimnisse). Antwort: `201 {"gespeichert":true}`, bei einer schon gespeicherten `event_id`
`200 {"gespeichert":false}`, unbekannter Job `404 {"fehler":"job_unbekannt"}`. Eine Lease ist nicht nötig: auch eine
späte Meldung gehört ins Audit.

### `POST /pipeline/complete`

```json
{
  "runner": "mini-pc", "job_id": "7bfe87d7-…", "ergebnis": "done",
  "result": {"pr": 170, "head_sha": "abc123"},
  "usage": [{"tool":"claude-code","model":"claude-opus-5-5","billing":"abo","input_tokens":1200,"output_tokens":300,
             "cache_tokens":5000,"cost_eur_notional":1.25,"duration_s":900}]
}
```

| `ergebnis` | Wirkung |
| --- | --- |
| `done` | Status `done`, `result` gespeichert. Endgültig |
| `failed` | Status `failed` (Eskalation, Rundenlimit …). Endgültig |
| `abandoned` | zurück in die Queue, `attempt + 1`, bei mehr als `max_attempts` `parked` (etwa beim Start des Runners für Leases aus seiner lokalen Statusdatei) |
| `released` | zurück in die Queue **ohne** Versuch (JAC-767): der Runner hat den Job bei einem geordneten Neustart (SIGTERM, Deploy) selbst abgebrochen und aufgeräumt. Ein Absturz meldet dagegen `abandoned` |
| `quota` | zurück in die Queue **ohne** Versuch; der Anbieter des Jobs gilt als erschöpft bis `provider_bis` (ISO-8601 mit Zone, nur bei `quota`), ohne Angabe eine Stunde |

`usage` (optional, höchstens 50 Einträge) wird in jedem Fall gespeichert — auch ein gescheiterter Lauf hat Tokens
verbraucht. `tool`: `^[a-z][a-z0-9_.-]{0,39}$`, `billing`: `abo` oder `api`, Zahlen nicht negativ.

Antwort `200 {"status":"done","attempt":0,"wiederholt":false}`. Derselbe Abschluss mit `done`/`failed` noch einmal:
`wiederholt: true`, nichts geändert. `409 lease_verloren`, `404 job_unbekannt` wie oben.

## Teil 2: Koordinator — `/intern/pipeline/*`

Agenten-API (`docs/agenten-api.md`): Bearer-Token, Recht **`pipeline_verwalten`**. Zugang anlegen:

```sh
docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name koordinator-pipeline --scope pipeline_verwalten
```

### `POST /intern/pipeline/jobs`

```json
{"ticket_key":"COPI-145","repo":"Stefan39/cockpit","kind":"implement","priority":2,"due_date":"2026-10-16","max_attempts":2,"payload":{"titel":"…"}}
```

Pflicht: `ticket_key` (1–200 Zeichen), `repo`, `kind`. `payload` ist ein Objekt für den Runner (Ticket-Text zum Zeitpunkt
der Freigabe, Befunde für `rework` …). Antwort `201 {"angelegt":true,"job":{…}}`. Wartet oder läuft derselbe Job
(`ticket_key` und `kind`) schon: `200 {"angelegt":false,"job":{…}}` — das Polling darf also jedes Mal anlegen. Repo ohne
Einstellungen: `409 {"fehler":"repo_unbekannt"}`.

### `GET /intern/pipeline/jobs`

Die Jobs als Liste, neueste zuerst (`created_at`, dann `id` absteigend), ohne Verlauf — den liefert `GET /intern/pipeline/jobs/:id`.
Alle Parameter sind optional und stehen im Query-String; ein unbekannter Parameter oder ein ungültiger Wert ist `400`.

| Parameter | Bedeutung |
| --- | --- |
| `status` | einer aus `queued`, `leased`, `done`, `failed`, `parked` |
| `ticket_key` | nur Jobs dieses Tickets (1–200 Zeichen) |
| `limit` | ganze Zahl 1–200, Standard `50` |

`GET /intern/pipeline/jobs?status=parked&limit=10` — `200 {"jobs":[{…},{…}]}`, je Job dieselben Felder wie bei `POST`.
Ohne Treffer: `200 {"jobs":[]}`.

### `GET /intern/pipeline/jobs/:id`

`200 {"job":{…},"ereignisse":[{"event_id":null,"runner":"mini-pc","ts":"…","type":"status","data":{"von":"queued","nach":"leased","grund":"claim"}}, …]}`,
älteste zuerst. Statuswechsel haben `type: status` und `data.grund` (`angelegt`, `claim`, `lease_abgelaufen`, `done`,
`failed`, `abandoned`, `released`, `quota`). Unbekannt: `404`.

### `GET /intern/pipeline/freigaben`

Die PRs, die auf die Freigabe des Betreuers warten: je Job die jüngste Meldung `merge.approval_requested`, nach der es kein
`merge.erledigt` desselben Jobs gibt. Eine erneute Anfrage nach einer Nacharbeit ersetzt die frühere. Älteste Anfrage zuerst.

`200 {"freigaben":[{"job_id":"…","ticket_key":"COPI-180","titel":"…","repo":"Stefan39/cockpit","pr":202,"pr_url":"https://github.com/…","head_sha":"…","runden":2,"angefragt_am":"…"}]}`

`runden` ist die höchste `data.round` aus `review.clean` dieses Jobs, ohne ein solches Ereignis `null`.

`titel` stammt aus `payload.titel` des Jobs; ist es leer oder fehlt es, ist `titel` `null`.

Dieselbe Liste zeigt die Übersicht unter „Zu tun" als Spalte „PR-Freigaben", nur für den Betreuer (`technik_sehen`) und nur,
wenn mindestens eine Freigabe offen ist.

### `POST /intern/pipeline/jobs/:id/freigabe-erledigt`

```json
{"grund":"gemergt"}
```

`grund`: `gemergt` oder `geschlossen`. Koordinator ruft das, sobald der PR gemergt oder geschlossen ist. Es wird ein Ereignis
`merge.erledigt` (`runner: null`, `data: {"grund":…}`) angehängt, nichts geändert. Antwort `200 {"erledigt":true}`;
gibt es keine offene Anfrage (auch weil sie schon erledigt ist), `200 {"erledigt":false}` und es wird nichts geschrieben,
das Aufrufen ist also idempotent. Unbekannter Job: `404`, ungültiger Rumpf oder ungültige ID: `400`.

### `POST /intern/pipeline/aufraeumen`

Ohne Rumpf oder mit `{}`. Antwort `200 {"aufgeraeumt":[{"id":"…","ticket_key":"COPI-145","status":"parked","attempt":3}]}` —
alle Jobs, deren Lease abgelaufen war, mit ihrem neuen Status. Die mit `parked` meldet der Koordinator dem Betreuer und stellt das
Ticket zurück. Alle 5 Minuten.

### `GET /intern/pipeline/verbrauch?ticket=COPI-123`

Der KI-Verbrauch eines Tickets, über alle Jobs summiert (Umsetzung, Nacharbeit, Reviews), damit Koordinator ihn in den
Jira-Kommentar schreiben kann. `ticket` ist Pflicht (1–200 Zeichen), sonst `400`. Antwort:

```json
{
  "ticket_key": "COPI-123",
  "jobs": 3,
  "gesamt": { "laeufe": 4, "input_tokens": 1200, "output_tokens": 300, "cache_tokens": 50, "cost_eur_notional": 1.25, "cost_eur_real": null, "duration_s": 840 },
  "je_werkzeug": [{ "tool": "claude-code", "model": null, "laeufe": 2, "input_tokens": 900, "output_tokens": 200, "cache_tokens": 50, "cost_eur_notional": 1.0, "cost_eur_real": null, "duration_s": 600 }]
}
```

`jobs` zählt die verschiedenen Jobs. `je_werkzeug` hat eine Zeile je `tool` und `model`. Die Kosten sind Summen; hat keine
Zeile einen Wert, bleibt der Wert `null` (unbekannt, nicht 0). Ein Ticket ohne Verbrauch ist kein Fehler: `jobs: 0`,
leere `je_werkzeug`, Summen 0.

## Teil 3: Betreuer — Server-Kommando

```sh
docker compose exec -T cockpit node dist/cli/index.js pipeline-repo <<'YAML'
repo: Stefan39/cockpit
quelle: jira
jira_project: COPI
base_branch: main
auto_merge: false
phase: 0
reviewers: [codex]
protected_paths: [".github/**", "package.json", "package-lock.json", "docs/architektur-leitplanken.md"]
YAML
docker compose exec cockpit node dist/cli/index.js pipeline-repos
```

Anbieter zeigen, abschalten und wieder freigeben:

```sh
docker compose exec cockpit node dist/cli/index.js pipeline-anbieter
docker compose exec cockpit node dist/cli/index.js pipeline-anbieter-setzen --anbieter codex --zustand aus
docker compose exec cockpit node dist/cli/index.js pipeline-anbieter-setzen --anbieter codex --zustand ok
```

`pipeline-anbieter` zeigt Anbieter, Zustand, `bis` und Änderungszeit (ohne Einträge: „alle ok (keine Einträge)“).
`pipeline-anbieter-setzen` setzt `ok` oder `aus` (in der Datenbank `disabled`), leert `bis` und gibt eine Zeile aus,
etwa `codex: disabled`. `exhausted` setzt nur der Runner über `quota`.

Offene Freigaben auflisten (nur lesend, ohne Optionen):

```sh
docker compose exec cockpit node dist/cli/index.js pipeline-freigaben
```

Die Ausgabe ist eine Tabelle Ticket, Repo, PR, Runden, angefragt und Titel (auf 60 Zeichen gekürzt), älteste Anfrage zuerst (Fehlendes steht als „–“); ohne offene Freigaben kommt die Zeile „keine offenen Freigaben“.

Ersetzt die Einstellungen des Repos vollständig. Phase und Auto-Merge sind die Entscheidung des Betreuers und deshalb nicht über
die Agenten-API änderbar.

## Konfiguration

| Variable | Bedeutung |
| --- | --- |
| `COCKPIT_PIPELINE_SECRET` | das gemeinsame Geheimnis mit dem Runner, mind. 32 Zeichen (`openssl rand -base64 32`). Ohne Wert nimmt `/pipeline` nichts an (401); zu kurz hält den Start an. Rotation alle 90 Tage (Konzept §8): neuen Wert setzen, Cockpit und Runner neu starten |

## Noch nicht enthalten

Cockpit-Ansicht und
Freigabe-Buttons (Konzept Story 15), Verbrauchsauswertung je Ticket in der Oberfläche (Story 18).
