# Architektur-Leitplanken

Auszug aus den Projektregeln: Was das Cockpit ist, woraus es besteht und welche Sicherheitsgrenzen nicht ohne
bewusste Entscheidung verschoben werden.

## Projekt-Überblick

Node.js/TypeScript-Anwendung, **kein PHP, kein Symfony**. Ein Prozess, ein Container, kein zusätzlicher Infrastrukturdienst. Läuft als vierter Dienst neben `n8n`/PostgreSQL/Caddy in jeder Kundeninstanz, zieht ausschließlich ein gepinntes GHCR-Image (nie Quellcode) auf den Kundenservern.

| Baustein | Wahl |
| --- | --- |
| Laufzeit | Node.js LTS, TypeScript (strict) |
| Web-Framework | Fastify, serverseitig gerendert |
| Oberfläche | Nunjucks/Eta + Turbo/Stimulus + Tailwind (im Image gebaut) |
| Datenhaltung | Vorhandene PostgreSQL, eigenes Schema `cockpit` — kein eigener DB-Container |
| Sitzungen | Cookie-Sitzung in Postgres, kein Redis |
| Auth | Better Auth (Argon2id, TOTP, WebAuthn/Passkeys) |
| Push | Web Push (VAPID) + Service Worker, E-Mail als Pflicht-Zweitkanal |
| Echtzeit | Server-Sent Events, kein WebSocket |
| Mail | `nodemailer` über vorhandenen mailcow-SMTP-Zugang |
| Auslieferung | Multi-Stage-Dockerfile → GHCR, SemVer+Digest gepinnt, Renovate |

Bewusst nicht im Stack: Redis, eigener IdP, eigener Push-Server, zweiter DB-Dienst, React/SPA, PHP/Symfony.

## Architektur-Leitplanken (Änderungen nur als bewusster Architektur-Entscheid)

Diese Punkte kommen direkt aus der ADR und sind Sicherheitsgrenzen, keine Stilfragen:

- **Das Cockpit prüft und aktualisiert nichts selbst.** Kein Docker-Socket, kein SSH-Zugang — es ist der einzige öffentlich erreichbare Dienst mit Login. Zustandsdaten kommen ausschließlich aus `cockpit.befund` (vom Admin-Agenten geschrieben) und aus fachlichen Views. Eingriffe (inkl. Updates) laufen ausschließlich über die Tabelle `cockpit.eingriff` bzw. definierte n8n-Webhooks — nie per SSH, nie direkt in Fachtabellen.
- **Updates sind Anträge, keine Aktionen.** Ein Update (Cockpit-Image oder Modul) erzeugt eine Zeile in `cockpit.eingriff` (`art: cockpit-image` oder `art: modul`). Freigabe erfolgt außerhalb des Cockpits, auf dem Meldekanal des Betreuers — außer im Freigabemodus `direkt` (Entscheidung vom 13.10.2026, COPI-141, `docs/adr/0002-freigabe-direkt.md`): dann ist die signierte Bestätigung des Betreuers im Cockpit die Freigabe, getrennt schaltbar für Cockpit und Module, Standard bleibt die Rückfrage. Im Modus `automatisch` (Entscheidung vom 13.10.2026, COPI-142, `docs/adr/0003-update-automatisch.md`) stellt das Cockpit den Antrag selbst, sobald die Versions-Wache ein Update meldet, und gibt ihn direkt frei (Image nur Di 07–09, je Ziel und Tag höchstens einer, kein zweiter Versuch nach Fehlschlag) — ausgeführt wird auch dann nur vom Admin-Agenten. Ausführung übernimmt der Admin-Agent über das eng gefasste Werkzeug `cockpit-update` — niemals das Cockpit selbst. Rolle `betreuer` ist in der Oberfläche nicht vergebbar.
- **Modulseiten sind deklariert, nicht programmiert.** Ein optionaler `cockpit:`-Block in der jeweiligen Agent-Blueprint-YAML (Menüname, Ansichtstyp, View, Spalten, Eingriffe, Rollen-Sichtbarkeit) — genau fünf Ansichtstypen: Liste+Detail, Verlauf, Belegung, Aufgaben, Kennzahlen. Der Vertrag zum Fachmodul ist eine SQL-View mit festen Spaltennamen, nie Code. Ein sechster Ansichtstyp erst „wenn zweimal gebraucht".
- **Die Modul-Registry lebt in der Datenbank** (`cockpit.modul`), nicht im Image — Modul-Updates ohne Image-Wechsel oder Neustart. Der YAML-Block ist in der Oberfläche nicht bearbeitbar.
- **Module gelten für Kundeninstanzen, der Kunde entscheidet über seine Daten** (Entscheidung vom 09.10.2026, COPI-134). Fachmodule sind für `betriebs_admin` (ggf. `betrieb_mitarbeiter`) deklariert; der Betreuer sieht ein Fachmodul nur, wenn der Betriebs-Admin es unter Einstellungen freigibt (`aus` Standard, `lesen`, `entscheiden`; protokolliert, Tabelle `cockpit.modul_betreuer_zugriff`). Technische Module (`art: betrieb`: Server-Zustand, KI-Verbrauch) sieht der Betreuer immer. Das Recht `betreuer_zugriff_freigeben` hat der Betreuer bewusst nicht. Instanz ohne Kunden-Admin (die des Betreibers): Server-Kommando `modul-freigabe`.
- **`kundensichtbar` ist per Default `false`.** Rohbefunde des Admin-Agenten gehen nie direkt an den Kunden — nur der Koordinator-Agent übersetzt in Klartext.
- **Nie physisch löschen, nur als gelöscht markieren** (Entscheidung vom 23.09.2026; mögliche Dokumentationspflichten). Das gilt für Nachrichten, Konten und alle Nachweisdaten, auch wenn ein Konto entfernt wird. Muster: `geloescht_am`/`geloescht_von`, die Trigger-Funktion `cockpit.nie_loeschen()` weist `DELETE` ab (Migration 0024), Fremdschlüssel ohne `CASCADE`/`SET NULL`. Konten werden markiert und ihre Adresse durch einen Platzhalter ersetzt, Zugangsmittel ohne Geheimnis archiviert (COPI-62, Migration 0025). Ausgenommen sind nur technische Kurzzeitdaten ohne Dokumentationswert (Sitzungen, `verification`, `anmeldevorgang`, `passkey_vorgang`, `anmeldeversuch`; Entscheidung vom 23.09.2026) und die abgeleiteten Tageswerte `cockpit.verbrauch_tag` (COPI-98; Entscheidung vom 30.09.2026). Details: README „Nie löschen, nur markieren".
- **Domain ist ein Parameter, aber bei Anlage fest.** Ein Caddy-Site-Block, zwei Fälle (Kundendomain oder `<kuerzel>.example.com`), kein DNS-01, keine Wildcards, Sitzungs-Cookies host-only mit `__Host-`-Präfix. Ein Domainwechsel ist eine Migration, keine Einstellung.
- **Erststart-Bootstrap:** Ohne existierenden Benutzer erzeugt das Cockpit einen Einmal-Token (32 Byte, nur Hash gespeichert), ausgegeben auf `stdout`, nie ein fertiges Passwort. `/erststart/<token>` legt den Betreuer-Zugang mit Passkey an. Der Betriebs-Admin des Kunden bekommt seinen Zugang separat, erst später, per E-Mail-Einladung (3 Std. gültig).
- **Gästeinhalte im Chat werden escaped, nie automatisch verlinkt**.

Wer eine dieser Grenzen anfassen will (z. B. dem Cockpit doch einen direkten Docker-Zugriff geben), bricht die Architektur-Entscheidung dahinter — das ist kein Implementierungsdetail, sondern muss vorher besprochen werden.

