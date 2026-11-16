/**
 * `moeglicheOptionen` (COPI-175): filtert die Entscheidungsoptionen nach dem geltenden Stand (`wenn`, ohne Angabe nur
 * „offen") und nach dem Entwurf (`entwurf: mit|ohne`, COPI-125). Rein, läuft ohne Datenbank.
 */
import { describe, expect, it } from 'vitest';
import { ENTSCHEIDUNG_OFFEN, type EntscheidungOption } from '../src/module/block.js';
import { moeglicheOptionen } from '../src/module/entscheidung.js';

function option(wert: string, rest: Partial<EntscheidungOption> = {}): EntscheidungOption {
  return { wert, label: wert, kurz: wert, ...rest };
}

function werte(optionen: readonly EntscheidungOption[]): string[] {
  return optionen.map((eintrag) => eintrag.wert);
}

describe('moeglicheOptionen', () => {
  it('behandelt einen fehlenden geltenden Stand als offen', () => {
    const optionen = [option('a'), option('b', { wenn: [ENTSCHEIDUNG_OFFEN] }), option('c', { wenn: ['freigegeben'] })];

    expect(werte(moeglicheOptionen(optionen, undefined, false))).toEqual(['a', 'b']);
    expect(werte(moeglicheOptionen(optionen, ENTSCHEIDUNG_OFFEN, false))).toEqual(['a', 'b']);
  });

  it('bietet bei Stand freigegeben nur Optionen mit passendem wenn an', () => {
    const optionen = [option('a'), option('b', { wenn: ['freigegeben'] }), option('c', { wenn: ['abgelehnt'] }), option('d', { wenn: ['offen', 'freigegeben'] })];

    expect(werte(moeglicheOptionen(optionen, 'freigegeben', false))).toEqual(['b', 'd']);
  });

  it('filtert nach Entwurf: mit nur mit Entwurf, ohne nur ohne, ohne Angabe immer', () => {
    const optionen = [option('mit', { entwurf: 'mit' }), option('ohne', { entwurf: 'ohne' }), option('egal')];

    expect(werte(moeglicheOptionen(optionen, undefined, true))).toEqual(['mit', 'egal']);
    expect(werte(moeglicheOptionen(optionen, undefined, false))).toEqual(['ohne', 'egal']);
  });

  it('verbindet Stand und Entwurf', () => {
    const optionen = [option('a', { entwurf: 'mit' }), option('b', { wenn: ['freigegeben'], entwurf: 'mit' }), option('c', { wenn: ['freigegeben'], entwurf: 'ohne' })];

    expect(werte(moeglicheOptionen(optionen, 'freigegeben', true))).toEqual(['b']);
    expect(werte(moeglicheOptionen(optionen, 'freigegeben', false))).toEqual(['c']);
    expect(werte(moeglicheOptionen(optionen, undefined, true))).toEqual(['a']);
  });

  it('behält die Reihenfolge der Eingabe bei', () => {
    const optionen = [option('z'), option('a'), option('m')];

    expect(werte(moeglicheOptionen(optionen, undefined, false))).toEqual(['z', 'a', 'm']);
  });

  it('liefert bei leerer Eingabe eine leere Liste', () => {
    expect(moeglicheOptionen([], undefined, true)).toEqual([]);
  });
});
