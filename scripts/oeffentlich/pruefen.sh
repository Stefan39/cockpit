#!/bin/sh
# Prüft, dass der öffentliche Teil des Repos keine internen Namen enthält (COPI-247).
#
# Geprüft werden alle versionierten Dateien außer denen aus `ausschluss.txt`, gegen die Muster aus `muster.txt`; Treffer
# aus `erlaubt.txt` gelten als begründeter Rest. Die drei Listen liegen nur im privaten Repo. Fehlt `muster.txt`
# (öffentliches Repo), gibt es nichts zu prüfen und das Skript endet erfolgreich.
set -eu
cd "$(dirname "$0")/../.."

liste() { test -f "scripts/oeffentlich/$1" && grep -vE '^(#|$)' "scripts/oeffentlich/$1" | paste -sd'|' - || true; }

muster=$(liste muster.txt)
if [ -z "$muster" ]; then
  echo "Keine Muster hinterlegt, Prüfung übersprungen."
  exit 0
fi
ausschluss=$(liste ausschluss.txt)
erlaubt=$(liste erlaubt.txt)

treffer=$(git ls-files \
  | { if [ -n "$ausschluss" ]; then grep -vE "$ausschluss"; else cat; fi; } \
  | grep -vE '^(package-lock\.json|scripts/oeffentlich/)' \
  | tr '\n' '\0' | xargs -0 grep -nIE "$muster" -- 2>/dev/null \
  | { if [ -n "$erlaubt" ]; then grep -vE "$erlaubt"; else cat; fi; } || true)

if [ -n "$treffer" ]; then
  echo "Interne Namen im öffentlichen Teil:"
  echo "$treffer"
  exit 1
fi
echo "Öffentlicher Teil ohne interne Namen."
