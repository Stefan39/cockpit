/**
 * Direkter Test von `istInternerPfad` und `istPipelinePfad` (COPI-165) — rein, ohne Datenbank.
 *
 * Beide Funktionen entscheiden im zentralen Tor, welche Pfade ohne Sitzung durchgehen. Jede Schreibweise
 * (roh, klein, prozent-dekodiert) muss auf das Präfix zeigen, sonst bleibt der Pfad zu.
 */
import { describe, expect, it } from 'vitest';
import { istInternerPfad, istPipelinePfad } from '../src/auth/zwei-faktor-tor.js';

describe('istInternerPfad', () => {
  it.each([
    ['/intern', true],
    ['/intern/', true],
    ['/intern/befund', true],
    ['/intern/agenten/x', true],
    ['/internx', false],
    ['/INTERN/x', false],
    ['/Intern/x', false],
    ['/%69ntern/x', false],
    ['/intern%2Fx', false],
    ['/intern/../portal', false],
    ['/', false],
    ['/pipeline/jobs', false],
  ])('%s -> %s', (pfad, erwartet) => {
    expect(istInternerPfad(pfad)).toBe(erwartet);
  });
});

describe('istPipelinePfad', () => {
  it.each([
    ['/pipeline', true],
    ['/pipeline/', true],
    ['/pipeline/jobs', true],
    ['/pipelinex', false],
    ['/PIPELINE/jobs', false],
    ['/Pipeline/jobs', false],
    ['/%70ipeline/jobs', false],
    ['/pipeline%2Fjobs', false],
    ['/pipeline/../intern', false],
    ['/', false],
    ['/intern/x', false],
  ])('%s -> %s', (pfad, erwartet) => {
    expect(istPipelinePfad(pfad)).toBe(erwartet);
  });
});
