/**
 * Die frische Bestätigung durch einen vorhandenen Faktor (COPI-94): ein signiertes Cookie, gebunden an Sitzung, Konto
 * und Faktor, zehn Minuten gültig.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bestaetigungLesen,
  bestaetigungsCookie,
  FAKTOR_BESTAETIGT_COOKIE,
} from '../src/auth/faktor-bestaetigung.js';

const SCHLUESSEL = randomBytes(32);
const BEZUG = { sitzungId: 'sitzung-1', benutzerId: 'konto-1' };
const JETZT = new Date('2026-10-03T14:32:00Z');
const MINUTE = 60_000;

/** Der Cookie-Kopf, den der Browser aus der `set-cookie`-Zeile zurückschickt. */
function kopf(zeile: string): string {
  return zeile.slice(0, zeile.indexOf(';'));
}

describe('faktor-bestaetigung', () => {
  it('liest eine eben ausgestellte Bestätigung mit Faktor und Ablauf', () => {
    const zeile = bestaetigungsCookie(SCHLUESSEL, BEZUG, 'ersatzcode', JETZT);

    expect(bestaetigungLesen(SCHLUESSEL, `andere=1; ${kopf(zeile)}`, BEZUG, new Date(JETZT.getTime() + 9 * MINUTE))).toEqual({
      faktor: 'ersatzcode',
      bis: new Date(JETZT.getTime() + 10 * MINUTE),
    });
  });

  it('setzt ein host-only Cookie, das kein Skript liest und keine fremde Seite mitschickt', () => {
    const zeile = bestaetigungsCookie(SCHLUESSEL, BEZUG, 'passkey', JETZT);

    expect(zeile).toMatch(new RegExp(`^${FAKTOR_BESTAETIGT_COOKIE}=passkey\\.[0-9]+\\.[A-Za-z0-9_-]{43}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Strict$`));
  });

  it.each([
    ['einer anderen Sitzung', { ...BEZUG, sitzungId: 'sitzung-2' }, JETZT],
    ['einem anderen Konto', { ...BEZUG, benutzerId: 'konto-2' }, JETZT],
    ['nach zehn Minuten', BEZUG, new Date(JETZT.getTime() + 10 * MINUTE)],
  ])('gilt nicht in %s', (_fall, bezug, zeitpunkt) => {
    const zeile = bestaetigungsCookie(SCHLUESSEL, BEZUG, 'totp', JETZT);

    expect(bestaetigungLesen(SCHLUESSEL, kopf(zeile), bezug, zeitpunkt)).toBeUndefined();
  });

  it('gilt nicht mit einem anderen Schlüssel (nach einem Neustart)', () => {
    const zeile = bestaetigungsCookie(SCHLUESSEL, BEZUG, 'totp', JETZT);

    expect(bestaetigungLesen(randomBytes(32), kopf(zeile), BEZUG, JETZT)).toBeUndefined();
  });

  it('gilt nicht, wenn der Faktor im Cookie nachträglich geändert wurde', () => {
    const zeile = kopf(bestaetigungsCookie(SCHLUESSEL, BEZUG, 'ersatzcode', JETZT));

    expect(bestaetigungLesen(SCHLUESSEL, zeile.replace('=ersatzcode.', '=passkey.'), BEZUG, JETZT)).toBeUndefined();
  });

  it.each([
    ['ohne Cookie', undefined],
    ['mit leerem Wert', `${FAKTOR_BESTAETIGT_COOKIE}=`],
    ['mit unbekanntem Faktor', `${FAKTOR_BESTAETIGT_COOKIE}=passwort.1.x`],
    ['mit zusätzlichen Teilen', `${FAKTOR_BESTAETIGT_COOKIE}=totp.1.x.y`],
    ['mit ähnlichem Namen', 'faktor-bestaetigt=totp.1.x'],
  ])('kennt keine Bestätigung %s', (_fall, cookie) => {
    expect(bestaetigungLesen(SCHLUESSEL, cookie, BEZUG, JETZT)).toBeUndefined();
  });
});
