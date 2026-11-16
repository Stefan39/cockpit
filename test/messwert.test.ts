/**
 * `messwertAus` (COPI-83) als reiner Unit-Test ohne Datenbank: Was die Messwert-Form hat, kommt gekürzt zurück,
 * alles andere ist `undefined` — nie ein halber Messwert.
 */
import { describe, expect, it } from 'vitest';
import { messwertAus } from '../src/status/messwert.js';

describe('messwertAus', () => {
  describe('liefert einen Messwert', () => {
    it('mit nur wert und einheit', () => {
      expect(messwertAus({ wert: 86, einheit: '%' })).toEqual({ wert: 86, einheit: '%' });
    });

    it('mit max', () => {
      expect(messwertAus({ wert: 86, einheit: '%', max: 100 })).toEqual({ wert: 86, einheit: '%', max: 100 });
    });

    it('mit warnung', () => {
      expect(messwertAus({ wert: 86, einheit: '%', warnung: 85 })).toEqual({ wert: 86, einheit: '%', warnung: 85 });
    });

    it('mit max und warnung', () => {
      expect(messwertAus({ wert: 86, einheit: '%', max: 100, warnung: 85 })).toEqual({
        wert: 86,
        einheit: '%',
        max: 100,
        warnung: 85,
      });
    });

    it('kürzt Leerzeichen am Rand der einheit', () => {
      expect(messwertAus({ wert: 3, einheit: '  von 5 ' })?.einheit).toBe('von 5');
    });

    it('lässt max und warnung weg, wenn sie nicht angegeben sind (kein Schlüssel mit undefined)', () => {
      const messwert = messwertAus({ wert: 1, einheit: 'ms' });
      expect(messwert).toBeDefined();
      expect(Object.keys(messwert ?? {})).toEqual(['wert', 'einheit']);
    });

    it('nimmt eine einheit mit genau 12 Zeichen', () => {
      expect(messwertAus({ wert: 1, einheit: 'Millisekunde' })?.einheit).toBe('Millisekunde');
    });

    it('nimmt 0 und negative Zahlen als wert und warnung', () => {
      expect(messwertAus({ wert: 0, einheit: 'ms', warnung: -1 })).toEqual({ wert: 0, einheit: 'ms', warnung: -1 });
    });
  });

  describe('liefert undefined', () => {
    it.each([
      ['null', null],
      ['Array', [{ wert: 1, einheit: '%' }]],
      ['Zahl', 42],
      ['String', 'Plattenplatz'],
    ])('bei %s', (_name, json) => {
      expect(messwertAus(json)).toBeUndefined();
    });

    it.each([
      ['wert fehlt', { einheit: '%' }],
      ['wert ist NaN', { wert: Number.NaN, einheit: '%' }],
      ['wert ist Infinity', { wert: Number.POSITIVE_INFINITY, einheit: '%' }],
      ['wert ist ein String', { wert: '86', einheit: '%' }],
      ['einheit fehlt', { wert: 86 }],
      ['einheit ist leer', { wert: 86, einheit: '' }],
      ['einheit besteht nur aus Leerzeichen', { wert: 86, einheit: '   ' }],
      ['einheit hat 13 Zeichen', { wert: 1, einheit: 'Millisekunden' }],
      ['max ist 0', { wert: 86, einheit: '%', max: 0 }],
      ['max ist negativ', { wert: 86, einheit: '%', max: -100 }],
      ['max ist nicht endlich', { wert: 86, einheit: '%', max: Number.POSITIVE_INFINITY }],
      ['warnung ist NaN', { wert: 86, einheit: '%', warnung: Number.NaN }],
      ['warnung ist nicht endlich', { wert: 86, einheit: '%', warnung: Number.NEGATIVE_INFINITY }],
      ['ein zusätzliches Feld vorkommt', { wert: 1, einheit: '%', farbe: 'rot' }],
      ['ein zusätzliches Feld undefined ist', { wert: 1, einheit: '%', farbe: undefined }],
    ])('wenn %s', (_name, json) => {
      expect(messwertAus(json)).toBeUndefined();
    });
  });
});
