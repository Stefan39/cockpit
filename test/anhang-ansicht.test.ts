/**
 * Was die Oberfläche über einen Anhang sagt (COPI-110): Zeile der Liste und starke Warnung je Grund.
 */
import { describe, expect, it } from 'vitest';
import { anhangZeileAnsicht, starkeWarnung } from '../src/module/anhang-ansicht.js';
import { anhangEinstufen } from '../src/module/anhang-pruefung.js';
import type { Anhang } from '../src/module/anhaenge.js';

function anhang(dateiname: string, kopf: readonly number[] | undefined, laenge: number | undefined, groesse = laenge ?? 0): Anhang {
  return {
    id: '7',
    dateiname,
    groesse,
    laenge,
    einstufung: anhangEinstufen(dateiname, kopf === undefined ? undefined : Uint8Array.from(kopf), laenge !== undefined),
  };
}

const PDF = [0x25, 0x50, 0x44, 0x46];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

describe('anhangZeileAnsicht', () => {
  it('verlinkt eine normale Datei auf die Warnseite, ohne Grund', () => {
    expect(anhangZeileAnsicht(anhang('a.pdf', PDF, 2048), '/w')).toEqual({ id: '7', name: 'a.pdf', klasse: 'normal', meta: 'PDF · 2 KB', grund: undefined, href: '/w', symbol: 'datei' });
  });

  it('nennt bei einem kleinen Anhang ohne Inhalt nur „liegt im Postfach" (nach der Frist)', () => {
    expect(anhangZeileAnsicht(anhang('a.pdf', undefined, undefined, 2048), '/w')).toMatchObject({ klasse: 'postfach', grund: 'Liegt im Postfach', href: undefined, symbol: 'posteingang' });
  });

  it('nennt bei einem großen „zu groß"', () => {
    expect(anhangZeileAnsicht(anhang('a.mov', undefined, undefined, 30_000_000), '/w')).toMatchObject({ grund: 'Zu groß fürs Cockpit, liegt im Postfach', meta: 'Video · 28,6 MB' });
  });

  it('verlinkt Gesperrtes nie', () => {
    expect(anhangZeileAnsicht(anhang('a.exe', PDF, 10), '/w')).toMatchObject({ klasse: 'gesperrt', href: undefined, symbol: 'schloss', grund: 'Gesperrt, liegt im Postfach' });
  });
});

describe('starkeWarnung', () => {
  it.each([
    ['a.zip', [0x50, 0x4b, 0x03, 0x04], 'Archiv: kann Programme und Makros enthalten.'],
    ['a.doc', OLE2, 'Office-Datei, die Makros enthalten kann.'],
    ['a.html', [...new TextEncoder().encode('<html>')], 'Webseite oder Grafik, die Skripte enthalten kann.'],
    ['a.pdf', [...new TextEncoder().encode('Hallo')], 'Die Endung passt nicht zum Inhalt.'],
  ] as const)('nennt für %s den passenden Grund', (name, kopf, titel) => {
    expect(starkeWarnung(anhang(name, kopf, 10))?.titel).toBe(titel);
  });

  it('sagt beim Widerspruch, was die Endung verspricht und was der Inhalt ist', () => {
    expect(starkeWarnung(anhang('a.pdf', OLE2, 10))?.text).toContain('Der Name sagt „PDF“, der Inhalt ist aber „Office-Datei (altes Format)“.');
    expect(starkeWarnung(anhang('a.pdf', [...new TextEncoder().encode('Hallo')], 10))?.text).toContain('der Inhalt passt aber nicht dazu');
  });

  it('gibt es für eine normale Datei nicht', () => {
    expect(starkeWarnung(anhang('a.pdf', PDF, 10))).toBeUndefined();
  });
});
