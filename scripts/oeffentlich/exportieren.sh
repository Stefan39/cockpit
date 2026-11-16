#!/bin/sh
# Schreibt den öffentlichen Teil des Repos in einen neuen, leeren Ordner (COPI-249, Grundlage für COPI-251): alle
# versionierten Dateien außer denen aus `ausschluss.txt`, ohne `.git`, ohne Historie. Der Ordner bekommt einen Link auf
# `node_modules`, damit sich Typecheck, Lint und Tests dort sofort ausführen lassen.
#
#   sh scripts/oeffentlich/exportieren.sh <zielordner>
set -eu
cd "$(dirname "$0")/../.."

ziel=${1:?Nutzung: exportieren.sh <zielordner>}
if [ -e "$ziel" ] && [ -n "$(ls -A "$ziel" 2>/dev/null)" ]; then
  echo "Der Zielordner $ziel ist nicht leer." >&2
  exit 1
fi
mkdir -p "$ziel"

ausschluss=$(grep -vE '^(#|$)' scripts/oeffentlich/ausschluss.txt 2>/dev/null | paste -sd'|' - || true)
git ls-files | { if [ -n "$ausschluss" ]; then grep -vE "$ausschluss"; else cat; fi; } | while IFS= read -r datei; do
  mkdir -p "$ziel/$(dirname "$datei")"
  cp -p "$datei" "$ziel/$datei"
done
test -d node_modules && ln -s "$PWD/node_modules" "$ziel/node_modules"
echo "Öffentlicher Teil nach $ziel geschrieben."
