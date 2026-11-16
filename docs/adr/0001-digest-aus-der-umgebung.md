# 0001 — Der Digest kommt aus der Umgebung, die Version aus dem Build

- **Status:** angenommen, 21.09.2026 (COPI-39)
- **Bezug:** Architektur-Vorschlag, Abschnitt 13.1, Punkt 6 („Erfolgsbeleg")
- **Klarstellt:** die Formulierung „ins Image gebackener Digest"

## Kontext

Die ADR verlangt, dass das neue Cockpit beim Start „seinen ins Image gebackenen Digest nach `cockpit.instanz`"
schreibt; erst das bestätigt ein Update („ein Cockpit mit dem Ziel-Digest hat sich gemeldet", nicht „der Befehl
lief ohne Fehler durch").

Ein Image kann seinen eigenen Digest nicht enthalten: der Digest ist ein Hash über den Inhalt des Images. Jede
Datei, die ihn trüge, änderte den Inhalt und damit den Digest. Dockerfile und Release-Workflow enthielten bis
COPI-39 auch nichts dergleichen.

## Entscheidung

| Wert | Woher | Wo festgelegt |
| --- | --- | --- |
| **Version** (SemVer) | beim Bauen gebacken: Build-Argument `COCKPIT_VERSION`, im Release die geprüfte Version aus `package.json` (COPI-49; den Tag legt der Workflow danach an) | `docker/Dockerfile` (Laufzeit-Stage), `.github/workflows/release.yaml` |
| **Commit** | beim Bauen gebacken: Build-Argument `COCKPIT_COMMIT` (`github.sha`), gemeldet als SemVer-Build-Metadatum (`1.4.0+0123456`) | wie oben |
| **Digest** | aus der Umgebung: `COCKPIT_IMAGE_DIGEST` in der Compose-Datei der Instanz, **derselbe `<DIGEST>`-Platzhalter wie die `image:`-Zeile** — beide werden zugleich ersetzt und stimmen damit immer überein | `docker/compose.fragment.yaml` |

Beim Start schreibt das Cockpit Version und Digest nach `cockpit.instanz` (eine Zeile, jeder Start ersetzt sie),
**bevor** es lauscht: wer auf `/gesund` antwortet, hat sich gemeldet.

- **Nie wird ein Wert erfunden.** Ein fehlender oder kaputter Digest (etwa der nicht ersetzte Platzhalter) bleibt
  NULL, mit Hinweis im Log. Ein erfundener Digest könnte ein Update bestätigen, das nicht stattgefunden hat.
- **Eine kaputte Versionsbeschriftung hält den Start nicht auf:** dann gilt die Version aus `package.json`, mit
  Hinweis. Ohne Build-Argumente (lokal) meldet sich das Cockpit als `<package.json>+lokal`.
- **Scheitert das Schreiben, startet das Cockpit nicht:** ohne Meldung ließe sich ein Update nie bestätigen.

## Folgen

- Der Erfolg eines Updates (COPI-41) heißt: ein Cockpit hat sich mit dem **Ziel-Digest** gemeldet, und die
  gebackene Version passt zum Antrag.
- Wer das Compose-Fragment beim Server-Setup ausfüllt, ersetzt `<DIGEST>` an zwei Stellen. Ein statischer Test
  (`test/image-version.test.ts`) prüft, dass beide Zeilen denselben Platzhalter tragen; der Smoke-Test des Images
  (`docker/smoke-schema.sh`, Gate 6) prüft, dass das gestartete Image Version und Digest meldet.
- Die Anzeige („Versionen" in den Einstellungen) liest den laufenden Digest aus `cockpit.instanz`, den Soll-Digest
  aus einem offenen Antrag (`cockpit.eingriff`) und die verfügbare Version aus dem Befund der Versions-Wache
  (`version-cockpit`). Das Cockpit fragt GHCR nie selbst (ADR 4).

## Verworfen

- **Digest in eine Datei im Image schreiben** — unmöglich (siehe Kontext).
- **Digest zur Laufzeit ermitteln** (Docker-Socket, Registry-Abfrage) — bricht die ADR: das Cockpit hat keinen
  Docker-Zugang und fragt GHCR nie selbst.
- **Nur die Version prüfen** — eine Version lässt sich neu bauen und bezeichnet dann ein anderes Image; nur der
  Digest benennt genau eines.
