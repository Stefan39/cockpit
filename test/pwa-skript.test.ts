/**
 * Das Browser-Skript der installierbaren App (`assets/js/pwa.js`, COPI-58): ob Benachrichtigungen auf diesem Gerät
 * gehen, und ob es ein iPhone oder iPad ist — auch eines, das sich als Mac ausgibt.
 */
import { describe, expect, it } from 'vitest';
import { bereichOffen, formularBeschaeftigt, istIos, neuLadenFaellig, pushZugang, schluesselBytes, symbolZahl, type FormularDokument, type PushUmgebung } from '../assets/js/pwa.js';
import { vapidErzeugen } from '../src/chat/push.js';

const DESKTOP: PushUmgebung = { ios: false, standalone: false, serviceWorker: true, pushManager: true, notification: true, erlaubnis: 'default' };

describe('pushZugang', () => {
  it.each<[string, Partial<PushUmgebung>, string]>([
    ['Desktop-Browser, noch nicht gefragt', {}, 'moeglich'],
    ['erteilte Berechtigung', { erlaubnis: 'granted' }, 'erlaubt'],
    ['verweigerte Berechtigung', { erlaubnis: 'denied' }, 'abgelehnt'],
    ['iPhone im Safari-Tab', { ios: true, standalone: false }, 'home_bildschirm'],
    ['iPhone im Safari-Tab, auch wenn es Push kennte', { ios: true, standalone: false, erlaubnis: 'granted' }, 'home_bildschirm'],
    ['iPhone vom Home-Bildschirm, ab iOS 16.4', { ios: true, standalone: true }, 'moeglich'],
    ['iPhone vom Home-Bildschirm, vor iOS 16.4 (kein PushManager)', { ios: true, standalone: true, pushManager: false }, 'nicht_unterstuetzt'],
    ['Browser ohne Service Worker', { serviceWorker: false }, 'nicht_unterstuetzt'],
    ['Browser ohne Notification', { notification: false, erlaubnis: undefined }, 'nicht_unterstuetzt'],
  ])('%s: %s', (_fall, teil, erwartet) => {
    expect(pushZugang({ ...DESKTOP, ...teil })).toBe(erwartet);
  });
});

describe('schluesselBytes', () => {
  it('macht aus dem öffentlichen VAPID-Schlüssel die 65 Bytes, die applicationServerKey braucht', () => {
    const { oeffentlich } = vapidErzeugen();
    const bytes = schluesselBytes(oeffentlich);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
    expect(Buffer.from(bytes).toString('base64url')).toBe(oeffentlich);
  });
});

describe('istIos', () => {
  it.each<[string, string, string, number, boolean]>([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15', 'iPhone', 5, true],
    ['iPad (alte Kennung)', 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)', 'iPad', 5, true],
    ['iPad, das sich als Mac ausgibt', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 5, true],
    ['echter Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 0, false],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0', 'Linux armv8l', 5, false],
  ])('%s', (_fall, userAgent, plattform, punkte, erwartet) => {
    expect(istIos(userAgent, plattform, punkte)).toBe(erwartet);
  });
});

describe('neuLadenFaellig (COPI-105)', () => {
  const BASIS = { jetzt: 200_000, geladenUm: 100_000, taktSekunden: 60, sichtbar: true, online: true, beschaeftigt: false };

  it('lädt neu, wenn der Stand älter als der Takt ist', () => {
    expect(neuLadenFaellig(BASIS)).toBe(true);
  });

  it.each<[string, Partial<typeof BASIS>]>([
    ['solange der Stand jünger als der Takt ist', { jetzt: 159_999 }],
    ['wenn die Seite nicht sichtbar ist (Hintergrund, anderer Tab)', { sichtbar: false }],
    ['ohne Netz: sonst stünde eine Fehlerseite statt des alten Stands da', { online: false }],
    ['während ein Formular bearbeitet wird', { beschaeftigt: true }],
    ['bei unbrauchbarem Takt', { taktSekunden: Number.NaN }],
    ['bei einem Takt unter 15 s (Tippfehler im Markup)', { taktSekunden: 5 }],
  ])('lädt nicht neu %s', (_fall, teil) => {
    expect(neuLadenFaellig({ ...BASIS, ...teil })).toBe(false);
  });
});

describe('formularBeschaeftigt (COPI-105)', () => {
  const feld = (teil: Record<string, unknown> = {}) => ({ tagName: 'INPUT', type: 'text', value: '', defaultValue: '', checked: false, defaultChecked: false, isContentEditable: false, ...teil });
  const dokument = (felder: unknown[], aktiv: unknown = null) => ({ activeElement: aktiv, querySelectorAll: () => felder }) as unknown as FormularDokument;

  it('ist frei ohne Fokus und ohne Änderung', () => {
    expect(formularBeschaeftigt(dokument([feld(), feld({ type: 'checkbox' })]))).toBe(false);
  });

  it.each<[string, unknown[], unknown]>([
    ['ein Eingabefeld den Fokus hat', [feld()], feld()],
    ['ein Textfeld den Fokus hat', [], feld({ tagName: 'TEXTAREA' })],
    ['eine Auswahl den Fokus hat', [], feld({ tagName: 'SELECT' })],
    ['ein Feld geändert ist', [feld({ value: 'Entwurf' })], null],
    ['ein Häkchen geändert ist', [feld({ type: 'checkbox', checked: true })], null],
    ['eine Auswahl geändert ist', [feld({ tagName: 'SELECT', type: 'select-one', defaultValue: undefined, options: [{ selected: false, defaultSelected: true }, { selected: true, defaultSelected: false }] })], null],
  ])('ist beschäftigt, wenn %s', (_fall, felder, aktiv) => {
    expect(formularBeschaeftigt(dokument(felder, aktiv))).toBe(true);
  });

  it('zählt eine unveränderte Auswahl nicht', () => {
    expect(formularBeschaeftigt(dokument([feld({ tagName: 'SELECT', type: 'select-one', defaultValue: undefined, options: [{ selected: true, defaultSelected: true }] })]))).toBe(false);
  });

  it('zählt versteckte Felder (Token im Formular) nicht', () => {
    expect(formularBeschaeftigt(dokument([feld({ type: 'hidden', value: 'abc', defaultValue: '' })]))).toBe(false);
  });

  it('zählt einen fokussierten Knopf oder Link nicht', () => {
    expect(formularBeschaeftigt(dokument([], feld({ tagName: 'BUTTON' })))).toBe(false);
    expect(formularBeschaeftigt(dokument([], feld({ tagName: 'A' })))).toBe(false);
  });
});

describe('symbolZahl (COPI-116)', () => {
  it('nimmt nur eine ganze Zahl ab 0 aus dem Attribut des Badges', () => {
    expect(symbolZahl('0')).toBe(0);
    expect(symbolZahl('7')).toBe(7);
    expect(symbolZahl('120')).toBe(120);
    expect(symbolZahl('-1')).toBeUndefined();
    expect(symbolZahl('1.5')).toBeUndefined();
    expect(symbolZahl('')).toBeUndefined();
    expect(symbolZahl(undefined)).toBeUndefined();
    expect(symbolZahl('99+')).toBeUndefined();
  });
});

describe('bereichOffen (COPI-122)', () => {
  it.each<[string | null, boolean, boolean]>([
    ['auf', false, true],
    ['zu', true, false],
    [null, true, true],
    [null, false, false],
    ['unsinn', true, true],
  ])('gemerkt %j, Server offen %s → %s', (gemerkt, standard, erwartet) => {
    expect(bereichOffen(gemerkt, standard)).toBe(erwartet);
  });
});
