/**
 * Das Manifest der gebauten Assets (COPI-30): welche Dateien das Cockpit ausliefert und
 * unter welchem Namen das Stylesheet steht. `npm run assets` schreibt es (siehe `bauen.ts`),
 * die Anwendung liest es hier — beides über dieselbe Form, damit ein Build, der nicht zur
 * Anwendung passt, beim Start auffällt statt erst im Browser.
 *
 * Ausgeliefert wird **nur**, was im Manifest steht. Ein Dateiname aus der Anfrage wird nie
 * an einen Pfad gehängt; er ist ein Schlüssel in einer Tabelle.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Vom Build geschrieben: Name des Stylesheets und Inhaltstyp jeder Datei (Name → Typ). */
export interface AssetsManifest {
  readonly stylesheet: string;
  readonly dateien: Readonly<Record<string, string>>;
}

export interface AssetDatei {
  readonly inhalt: Buffer;
  readonly typ: string;
}

export interface Assets {
  /** Die Adresse des Stylesheets, wie sie im `<link>` steht (`/assets/cockpit.<hash>.css`). */
  readonly stylesheet: string;
  /** Die Datei zu einem Namen aus dem Manifest, sonst `undefined`. */
  datei(name: string): AssetDatei | undefined;
}

/** Ein Ordner im Repo und im Image: `src/assets` und `dist/assets` liegen zwei Ordner unter der Wurzel. */
export const ASSETS_ORDNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'gebaut',
);

export const ASSETS_PFAD = '/assets';
export const MANIFEST_DATEI = 'manifest.json';

/** Hash im Namen: 16 Hex-Zeichen (64 Bit) des SHA-256 des Inhalts. */
const DATEINAME = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[0-9a-f]{16}\.(?:css|woff2)$/;

function manifestPruefen(daten: unknown): AssetsManifest {
  const fehler = (grund: string): Error => new Error(`Manifest der Assets ungültig: ${grund}.`);
  if (typeof daten !== 'object' || daten === null) {
    throw fehler('kein Objekt');
  }
  const { stylesheet, dateien } = daten as { stylesheet?: unknown; dateien?: unknown };
  if (typeof stylesheet !== 'string' || typeof dateien !== 'object' || dateien === null) {
    throw fehler('`stylesheet` oder `dateien` fehlt');
  }
  for (const [name, typ] of Object.entries(dateien)) {
    if (!DATEINAME.test(name)) {
      throw fehler(`Dateiname „${name}" nicht erlaubt`);
    }
    if (typeof typ !== 'string') {
      throw fehler(`Inhaltstyp von „${name}" fehlt`);
    }
  }
  if (!(stylesheet in dateien)) {
    throw fehler('das Stylesheet steht nicht unter den Dateien');
  }
  return { stylesheet, dateien: dateien as Record<string, string> };
}

/**
 * Liest Manifest und Dateien aus dem Ordner. Fehlt das Manifest, bricht das ab und sagt, was zu
 * tun ist — im Image kann das nur ein Build ohne den Asset-Schritt sein.
 */
export function assetsLaden(ordner: string = ASSETS_ORDNER): Assets {
  const manifestPfad = path.join(ordner, MANIFEST_DATEI);
  if (!existsSync(manifestPfad)) {
    throw new Error(
      `Keine gebauten Assets gefunden (${manifestPfad}). Stylesheet und Schriften entstehen mit \`npm run assets\`.`,
    );
  }
  const manifest = manifestPruefen(JSON.parse(readFileSync(manifestPfad, 'utf8')));
  const dateien = new Map<string, AssetDatei>(
    Object.entries(manifest.dateien).map(([name, typ]) => [name, { inhalt: readFileSync(path.join(ordner, name)), typ }]),
  );
  return {
    stylesheet: `${ASSETS_PFAD}/${manifest.stylesheet}`,
    datei: (name) => dateien.get(name),
  };
}
