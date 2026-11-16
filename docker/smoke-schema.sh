#!/bin/sh
# Smoke-Test des Images gegen eine echte PostgreSQL (COPI-31): auf einer LEEREN Datenbank
# entsteht mit dem Image das Schema, und danach startet das Cockpit.
#
# Bis COPI-31 baute die CI das Image und startete es nie gegen eine Datenbank: dass es auf einer
# neuen Instanz weder Migrationen noch Runner enthielt und beim Start mit einem SQL-Fehler abbrach,
# fiel erst beim Blick ins Image auf. Dieses Skript spielt genau den Weg einer neuen Instanz nach:
#
#   1. Ohne Schema startet das Cockpit nicht: Exit 3 und eine Meldung, die die Migration und den
#      Befehl nennt (kein SQL-Fehler).
#   2. `migrieren` legt das Schema an; ein zweiter Aufruf tut nichts; `--status` zeigt nichts Offenes.
#   3. Danach startet das Cockpit, `/gesund` antwortet, und das Erststart-Token steht im Log.
#   4. Das Cockpit hat sich gemeldet (COPI-39): in `cockpit.instanz` stehen die gebackene Version und der Digest
#      aus der Umgebung. `SMOKE_VERSION` (optional) ist die erwartete Version, etwa `0.0.0-ci+0123456`; ohne sie
#      prüft das Skript nur die Form.
#
# Nutzung:
#   docker/smoke-schema.sh <image> <datenbank-url> [docker-run-optionen ...]
# Die URL gilt aus Sicht des Containers; die Optionen (Netz, Port) reicht der Aufrufer durch.
#   CI:    SMOKE_URL=http://127.0.0.1:39105 sh docker/smoke-schema.sh cockpit:ci \
#            postgres://cockpit:cockpit@<netz>-db:5432/cockpit --network <netz> -p 127.0.0.1:39105:3000
#          (eigenes Docker-Netz mit PostgreSQL, damit es auch unter rootless Docker auf der devbox läuft, JAC-770)
#   lokal: SMOKE_URL=http://localhost:3105 sh docker/smoke-schema.sh cockpit:ci \
#            postgres://postgres:dev@host.docker.internal:5432/cockpit_smoke -p 3105:3000
# `SMOKE_URL` ist die Adresse, unter der das Cockpit vom Aufrufer aus erreichbar ist
# (Vorgabe http://localhost:3000). Die Datenbank muss leer sein; das Skript legt sie nicht an.
set -eu

IMAGE=${1:?Nutzung: smoke-schema.sh <image> <datenbank-url> [docker-run-optionen ...]}
DB=${2:?Nutzung: smoke-schema.sh <image> <datenbank-url> [docker-run-optionen ...]}
shift 2
URL=${SMOKE_URL:-http://localhost:3000}
NAME="cockpit-smoke-$$"
LOG=$(mktemp)
SECRET=$(head -c 32 /dev/urandom | base64)
# Ein Digest der richtigen Form, wie ihn die Compose-Datei der Instanz setzt (COPI-39).
DIGEST="sha256:$(printf '5a%.0s' $(seq 1 32))"
# Netz und Port des Aufrufers, einfache Wörter (`--network host`, `-p 3105:3000`).
OPTIONEN="$*"

trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f "$LOG"' EXIT

fehler() {
  echo "SMOKE-TEST FEHLGESCHLAGEN: $1" >&2
  echo "--- Ausgabe ---" >&2
  cat "$LOG" >&2 || true
  exit 1
}

# Das Image mit seinem Startbefehl, mit der Umgebung, wie compose sie setzt.
starten() {
  # shellcheck disable=SC2086
  docker run "$@" $OPTIONEN -e DATABASE_URL="$DB" -e NODE_ENV=production -e BETTER_AUTH_SECRET="$SECRET" \
    -e COCKPIT_IMAGE_DIGEST="$DIGEST" "$IMAGE"
}
# Das Server-Kommando aus dem Image: `cli migrieren --status`.
cli() {
  # shellcheck disable=SC2086
  docker run --rm $OPTIONEN -e DATABASE_URL="$DB" "$IMAGE" node dist/cli/index.js "$@"
}

echo "1. Ohne Schema startet das Cockpit nicht"
set +e
starten --rm >"$LOG" 2>&1
CODE=$?
set -e
[ "$CODE" -eq 3 ] || fehler "erwartet Exit 3, war $CODE"
grep -q "Migration 0001_init ausstehend" "$LOG" || fehler "die Meldung nennt die Migration nicht"
grep -q "migrieren" "$LOG" || fehler "die Meldung nennt den Befehl nicht"
if grep -q "does not exist" "$LOG"; then fehler "SQL-Fehler statt einer klaren Meldung"; fi

echo "2. migrieren legt das Schema an"
cli migrieren >"$LOG" 2>&1 || fehler "migrieren scheiterte"
grep -q "angewendet: 0001_init" "$LOG" || fehler "0001_init wurde nicht angewendet"
grep -q "Migrationen angewendet." "$LOG" || fehler "keine Erfolgsmeldung"

echo "   zweiter Aufruf tut nichts"
cli migrieren >"$LOG" 2>&1 || fehler "der zweite Aufruf scheiterte"
grep -q "nichts zu tun" "$LOG" || fehler "der zweite Aufruf hat etwas getan"

echo "   --status zeigt nichts Offenes"
cli migrieren --status >"$LOG" 2>&1 || fehler "--status scheiterte"
if grep -q "ausstehend" "$LOG"; then fehler "--status nennt Ausstehendes"; fi
grep -q "angewendet   0001_init" "$LOG" || fehler "--status kennt 0001_init nicht"

echo "3. Danach startet das Cockpit"
starten -d --name "$NAME" >/dev/null
ZEIT=0
until curl -fsS "$URL/gesund" >/dev/null 2>&1; do
  ZEIT=$((ZEIT + 1))
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
    docker logs "$NAME" >"$LOG" 2>&1 || true
    fehler "das Cockpit endete beim Start"
  fi
  if [ "$ZEIT" -ge 60 ]; then
    docker logs "$NAME" >"$LOG" 2>&1 || true
    fehler "keine Antwort auf $URL/gesund"
  fi
  sleep 1
done
docker logs "$NAME" >"$LOG" 2>&1
grep -q "/erststart/" "$LOG" || fehler "das Erststart-Token steht nicht im Log"
echo "   /gesund antwortet, das Erststart-Token steht im Log"

echo "4. Das Cockpit hat sich in cockpit.instanz gemeldet"
# Im laufenden Cockpit selbst gelesen: ein zweiter Container mit denselben Optionen bekäme lokal den Port nicht
# (`-p`), und die Umgebung (DATABASE_URL) hat der Container schon.
docker exec "$NAME" node --input-type=module -e "
  import pg from 'pg';
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query('SELECT version, digest FROM cockpit.instanz');
  await pool.end();
  for (const zeile of rows) console.log('instanz', zeile.version, zeile.digest);
" >"$LOG" 2>&1 || fehler "cockpit.instanz ließ sich nicht lesen"
[ "$(grep -c '^instanz ' "$LOG")" -eq 1 ] || fehler "erwartet genau eine Zeile in cockpit.instanz"
grep -q "^instanz .* $DIGEST\$" "$LOG" || fehler "der Digest aus COCKPIT_IMAGE_DIGEST fehlt"
if [ -n "${SMOKE_VERSION:-}" ]; then
  grep -qF "instanz $SMOKE_VERSION $DIGEST" "$LOG" || fehler "erwartet Version $SMOKE_VERSION"
else
  grep -Eq '^instanz [0-9]+\.[0-9]+\.[0-9]+[^ ]*\+[0-9a-z]+ ' "$LOG" || fehler "die Version hat nicht die Form SemVer+Commit"
fi
echo "   $(sed -n 's/^instanz \([^ ]*\) .*/Version \1/p' "$LOG"), Digest aus der Umgebung"
echo "SMOKE-TEST BESTANDEN"
