/**
 * Das Wartungsfenster des automatischen Cockpit-Updates (COPI-142): Dienstag 07:00 bis vor 09:00 in Europe/Berlin, auch
 * über die Umstellung zwischen Sommer- und Winterzeit.
 */
import { describe, expect, it } from 'vitest';
import { imWartungsfenster } from '../src/status/update-planer.js';

describe('Wartungsfenster (COPI-142)', () => {
  it.each([
    // Sommerzeit (UTC+2): Dienstag, 20.10.2026
    ['2026-10-20T04:59:59Z', false, 'Di 06:59:59'],
    ['2026-10-20T05:00:00Z', true, 'Di 07:00'],
    ['2026-10-20T06:59:59Z', true, 'Di 08:59:59'],
    ['2026-10-20T07:00:00Z', false, 'Di 09:00'],
    // Winterzeit (UTC+1): Dienstag, 27.10.2026, zwei Tage nach der Umstellung
    ['2026-10-27T05:59:59Z', false, 'Di 06:59:59'],
    ['2026-10-27T06:00:00Z', true, 'Di 07:00'],
    ['2026-10-27T07:59:59Z', true, 'Di 08:59:59'],
    ['2026-10-27T08:00:00Z', false, 'Di 09:00'],
    // Andere Tage zur selben Uhrzeit
    ['2026-10-19T06:00:00Z', false, 'Mo 08:00'],
    ['2026-10-21T06:00:00Z', false, 'Mi 08:00'],
    // In UTC noch Montag, in Berlin schon Dienstag — und umgekehrt
    ['2026-10-19T23:30:00Z', false, 'Di 01:30'],
    ['2026-10-20T22:30:00Z', false, 'Mi 00:30'],
  ])('%s → %s (%s Berlin)', (zeit, erwartet) => {
    expect(imWartungsfenster(new Date(zeit))).toBe(erwartet);
  });
});
