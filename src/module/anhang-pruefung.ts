/**
 * Die Gefahrenklasse eines Anhangs (COPI-110) — reine Funktionen, ohne Datenbank. Ein Anhang ist Fremdinhalt: Das
 * Cockpit prüft ihn nicht auf Schadsoftware, aber es sortiert ihn nach dem, was es sicher erkennen kann, bevor ein
 * Mensch ihn herunterlädt.
 *
 * **Vier Klassen** (Entscheidungen Stefan, 01.10. und 06.10.2026):
 *
 *   * `gesperrt` — ausführbar nach Endung (`.exe`, `.js`, …) **oder** nach den ersten Bytes (MZ/PE, ELF, Mach-O), gleich
 *     welche Endung. Nie auslieferbar, auch nicht nach Bestätigung; die Mail liegt weiter im Postfach.
 *   * `warnung` — Archive, Office mit Makros (auch das alte Office-Format, das Makros tragen kann), HTML und SVG, und
 *     jeder **Widerspruch** zwischen Endung und Inhalt („Rechnung.pdf", die ein ZIP ist). Download erst nach einer
 *     Bestätigung mit Pflicht-Haken.
 *   * `postfach` — kein Inhalt im Cockpit (zu groß, oder nach der Frist entfernt, COPI-102). Nur der Name.
 *   * `normal` — alles andere. Download nach einer einfachen Bestätigung.
 *
 * **Endung aus dem bereinigten Namen.** Erst fallen unsichtbare und Bidi-Zeichen weg (`U+202E` ließe „fdp.exe" als
 * „exe.pdf" erscheinen), dann gilt die letzte Endung — „Rechnung.pdf.exe" ist ein Programm. Abschließende Punkte und
 * Leerzeichen zählen nicht (Windows ignoriert sie: „a.exe." startet wie „a.exe").
 */
import { langtextBereinigen } from './ansicht.js';

export type AnhangKlasse = 'normal' | 'warnung' | 'gesperrt' | 'postfach';

/** Größer liefert das Cockpit nichts aus (Entscheidung Stefan, 01.10.2026), gleich was die View meldet. */
export const ANHANG_HOECHSTENS_BYTES = 10 * 1024 * 1024;

/** So viele Bytes vom Anfang des Inhalts reichen für jede Erkennung hier; mehr liest die Liste nicht. */
export const ANHANG_KOPF_BYTES = 16;

/** Höchstlänge eines Dateinamens, wie er gezeigt und im Header geliefert wird. */
const NAME_HOECHSTENS = 120;

/** Ausführbar nach Endung: nie auslieferbar (Entscheidung Stefan, 01.10.2026). */
const GESPERRTE_ENDUNGEN: ReadonlySet<string> = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'jar', 'lnk', 'iso', 'img', 'dll', 'hta', 'reg', 'msc',
]);

/** Warum ein Anhang eine Warnung trägt — bestimmt den Satz auf der Warnseite. */
export type WarnGrund = 'archiv' | 'makro' | 'web' | 'widerspruch';

/** Eine Inhaltsart, die sich an ihren ersten Bytes erkennen lässt, mit den Endungen, die zu ihr passen. */
interface Inhaltsart {
  readonly name: string;
  readonly endungen: readonly string[];
  readonly erkennen: (kopf: Uint8Array) => boolean;
  /** Ausführbar: gesperrt, gleich welche Endung. */
  readonly ausfuehrbar?: true;
  /** Diese Art ist schon selbst eine Warnung, auch wenn Endung und Inhalt zusammenpassen. */
  readonly warnung?: WarnGrund;
  /** Ein Bild, das die Detailseite als Vorschau zeigen darf (COPI-124), mit seinem Medientyp. */
  readonly bild?: BildTyp;
}

/** Die Bildarten mit Vorschau (COPI-124, Entscheidung Stefan 08.10.2026): nur diese drei, nie SVG oder GIF. */
export type BildTyp = 'image/png' | 'image/jpeg' | 'image/webp';

function beginntMit(kopf: Uint8Array, ...bytes: number[]): boolean {
  return bytes.every((byte, stelle) => kopf[stelle] === byte);
}

/** Der Anfang als Text (nur ASCII), ohne UTF-8-BOM und führende Leerzeichen, klein — für HTML und SVG. */
function textAnfang(kopf: Uint8Array): string {
  const ohneBom = beginntMit(kopf, 0xef, 0xbb, 0xbf) ? kopf.subarray(3) : kopf;
  return String.fromCharCode(...ohneBom).trimStart().toLowerCase();
}

const INHALTSARTEN: readonly Inhaltsart[] = [
  { name: 'Programm (Windows)', endungen: [], erkennen: (k) => beginntMit(k, 0x4d, 0x5a), ausfuehrbar: true },
  { name: 'Programm (Linux)', endungen: [], erkennen: (k) => beginntMit(k, 0x7f, 0x45, 0x4c, 0x46), ausfuehrbar: true },
  {
    name: 'Programm (macOS)',
    endungen: [],
    // Mach-O 32/64 Bit in beiden Byte-Reihenfolgen und die „fat"-Form (CAFEBABE, zugleich eine Java-Klasse).
    erkennen: (k) =>
      [
        [0xfe, 0xed, 0xfa, 0xce],
        [0xfe, 0xed, 0xfa, 0xcf],
        [0xce, 0xfa, 0xed, 0xfe],
        [0xcf, 0xfa, 0xed, 0xfe],
        [0xca, 0xfe, 0xba, 0xbe],
      ].some((magie) => beginntMit(k, ...magie)),
    ausfuehrbar: true,
  },
  { name: 'PDF', endungen: ['pdf'], erkennen: (k) => beginntMit(k, 0x25, 0x50, 0x44, 0x46) },
  { name: 'PNG-Bild', endungen: ['png'], erkennen: (k) => beginntMit(k, 0x89, 0x50, 0x4e, 0x47), bild: 'image/png' },
  { name: 'JPEG-Bild', endungen: ['jpg', 'jpeg', 'jfif'], erkennen: (k) => beginntMit(k, 0xff, 0xd8, 0xff), bild: 'image/jpeg' },
  // „RIFF", vier Bytes Länge, „WEBP".
  { name: 'WebP-Bild', endungen: ['webp'], erkennen: (k) => beginntMit(k, 0x52, 0x49, 0x46, 0x46) && beginntMit(k.subarray(8), 0x57, 0x45, 0x42, 0x50), bild: 'image/webp' },
  { name: 'GIF-Bild', endungen: ['gif'], erkennen: (k) => beginntMit(k, 0x47, 0x49, 0x46, 0x38) },
  {
    name: 'ZIP-Archiv',
    // Office (ab 2007), OpenDocument und E-Books sind ZIP-Container.
    endungen: ['zip', 'docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'odt', 'ods', 'odp', 'epub', 'jar'],
    erkennen: (k) => beginntMit(k, 0x50, 0x4b, 0x03, 0x04) || beginntMit(k, 0x50, 0x4b, 0x05, 0x06) || beginntMit(k, 0x50, 0x4b, 0x07, 0x08),
  },
  { name: 'RAR-Archiv', endungen: ['rar'], erkennen: (k) => beginntMit(k, 0x52, 0x61, 0x72, 0x21), warnung: 'archiv' },
  { name: '7z-Archiv', endungen: ['7z'], erkennen: (k) => beginntMit(k, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), warnung: 'archiv' },
  { name: 'GZIP-Archiv', endungen: ['gz', 'tgz'], erkennen: (k) => beginntMit(k, 0x1f, 0x8b), warnung: 'archiv' },
  {
    // Das alte Office-Format (OLE2): Word, Excel und PowerPoint vor 2007, auch Outlook-Nachrichten — kann Makros tragen.
    name: 'Office-Datei (altes Format)',
    endungen: ['doc', 'dot', 'xls', 'xlt', 'ppt', 'pot', 'pps', 'msg'],
    erkennen: (k) => beginntMit(k, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1),
    warnung: 'makro',
  },
  { name: 'HTML-Seite', endungen: ['html', 'htm', 'xhtml'], erkennen: (k) => /^<(!doctype html|html)/.test(textAnfang(k)), warnung: 'web' },
  { name: 'SVG-Grafik', endungen: ['svg'], erkennen: (k) => textAnfang(k).startsWith('<svg'), warnung: 'web' },
];

/** Endungen, die eine Warnung tragen, auch wenn der Inhalt nicht erkannt wird (Entscheidung Stefan, 01.10.2026). */
const WARN_ENDUNGEN: Readonly<Record<string, WarnGrund>> = {
  zip: 'archiv',
  rar: 'archiv',
  '7z': 'archiv',
  gz: 'archiv',
  tgz: 'archiv',
  docm: 'makro',
  xlsm: 'makro',
  pptm: 'makro',
  doc: 'makro',
  dot: 'makro',
  xls: 'makro',
  xlt: 'makro',
  ppt: 'makro',
  pot: 'makro',
  pps: 'makro',
  html: 'web',
  htm: 'web',
  xhtml: 'web',
  svg: 'web',
  svgz: 'web',
};

/** Namen für Endungen, die genauer sind als ihre Inhaltsart (ein Word-Dokument ist auch ein ZIP) oder keine haben. */
const ENDUNGS_NAMEN: Readonly<Record<string, string>> = {
  docx: 'Word-Dokument',
  docm: 'Word-Dokument mit Makros',
  xlsx: 'Excel-Tabelle',
  xlsm: 'Excel-Tabelle mit Makros',
  pptx: 'PowerPoint',
  pptm: 'PowerPoint mit Makros',
  odt: 'OpenDocument-Text',
  ods: 'OpenDocument-Tabelle',
  odp: 'OpenDocument-Präsentation',
  epub: 'E-Book',
  mov: 'Video',
  mp4: 'Video',
};

/**
 * Ein Dateiname, wie das Cockpit ihn zeigt und ausliefert: ohne unsichtbare, Steuer- und Bidi-Zeichen, ohne Pfad
 * (`/`, `\`), ohne Anführungszeichen, Leerraum zusammengefasst, höchstens `NAME_HOECHSTENS` Zeichen — gekürzt wird vorn,
 * die Endung bleibt. Leer: „anhang".
 */
export function dateinameBereinigen(roh: string): string {
  const bereinigt = langtextBereinigen(roh)
    .replace(/[\t\n\r\u0080-\u009f]/g, ' ')
    .replace(/[/\\]/g, '_')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (bereinigt === '') {
    return 'anhang';
  }
  const zeichen = [...bereinigt];
  if (zeichen.length <= NAME_HOECHSTENS) {
    return bereinigt;
  }
  // Vorn kürzen, die Endung (höchstens 16 Zeichen) bleibt: „Rechnung … .pdf.exe" soll man noch als .exe erkennen.
  const endung = [...bereinigt.slice(bereinigt.lastIndexOf('.'))];
  const schwanz = bereinigt.lastIndexOf('.') > 0 && endung.length <= 16 ? endung : [];
  return zeichen.slice(0, NAME_HOECHSTENS - 1 - schwanz.length).join('') + '…' + schwanz.join('');
}

/** Die letzte Endung eines bereinigten Namens, klein; ohne Punkt oder bei „.profil" (nur Punkt vorn): leer. */
export function endungVon(name: string): string {
  const punkt = name.lastIndexOf('.');
  return punkt > 0 ? name.slice(punkt + 1).toLowerCase() : '';
}

/** Was der Kopf des Inhalts verrät; `undefined`, wenn nichts Bekanntes. */
function inhaltErkennen(kopf: Uint8Array | undefined): Inhaltsart | undefined {
  return kopf === undefined || kopf.length === 0 ? undefined : INHALTSARTEN.find((art) => art.erkennen(kopf));
}

export interface AnhangEinstufung {
  readonly klasse: AnhangKlasse;
  /** Nur bei `warnung`. */
  readonly warnGrund: WarnGrund | undefined;
  /** Was der Inhalt ist, wenn er erkannt wurde, sonst was die Endung sagt — etwa „PDF", „ZIP-Archiv", „TXT". */
  readonly art: string;
  /** Was die Endung verspricht, für den Satz beim Widerspruch — etwa „PDF". */
  readonly endungsArt: string;
  /**
   * Der Medientyp für die Bildvorschau (COPI-124): nur bei `normal`, wenn der Inhalt ein PNG, JPEG oder WebP ist und die
   * Endung dazu passt. Sonst `undefined` — ein „bild.png", das ein ZIP ist, bekommt nie eine Vorschau.
   */
  readonly bild: BildTyp | undefined;
}

/** Der Name für eine Endung: ein eigener Name, die Inhaltsart, zu der sie gehört, oder die Endung groß; ohne: „Datei". */
function endungsName(endung: string): string {
  if (endung === '') {
    return 'Datei';
  }
  return ENDUNGS_NAMEN[endung] ?? INHALTSARTEN.find((art) => art.endungen.includes(endung))?.name ?? endung.toUpperCase();
}

/**
 * Die Klasse eines Anhangs aus bereinigtem Namen, Kopf des Inhalts (`ANHANG_KOPF_BYTES`) und ob der Inhalt im Cockpit
 * liegt (`inhaltDa`: vorhanden und höchstens `ANHANG_HOECHSTENS_BYTES`). Gesperrt geht vor allem, dann „liegt im
 * Postfach", dann Warnung.
 */
export function anhangEinstufen(name: string, kopf: Uint8Array | undefined, inhaltDa: boolean): AnhangEinstufung {
  const endung = endungVon(name);
  const inhalt = inhaltErkennen(kopf);
  const endungsArt = endungsName(endung);
  // Gezeigt wird, was die Endung sagt — außer der Inhalt ist ein Programm oder passt nicht dazu: dann, was er ist.
  const art = inhalt !== undefined && (inhalt.ausfuehrbar === true || !inhalt.endungen.includes(endung)) ? inhalt.name : endungsArt;
  const bild = inhalt?.bild !== undefined && inhalt.endungen.includes(endung) ? inhalt.bild : undefined;
  const ergebnis = (klasse: AnhangKlasse, warnGrund?: WarnGrund): AnhangEinstufung => ({ klasse, warnGrund, art, endungsArt, bild: klasse === 'normal' ? bild : undefined });

  if (GESPERRTE_ENDUNGEN.has(endung) || inhalt?.ausfuehrbar === true) {
    return ergebnis('gesperrt');
  }
  if (!inhaltDa) {
    return ergebnis('postfach');
  }
  // Ein Widerspruch: der Inhalt ist etwas Bekanntes, das nicht zur Endung passt — oder die Endung verspricht eine
  // erkennbare Art, und der Inhalt ist es nicht.
  const endungErkennbar = INHALTSARTEN.some((kandidat) => kandidat.endungen.includes(endung));
  const widerspruch = inhalt === undefined ? endungErkennbar : !inhalt.endungen.includes(endung);
  if (widerspruch) {
    return ergebnis('warnung', 'widerspruch');
  }
  const grund = WARN_ENDUNGEN[endung] ?? inhalt?.warnung;
  return grund === undefined ? ergebnis('normal') : ergebnis('warnung', grund);
}

/** „980 Byte", „412 KB", „2,1 MB" — wie im Entwurf, mit deutschem Komma. */
export function groesseText(bytes: number): string {
  if (bytes < 1024) {
    return `${String(Math.max(0, Math.round(bytes)))} Byte`;
  }
  if (bytes < 1024 * 1024) {
    return `${String(Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/**
 * Der Header `Content-Disposition` für den Download: `attachment` (nie im Browser anzeigen; `inline` nur für die
 * Bildvorschau, COPI-124), mit einem ASCII-Namen
 * für alte Browser und dem vollen Namen nach RFC 5987/6266 (`filename*`). Der Name ist schon bereinigt; hier wird nur
 * noch kodiert.
 */
export function inhaltsAngabe(name: string, art: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[";\\%]/g, '_');
  const kodiert = encodeURIComponent(name).replace(/['()*]/g, (zeichen) => `%${zeichen.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${art}; filename="${ascii}"; filename*=UTF-8''${kodiert}`;
}
