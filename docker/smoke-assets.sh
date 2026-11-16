#!/bin/sh
# Smoke-Test des Images für Stylesheet und Schriften (COPI-30).
#
# Tailwind läuft nur im Build-Stage; das Image enthält das fertige Ergebnis unter assets/gebaut. Dieses
# Skript prüft, was ein Kunde bekäme: das Image baut die Anwendung auf (ohne Assets bräche der Start
# ab), liefert Stylesheet und jede Schrift mit `immutable` aus, und die Build-Werkzeuge sind nicht im Image.
#
# Nutzung:  sh docker/smoke-assets.sh <image>        (CI: cockpit:ci)
set -eu

IMAGE=${1:?Nutzung: smoke-assets.sh <image>}

# Nur Laufzeit-Abhängigkeiten im Image: kein Tailwind, keine Schriftpakete (`npm ci --omit=dev`).
docker run --rm "$IMAGE" sh -c 'test ! -e node_modules/tailwindcss && test ! -e node_modules/@tailwindcss && test ! -e node_modules/@fontsource'

docker run --rm -i "$IMAGE" node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { buildApp } from './dist/server/app.js';

const manifest = JSON.parse(readFileSync('assets/gebaut/manifest.json', 'utf8'));
const app = buildApp({ nodeEnv: 'production' });
const erwartet = 'public, max-age=31536000, immutable';
const namen = Object.keys(manifest.dateien);
let fehler = 0;

if (!/^cockpit\.[0-9a-f]{16}\.css$/.test(manifest.stylesheet) || namen.length < 3) {
  console.error('Manifest unerwartet:', JSON.stringify(manifest));
  fehler++;
}
for (const name of namen) {
  const antwort = await app.inject({ method: 'GET', url: `/assets/${name}` });
  const ok = antwort.statusCode === 200 && antwort.headers['cache-control'] === erwartet && antwort.rawPayload.length > 1000;
  console.log(`${ok ? 'ok    ' : 'FEHLER'} /assets/${name} ${antwort.statusCode} ${antwort.headers['content-type']} ${antwort.rawPayload.length} Byte`);
  if (!ok) fehler++;
}

const seite = await app.render('nicht-gefunden.eta', { titel: 'Nicht gefunden' });
if (!seite.includes(`href="/assets/${manifest.stylesheet}"`)) {
  console.error('Die Seite verweist nicht auf das gebaute Stylesheet');
  fehler++;
}
const css = readFileSync(`assets/gebaut/${manifest.stylesheet}`, 'utf8');
if (/(?:url\(\s*["']?|@import\s+["']?)(?:https?:)?\/\//.test(css)) {
  console.error('Das Stylesheet verweist auf einen fremden Host');
  fehler++;
}
await app.close();
if (fehler > 0) process.exit(1);
console.log('Stylesheet und Schriften kommen aus dem Image, unveränderlich ausgeliefert');
JS
