# 0002 — Freigabemodus „direkt": die Bestätigung im Cockpit ist die Freigabe

- **Status:** angenommen, 13.10.2026 (COPI-141, Entscheidung Stefan)
- **Bezug:** Architektur-Vorschlag, Abschnitt 13.1 („Updates sind Anträge, keine Aktionen"; Freigabe außerhalb des
  Cockpits auf Stefans Meldekanal)
- **Ändert:** die Regel „Freigabe außerhalb des Cockpits" wird abschaltbar, getrennt für Cockpit-Image und Module

## Kontext

Bis COPI-141 brauchte jedes Update zwei Bestätigungen derselben Person: den Antrag im Cockpit (mit signierter
Bestätigungsseite) und die Freigabe in Slack, die der Admin-Agent einholt. Seit COPI-140 kommt das Ziel aus der
Versions-Wache, getippt wird nichts mehr. Stefan will die Slack-Rückfrage vorerst behalten, sie aber abschalten können,
sobald der Ablauf stabil läuft: dann soll der Klick im Cockpit genügen, und Slack meldet nur das Ergebnis.

## Entscheidung

Zwei Modi, getrennt für **Cockpit** und **Module** (nicht je Modul):

| Modus | Antrag steht danach auf | Freigabe |
| --- | --- | --- |
| `rueckfrage` (Standard) | `beantragt` | außerhalb des Cockpits, wie in der ADR |
| `direkt` | `freigegeben` | die signierte Bestätigung des Betreuers im Cockpit |

- **Ausgeführt wird weiterhin nur vom Admin-Agenten.** Das Cockpit bekommt nichts dazu: kein Docker-Socket, kein SSH,
  kein Coolify-Zugang. Es schreibt im Modus `direkt` nur einen Statuswechsel mehr in `cockpit.eingriff`, in derselben
  Transaktion wie den Antrag, mit Protokoll `update_freigegeben` (`weg: direkt`, Akteur das Konto).
- **Der Modus ist ein Snapshot.** Er steht beim Antrag in `eingriff.freigabe_modus` und danach fest (Datenbank). Ein
  späterer Wechsel der Einstellung ändert keinen laufenden Antrag; der Agent liest den Modus aus dem Eingriff.
- **Nur mit Ziel der Versions-Wache.** Ein getipptes Ziel (Notweg „Bestimmten Stand wählen", oft der Weg zurück) bleibt
  immer bei der Rückfrage. Beim Image fehlte dafür auch die Version, die zum Erfolgsbeleg gehört (ADR 0001); die Wache
  meldet sie mit.
- **Rückzug bis zum Start.** Ein direkt freigegebener Antrag lässt sich zurückziehen, bis der Agent `laeuft` meldet
  (Kante `freigegeben → zurueckgezogen`, nur bei `direkt`). So bleibt ein Fehlklick korrigierbar, ohne Rückfrage.
- **Umschalten** darf nur, wer beantragen darf (der Betreuer, Rolle in der Oberfläche nicht vergebbar). Der Wechsel auf
  `direkt` braucht eine Bestätigungsseite; jede Änderung ist eine neue Zeile (`cockpit.update_freigabemodus`, nur
  anhängen) und ein Protokolleintrag mit alt → neu.

## Folgen

- Im Modus `direkt` hängt die Sicherheit eines Updates an der Anmeldung des Betreuers (Passkey bzw. zweiter Faktor) und an
  der signierten, an Herkunft und Ziel gebundenen Bestätigung, nicht mehr an einem zweiten Kanal. Wer das Betreuer-Konto
  übernimmt, kann ein Update auslösen — aber nur auf ein Ziel, das die Versions-Wache gemeldet hat.
- Der Admin-Agent muss `freigabe_modus` auswerten (JAC-723): `direkt` ohne Rückfrage ausführen, `laeuft` vor dem ersten
  Handgriff melden und bei `409` (zurückgezogen) nichts tun.
- Standard bleibt `rueckfrage`. Eine neue Instanz verhält sich wie vor COPI-141.

## Verworfen

- **Modus je Modul** — mehr Schalter ohne erkennbaren Nutzen; Module verhalten sich gleich.
- **Das Cockpit führt selbst aus** — bricht die ADR (kein Docker-/SSH-Zugang) und ist mit dieser Entscheidung nicht
  gemeint.
- **Modus zur Ausführung lesen statt beim Antrag** — dann änderte ein Umschalten nachträglich, wie ein schon gestellter
  Antrag freigegeben wird.
