/**
 * Die Tag-Hilfen der Kennzahlen-Zeiträume (COPI-98) — reine Funktionen, ohne Datenbank.
 */
import { describe, expect, it } from 'vitest';
import { ZEITRAEUME, istZeitraum, monatsName, tagKurz, tagLang, tagPlus } from '../src/module/kennzahlen-zeitraum.js';

describe('tagPlus', () => {
  it.each([
    ['über die Monatsgrenze', '2026-01-31', 1, '2026-02-01'],
    ['rückwärts über die Jahresgrenze', '2026-01-01', -1, '2025-12-31'],
    ['im Schaltjahr', '2028-02-28', 1, '2028-02-29'],
    ['über die Umstellung auf Sommerzeit', '2026-03-28', 2, '2026-03-30'],
    ['mit 0 Tagen', '2026-09-30', 0, '2026-09-30'],
  ])('rechnet %s', (_fall, tag, tage, erwartet) => {
    expect(tagPlus(tag, tage)).toBe(erwartet);
  });
});

describe('istZeitraum', () => {
  it.each(ZEITRAEUME)('lässt %s zu', (name) => {
    expect(istZeitraum(name)).toBe(true);
  });

  it.each([['14', '14'], ['leer', ''], ['Zahl', 30], ['undefined', undefined]])('weist %s ab', (_fall, wert) => {
    expect(istZeitraum(wert)).toBe(false);
  });
});

describe('monatsName', () => {
  it.each([
    ['2026-01-15', 'Januar'],
    ['2026-12-01', 'Dezember'],
    ['2026-03-01', 'März'],
  ])('nennt den Monat von %s', (tag, erwartet) => {
    expect(monatsName(tag)).toBe(erwartet);
  });

  it('gibt bei einem ungültigen Monat einen leeren Text zurück', () => {
    expect(monatsName('2026-13-01')).toBe('');
  });
});

describe('tagKurz und tagLang', () => {
  it('kürzt den Tag für Achsen', () => {
    expect(tagKurz('2026-09-30')).toBe('30.09.');
  });

  it('schreibt den Tag mit Jahr', () => {
    expect(tagLang('2026-09-30')).toBe('30.09.2026');
  });
});
