/**
 * Der Satz der Symbol-Dateien einer Instanz (COPI-101): App-Symbol in 512 und 192 px (auch `maskable`),
 * `apple-touch-icon` in 180 px und das Favicon in 32 px — entweder das gezeichnete Standard-Symbol (COPI-58) oder,
 * aus einem hochgeladenen Bild, neu gerechnet und neu kodiert.
 *
 * Jeder Satz trägt einen **Inhalts-Hash**. Seiten und Manifest verweisen auf `/icons/<name>.<hash>.png`: solche
 * Adressen ändern sich nie und dürfen lange im Zwischenspeicher liegen; ein neues Symbol ist eine neue Adresse. Die
 * Adressen ohne Hash (`/icons/icon-512.png`) bleiben für Geräte, die sie schon kennen, und liefern immer das aktuelle.
 */
import { createHash } from 'node:crypto';
import { iconPng } from './icon.js';
import { pngLesen, pngSchreiben, verkleinern } from './png.js';

/** Kantenlänge des Bildes, das der Browser schickt und das die Datenbank hält. */
export const SYMBOL_GROESSE = 512;

/** Die Dateien eines Satzes und ihre Kantenlänge. */
export const SYMBOL_DATEIEN = {
  'icon-512': 512,
  'icon-192': 192,
  'apple-touch-icon': 180,
  'favicon-32': 32,
} as const satisfies Readonly<Record<string, number>>;

export type SymbolDatei = keyof typeof SYMBOL_DATEIEN;

export function istSymbolDatei(name: string): name is SymbolDatei {
  return Object.hasOwn(SYMBOL_DATEIEN, name);
}

/** Zwölf Hex-Zeichen: genug gegen Verwechslung, kurz genug für eine Adresse. */
const HASH_LAENGE = 12;

export interface SymbolSatz {
  readonly hash: string;
  readonly dateien: Readonly<Record<SymbolDatei, Buffer>>;
}

function hashVon(png512: Buffer): string {
  return createHash('sha256').update(png512).digest('hex').slice(0, HASH_LAENGE);
}

let standardSatz: SymbolSatz | undefined;

/**
 * Der Standard: in jeder Größe neu gezeichnet, nicht verkleinert. Das Zeichnen kostet rund 300 ms, darum geschieht es
 * einmal je Prozess (COPI-207) statt bei jedem `buildApp`. Der Satz ist unveränderlich und hängt nur vom Code ab, nie
 * von einer Instanz; eigene Symbole (`eigenerSymbolSatz`) werden nicht zwischengespeichert.
 */
export function standardSymbolSatz(): SymbolSatz {
  if (standardSatz === undefined) {
    const dateien = Object.fromEntries(
      Object.entries(SYMBOL_DATEIEN).map(([name, groesse]) => [name, iconPng(groesse)]),
    ) as Record<SymbolDatei, Buffer>;
    standardSatz = { hash: hashVon(dateien['icon-512']), dateien };
  }
  return standardSatz;
}

/**
 * Aus einem PNG mit 512 × 512 Pixeln (vom Browser zugeschnitten): streng gelesen, Transparenz auf Weiß gelegt, jede
 * Größe neu gerechnet und neu kodiert. Wirft `PngFehler`, wenn die Datei nicht genau passt.
 */
export function eigenerSymbolSatz(png: Buffer): SymbolSatz {
  const bild = pngLesen(png, SYMBOL_GROESSE);
  const dateien = Object.fromEntries(
    Object.entries(SYMBOL_DATEIEN).map(([name, groesse]) => [
      name,
      pngSchreiben(groesse === SYMBOL_GROESSE ? bild : verkleinern(bild, groesse)),
    ]),
  ) as Record<SymbolDatei, Buffer>;
  return { hash: hashVon(dateien['icon-512']), dateien };
}

/** Die Adresse einer Datei des Satzes, mit Hash. */
export function symbolPfad(satz: Pick<SymbolSatz, 'hash'>, datei: SymbolDatei): string {
  return `/icons/${datei}.${satz.hash}.png`;
}

/** `/icons/<name>.png` oder `/icons/<name>.<hash>.png` — sonst nichts. Das Tor lässt genau diese durch. */
export const SYMBOL_PFAD = /^\/icons\/(icon-512|icon-192|apple-touch-icon|favicon-32)(?:\.([0-9a-f]{12}))?\.png$/;
