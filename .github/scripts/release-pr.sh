#!/bin/sh
# Release-PR automatisch anlegen oder aktualisieren (COPI-236, ADR COPI-211 Teil A). Der Workflow release-pr.yaml
# ruft `anwenden` nach jedem Push auf main auf; die übrigen Unterbefehle sind die prüfbaren Bausteine davon
# (geprüft in test/release-pr.test.ts).
#
#   plan              Entscheidung als Zeilen "schluessel=wert": aktion (nichts | anlegen | aktualisieren), grund,
#                     version, letzter. Liest nur Git (Tags v*, Zweige origin/release/*), ruft nichts auf.
#   liste <letzter>   gemergte PRs seit dem Tag v<letzter> als Markdown-Liste
#   anheben <alt> <neu>   hebt die Version in package.json und package-lock.json an (ohne node)
#   json              liest Text von stdin und schreibt ihn als JSON-String
#   anwenden          führt die Entscheidung aus (braucht GH_TOKEN und GITHUB_REPOSITORY)
#
# Release-PRs werden hier per Merge-Commit gemergt: der Betreff des Head-Commits heißt dann "Merge pull request #N
# from …/release/X.Y.Z" und beginnt nicht mit "release: ". Darum bremst nicht nur der Betreff, sondern vor allem die
# Version: steht in package.json eine Version, die noch kein Tag hat, läuft ein Release (release.yaml legt den Tag
# erst nach dem Image-Build an), und es entsteht kein weiterer Release-PR.
set -eu

FORM='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
BOT_NAME='Cockpit Release'
BOT_MAIL='346473680+jacomeit-dev[bot]@users.noreply.github.com'

nach_semver() { sort -t. -k1,1n -k2,2n -k3,3n; }

paket_version() { sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' package.json | head -n 1; }

letztes_release() { git tag -l 'v*' | grep -Ex "v$FORM" | sed 's/^v//' | nach_semver | tail -n 1 || true; }

offener_release_zweig() {
  git for-each-ref --format='%(refname:strip=4)' refs/remotes/origin/release/ | grep -Ex "$FORM" | nach_semver | tail -n 1 || true
}

nichts() {
  echo "aktion=nichts"
  echo "grund=$1"
}

plan() {
  version=$(paket_version)
  if ! printf '%s\n' "$version" | grep -Eqx "$FORM"; then
    echo "Die Version \"$version\" in package.json ist keine Release-Version (X.Y.Z ohne Zusatz)." >&2
    exit 1
  fi
  letzter=$(letztes_release)
  if [ -z "$letzter" ]; then
    nichts "Es gibt noch kein Release-Tag (v*)"
    return 0
  fi
  if [ "$version" != "$letzter" ]; then
    nichts "Version $version in package.json hat noch keinen Tag (letzter Tag v$letzter): ein Release läuft oder steht an"
    return 0
  fi
  betreff=$(git log -1 --format=%s HEAD)
  case "$betreff" in
    'release: '* | *'from '*'/release/'*)
      nichts "Der Head-Commit gehört zu einem Release-PR: $betreff"
      return 0
      ;;
  esac
  if [ "$(git rev-list --count "v$letzter..HEAD")" -eq 0 ]; then
    nichts "Seit v$letzter gibt es keine neuen Commits auf main"
    return 0
  fi
  offen=$(offener_release_zweig)
  if [ -n "$offen" ] && [ "$offen" != "$letzter" ] \
    && [ "$(printf '%s\n%s\n' "$letzter" "$offen" | nach_semver | tail -n 1)" = "$offen" ]; then
    echo "aktion=aktualisieren"
    echo "version=$offen"
  else
    echo "aktion=anlegen"
    echo "version=$(printf '%s\n' "$letzter" | awk -F. '{ printf "%d.%d.0", $1, $2 + 1 }')"
  fi
  echo "letzter=$letzter"
}

# Gemergte PRs seit dem Tag: bei einem Merge-Commit "#N Titel" (der Titel steht im Text des Commits), bei einem
# Squash-Commit der Betreff. Der Merge des Release-PR selbst gehört nicht in die Liste.
liste() {
  git log "v$1..HEAD" --first-parent --format='%s%x1f%b%x1e' | awk '
    BEGIN { RS = "\036"; FS = "\037" }
    {
      sub(/^[ \n]+/, "", $1)
      betreff = $1
      if (betreff == "" || betreff ~ /^release: / || betreff ~ /\/release\//) next
      if (betreff ~ /^Merge pull request #[0-9]+ from /) {
        nr = betreff
        sub(/^Merge pull request #/, "", nr)
        sub(/ .*/, "", nr)
        titel = $2
        sub(/^[ \n]+/, "", titel)
        sub(/\n.*/, "", titel)
        if (titel == "") titel = betreff
        printf "- #%s %s\n", nr, titel
      } else {
        printf "- %s\n", betreff
      }
    }'
}

# Ersetzt genau die Zeilen mit der Version: package.json einmal, package-lock.json zweimal (Kopf und Eintrag des
# Pakets selbst, nicht die Version einer Abhängigkeit, die zufällig gleich lautet). Fehlt eine Stelle, bricht es ab.
anheben() {
  alt=$1
  neu=$2
  for datei in package.json package-lock.json; do
    erwartet=1
    [ "$datei" = package-lock.json ] && erwartet=2
    awk -v alt="$alt" -v neu="$neu" -v erwartet="$erwartet" '
      BEGIN {
        a = "  \"version\": \"" alt "\","
        b = "      \"version\": \"" alt "\","
      }
      !x && $0 == a { print "  \"version\": \"" neu "\","; x = 1; next }
      erwartet == 2 && !y && $0 == b { print "      \"version\": \"" neu "\","; y = 1; next }
      { print }
      END { if (!x || (erwartet == 2 && !y)) exit 1 }' "$datei" > "$datei.neu" \
      || { rm -f "$datei.neu"; echo "Die Version $alt steht nicht an den erwarteten Stellen in $datei." >&2; exit 1; }
    mv "$datei.neu" "$datei"
  done
}

json_text() {
  printf '"'
  tr -d '\r' | tr '\t' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{ printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }'
  printf '"'
}

pr_text() {
  echo "Automatisch angelegt von \`release-pr.yaml\` (COPI-236). Nach dem Merge baut \`release.yaml\` Tag, Image und GitHub-Release und stößt die Versions-Wache an."
  echo
  echo "Version $1, Minor-Sprung gegenüber v$2."
  echo
  echo "## Gemergte PRs seit v$2"
  echo
  echo "$3"
  echo
  echo "Stand: $(git rev-parse --short HEAD) auf main."
}

zusammenfassung() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}

api() {
  if [ -n "${3:-}" ]; then
    curl -sS -m 60 -o "$ARBEIT/antwort.json" -w '%{http_code}' -X "$1" \
      -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: cockpit-release-pr' \
      -H 'Content-Type: application/json' --data-binary "@$3" "https://api.github.com/repos/$GITHUB_REPOSITORY$2"
  else
    curl -sS -m 60 -o "$ARBEIT/antwort.json" -w '%{http_code}' -X "$1" \
      -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: cockpit-release-pr' \
      "https://api.github.com/repos/$GITHUB_REPOSITORY$2"
  fi
}

# Die Antworten der GitHub-API sind nur für `curl/…` als User-Agent eingerückt, sonst kompakt (COPI-252): ohne Rücksicht
# auf Zeilen und Einrückung lesen. Das erste Vorkommen gehört zum PR selbst, die verschachtelten Objekte folgen danach.
pr_nummer() { grep -o '"number": *[0-9][0-9]*' | head -n 1 | grep -o '[0-9][0-9]*$' || true; }
pr_url() { grep -o '"html_url": *"https:[^"]*/pull/[0-9][0-9]*"' | head -n 1 | sed 's/^"html_url": *"//; s/"$//' || true; }

pruefen() {
  case "$1" in
    2??) ;;
    *)
      echo "GitHub-API $2: HTTP $1" >&2
      cat "$ARBEIT/antwort.json" >&2
      exit 1
      ;;
  esac
}

anwenden() {
  : "${GH_TOKEN:?GH_TOKEN fehlt}" "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY fehlt}"
  ARBEIT=$(mktemp -d)
  trap 'rm -rf "$ARBEIT"' EXIT
  ergebnis=$(plan)
  wert() { printf '%s\n' "$ergebnis" | sed -n "s/^$1=//p" | head -n 1; }
  aktion=$(wert aktion)
  if [ "$aktion" = nichts ]; then
    zusammenfassung "Release-PR: nichts zu tun. $(wert grund)."
    return 0
  fi
  version=$(wert version)
  letzter=$(wert letzter)
  zweig="release/$version"
  text=$(pr_text "$version" "$letzter" "$(liste "$letzter")")

  if [ "$aktion" = anlegen ]; then
    git checkout -q -B "$zweig"
    anheben "$letzter" "$version"
    git add package.json package-lock.json
    git -c user.name="$BOT_NAME" -c user.email="$BOT_MAIL" commit -q -m "release: $version"
    git push -q origin "$zweig"
    { printf '{"title":"release: %s","head":"%s","base":"main","body":' "$version" "$zweig"; printf '%s' "$text" | json_text; printf '}'; } > "$ARBEIT/pr.json"
    code=$(api POST /pulls "$ARBEIT/pr.json")
    pruefen "$code" "POST /pulls"
    url=$(pr_url < "$ARBEIT/antwort.json")
    zusammenfassung "Release-PR angelegt: release: $version ($url)"
    return 0
  fi

  owner=${GITHUB_REPOSITORY%%/*}
  echo '{}' > "$ARBEIT/leer.json"
  code=$(api GET "/pulls?state=open&base=main&head=$owner:$zweig")
  pruefen "$code" "GET /pulls"
  nummer=$(pr_nummer < "$ARBEIT/antwort.json")
  if [ -z "$nummer" ]; then
    echo "Der Zweig $zweig existiert, aber es gibt keinen offenen PR dazu. Zweig löschen oder den PR öffnen." >&2
    exit 1
  fi
  { printf '{"body":'; printf '%s' "$text" | json_text; printf '}'; } > "$ARBEIT/text.json"
  code=$(api PATCH "/pulls/$nummer" "$ARBEIT/text.json")
  pruefen "$code" "PATCH /pulls/$nummer"
  # Hinter main steht der PR auf "veraltet", und der Branch-Schutz verlangt den aktuellen Stand. Der Merge von main
  # in den Release-Zweig bringt keinen Inhalt, nur den Stand; schlägt er fehl, bleibt der Text trotzdem aktuell.
  code=$(api PUT "/pulls/$nummer/update-branch" "$ARBEIT/leer.json")
  case "$code" in
    202) stand="Zweig auf den Stand von main gebracht" ;;
    *) stand="Zweig nicht aktualisiert (HTTP $code), bitte im PR prüfen" ;;
  esac
  zusammenfassung "Release-PR #$nummer ($zweig) aktualisiert: neue Liste der PRs. $stand."
}

case "${1:-}" in
  plan) plan ;;
  liste) liste "${2:?Nutzung: release-pr.sh liste <letzter>}" ;;
  anheben) anheben "${2:?Nutzung: release-pr.sh anheben <alt> <neu>}" "${3:?Nutzung: release-pr.sh anheben <alt> <neu>}" ;;
  nummer) pr_nummer ;;
  url) pr_url ;;
  json) json_text ;;
  anwenden) anwenden ;;
  *)
    echo "Nutzung: release-pr.sh plan | liste <letzter> | anheben <alt> <neu> | nummer | url | json | anwenden" >&2
    exit 2
    ;;
esac
