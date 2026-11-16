#!/usr/bin/env bash
# Prüft eine .env, bevor ./dev sie per Shell lädt (COPI-63).
#
#   bash docker/env-pruefen.sh <datei>
#
# Eine Zeile, an der die Shell scheitert, lädt ./dev nur halb: alles nach der Fehlerstelle fehlt, der
# Dev-Server läuft trotzdem an. Deshalb wird jede Zeile vorher geprüft. Erlaubt sind Kommentare, Leerzeilen
# und NAME=Wert (optional mit `export`), wobei der Wert
#   * ohne Anführungszeichen keine Leerzeichen und keine Shell-Sonderzeichen enthält,
#   * in einfachen Anführungszeichen steht (dort ist alles wörtlich, auch ${, !, # und ;), oder
#   * in doppelten Anführungszeichen ohne $, ` und \ steht.
# Dahinter darf ein Kommentar stehen. Mehrzeilige Werte gibt es nicht.
#
# Meldungen nennen Zeile und Namen, NIE den Wert: in der .env stehen Secrets. Exit 1 bei einem Fehler,
# sonst 0; halb eingerichtete Paare sind nur eine Warnung.
set -u

datei="${1:?Nutzung: env-pruefen.sh <datei>}"

ZUWEISUNG='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
REST='([[:space:]]+#.*)?[[:space:]]*$'
EINFACH="^'[^']*'${REST}"
DOPPELT="^\"[^\"\`\$\\]*\"${REST}"
OHNE="^[^[:space:]'\"\`\$\\;&|<>(){}]*${REST}"
LEER="^(''|\"\")?${REST}"
UEBERSPRINGEN='^[[:space:]]*(#.*)?$'

fehler=0
nr=0
gesetzt=" "

melde() { printf 'Fehler in %s, Zeile %s%s: %s\n' "$datei" "$nr" "$1" "$2" >&2; fehler=1; }

while IFS= read -r zeile || [ -n "$zeile" ]; do
  nr=$((nr + 1))
  if [[ "$zeile" == *$'\r'* ]]; then
    name=""
    [[ "$zeile" =~ $ZUWEISUNG ]] && name=" (${BASH_REMATCH[2]})"
    melde "$name" 'Windows-Zeilenende (CRLF). Die Datei mit LF speichern.'
    continue
  fi
  [[ "$zeile" =~ $UEBERSPRINGEN ]] && continue
  if ! [[ "$zeile" =~ $ZUWEISUNG ]]; then
    melde "" 'keine Zuweisung der Form NAME=Wert.'
    continue
  fi
  name="${BASH_REMATCH[2]}"
  wert="${BASH_REMATCH[3]}"
  case "$wert" in
    "'"*) [[ "$wert" =~ $EINFACH ]] \
      || melde " ($name)" 'einfaches Anführungszeichen nicht geschlossen, oder Text direkt dahinter.' ;;
    '"'*) [[ "$wert" =~ $DOPPELT ]] \
      || melde " ($name)" "doppelte Anführungszeichen nicht geschlossen oder mit \$, \` oder \\ darin. Den Wert in einfache Anführungszeichen setzen." ;;
    *) [[ "$wert" =~ $OHNE ]] \
      || melde " ($name)" 'Leerzeichen oder Shell-Sonderzeichen ohne Anführungszeichen. Den Wert in einfache Anführungszeichen setzen.' ;;
  esac
  [[ "$wert" =~ $LEER ]] || gesetzt="$gesetzt$name "
done < "$datei"

# Paare, die nur zusammen gelten. Das Cockpit bricht bei einem halben Paar ohnehin ab (COPI-54, COPI-59).
for paar in COCKPIT_KOORDINATOR_URL:COCKPIT_KOORDINATOR_SECRET COCKPIT_VAPID_PUBLIC_KEY:COCKPIT_VAPID_PRIVATE_KEY; do
  a="${paar%%:*}"
  b="${paar#*:}"
  case "$gesetzt" in *" $a "*) hat_a=1 ;; *) hat_a=0 ;; esac
  case "$gesetzt" in *" $b "*) hat_b=1 ;; *) hat_b=0 ;; esac
  [ "$hat_a" = 1 ] && [ "$hat_b" = 0 ] && printf 'Warnung: %s: %s ist gesetzt, %s fehlt.\n' "$datei" "$a" "$b" >&2
  [ "$hat_b" = 1 ] && [ "$hat_a" = 0 ] && printf 'Warnung: %s: %s ist gesetzt, %s fehlt.\n' "$datei" "$b" "$a" >&2
done

exit "$fehler"
