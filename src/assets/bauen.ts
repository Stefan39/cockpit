/**
 * Der Asset-Build (COPI-30): Tailwind erzeugt aus `assets/css/input.css` das Stylesheet, die
 * Schriften aus `node_modules` kommen dazu, und jede Datei bekommt den Hash ihres Inhalts im
 * Namen — so darf der Browser sie ein Jahr lang behalten (`immutable`), und ein neuer Build
 * heißt automatisch anders.
 *
 * Aufrufer: `npm run assets` (Docker-Build und lokal), `npm run assets:watch` (Entwicklung) und
 * der globale Test-Setup. Zur Laufzeit im Image läuft nichts davon; dort liegt nur das Ergebnis.
 *
 * Wie das Ergebnis entsteht:
 *   1. Tailwind CLI baut und minimiert das Stylesheet.
 *   2. Jede `url(...)` darin zeigt auf eine Schriftdatei (relativ zur Quelle). Sie wird mit Hash
 *      nach `ziel` kopiert, die Adresse im Stylesheet auf `/assets/<name>` umgeschrieben.
 *   3. Das umgeschriebene Stylesheet bekommt seinen Hash — er deckt damit die Schriftnamen mit ab.
 *   4. `manifest.json` nennt alle Dateien mit Inhaltstyp; nicht mehr genannte Dateien im Ziel
 *      werden gelöscht (nach dem Schreiben, damit ein laufender Server nie ins Leere greift).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ASSETS_ORDNER, ASSETS_PFAD, MANIFEST_DATEI, type AssetsManifest } from './manifest.js';

const WURZEL = path.join(ASSETS_ORDNER, '..', '..');
const STANDARD_EINGABE = path.join(WURZEL, 'assets', 'css', 'input.css');

const CSS_TYP = 'text/css; charset=utf-8';
const SCHRIFT_TYP = 'font/woff2';

export interface BauOptionen {
  /** Die Tailwind-Quelle. Standard: `assets/css/input.css`. */
  readonly eingabe?: string;
  /** Wohin gebaut wird. Standard: `assets/gebaut`. */
  readonly ziel?: string;
}

function hashVon(inhalt: Buffer | string): string {
  return createHash('sha256').update(inhalt).digest('hex').slice(0, 16);
}

/** Der Einstieg der Tailwind CLI, so wie das Paket ihn in seiner package.json nennt. */
function tailwindEinstieg(): string {
  const require = createRequire(import.meta.url);
  const paketDatei = require.resolve('@tailwindcss/cli/package.json');
  const paket = JSON.parse(readFileSync(paketDatei, 'utf8')) as { bin: Record<string, string> };
  const einstieg = paket.bin.tailwindcss;
  if (!einstieg) {
    throw new Error('@tailwindcss/cli nennt keinen Einstieg `tailwindcss` in seiner package.json.');
  }
  return path.join(path.dirname(paketDatei), einstieg);
}

function stylesheetBauen(eingabe: string): string {
  const arbeit = mkdtempSync(path.join(tmpdir(), 'cockpit-tailwind-'));
  const ausgabe = path.join(arbeit, 'out.css');
  try {
    execFileSync(process.execPath, [tailwindEinstieg(), '-i', eingabe, '-o', ausgabe, '--minify'], {
      cwd: WURZEL,
      stdio: 'pipe',
    });
    return readFileSync(ausgabe, 'utf8');
  } catch (fehler) {
    const ausgabeText =
      fehler instanceof Error && 'stderr' in fehler ? String((fehler as { stderr: unknown }).stderr) : '';
    throw new Error(`Tailwind konnte das Stylesheet nicht bauen:\n${ausgabeText}`, { cause: fehler });
  } finally {
    rmSync(arbeit, { recursive: true, force: true });
  }
}

/**
 * Kopiert jede Schrift, auf die das Stylesheet zeigt, mit Hash ins Ziel und schreibt die
 * Adressen im Stylesheet um. Andere Adressen als lokale `.woff2`-Dateien gibt es nicht: was das
 * Stylesheet nachlädt, wäre eine Fremdanfrage oder eine Datei, die im Image fehlt.
 */
export function schriftenEinsammeln(
  css: string,
  quellOrdner: string,
  ziel: string,
  dateien: Record<string, string>,
): string {
  return css.replace(/url\(\s*(["']?)([^"')\s]+)\1\s*\)/g, (_treffer, _anfuehrung: string, adresse: string) => {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(adresse)) {
      throw new Error(`Das Stylesheet verweist auf eine Fremdadresse: ${adresse}`);
    }
    if (!adresse.endsWith('.woff2')) {
      throw new Error(`Das Stylesheet verweist auf eine Datei, die der Build nicht kennt: ${adresse}`);
    }
    const quelle = path.resolve(quellOrdner, adresse);
    if (!existsSync(quelle)) {
      throw new Error(`Schriftdatei fehlt: ${quelle} (npm ci ausgeführt?)`);
    }
    const inhalt = readFileSync(quelle);
    const name = `${path.basename(quelle, '.woff2')}.${hashVon(inhalt)}.woff2`;
    copyFileSync(quelle, path.join(ziel, name));
    dateien[name] = SCHRIFT_TYP;
    return `url(${ASSETS_PFAD}/${name})`;
  });
}

/** Baut Stylesheet und Schriften nach `ziel` und gibt das geschriebene Manifest zurück. */
export function assetsBauen(optionen: BauOptionen = {}): AssetsManifest {
  const eingabe = optionen.eingabe ?? STANDARD_EINGABE;
  const ziel = optionen.ziel ?? ASSETS_ORDNER;
  mkdirSync(ziel, { recursive: true });

  const dateien: Record<string, string> = {};
  const roh = stylesheetBauen(eingabe);
  const css = schriftenEinsammeln(roh, path.dirname(eingabe), ziel, dateien);
  const stylesheet = `cockpit.${hashVon(css)}.css`;
  writeFileSync(path.join(ziel, stylesheet), css);
  dateien[stylesheet] = CSS_TYP;

  const sortiert = Object.fromEntries(Object.entries(dateien).sort(([a], [b]) => a.localeCompare(b)));
  const manifest: AssetsManifest = { stylesheet, dateien: sortiert };
  writeFileSync(path.join(ziel, MANIFEST_DATEI), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const vorhanden of readdirSync(ziel)) {
    if (vorhanden !== MANIFEST_DATEI && !(vorhanden in sortiert)) {
      rmSync(path.join(ziel, vorhanden), { force: true });
    }
  }
  return manifest;
}
