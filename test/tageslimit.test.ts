/**
 * Die reinen Teile des Tageslimits (COPI-57): der Kalendertag in Berlin, der Beginn des nächsten — auch an den Tagen,
 * an denen die Sommerzeit beginnt oder endet — und ab wann der Rest angezeigt wird.
 */
import { describe, expect, it } from 'vitest';
import { berlinerTag, naechsterTagesbeginn, restAnzeige } from '../src/chat/tageslimit.js';

describe('berlinerTag', () => {
  it.each([
    ['2026-09-23T10:00:00.000Z', '2026-09-23'],
    // 23:30 UTC ist in der Sommerzeit schon 01:30 am nächsten Tag.
    ['2026-09-22T23:30:00.000Z', '2026-09-23'],
    ['2026-09-22T21:59:59.000Z', '2026-09-22'],
    ['2026-09-22T22:00:00.000Z', '2026-09-23'],
    // Winterzeit: eine Stunde Versatz.
    ['2026-12-31T22:59:59.000Z', '2026-12-31'],
    ['2026-12-31T23:00:00.000Z', '2027-01-01'],
  ])('%s ist in Berlin der %s', (zeitpunkt, tag) => {
    expect(berlinerTag(new Date(zeitpunkt))).toBe(tag);
  });
});

describe('naechsterTagesbeginn', () => {
  it.each([
    ['ein Sommertag', '2026-09-23T10:00:00.000Z', '2026-09-23T22:00:00.000Z'],
    ['kurz vor Mitternacht', '2026-09-23T21:59:59.000Z', '2026-09-23T22:00:00.000Z'],
    ['genau Mitternacht', '2026-09-23T22:00:00.000Z', '2026-09-24T22:00:00.000Z'],
    ['ein Wintertag', '2026-12-01T12:00:00.000Z', '2026-12-01T23:00:00.000Z'],
    // Sommerzeit beginnt am 29.03.2026 um 02:00: der Tag davor endet noch in der Winterzeit (23:00 UTC), der Tag selbst in der Sommerzeit.
    ['der Tag vor Beginn der Sommerzeit', '2026-03-28T12:00:00.000Z', '2026-03-28T23:00:00.000Z'],
    ['der Tag, an dem die Sommerzeit beginnt', '2026-03-29T12:00:00.000Z', '2026-03-29T22:00:00.000Z'],
    // Sommerzeit endet am 25.10.2026 um 03:00: der Tag selbst endet schon in der Winterzeit.
    ['der Tag, an dem die Sommerzeit endet', '2026-10-25T12:00:00.000Z', '2026-10-25T23:00:00.000Z'],
    ['die doppelte Stunde in der Nacht', '2026-10-25T00:30:00.000Z', '2026-10-25T23:00:00.000Z'],
  ])('%s: der nächste Tag beginnt um Mitternacht in Berlin', (_fall, zeitpunkt, beginn) => {
    const ergebnis = naechsterTagesbeginn(new Date(zeitpunkt));
    expect(ergebnis.toISOString()).toBe(beginn);
    expect(berlinerTag(ergebnis)).not.toBe(berlinerTag(new Date(zeitpunkt)));
    expect(berlinerTag(new Date(ergebnis.getTime() - 1))).toBe(berlinerTag(new Date(zeitpunkt)));
  });
});

describe('restAnzeige', () => {
  it('zeigt den Rest erst ab 80 % und nie unter null', () => {
    expect(restAnzeige(0, 50)).toBeUndefined();
    expect(restAnzeige(39, 50)).toBeUndefined();
    expect(restAnzeige(40, 50)).toBe(10);
    expect(restAnzeige(50, 50)).toBe(0);
    expect(restAnzeige(55, 50)).toBe(0);
    expect(restAnzeige(4, 5)).toBe(1);
    expect(restAnzeige(3, 5)).toBeUndefined();
  });
});
