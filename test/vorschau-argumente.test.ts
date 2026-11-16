/**
 * `scripts/dev/vorschau.ts` (COPI-80): `argumenteLesen` ist eine reine Funktion, ohne Server und
 * ohne Datenbank — sie entscheidet nur, ob `--rolle`/`--port` brauchbar sind.
 */
import { describe, expect, it } from 'vitest';
import { argumenteLesen } from '../scripts/dev/vorschau.js';

describe('argumenteLesen (COPI-80)', () => {
  it('liest --rolle und nutzt den Standard-Port 3100 ohne --port', () => {
    expect(argumenteLesen(['--rolle', 'betreuer'])).toEqual({ rolle: 'betreuer', port: 3100 });
  });

  it.each(['betreuer', 'betriebs_admin', 'betrieb_mitarbeiter'])('akzeptiert die Rolle %s', (rolle) => {
    expect(argumenteLesen(['--rolle', rolle]).rolle).toBe(rolle);
  });

  it('liest einen gesetzten --port', () => {
    expect(argumenteLesen(['--rolle', 'betreuer', '--port', '4000'])).toEqual({ rolle: 'betreuer', port: 4000 });
  });

  it('nimmt die Reihenfolge der Optionen nicht ernst', () => {
    expect(argumenteLesen(['--port', '4000', '--rolle', 'betriebs_admin'])).toEqual({
      rolle: 'betriebs_admin',
      port: 4000,
    });
  });

  it('bricht ohne --rolle ab', () => {
    expect(() => argumenteLesen([])).toThrow(/--rolle/);
  });

  it('bricht bei einer unbekannten Rolle ab', () => {
    expect(() => argumenteLesen(['--rolle', 'admin'])).toThrow(/--rolle/);
  });

  it('bricht bei einem unbrauchbaren --port ab', () => {
    expect(() => argumenteLesen(['--rolle', 'betreuer', '--port', 'null'])).toThrow(/--port/);
    expect(() => argumenteLesen(['--rolle', 'betreuer', '--port', '0'])).toThrow(/--port/);
    expect(() => argumenteLesen(['--rolle', 'betreuer', '--port', '-5'])).toThrow(/--port/);
  });
});
