/**
 * `npm run assets` baut Stylesheet und Schriften einmal (COPI-30); `npm run assets:watch` baut
 * neu, sobald sich Views oder Quelle ändern. Die Anwendung liest außerhalb von Produktion das
 * Manifest bei jeder Anfrage neu — ein Neuladen im Browser genügt.
 */
import { watch } from 'node:fs';
import path from 'node:path';
import { assetsBauen } from './bauen.js';
import { ASSETS_ORDNER } from './manifest.js';

const WURZEL = path.join(ASSETS_ORDNER, '..', '..');

function einmalBauen(): void {
  const manifest = assetsBauen();
  console.warn(`Assets gebaut: ${manifest.stylesheet} (${Object.keys(manifest.dateien).length} Dateien)`);
}

function beobachten(): void {
  einmalBauen();
  let warten: NodeJS.Timeout | undefined;
  const neuBauen = (): void => {
    clearTimeout(warten);
    warten = setTimeout(() => {
      try {
        einmalBauen();
      } catch (fehler) {
        // Ein Tippfehler in der Quelle beendet den Watcher nicht; der nächste Speichervorgang baut neu.
        console.error(fehler instanceof Error ? fehler.message : fehler);
      }
    }, 100);
  };
  for (const ordner of ['views', path.join('assets', 'css')]) {
    watch(path.join(WURZEL, ordner), { recursive: true }, neuBauen);
  }
  console.warn('Beobachte views/ und assets/css/ …');
}

if (process.argv.includes('--watch')) {
  beobachten();
} else {
  einmalBauen();
}
