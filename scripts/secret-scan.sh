#!/bin/sh
# Sucht mit gitleaks nach Geheimnissen im Arbeitsstand (COPI-248): nur die versionierten Dateien, nicht die Historie
# und nicht lokale, ignorierte Dateien wie .env. Nimmt das Programm `gitleaks`, sonst das Docker-Image in der unten
# gepinnten Version. Ein Fund beendet das Skript mit Fehler; Ausnahmen stehen in `.gitleaks.toml`.
set -eu
cd "$(dirname "$0")/.."

IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1
arbeit=$(mktemp -d)
trap 'rm -rf "$arbeit"' EXIT

git ls-files -z --cached --exclude-standard | tr '\0' '\n' | while IFS= read -r datei; do
  test -f "$datei" || continue
  mkdir -p "$arbeit/$(dirname "$datei")"
  cp -p "$datei" "$arbeit/$datei"
done

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks dir "$arbeit" --config .gitleaks.toml --redact --verbose --no-banner --exit-code 1
else
  docker run --rm -v "$arbeit:/scan:ro" -v "$PWD/.gitleaks.toml:/gitleaks.toml:ro" "$IMAGE" \
    dir /scan --config /gitleaks.toml --redact --verbose --no-banner --exit-code 1
fi
