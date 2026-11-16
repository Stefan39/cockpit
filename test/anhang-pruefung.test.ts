/**
 * Die Gefahrenklasse eines Anhangs (COPI-110): Endung und erste Bytes, Widersprüche, die Bereinigung des Namens und der
 * Header für den Download. Sicherheitskritisch — jede Grenze steht einzeln da.
 */
import { describe, expect, it } from 'vitest';
import { anhangEinstufen, dateinameBereinigen, endungVon, groesseText, inhaltsAngabe } from '../src/module/anhang-pruefung.js';

const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const MZ = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]);
const ELF = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02]);
const MACHO = Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]);
const OLE2 = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const TEXT = new TextEncoder().encode('Hallo zusammen,\n');
const HTML = new TextEncoder().encode('\uFEFF  <!DOCTYPE html><html>');

function klasse(name: string, kopf?: Uint8Array, inhaltDa = true) {
  return anhangEinstufen(dateinameBereinigen(name), kopf, inhaltDa);
}

describe('anhangEinstufen', () => {
  it('lässt eine PDF mit PDF-Inhalt normal', () => {
    expect(klasse('Anforderungen.pdf', PDF)).toMatchObject({ klasse: 'normal', art: 'PDF' });
  });

  it('lässt Text ohne erkennbaren Inhalt normal', () => {
    expect(klasse('notiz.txt', TEXT)).toMatchObject({ klasse: 'normal', art: 'TXT' });
  });

  it('nennt ein Word-Dokument nicht „ZIP-Archiv", obwohl es eines ist', () => {
    expect(klasse('Angebot.docx', ZIP)).toMatchObject({ klasse: 'normal', art: 'Word-Dokument' });
  });

  it.each(['setup.exe', 'rechnung.js', 'bild.scr', 'start.lnk', 'skript.PS1', 'x.hta', 'paket.msi', 'abbild.iso'])('sperrt %s nach der Endung', (name) => {
    expect(klasse(name, TEXT).klasse).toBe('gesperrt');
  });

  it.each([
    ['MZ', MZ, 'Programm (Windows)'],
    ['ELF', ELF, 'Programm (Linux)'],
    ['Mach-O', MACHO, 'Programm (macOS)'],
  ] as const)('sperrt %s-Inhalt hinter einer harmlosen Endung', (_name, kopf, art) => {
    expect(klasse('Rechnung.pdf', kopf)).toMatchObject({ klasse: 'gesperrt', art });
  });

  it('sperrt eine doppelte Endung nach der letzten', () => {
    expect(klasse('Rechnung_Oktober.pdf.exe', PDF).klasse).toBe('gesperrt');
  });

  it('sperrt trotz Bidi-Zeichen, das „fdp.exe" als „exe.pdf" zeigen würde', () => {
    expect(klasse('Rechnung\u202Efdp.exe', PDF).klasse).toBe('gesperrt');
  });

  it('sperrt trotz abschließender Punkte und Leerzeichen', () => {
    expect(klasse('setup.exe. . ', TEXT).klasse).toBe('gesperrt');
  });

  it('sperrt auch, wenn der Inhalt nicht im Cockpit liegt', () => {
    expect(klasse('setup.exe', undefined, false).klasse).toBe('gesperrt');
  });

  it('meldet einen Anhang ohne Inhalt als „liegt im Postfach"', () => {
    expect(klasse('Baustellenvideo.mov', undefined, false)).toMatchObject({ klasse: 'postfach', art: 'Video' });
  });

  it.each([
    ['Bestand.zip', ZIP, 'archiv'],
    ['Bestand.rar', Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a]), 'archiv'],
    ['Kalkulation.xlsm', ZIP, 'makro'],
    ['Alt.doc', OLE2, 'makro'],
    ['Seite.html', HTML, 'web'],
    ['Logo.svg', new TextEncoder().encode('<svg xmlns=…'), 'web'],
  ] as const)('warnt bei %s', (name, kopf, grund) => {
    expect(klasse(name, kopf)).toMatchObject({ klasse: 'warnung', warnGrund: grund });
  });

  it('warnt, wenn eine PDF in Wahrheit ein ZIP ist, und nennt den Inhalt', () => {
    expect(klasse('Angebot_alt.pdf', ZIP)).toMatchObject({ klasse: 'warnung', warnGrund: 'widerspruch', art: 'ZIP-Archiv', endungsArt: 'PDF' });
  });

  it('warnt, wenn eine PDF keinen PDF-Inhalt hat', () => {
    expect(klasse('Angebot.pdf', TEXT)).toMatchObject({ klasse: 'warnung', warnGrund: 'widerspruch' });
  });

  it('warnt bei einem Bild ohne Endung, das sich als JPEG zeigt', () => {
    expect(klasse('bild', JPEG)).toMatchObject({ klasse: 'warnung', warnGrund: 'widerspruch', art: 'JPEG-Bild', endungsArt: 'Datei' });
  });

  it('warnt bei altem Office-Inhalt hinter einer Textendung', () => {
    expect(klasse('liesmich.txt', OLE2)).toMatchObject({ klasse: 'warnung', warnGrund: 'widerspruch' });
  });
});

describe('dateinameBereinigen', () => {
  it('entfernt Bidi- und unsichtbare Zeichen', () => {
    expect(dateinameBereinigen('Rech\u200Bnung\u202Efdp.exe')).toBe('Rechnungfdp.exe');
  });

  it('entfernt Zeilenumbrüche, Steuerzeichen und Anführungszeichen', () => {
    expect(dateinameBereinigen('a\r\nb\u0007"c\'.pdf')).toBe('a bc.pdf');
  });

  it('macht aus Pfaden einen Namen', () => {
    expect(dateinameBereinigen('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(dateinameBereinigen('C:\\Windows\\x.bat')).toBe('C:_Windows_x.bat');
  });

  it('gibt einem leeren Namen einen', () => {
    expect(dateinameBereinigen(' \u202E. ')).toBe('anhang');
  });

  it('kürzt lange Namen vorn und behält die Endung', () => {
    const name = dateinameBereinigen(`${'a'.repeat(300)}.pdf.exe`);
    expect([...name]).toHaveLength(120);
    expect(name.endsWith('….exe')).toBe(true);
    expect(endungVon(name)).toBe('exe');
  });
});

describe('endungVon', () => {
  it('nimmt die letzte Endung, klein, und keine bei führendem Punkt', () => {
    expect(endungVon('A.Tar.GZ')).toBe('gz');
    expect(endungVon('.profil')).toBe('');
    expect(endungVon('ohne')).toBe('');
  });
});

describe('groesseText', () => {
  it('nennt Byte, KB und MB mit deutschem Komma', () => {
    expect(groesseText(980)).toBe('980 Byte');
    expect(groesseText(412 * 1024)).toBe('412 KB');
    expect(groesseText(2.1 * 1024 * 1024)).toBe('2,1 MB');
  });
});

describe('inhaltsAngabe', () => {
  it('liefert immer attachment, mit ASCII-Ersatz und vollem Namen nach RFC 5987', () => {
    expect(inhaltsAngabe('Grüße (2).pdf')).toBe(`attachment; filename="Gr__e (2).pdf"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%282%29.pdf`);
  });

  it('lässt im ASCII-Teil nichts übrig, was den Header brechen könnte', () => {
    const kopf = inhaltsAngabe(dateinameBereinigen('a";\r\nX-Evil: 1\\b.pdf'));
    expect(kopf).not.toMatch(/[\r\n]/);
    expect(kopf.split('"')).toHaveLength(3);
  });
});

describe('anhangEinstufen — Bildvorschau (COPI-124)', () => {
  const PNG_KOPF = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const JPEG_KOPF = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const WEBP_KOPF = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const GIF_KOPF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const SVG_KOPF = new TextEncoder().encode('<svg xmlns=');
  const ZIP_KOPF = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);

  it.each([
    ['creative.png', PNG_KOPF, 'image/png'],
    ['creative.jpg', JPEG_KOPF, 'image/jpeg'],
    ['creative.jpeg', JPEG_KOPF, 'image/jpeg'],
    ['creative.webp', WEBP_KOPF, 'image/webp'],
  ] as const)('gibt %s eine Vorschau (%s)', (name, kopf, typ) => {
    expect(anhangEinstufen(name, kopf, true)).toMatchObject({ klasse: 'normal', bild: typ });
  });

  it.each([
    ['ein GIF', 'creative.gif', GIF_KOPF],
    ['ein SVG (Skript möglich)', 'creative.svg', SVG_KOPF],
    ['ein PNG mit falscher Endung', 'creative.jpg', PNG_KOPF],
    ['ein ZIP, das sich als PNG ausgibt', 'creative.png', ZIP_KOPF],
    ['ein PNG ohne Inhalt im Cockpit', 'creative.png', PNG_KOPF],
  ] as const)('gibt %s keine Vorschau', (_fall, name, kopf) => {
    const inhaltDa = _fall !== 'ein PNG ohne Inhalt im Cockpit';
    expect(anhangEinstufen(name, kopf, inhaltDa).bild).toBeUndefined();
  });
});
