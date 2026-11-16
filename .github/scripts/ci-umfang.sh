#!/bin/sh
# Entscheidet, welche Gates ein PR braucht (COPI-179). Die CI läuft auf einem einzigen Self-hosted-Runner (devbox),
# den sich mehrere Repos teilen; reine Doku-PRs sollen ihn nicht 15 Minuten belegen.
#
# Nutzung:  sh ci-umfang.sh "$GITHUB_EVENT_NAME" >> "$GITHUB_OUTPUT"   (im Workflow)
#           … | sh ci-umfang.sh                                     (Liste der geänderten Dateien auf stdin)
#   $1:     das Ereignis. Bei pull_request vergleicht das Skript den Merge-Commit mit seinem ersten Elternteil
#           (main; Checkout mit fetch-depth: 2). Jedes andere Ereignis (Start von Hand) prüft alles.
#   stdout: tests=true|false und docker=true|false
#
# tests=false nur, wenn ausschließlich Markdown geändert ist. Andere Dateien unter docs/ (beispiele/*.sql, *.yaml)
# lesen die Datenbanktests ein, sie zählen deshalb als Code. Auch bei tests=false laufen die Tests, die Markdown
# lesen (Routentabelle im README, API-Verträge), siehe ci.yaml.
# docker=true, wenn etwas geändert ist, das ins Image kommt oder es baut. .github/ zählt immer voll: eine geänderte
# CI soll sich selbst einmal ganz durchlaufen.
# Ohne Eingabe (Änderungen unbekannt) läuft alles.
set -eu

if [ "$#" -gt 0 ]; then
  if [ "$1" = pull_request ]; then
    git diff --name-only HEAD^1 HEAD | sh "$0"
  else
    sh "$0" </dev/null
  fi
  exit
fi

tests=false
docker=false
leer=true

while IFS= read -r datei || [ -n "$datei" ]; do
  [ -n "$datei" ] || continue
  leer=false
  case "$datei" in
    *.md) ;;
    *) tests=true ;;
  esac
  case "$datei" in
    src/* | views/* | assets/* | db/* | docker/* | config/* | .github/* | \
    package.json | package-lock.json | tsconfig*.json | .dockerignore) docker=true ;;
  esac
done

if [ "$leer" = true ]; then
  tests=true
  docker=true
fi

echo "tests=$tests"
echo "docker=$docker"
