/**
 * Die reinen Teile des Freigabemodus (COPI-141) ohne Datenbank: Typprüfungen, Bereichs-Zuordnung, Standard und Texttabellen.
 * Das Zusammenspiel mit der Datenbank prüft `freigabe-modus-datenbank.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  FREIGABE_BEREICH_TEXT,
  FREIGABE_BEREICHE,
  FREIGABE_MODI,
  FREIGABE_STANDARD,
  FREIGABE_TEXT,
  freigabeBereich,
  istFreigabeBereich,
  istFreigabeModus,
} from '../src/status/freigabe-modus.js';

describe('istFreigabeModus', () => {
  it.each(['rueckfrage', 'direkt'])('erkennt %s als gültig', (wert) => {
    expect(istFreigabeModus(wert)).toBe(true);
  });

  it.each([['Direkt'], [''], [1], [null], [undefined]])('weist %j ab', (wert) => {
    expect(istFreigabeModus(wert)).toBe(false);
  });
});

describe('istFreigabeBereich', () => {
  it.each(['cockpit', 'module'])('erkennt %s als gültig', (wert) => {
    expect(istFreigabeBereich(wert)).toBe(true);
  });

  it.each([['modul'], [''], [undefined]])('weist %j ab', (wert) => {
    expect(istFreigabeBereich(wert)).toBe(false);
  });
});

describe('freigabeBereich', () => {
  it('ordnet ein Modul den Modulen zu', () => {
    expect(freigabeBereich('modul')).toBe('module');
  });

  it('ordnet das Cockpit-Image dem Cockpit zu', () => {
    expect(freigabeBereich('cockpit-image')).toBe('cockpit');
  });
});

describe('FREIGABE_STANDARD', () => {
  it('ist die Rückfrage', () => {
    expect(FREIGABE_STANDARD).toBe('rueckfrage');
  });
});

describe('Texttabellen', () => {
  it('FREIGABE_TEXT hat genau die Schlüssel aus FREIGABE_MODI, jeder Text nicht leer', () => {
    expect(Object.keys(FREIGABE_TEXT).sort()).toEqual([...FREIGABE_MODI].sort());
    for (const text of Object.values(FREIGABE_TEXT)) {
      expect(text.trim()).not.toBe('');
    }
  });

  it('FREIGABE_BEREICH_TEXT hat genau die Schlüssel aus FREIGABE_BEREICHE, jeder Text nicht leer', () => {
    expect(Object.keys(FREIGABE_BEREICH_TEXT).sort()).toEqual([...FREIGABE_BEREICHE].sort());
    for (const text of Object.values(FREIGABE_BEREICH_TEXT)) {
      expect(text.trim()).not.toBe('');
    }
  });
});
