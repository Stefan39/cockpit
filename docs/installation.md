# Das Cockpit auf eine Kundeninstanz bringen

Diese Anleitung reicht aus, um das Cockpit ohne Blick in den Code auf einem Kundenserver aufzusetzen, zu
aktualisieren und im Notfall zurückzunehmen. Sie gehört zu Phase 3 des Playbooks „neuen Kundenserver aufsetzen“;
dort steht, wie der Server bis dahin entsteht.

Alles hier macht ein Mensch am Server (später das Werkzeug `cockpit-update` des Admin-Agenten). **Das Cockpit
selbst kann nichts davon**: Es hat weder Docker-Socket noch SSH noch Zugang zu GHCR, und es aktualisiert sich
nicht selbst (Architektur-Vorschlag Abschnitt 4 und 13.1). Ein Update ist dort ein Antrag, keine Handlung.

Laufen die Agenten schon als Coolify-Service (mit Traefik statt eigenem Caddy), steht der Compose-Entwurf in
`docker/compose.coolify.yaml`.

## Voraussetzungen

- Der Server steht nach Playbook: `/opt/<kuerzel>/` mit `compose.yaml` und `.env`, Benutzer `deploy` (sudo,
  Docker-Gruppe), Docker mit Compose-Plugin, die Netze `frontend` und `backend`, PostgreSQL als interner Dienst
  ohne offenen Port, Caddy als einziger Dienst mit 80/443.
- **Domain und DNS stehen.** Entweder die Domain des Kunden oder `<kuerzel>.example.com`, mit A/AAAA auf den
  Server. Caddy holt das Zertifikat selbst. Die Domain steht mit der Anlage fest: Ein Wechsel ist eine Migration,
  keine Einstellung (Abschnitt 13.3), weil Sitzungs-Cookies und später die Push-Abos am Ursprung hängen.
- **Mail:** ein eigenes App-Passwort dieser Instanz auf mailcow, nicht das Passwort eines Postfachs.
- **Ein Release existiert:** Version und Digest stehen im GitHub-Release (siehe README, „Release“). Der Digest gilt für
  amd64 und arm64 (seit COPI-86); ältere Releases gibt es nur für amd64.

## 1. Lese-Token für GHCR (einmal je Server)

Das Image liegt privat in GHCR. Jeder Server meldet sich mit einem **eigenen** Token an, damit ein verlorener
Server einzeln ausgesperrt werden kann.

1. Als `<ghcr-konto>` unter <https://github.com/settings/tokens/new> ein classic Token anlegen: Name
   `GHCR-Pull <kuerzel>`, ein Jahr gültig, **nur** den Haken `read:packages`. GHCR nimmt nur classic Tokens; ein
   fine-grained Token kann keine Pakete lesen.
2. Auf dem Server, als der Benutzer, der `docker compose` ausführt:

   ```bash
   printf '%s' '<token>' | docker login ghcr.io -u <ghcr-konto> --password-stdin
   ```

   Das Token landet danach in `~/.docker/config.json`, nur base64-kodiert und nicht verschlüsselt. Die Datei
   gehört diesem Benutzer und geht niemanden sonst an; das Token darf ohnehin nur lesen und lässt sich einzeln
   widerrufen.

3. Probe mit dem Digest aus dem Release:

   ```bash
   docker pull ghcr.io/stefan39/cockpit@<DIGEST>
   ```

## 2. Datenbank: eigene Rolle, eigenes Schema

Das Cockpit bekommt keinen eigenen Datenbankdienst, sondern ein eigenes Schema `cockpit` in der vorhandenen
PostgreSQL (Abschnitt 2). Es bekommt aber eine **eigene Rolle** mit eigenem Passwort: Sie ist die Grenze, an der
sich später auch die engeren Rechte des Admin-Agenten festmachen lassen.

```bash
# <postgres-dienst> ist der Dienst aus der compose.yaml des Servers, <datenbank> die Datenbank der Instanz.
docker compose exec -T <postgres-dienst> psql -U postgres -v ON_ERROR_STOP=1 -d <datenbank> <<'SQL'
CREATE ROLE cockpit LOGIN PASSWORD '<passwort>';
CREATE SCHEMA IF NOT EXISTS cockpit AUTHORIZATION cockpit;
SQL
```

Das Schema legt hier die Verwaltung an, nicht das Cockpit: So braucht die Rolle `cockpit` kein Recht, in der
Datenbank weitere Schemas anzulegen. Alles Weitere macht `migrieren` (Schritt 5) in ihrem eigenen Schema. Ein
`GRANT CREATE ON DATABASE` ist **nicht** nötig: Seit v0.3.0 legt `migrieren` das Schema nur an, wenn es fehlt
(COPI-66). v0.2.0 brach bei genau diesen Rechten mit `permission denied for database` ab.

**Welche Datenbank?** Die der Instanz, in der auch die fachlichen Tabellen liegen. Die Modulseiten (E5) sind
SQL-Views im Schema `cockpit` und können nur lesen, was in **derselben** Datenbank steht. Liegt n8n in einer
eigenen Datenbank, ist das nicht die richtige. Das Playbook benennt die Datenbank bisher nicht ausdrücklich — im
Zweifel vor der Anlage klären, denn ein späterer Wechsel ist eine Migration.

## 3. Werte für die `.env`

Der Dienstblock liest diese Werte aus der `.env` neben der `compose.yaml`:

| Variable | Wert |
| --- | --- |
| `COCKPIT_DATABASE_URL` | `postgres://cockpit:<passwort>@<postgres-dienst>:5432/<datenbank>` |
| `COCKPIT_AUTH_SECRET` | `openssl rand -base64 32`, je Instanz eigen. Ein Wechsel entwertet alle Sitzungen |
| `COCKPIT_SMTP_HOST`, `COCKPIT_SMTP_PORT` | mailcow der Instanz; `587` spricht STARTTLS, `465` TLS von Anfang an |
| `COCKPIT_SMTP_USER`, `COCKPIT_SMTP_PASS` | das App-Passwort dieser Instanz |
| `COCKPIT_SMTP_FROM` | Absenderadresse. Ein Anzeigename wird verworfen (Abschnitt 7) |
| `COCKPIT_KOORDINATOR_URL` | Webhook des Koordinator-Workflows in n8n, etwa `http://n8n:5678/webhook/koordinator` (COPI-54) |
| `COCKPIT_KOORDINATOR_SECRET` | `openssl rand -base64 32`, je Instanz eigen; dasselbe Geheimnis prüft der Workflow. Mit der URL zusammen oder gar nicht |
| `COCKPIT_PIPELINE_SECRET` | nur auf Stefans eigener Instanz (Entwicklungspipeline, COPI-145): `openssl rand -base64 32`, dasselbe Geheimnis bekommt der Runner. Ohne Wert nimmt `/pipeline` nichts an |
| `COCKPIT_AUTO_MERGE_SPERRLISTE` | optional, nur mit Entwicklungspipeline: kommagetrennte Repos (`owner/name`), für die `auto_merge` nie erlaubt ist (Standard: leer) |
| `COCKPIT_KOORDINATOR_FRIST` | optional, Sekunden bis „Der Assistent antwortet gerade nicht" (Standard 120) |
| `COCKPIT_CHAT_TAGESLIMIT` | optional, Nachrichten an den Assistenten je Konto und Tag (Standard 50) |
| `COCKPIT_CHAT_MAIL_NACH_MINUTEN` | optional, Minuten bis eine dringende, ungelesene Nachricht per E-Mail gemeldet wird (Standard 15; braucht SMTP) |
| `COCKPIT_WARTUNGSFENSTER` | optional, `di 07-09` (Standard: Kundeninstanzen behalten den Dienstag 07:00–09:00) oder `jederzeit` (automatische Image-Updates ohne Fenster und ohne Tagesgrenze, nur wo Stefan es für die Instanz entschieden hat, COPI-235). Jeder andere Wert verhindert den Start, auch einer mit Leerzeichen am Rand. Der Dienstblock in `docker/compose.fragment.yaml` reicht die Variable nicht von selbst an den Container weiter: Wer `jederzeit` will, ergänzt `COCKPIT_WARTUNGSFENSTER: "${COCKPIT_WARTUNGSFENSTER}"` im `environment`-Block der lokalen `compose.yaml`, sonst gilt weiter der Dienstag |
| `COCKPIT_VAPID_PUBLIC_KEY`, `COCKPIT_VAPID_PRIVATE_KEY` | Web Push: `docker compose run --rm cockpit node dist/cli/index.js vapid-erzeugen`, je Instanz eigen, ins Zugangsdatenblatt. Beide oder keins. Ein neues Paar entwertet alle Abos |
| `COCKPIT_VAPID_KONTAKT` | optional, `mailto:` oder `https:` für die Push-Dienste (ohne Angabe die Adresse des Cockpits) |

Ohne `SMTP_HOST` und `SMTP_FROM` startet das Cockpit zwar, registriert die Einladungsroute aber nicht — der
Betriebs-Admin käme dann nicht an seinen Zugang.

### SMTP nur mit TLS — kein interner Relay ohne Verschlüsselung

Das Cockpit schickt keine Mail über eine offene Verbindung (Abschnitt 7): Auf `465` spricht es TLS von Anfang an,
auf **jedem anderen Port** verlangt es STARTTLS (`requireTLS`). Das gilt auch ohne `COCKPIT_SMTP_USER`. Ein
interner Weiterleitungs-Relay, der kein Server-TLS anbietet (etwa das Relay-Muster, das FEWOTEST-36 für n8n gebaut
hat), ist deshalb **kein gültiger `COCKPIT_SMTP_HOST`**. Die Verbindung bricht dann mit
`502 5.5.1 Error: command not implemented` ab, sobald das Cockpit `STARTTLS` sendet. Den Schalter gibt es bewusst
nicht. Stattdessen:

- `COCKPIT_SMTP_HOST` direkt auf mailcow (`587`, STARTTLS) mit dem App-Passwort dieser Instanz — so auf FEWOTEST
  (COPI-67), oder
- ein Relay, der selbst mindestens STARTTLS anbietet.

**Mehrere Netze und eine SMTP-Firewall-Ausnahme:** Hängt der Cockpit-Dienst in mehreren Docker-Netzen (Fragment:
`frontend` und `backend`; mit eigenem Mail-Netz drei), bekommt er den Default-Gateway aus **irgendeinem** davon.
Weder die Reihenfolge in der `compose.yaml` noch `networks.<name>.priority` haben das auf FEWOTEST beeinflusst
(Docker 29.8, Compose v5.5.1). Ausgehender SMTP läuft dann womöglich über das falsche Netz, an einer host-seitigen
Firewall-Ausnahme für das Mail-Netz vorbei, und die Mail geht nicht raus. Prüfen:

```bash
docker compose exec cockpit ip route   # welches Netz trägt "default via"?
```

Zeigt der Default-Gateway nicht ins Mail-Netz, braucht der Dienst eine eigene Route zum SMTP-Ziel über das
Mail-Netz. Der Container kann sie nicht selbst setzen (kein `NET_ADMIN`, Docker-Standard), also setzt sie der Host
in seinem Netz-Namespace — und zwar nach **jedem** Start des Containers neu, denn sie geht mit ihm verloren. Vorlage
ist der systemd-Wächter auf FEWOTEST (`/usr/local/sbin/fewotest-cockpit-route.sh`, FEWOTEST-69).

Die Adresse des Betriebs-Admins gehört ins Zugangsdatenblatt. Das Cockpit liest sie noch nicht; eingeladen wird
er in Phase 6 über die Oberfläche oder das Server-Kommando (`einladung`). Das VAPID-Schlüsselpaar für Web Push
(COPI-59) erzeugt `vapid-erzeugen`; ohne es startet das Cockpit, aber ohne Push.

## 4. Dienst und Routing einsetzen

1. Den Block aus [`docker/compose.fragment.yaml`](../docker/compose.fragment.yaml) in `/opt/<kuerzel>/compose.yaml`
   übernehmen und die Platzhalter ersetzen: `<KUERZEL>`, `<INSTANZNAME>` und **`<DIGEST>` an beiden Stellen** — in
   der `image:`-Zeile und bei `COCKPIT_IMAGE_DIGEST`. Beide Werte müssen übereinstimmen: Daran hängt, dass sich
   ein Update später bestätigen lässt ([`docs/adr/0001-digest-aus-der-umgebung.md`](adr/0001-digest-aus-der-umgebung.md)).
   Nie ein bewegliches Tag eintragen.
2. Den Site-Block aus [`docker/Caddyfile.fragment`](../docker/Caddyfile.fragment) in die Caddy-Konfiguration des
   Servers übernehmen. `COCKPIT_DOMAIN` muss in **Caddys** Umgebung stehen, sonst löst `{$COCKPIT_DOMAIN}` nicht
   auf. `/webhook/*` bleibt bei n8n und muss erreichbar bleiben; die IP-Beschränkung für `/n8n/*` bleibt in der
   servereigenen Konfiguration.
3. Prüfen, ohne etwas zu starten:

   ```bash
   docker compose config
   ```

## 5. Schema anlegen und starten

```bash
docker compose pull cockpit
docker compose run --rm cockpit node dist/cli/index.js migrieren
docker compose up -d cockpit
docker compose run --rm cockpit node dist/cli/index.js migrieren --status
```

`run --rm`, nicht `exec`: Das Cockpit **startet ohne Schema nicht** (Exit 3, mit Meldung), es gäbe also keinen
laufenden Container. `migrieren` ist beliebig oft wiederholbar; ist die Datenbank auf dem Stand, tut es nichts.
Der letzte Aufruf darf nichts „ausstehend“ mehr zeigen. Mehr dazu in der README, „Schema und Migrationen“.

## 6. Erster Zugang

```bash
docker compose logs cockpit
```

Im Log steht ein abgegrenzter Block mit dem Erststart-Token. Der Link `https://<domain>/erststart/<token>` gilt
24 Stunden, lässt sich einmal einlösen und verfällt, sobald ein Benutzer existiert; ein Neustart entwertet ihn
und gibt ein neues Token aus. Gespeichert wird nur sein Hash — ein fertiges Passwort gibt das Cockpit nie aus.

Der Zugang, der so entsteht, ist der **Betreuer** (Stefan), nicht der des Betriebs-Admins. Direkt danach verlangt
das Cockpit einen zweiten Faktor (Passkey oder TOTP). Das Token gehört wie das Datenbankpasswort ins
Zugangsdatenblatt. Der Betriebs-Admin bekommt seinen Zugang später per Einladung, die drei Stunden gilt.

## 7. Prüfungen

| Prüfung | Erwartung |
| --- | --- |
| `curl -fsS https://<domain>/gesund` | antwortet |
| `https://<domain>/` im Browser | Anmeldeseite, ohne Hinweis auf den Erststart |
| `curl -i https://<domain>/webhook/<pfad>` | Antwort von n8n, **nicht** die Anmeldeseite des Cockpits |
| `sudo reboot`, danach `docker compose ps` und `/gesund` | alle Dienste laufen wieder, das Cockpit antwortet |
| Einstellungen als Betreuer | zeigt Version und laufenden Digest, beide wie im Release |

Die letzte Zeile ist die Selbstmeldung: Beim Start schreibt das Cockpit Version (aus dem Image) und Digest (aus
der Umgebung) nach `cockpit.instanz`. Stimmen sie nicht mit dem Release überein, stimmt eine der beiden Stellen
in der Compose-Datei nicht. Version und Digest gehören ins Kundenregister.

### Chat, Koordinator und Push (E4)

Den ganzen Weg einer Frage, den Webhook und seine Signatur beschreibt [`koordinator-api.md`](koordinator-api.md).

1. Zwei Zugänge anlegen — die Tokens erscheinen einmal und gehören ins Zugangsdatenblatt bzw. als Credential in n8n:

   ```bash
   docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name koordinator \
     --scope chat_antworten --scope zustand_lesen
   docker compose exec cockpit node dist/cli/index.js api-token-erzeugen --name budget-wache --scope zustand_lesen
   ```

2. Im Koordinator-Workflow von n8n: Webhook unter der Adresse aus `COCKPIT_KOORDINATOR_URL`, Signatur und Frische
   prüfen, sofort quittieren, antworten über `POST /intern/chat/antwort` mit dem Token `koordinator`. Die n8n-Instanz
   braucht dafür `NODE_FUNCTION_ALLOW_BUILTIN=crypto` in ihrer Umgebung, sonst scheitert die Signaturprüfung im
   Code-Knoten zur Laufzeit (COPI-70).
3. Prüfen:

| Prüfung | Erwartung |
| --- | --- |
| Im Chat eine Frage an den Assistenten schicken | Antwort erscheint ohne Neuladen; im Log keine Warnung „Koordinator nicht erreicht" |
| Webhook ohne Signatur aufrufen: `curl -i -X POST <COCKPIT_KOORDINATOR_URL>` | `401` vom Workflow, kein Agentenlauf |
| Einstellungen → Benachrichtigungen, auf Android und iPhone (dort erst nach „Zum Home-Bildschirm") einschalten, dann eine Frage stellen | Push „Neue Antwort des Assistenten", ohne Text; der Klick öffnet den Chat |
| Eine dringende Antwort ungelesen lassen | nach `COCKPIT_CHAT_MAIL_NACH_MINUTEN` (Standard 15) eine E-Mail ohne Inhalt, höchstens eine je Stunde |
| `curl -H "Authorization: Bearer <budget-wache>" https://<domain>/intern/chat/verbrauch` | Summen je Tag, keine Kennungen |

Den Nachweis auf echten Geräten für die erste Instanz führt FEWOTEST-69.

## 8. Update, solange es `cockpit-update` noch nicht gibt

Reihenfolge, damit das Cockpit den Erfolg selbst bestätigen kann:

1. Der Betreuer stellt den Antrag im Cockpit (Einstellungen, „Update beantragen“, mit dem neuen Ziel-Digest).
2. Stefan gibt außerhalb des Cockpits frei.
3. Am Server: den neuen Digest an **beiden** Stellen eintragen, dann

   ```bash
   docker compose pull cockpit
   docker compose run --rm cockpit node dist/cli/index.js migrieren
   docker compose up -d cockpit
   ```

4. Die Versions-Wache des Admin-Agenten einmal anstoßen (`version-cockpit`, siehe
   [Agenten-API](agenten-api.md#die-versions-wache)). Ohne diesen Schritt zeigt „Verfügbar" bis zum nächsten
   Tageslauf den Befund von vor dem Update.
5. Prüfen, dass die Einstellungen die neue Version und den neuen Digest zeigen und „Verfügbar" den Stand als aktuell
   meldet.

Solange der Admin-Agent die Statuskette nicht bedient, bleibt der Antrag im Cockpit offen stehen: Erst der Agent
schaltet ihn über `freigegeben` und `laeuft` weiter, und erst dann kann die Selbstmeldung ihn auf `erledigt`
setzen. Das Update selbst läuft trotzdem durch — der offene Antrag ist sichtbar und gewollt, keine Störung.

## 9. Rückweg

Der Regelweg ist **das ältere Image auf der neueren Datenbank**: den vorherigen Digest wieder an beiden Stellen
eintragen, `docker compose pull cockpit`, `docker compose up -d cockpit`. `migrieren` entfällt. Die meisten
Migrationen sind additiv; ein Cockpit, das weniger Migrationen kennt, startet mit einer Warnung im Log. Den Weg
zurück muss man nicht suchen: Der vorherige Digest steht im Antrag.

Erst wenn das nicht reicht, wird die Datenbank zurückgenommen — sie **löscht dabei Daten**. Vorgehen und
Warnungen stehen in der README unter „Rückwärts: wann, von wem, womit“.

## Was hier bewusst nicht vorkommt

- Kein Zugriff des Cockpits auf Docker, SSH oder GHCR. Es fragt auch nie selbst nach neuen Versionen: Was
  verfügbar ist, meldet eine Wache des Admin-Agenten.
- Kein automatisches Migrieren beim Start. Ein Image-Update würde sonst die Datenbank ohne Freigabe verändern.
- Kein bewegliches Tag in der Compose-Datei. Was läuft, ist genau ein Digest.
