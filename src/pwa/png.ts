/**
 * PNG lesen, verkleinern und schreiben — ohne Bildbibliothek (COPI-58, COPI-101).
 *
 * **Lesen ist absichtlich eng.** Ein eigenes App-Symbol (COPI-101) kommt aus dem Browser: das Skript der Einstellungen
 * schneidet das gewählte Bild zu und schickt ein PNG mit genau 512 × 512 Pixeln, wie `canvas.toBlob` es schreibt.
 * Angenommen wird nur genau das: 8 Bit je Kanal, RGB oder RGBA, ohne Zeilensprung, die verlangte Größe, gültige
 * Prüfsummen, `IDAT` am Stück, `IEND` am Ende und nichts danach. Begleitblöcke (Kleinbuchstabe vorn, z. B. `sRGB`)
 * werden übergangen, unbekannte Pflichtblöcke abgewiesen. Entpackt wird mit fester Obergrenze (`maxOutputLength`):
 * eine „Zip-Bombe" scheitert, bevor sie Speicher frisst. SVG, Paletten, 16 Bit oder ein anderes Format gibt es hier
 * nicht — sie kommen gar nicht erst durch.
 *
 * Ausgeliefert wird nie, was hochgeladen wurde: das Cockpit legt die Pixel auf eine Fläche, rechnet die Größen selbst
 * und schreibt neue PNG-Dateien. Metadaten und angehängte Daten fallen dabei weg.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATUR = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Ein Bild mit drei Bytes (RGB) je Pixel, Zeile für Zeile. */
export interface RgbBild {
  readonly breite: number;
  readonly hoehe: number;
  readonly pixel: Buffer;
}

export class PngFehler extends Error {}

function abweisen(grund: string): never {
  throw new PngFehler(grund);
}

function block(typ: string, daten: Buffer): Buffer {
  const laenge = Buffer.alloc(4);
  laenge.writeUInt32BE(daten.length);
  const kopfUndDaten = Buffer.concat([Buffer.from(typ, 'ascii'), daten]);
  const pruefsumme = Buffer.alloc(4);
  pruefsumme.writeUInt32BE(crc32(kopfUndDaten));
  return Buffer.concat([laenge, kopfUndDaten, pruefsumme]);
}

/** Ein RGB-Bild als PNG (8 Bit, ohne Filter). */
export function pngSchreiben(bild: RgbBild): Buffer {
  const zeile = 1 + bild.breite * 3;
  const roh = Buffer.alloc(zeile * bild.hoehe);
  for (let y = 0; y < bild.hoehe; y++) {
    roh[y * zeile] = 0; // Filter: keiner
    bild.pixel.copy(roh, y * zeile + 1, y * bild.breite * 3, (y + 1) * bild.breite * 3);
  }
  const kopf = Buffer.alloc(13);
  kopf.writeUInt32BE(bild.breite, 0);
  kopf.writeUInt32BE(bild.hoehe, 4);
  kopf[8] = 8; // Bittiefe
  kopf[9] = 2; // Farbtyp: RGB
  return Buffer.concat([SIGNATUR, block('IHDR', kopf), block('IDAT', deflateSync(roh)), block('IEND', Buffer.alloc(0))]);
}

interface Block {
  readonly typ: string;
  readonly daten: Buffer;
}

/** Zerlegt die Datei in Blöcke und prüft Länge und Prüfsumme jedes einzelnen. */
function bloeckeLesen(png: Buffer): Block[] {
  if (png.length < SIGNATUR.length || !png.subarray(0, SIGNATUR.length).equals(SIGNATUR)) {
    abweisen('kein PNG');
  }
  const bloecke: Block[] = [];
  let stelle = SIGNATUR.length;
  while (stelle < png.length) {
    if (stelle + 12 > png.length) {
      abweisen('Block abgeschnitten');
    }
    const laenge = png.readUInt32BE(stelle);
    const ende = stelle + 12 + laenge;
    if (ende > png.length) {
      abweisen('Block abgeschnitten');
    }
    const kopfUndDaten = png.subarray(stelle + 4, stelle + 8 + laenge);
    if (crc32(kopfUndDaten) !== png.readUInt32BE(stelle + 8 + laenge)) {
      abweisen('Prüfsumme falsch');
    }
    const typ = kopfUndDaten.subarray(0, 4).toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(typ)) {
      abweisen('Blocktyp ungültig');
    }
    bloecke.push({ typ, daten: kopfUndDaten.subarray(4) });
    stelle = ende;
    if (typ === 'IEND') {
      break;
    }
  }
  if (stelle !== png.length) {
    abweisen('Daten nach dem Ende');
  }
  return bloecke;
}

/** Die komprimierten Bilddaten: Kopf zuerst, `IDAT` am Stück, `IEND` zuletzt, keine unbekannten Pflichtblöcke. */
function aufbauPruefen(bloecke: readonly Block[]): { kopf: Buffer; daten: Buffer } {
  const erster = bloecke[0];
  if (erster?.typ !== 'IHDR' || bloecke.at(-1)?.typ !== 'IEND') {
    abweisen('Aufbau ungültig');
  }
  const daten: Buffer[] = [];
  let idatVorbei = false;
  for (const { typ, daten: inhalt } of bloecke.slice(1, -1)) {
    if (typ === 'IDAT') {
      if (idatVorbei) {
        abweisen('IDAT nicht am Stück');
      }
      daten.push(inhalt);
    } else if (/^[A-Z]/.test(typ)) {
      abweisen(`Pflichtblock ${typ} nicht unterstützt`);
    } else if (daten.length > 0) {
      idatVorbei = true;
    }
  }
  if (daten.length === 0) {
    abweisen('keine Bilddaten');
  }
  return { kopf: erster.daten, daten: Buffer.concat(daten) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/** Macht die Zeilenfilter rückgängig (PNG-Spezifikation, Abschnitt 9), in place. */
function entfiltern(roh: Buffer, breite: number, hoehe: number, kanaele: number): Buffer {
  const zeilenBytes = breite * kanaele;
  const ergebnis = Buffer.alloc(zeilenBytes * hoehe);
  for (let y = 0; y < hoehe; y++) {
    const filter = roh[y * (zeilenBytes + 1)];
    const quelle = y * (zeilenBytes + 1) + 1;
    const ziel = y * zeilenBytes;
    for (let i = 0; i < zeilenBytes; i++) {
      const x = roh[quelle + i] ?? 0;
      const links = i >= kanaele ? (ergebnis[ziel + i - kanaele] ?? 0) : 0;
      const oben = y > 0 ? (ergebnis[ziel - zeilenBytes + i] ?? 0) : 0;
      const obenLinks = y > 0 && i >= kanaele ? (ergebnis[ziel - zeilenBytes + i - kanaele] ?? 0) : 0;
      let wert: number;
      switch (filter) {
        case 0:
          wert = x;
          break;
        case 1:
          wert = x + links;
          break;
        case 2:
          wert = x + oben;
          break;
        case 3:
          wert = x + Math.floor((links + oben) / 2);
          break;
        case 4:
          wert = x + paeth(links, oben, obenLinks);
          break;
        default:
          abweisen('Filter unbekannt');
      }
      ergebnis[ziel + i] = wert & 0xff;
    }
  }
  return ergebnis;
}

/**
 * Liest ein PNG in genau der verlangten Größe und legt es auf die Hintergrundfarbe (Transparenz wird flach). Wirft
 * `PngFehler` bei allem, was nicht genau passt; die Meldung nennt nie Inhalte der Datei.
 */
export function pngLesen(png: Buffer, groesse: number, hintergrund: readonly [number, number, number] = [255, 255, 255]): RgbBild {
  const { kopf, daten } = aufbauPruefen(bloeckeLesen(png));
  if (kopf.length !== 13) {
    abweisen('Kopf ungültig');
  }
  const breite = kopf.readUInt32BE(0);
  const hoehe = kopf.readUInt32BE(4);
  const [bittiefe, farbtyp, kompression, filterart, zeilensprung] = [kopf[8], kopf[9], kopf[10], kopf[11], kopf[12]];
  if (breite !== groesse || hoehe !== groesse) {
    abweisen('Größe passt nicht');
  }
  if (bittiefe !== 8 || (farbtyp !== 2 && farbtyp !== 6) || kompression !== 0 || filterart !== 0 || zeilensprung !== 0) {
    abweisen('Format nicht unterstützt');
  }
  const kanaele = farbtyp === 6 ? 4 : 3;
  const erwartet = hoehe * (1 + breite * kanaele);
  let roh: Buffer;
  try {
    roh = inflateSync(daten, { maxOutputLength: erwartet + 1 });
  } catch {
    abweisen('Bilddaten unlesbar oder zu groß');
  }
  if (roh.length !== erwartet) {
    abweisen('Bilddaten passen nicht zur Größe');
  }
  const pixel = entfiltern(roh, breite, hoehe, kanaele);
  if (kanaele === 3) {
    return { breite, hoehe, pixel };
  }
  const rgb = Buffer.alloc(breite * hoehe * 3);
  for (let i = 0; i < breite * hoehe; i++) {
    const alpha = (pixel[i * 4 + 3] ?? 0) / 255;
    for (let kanal = 0; kanal < 3; kanal++) {
      rgb[i * 3 + kanal] = Math.round((pixel[i * 4 + kanal] ?? 0) * alpha + (hintergrund[kanal] ?? 0) * (1 - alpha));
    }
  }
  return { breite, hoehe, pixel: rgb };
}

/** Gewichte eines Zielpixels: welche Quellpixel mit welchem Anteil hineinfallen (Flächenmittel). */
function anteile(von: number, nach: number): { start: number; gewichte: number[] }[] {
  const faktor = von / nach;
  return Array.from({ length: nach }, (_, ziel) => {
    const anfang = ziel * faktor;
    const ende = anfang + faktor;
    const start = Math.floor(anfang);
    const gewichte: number[] = [];
    for (let q = start; q < Math.min(von, Math.ceil(ende)); q++) {
      gewichte.push((Math.min(ende, q + 1) - Math.max(anfang, q)) / faktor);
    }
    return { start, gewichte };
  });
}

/** Verkleinert ein quadratisches Bild per Flächenmittel — scharf genug für Symbole, ohne Treppen. */
export function verkleinern(bild: RgbBild, groesse: number): RgbBild {
  if (bild.breite !== bild.hoehe || groesse > bild.breite) {
    throw new RangeError('verkleinern: nur quadratisch und nur kleiner');
  }
  const quelle = bild.breite;
  const spalten = anteile(quelle, groesse);
  // Erst waagerecht (quelle Zeilen × groesse Spalten), dann senkrecht.
  const zwischen = new Float64Array(quelle * groesse * 3);
  for (let y = 0; y < quelle; y++) {
    spalten.forEach(({ start, gewichte }, x) => {
      for (let kanal = 0; kanal < 3; kanal++) {
        let summe = 0;
        gewichte.forEach((gewicht, k) => {
          summe += (bild.pixel[(y * quelle + start + k) * 3 + kanal] ?? 0) * gewicht;
        });
        zwischen[(y * groesse + x) * 3 + kanal] = summe;
      }
    });
  }
  const pixel = Buffer.alloc(groesse * groesse * 3);
  spalten.forEach(({ start, gewichte }, y) => {
    for (let x = 0; x < groesse; x++) {
      for (let kanal = 0; kanal < 3; kanal++) {
        let summe = 0;
        gewichte.forEach((gewicht, k) => {
          summe += (zwischen[((start + k) * groesse + x) * 3 + kanal] ?? 0) * gewicht;
        });
        pixel[(y * groesse + x) * 3 + kanal] = Math.min(255, Math.round(summe));
      }
    }
  });
  return { breite: groesse, hoehe: groesse, pixel };
}
