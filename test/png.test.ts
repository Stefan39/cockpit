/**
 * PNG lesen, verkleinern und schreiben (COPI-101, `src/pwa/png.ts`). Das Lesen ist der Eingang für hochgeladene
 * Symbole: es nimmt genau ein 8-Bit-RGB(A)-PNG in der verlangten Größe an und weist alles andere ab — auch eine Datei,
 * die sich beim Entpacken aufbläht.
 */
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PngFehler, pngLesen, pngSchreiben, verkleinern, type RgbBild } from '../src/pwa/png.js';

function block(typ: string, daten: Buffer): Buffer {
  const laenge = Buffer.alloc(4);
  laenge.writeUInt32BE(daten.length);
  const kopfUndDaten = Buffer.concat([Buffer.from(typ, 'latin1'), daten]);
  const pruefsumme = Buffer.alloc(4);
  pruefsumme.writeUInt32BE(crc32(kopfUndDaten));
  return Buffer.concat([laenge, kopfUndDaten, pruefsumme]);
}

const SIGNATUR = Buffer.from('89504e470d0a1a0a', 'hex');

interface Bauplan {
  readonly groesse: number;
  /** Pixel als [r, g, b, a]; ohne Alpha (`kanaele: 3`) wird a ignoriert. */
  readonly farbe: (x: number, y: number) => readonly [number, number, number, number];
  readonly kanaele?: 3 | 4;
  /** Filter je Zeile (0–4), reihum. */
  readonly filter?: readonly number[];
  readonly kopf?: Partial<{ bittiefe: number; farbtyp: number; zeilensprung: number; breite: number }>;
  readonly vorIdat?: readonly Buffer[];
  readonly nachIdat?: readonly Buffer[];
  readonly danach?: Buffer;
  readonly rohAnhang?: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Ein PNG wie ein Browser es schreiben könnte, mit wählbaren Zeilenfiltern. */
function bauen(plan: Bauplan): Buffer {
  const kanaele = plan.kanaele ?? 4;
  const g = plan.groesse;
  const zeilen: Buffer[] = [];
  let vorher = Buffer.alloc(g * kanaele);
  for (let y = 0; y < g; y++) {
    const zeile = Buffer.alloc(g * kanaele);
    for (let x = 0; x < g; x++) {
      const pixel = plan.farbe(x, y);
      for (let k = 0; k < kanaele; k++) {
        zeile[x * kanaele + k] = pixel[k] ?? 0;
      }
    }
    const filter = plan.filter?.[y % plan.filter.length] ?? 0;
    const aus = Buffer.alloc(g * kanaele + 1);
    aus[0] = filter;
    for (let i = 0; i < zeile.length; i++) {
      const links = i >= kanaele ? (zeile[i - kanaele] ?? 0) : 0;
      const oben = vorher[i] ?? 0;
      const obenLinks = i >= kanaele ? (vorher[i - kanaele] ?? 0) : 0;
      const vorhersage = [0, links, oben, Math.floor((links + oben) / 2), paeth(links, oben, obenLinks)][filter] ?? 0;
      aus[i + 1] = ((zeile[i] ?? 0) - vorhersage) & 0xff;
    }
    zeilen.push(aus);
    vorher = zeile;
  }
  const kopf = Buffer.alloc(13);
  kopf.writeUInt32BE(plan.kopf?.breite ?? g, 0);
  kopf.writeUInt32BE(g, 4);
  kopf[8] = plan.kopf?.bittiefe ?? 8;
  kopf[9] = plan.kopf?.farbtyp ?? (kanaele === 4 ? 6 : 2);
  kopf[12] = plan.kopf?.zeilensprung ?? 0;
  const roh = Buffer.concat([...zeilen, plan.rohAnhang ?? Buffer.alloc(0)]);
  return Buffer.concat([
    SIGNATUR,
    block('IHDR', kopf),
    ...(plan.vorIdat ?? []),
    block('IDAT', deflateSync(roh)),
    ...(plan.nachIdat ?? []),
    block('IEND', Buffer.alloc(0)),
    plan.danach ?? Buffer.alloc(0),
  ]);
}

const VERLAUF = (x: number, y: number): [number, number, number, number] => [(x * 7) % 256, (y * 13) % 256, (x + y) % 256, 255];

function pixel(bild: RgbBild, x: number, y: number): number[] {
  const stelle = (y * bild.breite + x) * 3;
  return [...bild.pixel.subarray(stelle, stelle + 3)];
}

describe('pngLesen', () => {
  it.each([0, 1, 2, 3, 4])('liest jedes Pixel richtig, auch mit Zeilenfilter %i', (filter) => {
    const bild = pngLesen(bauen({ groesse: 16, farbe: VERLAUF, filter: [filter, (filter + 2) % 5] }), 16);
    for (const [x, y] of [[0, 0], [15, 0], [7, 9], [15, 15]] as const) {
      expect(pixel(bild, x, y)).toEqual(VERLAUF(x, y).slice(0, 3));
    }
  });

  it('liest RGB ohne Alpha', () => {
    const bild = pngLesen(bauen({ groesse: 8, kanaele: 3, farbe: () => [10, 20, 30, 0] }), 8);
    expect(pixel(bild, 3, 3)).toEqual([10, 20, 30]);
  });

  it('legt Transparenz auf den Hintergrund (Standard Weiß)', () => {
    const png = bauen({ groesse: 4, farbe: (x) => (x < 2 ? [0, 0, 0, 0] : [0, 0, 0, 255]) });
    expect(pixel(pngLesen(png, 4), 0, 0)).toEqual([255, 255, 255]);
    expect(pixel(pngLesen(png, 4), 3, 0)).toEqual([0, 0, 0]);
    expect(pixel(pngLesen(png, 4, [41, 84, 224]), 0, 0)).toEqual([41, 84, 224]);
  });

  it('übergeht Begleitblöcke vor und nach den Bilddaten (sRGB, tEXt)', () => {
    const png = bauen({
      groesse: 4,
      farbe: VERLAUF,
      vorIdat: [block('sRGB', Buffer.from([0]))],
      nachIdat: [block('tEXt', Buffer.from('Comment\0irgendwas', 'latin1'))],
    });
    expect(pngLesen(png, 4).breite).toBe(4);
  });

  it('liest, was es selbst schreibt', () => {
    const bild: RgbBild = { breite: 5, hoehe: 5, pixel: Buffer.from(Array.from({ length: 75 }, (_, i) => (i * 37) % 256)) };
    expect(pngLesen(pngSchreiben(bild), 5).pixel.equals(bild.pixel)).toBe(true);
  });

  const KAPUTT: [string, () => Buffer][] = [
    ['keine PNG-Signatur (z. B. SVG)', () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['leere Datei', () => Buffer.alloc(0)],
    ['falsche Größe', () => bauen({ groesse: 8, farbe: VERLAUF })],
    ['nicht quadratisch', () => bauen({ groesse: 16, farbe: VERLAUF, kopf: { breite: 17 } })],
    ['16 Bit', () => bauen({ groesse: 16, farbe: VERLAUF, kopf: { bittiefe: 16 } })],
    ['Palette', () => bauen({ groesse: 16, farbe: VERLAUF, kopf: { farbtyp: 3 } })],
    ['Zeilensprung', () => bauen({ groesse: 16, farbe: VERLAUF, kopf: { zeilensprung: 1 } })],
    ['Daten nach IEND', () => bauen({ groesse: 16, farbe: VERLAUF, danach: Buffer.from('<script>') })],
    ['unbekannter Pflichtblock', () => bauen({ groesse: 16, farbe: VERLAUF, vorIdat: [block('ABCD', Buffer.alloc(1))] })],
    ['zu viele Bilddaten (Zip-Bombe)', () => bauen({ groesse: 16, farbe: VERLAUF, rohAnhang: Buffer.alloc(5_000_000) })],
    [
      'falsche Prüfsumme',
      () => {
        const png = bauen({ groesse: 16, farbe: VERLAUF });
        png[30] = (png[30] ?? 0) ^ 0xff;
        return png;
      },
    ],
    ['abgeschnitten', () => bauen({ groesse: 16, farbe: VERLAUF }).subarray(0, 60)],
  ];

  it.each(KAPUTT)('weist ab: %s', (_name, datei) => {
    expect(() => pngLesen(datei(), 16)).toThrow(PngFehler);
  });

  it('weist einen Zeilenfilter außerhalb von 0–4 ab', () => {
    // Filter 5 gibt es nicht; der Bauplan kann ihn nicht vorhersagen, also roh: alle Zeilen beginnen mit 5.
    const zeilen = Buffer.alloc(16 * (1 + 16 * 4));
    for (let y = 0; y < 16; y++) {
      zeilen[y * (1 + 16 * 4)] = 5;
    }
    const kopf = Buffer.alloc(13);
    kopf.writeUInt32BE(16, 0);
    kopf.writeUInt32BE(16, 4);
    kopf[8] = 8;
    kopf[9] = 6;
    const png = Buffer.concat([SIGNATUR, block('IHDR', kopf), block('IDAT', deflateSync(zeilen)), block('IEND', Buffer.alloc(0))]);
    expect(() => pngLesen(png, 16)).toThrow(PngFehler);
  });
});

describe('verkleinern', () => {
  it('lässt eine einfarbige Fläche einfarbig', () => {
    const bild: RgbBild = { breite: 512, hoehe: 512, pixel: Buffer.alloc(512 * 512 * 3, 200) };
    for (const groesse of [192, 180, 32]) {
      const klein = verkleinern(bild, groesse);
      expect(klein.breite).toBe(groesse);
      expect(new Set(klein.pixel)).toEqual(new Set([200]));
    }
  });

  it('mittelt die Fläche: links schwarz, rechts weiß ergibt in der Mitte Grau', () => {
    const pixel = Buffer.alloc(4 * 4 * 3);
    for (let y = 0; y < 4; y++) {
      pixel.fill(255, (y * 4 + 2) * 3, (y * 4 + 4) * 3);
    }
    const klein = verkleinern({ breite: 4, hoehe: 4, pixel }, 3);
    expect(klein.pixel[0]).toBe(0);
    // Halb schwarz, halb weiß: 127,5 — je nach Rundung des Flächenmittels 127 oder 128.
    expect(klein.pixel[3]).toBeGreaterThanOrEqual(127);
    expect(klein.pixel[3]).toBeLessThanOrEqual(128);
    expect(klein.pixel[6]).toBe(255);
  });
});
