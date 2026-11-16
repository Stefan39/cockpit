/**
 * `ersatzcodesErzeugen` (COPI-26, COPI-94) ohne Datenbank: Anzahl, Eindeutigkeit, Format und Alphabet der Codes.
 * `ersatzcodeEinloesen` braucht die Datenbank und wird hier nicht geprüft.
 */
import { describe, expect, it } from 'vitest';
import { ERSATZCODE_ANZAHL, ersatzcodesErzeugen } from '../src/auth/ersatzcode.js';

const DURCHLAEUFE = 50;

describe('ersatzcodesErzeugen', () => {
  it('liefert genau ERSATZCODE_ANZAHL verschiedene Codes', () => {
    for (let i = 0; i < DURCHLAEUFE; i++) {
      const codes = ersatzcodesErzeugen();
      expect(codes).toHaveLength(ERSATZCODE_ANZAHL);
      expect(new Set(codes).size).toBe(ERSATZCODE_ANZAHL);
    }
  });

  it('erzeugt Codes im Format xxxxx-xxxxx', () => {
    for (let i = 0; i < DURCHLAEUFE; i++) {
      for (const code of ersatzcodesErzeugen()) {
        expect(code).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
      }
    }
  });

  it('verwendet keine leicht zu verwechselnden Zeichen (i, l, o, 0, 1)', () => {
    for (let i = 0; i < DURCHLAEUFE; i++) {
      for (const code of ersatzcodesErzeugen()) {
        expect(code).not.toMatch(/[ilo01]/);
      }
    }
  });
});
