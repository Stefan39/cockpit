/**
 * Das Browser-Skript des App-Symbols (`assets/js/erscheinungsbild.js`, COPI-101): welche Dateien es gar nicht erst
 * liest, und wohin es das Bild auf die quadratische Fläche legt — mit Rand ganz in der sicheren Zone für `maskable`.
 */
import { describe, expect, it } from 'vitest';
import { dateiFehler, grossGenug, meldung, zeichenFlaeche } from '../assets/js/erscheinungsbild.js';

describe('dateiFehler', () => {
  it.each<[string, { name: string; type: string; size: number }, string | undefined]>([
    ['PNG', { name: 'logo.png', type: 'image/png', size: 200_000 }, undefined],
    ['JPEG', { name: 'logo.jpg', type: 'image/jpeg', size: 200_000 }, undefined],
    ['WebP', { name: 'logo.webp', type: 'image/webp', size: 200_000 }, undefined],
    ['SVG am Typ', { name: 'logo', type: 'image/svg+xml', size: 2_000 }, 'svg'],
    ['SVG am Namen, Typ leer', { name: 'Logo.SVG', type: '', size: 2_000 }, 'svg'],
    ['GIF', { name: 'logo.gif', type: 'image/gif', size: 2_000 }, 'typ'],
    ['PDF', { name: 'logo.pdf', type: 'application/pdf', size: 2_000 }, 'typ'],
    ['genau 5 MB', { name: 'logo.png', type: 'image/png', size: 5 * 1024 * 1024 }, undefined],
    ['über 5 MB', { name: 'logo.png', type: 'image/png', size: 5 * 1024 * 1024 + 1 }, 'gross'],
  ])('%s', (_name, datei, erwartet) => {
    expect(dateiFehler(datei)).toBe(erwartet);
  });
});

describe('grossGenug', () => {
  it.each<[number, number, boolean]>([
    [512, 512, true],
    [1200, 400, true],
    [400, 1200, true],
    [511, 511, false],
    [300, 280, false],
  ])('%i × %i: %s', (breite, hoehe, erwartet) => {
    expect(grossGenug(breite, hoehe)).toBe(erwartet);
  });
});

describe('meldung', () => {
  it('nennt bei einem zu kleinen Bild dessen Größe und die verlangte', () => {
    expect(meldung('klein', 300, 280)).toBe(
      'Das Bild ist zu klein (300 × 280 Pixel). Es braucht an der längeren Seite mindestens 512 Pixel, sonst wird das Symbol unscharf.',
    );
  });

  it('hat für jeden Fehler einen eigenen Satz', () => {
    const saetze = (['svg', 'typ', 'gross', 'unlesbar', 'server'] as const).map((fehler) => meldung(fehler));
    expect(new Set(saetze).size).toBe(saetze.length);
  });
});

describe('zeichenFlaeche', () => {
  it('füllt ohne Rand die Fläche mit einem quadratischen Ausschnitt aus der Mitte', () => {
    expect(zeichenFlaeche(1000, 600, false)).toEqual({
      quelle: { x: 200, y: 0, b: 600, h: 600 },
      ziel: { x: 0, y: 0, b: 512, h: 512 },
    });
  });

  it.each([
    [800, 800],
    [1200, 400],
    [300, 900],
  ])('legt ein Bild von %i × %i mit Rand ganz und mittig in den Kreis mit 40 %% Radius', (breite, hoehe) => {
    const { quelle, ziel } = zeichenFlaeche(breite, hoehe, true);
    expect(quelle).toEqual({ x: 0, y: 0, b: breite, h: hoehe });
    // Seitenverhältnis bleibt, Mitte bleibt.
    expect(ziel.b / ziel.h).toBeCloseTo(breite / hoehe);
    expect(ziel.x + ziel.b / 2).toBeCloseTo(256);
    expect(ziel.y + ziel.h / 2).toBeCloseTo(256);
    // Jede Ecke liegt auf oder in dem Kreis, den Android nie wegschneidet.
    expect(Math.hypot(ziel.b / 2, ziel.h / 2)).toBeCloseTo(0.4 * 512);
  });
});
