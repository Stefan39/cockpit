#!/bin/sh
# Entscheidet, ob der Stand auf main ein Release wird (COPI-49). Ein Release entsteht per Release-PR: er hebt die
# Version in package.json an, Stefan gibt ihn frei, und nach dem Merge veröffentlicht der Release-Workflow genau
# diese Version. Niemand setzt Tags von Hand.
#
# Nutzung:  git ls-remote --tags --refs origin 'v*' | sed 's#.*refs/tags/##' | sh release-version.sh <version>
#   stdin:  die vorhandenen Tags, einer je Zeile (v0.1.0 …); andere Zeilen werden übergangen
#   stdout: "neu" (Version ist noch nicht veröffentlicht) oder "vorhanden" (nichts zu tun)
#   Exit 1: die Version ist keine Release-Version, oder sie ist kleiner als das jüngste Release
#
# Release-Versionen sind X.Y.Z ohne Zusatz. Vorabversionen (1.0.0-rc.1) kennt die Datenbank zwar als Ziel-Version
# (eingriff_ziel_version_form), dieser Workflow veröffentlicht sie aber nicht: ihre Reihenfolge ließe sich hier
# nur mit einem vollständigen SemVer-Vergleich prüfen, und gebraucht werden sie bisher nicht.
set -eu

FORM='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'

if [ "$#" -ne 1 ]; then
  echo "Nutzung: release-version.sh <version>  (vorhandene Tags auf stdin)" >&2
  exit 2
fi
version="$1"

if ! printf '%s\n' "$version" | grep -Eqx "$FORM"; then
  echo "Die Version \"$version\" in package.json ist keine Release-Version (X.Y.Z ohne Zusatz)." >&2
  exit 1
fi

# Nur Tags in Release-Form zählen, ohne das führende v.
releases=$(grep -Ex "v$FORM" | sed 's/^v//' || true)

if printf '%s\n' "$releases" | grep -Fqx "$version"; then
  echo vorhanden
  exit 0
fi

nach_semver() { sort -t. -k1,1n -k2,2n -k3,3n; }
juengstes=$(printf '%s\n' "$releases" | grep . | nach_semver | tail -n 1 || true)
if [ -n "$juengstes" ] && [ "$(printf '%s\n%s\n' "$juengstes" "$version" | nach_semver | tail -n 1)" != "$version" ]; then
  echo "Die Version $version ist kleiner als das jüngste Release v$juengstes. Ein Release-PR hebt die Version an." >&2
  exit 1
fi

echo neu
