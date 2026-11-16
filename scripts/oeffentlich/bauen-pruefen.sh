#!/bin/sh
# Prüft, dass der öffentliche Teil für sich allein baut (COPI-249): Export in einen Temp-Ordner, dort Typecheck und Lint.
# Fängt Dateien, die auf Ausgeschlossenes zeigen (etwa ein Test, der beim Import eine private View liest).
set -eu
cd "$(dirname "$0")/../.."

ziel=$(mktemp -d)
trap 'rm -rf "$ziel"' EXIT
rmdir "$ziel"
sh scripts/oeffentlich/exportieren.sh "$ziel"
cd "$ziel"
npm run typecheck
npm run lint
echo "Der öffentliche Teil baut für sich allein."
