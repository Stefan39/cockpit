# 0003 — Freigabemodus „automatisch": das Cockpit stellt den Antrag selbst

- **Status:** angenommen, 13.10.2026 (COPI-142, Entscheidung Stefan), umgesetzt 19.10.2026
- **Bezug:** Architektur-Vorschlag, Abschnitt 13.1 („Updates sind Anträge, keine Aktionen"); [ADR 0002](0002-freigabe-direkt.md)
- **Ändert:** wer den Antrag stellt. Bisher immer ein Mensch im Cockpit, im Modus `automatisch` das Cockpit selbst

## Kontext

Seit COPI-140 kommt das Ziel eines Updates aus der Versions-Wache, seit COPI-141 genügt auf Wunsch der Klick im Cockpit
als Freigabe. Stefan will am Ende gar keinen Klick mehr: ist ein Update gemeldet, wird es installiert, und Slack meldet
nur „erfolgreich installiert" (oder den Fehlschlag). Das ist die dritte Stufe nach „Rückfrage" und „Direkt".

## Entscheidung

Ein dritter Modus `automatisch`, getrennt für **Cockpit** und **Module**, Standard bleibt `rueckfrage`.

- **Das Cockpit beantragt, es führt nicht aus.** Ein Planer im Server-Prozess (jede Minute) stellt den Antrag über
  denselben Weg wie der Klick und setzt ihn wie bei `direkt` in derselben Transaktion auf `freigegeben`. Ausgeführt wird
  weiterhin nur vom Admin-Agenten mit `cockpit-update`, mit Rückweg bei Fehlschlag. Das Cockpit bekommt nichts dazu: kein
  Docker-Socket, kein SSH, kein Registry-Zugang, keine eigene Verbindung nach außen.
- **Für den Agenten ist ein automatischer Antrag ein direkter** (`freigabe_modus: direkt`). Das Merkmal `automatisch` am
  Eingriff (nach dem Antrag fest) unterscheidet ihn für Oberfläche, Protokoll (`weg: automatisch`) und Schleifenschutz.
- **Antragsteller ist das Konto, das den Bereich umgestellt hat.** Ist es kein aktiver Betreuer mehr, ruht die Automatik.
- **Nur ein Ziel der Versions-Wache**, beim Image mit Version (Erfolgsbeleg) und nur im **Wartungsfenster** Dienstag
  07:00–09:00 (Europe/Berlin). Module jederzeit, nur mit Herkunft unter `module/`.
- **Schleifenschutz:** höchstens ein automatischer Antrag je Image bzw. Modul und Kalendertag; kein neuer für ein Ziel,
  auf das ein Antrag gescheitert ist oder dessen automatischer Antrag zurückgezogen wurde, bis die Wache ein anderes Ziel
  meldet. Geprüft in der Transaktion des Antrags, unter der Sperre des Bereichs.
- **Umschalten** wie bei `direkt`: nur der Betreuer, mit Bestätigungsseite, jede Änderung eine neue Zeile und ein
  Protokolleintrag.

## Folgen

- Ein Update kann ohne jeden Menschen installiert werden. Die Sicherheit hängt an der Versions-Wache des Admin-Agenten
  (sie meldet das Ziel) und an der Registry bzw. agent-blueprints, aus der sie es liest — nicht mehr an einer Anmeldung.
  Wer die Wache dazu bringt, ein falsches Ziel zu melden, löst ein Update aus. Deshalb ist `automatisch` eine bewusste
  Einstellung je Bereich und nie der Standard.
- Ein fehlerhaftes Ziel wird genau einmal versucht. Danach meldet der Agent den Fehlschlag (Wache rot, Slack), und die
  Karte im Cockpit sagt „Automatik für dieses Ziel gesperrt"; von Hand bleibt das Ziel beantragbar.
- Der Vertrag mit dem Agenten bleibt unverändert (JAC-723 genügt); neu ist nur das Feld `automatisch` in der API.

## Verworfen

- **Das Cockpit führt selbst aus** — bricht die ADR, wie schon in 0002.
- **Der Agent stellt den Antrag** — dann bräuchte er ein Recht zum Beantragen, und die Einstellung lebte an zwei Orten.
- **Ein eigener Wert `automatisch` in `freigabe_modus`** — der Agent hätte ihn auswerten müssen, ohne dass sich für ihn
  etwas ändert.
- **Wartungsfenster auch für Module** — Modul-Updates sind View und Block, ohne Neustart; Stefan will sie sofort.
