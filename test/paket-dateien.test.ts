/**
 * Der Kern als Paket (COPI-250): Die Testhilfen, die `package.json` unter `files` und `exports` für Verbraucher
 * bereitstellt, importieren selbst weitere Dateien. Fehlt eine davon im Paket, scheitert ein Verbraucher erst beim
 * Typecheck oder Testlauf, nicht im Kern. Der Test folgt den relativen Importen und verlangt, dass jede erreichte Datei im
 * Paket liegt.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const paket = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[]; exports: Record<string, unknown> };

/** Die Einstiege der Testhilfen: alles unter `./testen/…` in `exports`, dazu `global-setup`, das Verbraucher als Datei laden. */
function einstiege(): string[] {
  const ausExports = Object.entries(paket.exports)
    .filter(([schluessel, wert]) => schluessel.startsWith('./testen/') && typeof wert === 'string' && !wert.includes('*'))
    .map(([, wert]) => (wert as string).replace(/^\.\//, ''));
  return [...ausExports, 'test/global-setup.ts', 'test/hilfen.ts', 'test/testdatenbank.ts'];
}

function imVerzeichnisOderDatei(datei: string): boolean {
  return paket.files.some((eintrag) => !eintrag.startsWith('!') && (datei === eintrag || datei.startsWith(`${eintrag}/`)));
}

function erreichbar(): string[] {
  const besucht = new Set<string>();
  const warteschlange = einstiege();
  while (warteschlange.length > 0) {
    const datei = warteschlange.pop() as string;
    if (besucht.has(datei) || !existsSync(datei)) {
      continue;
    }
    besucht.add(datei);
    for (const treffer of readFileSync(datei, 'utf8').matchAll(/(?:from|import) '(\.[^']+)'/g)) {
      const ziel = path.normalize(path.join(path.dirname(datei), (treffer[1] ?? '').replace(/\.js$/, '.ts')));
      if (ziel.startsWith('test/') || ziel.startsWith('scripts/')) {
        warteschlange.push(ziel);
      }
    }
  }
  return [...besucht].sort();
}

describe('Paketinhalt (package.json, files)', () => {
  it('enthält jede Datei, die die Testhilfen für Verbraucher über relative Importe erreichen', () => {
    const fehlend = erreichbar().filter((datei) => !imVerzeichnisOderDatei(datei));

    expect(fehlend).toEqual([]);
  });

  it('findet die bekannten Hilfen, der Test prüft also etwas', () => {
    const gefunden = erreichbar();

    expect(gefunden).toEqual(expect.arrayContaining(['test/hilfen.ts', 'test/testdatenbank.ts', 'scripts/dev/fach-migrationen.ts']));
  });
});
