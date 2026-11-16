/**
 * Kontrast der Theme-Werte (COPI-30, Barrierefreiheit): Die Farben stehen an **einer** Stelle,
 * `assets/css/input.css`, im Block `@theme static` — je Name ein Wert, `light-dark(hell, dunkel)` oder ein Wert
 * für beide Modi (seit COPI-43, damit der Dark-Mode-Schalter keinen zweiten Block braucht).
 * Dieser Test liest sie von dort und misst jedes Paar, das die Oberfläche wirklich verwendet,
 * nach WCAG 2.2: Text mindestens 4,5 : 1 (AA), Bedienelemente und Fokus mindestens 3 : 1.
 *
 * Er ersetzt die Sicht „sieht lesbar aus": Wer später einen Farbwert ändert, sieht hier sofort,
 * ob AA hält, in beiden Modi.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Farben = Readonly<Record<string, string>>;

const quelle = readFileSync('assets/css/input.css', 'utf8');

const HEX = '(#[0-9a-fA-F]{6})';

/** Die Farben eines Modus: aus `light-dark(hell, dunkel)` die passende Hälfte, ein einzelner Wert gilt für beide. */
function farbenLesen(block: string, modus: 'hell' | 'dunkel'): Farben {
  const farben: Record<string, string> = {};
  const muster = new RegExp(`--color-([a-z0-9-]+):\\s*(?:light-dark\\(\\s*${HEX}\\s*,\\s*${HEX}\\s*\\)|${HEX})\\s*;`, 'g');
  for (const treffer of block.matchAll(muster)) {
    const wert = treffer[4] ?? (modus === 'hell' ? treffer[2] : treffer[3]) ?? '';
    farben[treffer[1] ?? ''] = wert.toLowerCase();
  }
  return farben;
}

const themeBlock = /@theme static\s*\{([^}]*)\}/.exec(quelle)?.[1] ?? '';
const hell = farbenLesen(themeBlock, 'hell');
const dunkel = farbenLesen(themeBlock, 'dunkel');

/** Relative Leuchtdichte nach WCAG 2.x. */
function leuchtdichte(hex: string): number {
  const kanal = (start: number): number => {
    const wert = parseInt(hex.slice(start, start + 2), 16) / 255;
    return wert <= 0.03928 ? wert / 12.92 : ((wert + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * kanal(1) + 0.7152 * kanal(3) + 0.0722 * kanal(5);
}

function kontrast(a: string, b: string): number {
  const [hoch, tief] = [leuchtdichte(a), leuchtdichte(b)].sort((x, y) => y - x) as [number, number];
  return (hoch + 0.05) / (tief + 0.05);
}

/** Text auf Fläche: AA für normalen Text. */
const TEXT_PAARE: readonly (readonly [vordergrund: string, hintergrund: string])[] = [
  ['ink', 'page'],
  ['ink', 'surface'],
  ['ink-2', 'page'],
  ['ink-2', 'surface'],
  ['ink-3', 'page'],
  ['ink-3', 'surface'],
  ['accent', 'page'],
  ['accent', 'surface'],
  ['accent', 'accent-soft'],
  ['ok', 'ok-soft'],
  ['ok', 'surface'],
  ['warn', 'warn-soft'],
  ['warn', 'surface'],
  ['danger', 'danger-soft'],
  ['danger', 'surface'],
  ['ink', 'warn-soft'],
  ['ink', 'danger-soft'],
  ['ink-2', 'warn-soft'],
  // Die Statuskarte der Übersicht (COPI-37): Text auf allen vier Flächen.
  ['ink', 'ok-soft'],
  ['ink-2', 'ok-soft'],
  ['ink-2', 'danger-soft'],
  ['on-primary', 'primary'],
  // „Jetzt ansehen" der Statuskarte (COPI-43): Schrift in der Farbe der Fläche auf Warn- bzw. Fehlerfarbe.
  ['surface', 'warn'],
  ['surface', 'danger'],
  // Dashboard (COPI-81): Text auf den getönten Karten, Pillen und Kürzel auf der weichen Fläche.
  ['ink', 'danger-hauch'],
  ['ink-2', 'danger-hauch'],
  ['ink-3', 'danger-hauch'],
  ['ink', 'warn-hauch'],
  ['ink-2', 'warn-hauch'],
  ['ink-3', 'warn-hauch'],
  ['surface', 'ok'],
  // Kacheln der Modulseite (COPI-82): der aktive Filter-Chip füllt sich dunkel (surface-Text auf ink-Grund,
  // statt der Akzentfarbe der Meldungen-Chips), „Details" in der Fußzeile steht in der Akzentfarbe auch auf
  // den getönten Karten (rot/gelb).
  ['surface', 'ink'],
  ['accent', 'danger-hauch'],
  ['accent', 'warn-hauch'],
  // Übernahme-Sperre (COPI-85): Band und Marke auf der weichen Akzentfläche — Titel und Marke in der Akzentfarbe (oben),
  // der Satz darunter in `ink`; das Schloss weiß auf der Primärfarbe (oben, `on-primary` auf `primary`).
  ['ink', 'accent-soft'],
  ['ink-2', 'accent-soft'],
];

/**
 * Bedienelemente und Fokus: mindestens 3 : 1 gegen die Fläche, auf der sie sitzen (WCAG 1.4.11).
 * Der Primärknopf steht bewusst nicht hier: Er wird über seine Beschriftung erkannt (weiß auf
 * Blau, oben gemessen); seine Fläche gegen den dunklen Grund liegt bei 2,7 : 1, das verlangt
 * die Regel für beschriftete Schaltflächen nicht.
 */
const BEDIENELEMENT_PAARE: readonly (readonly [vordergrund: string, hintergrund: string])[] = [
  ['field-line', 'surface'],
  ['focus', 'surface'],
  ['focus', 'page'],
  // Die Segmente der Stundenbänder und des Wochendiagramms (COPI-81) auf jeder Fläche, auf der sie stehen.
  ['band-ok', 'surface'],
  ['band-warn', 'surface'],
  ['band-danger', 'surface'],
  ['band-ok', 'danger-hauch'],
  ['band-warn', 'danger-hauch'],
  ['band-danger', 'danger-hauch'],
  ['band-ok', 'warn-hauch'],
  ['band-warn', 'warn-hauch'],
  ['band-danger', 'warn-hauch'],
];

describe.each([
  ['hell', hell],
  ['dunkel', dunkel],
] as const)('Kontrast (%s)', (_modus, farben) => {
  it.each(TEXT_PAARE)('%s auf %s: mindestens 4,5 : 1 (AA)', (vordergrund, hintergrund) => {
    const v = farben[vordergrund];
    const h = farben[hintergrund];
    expect(v, `Farbe „${vordergrund}" fehlt`).toBeDefined();
    expect(h, `Farbe „${hintergrund}" fehlt`).toBeDefined();
    const verhaeltnis = kontrast(v as string, h as string);

    expect(verhaeltnis, `${vordergrund} ${String(v)} auf ${hintergrund} ${String(h)}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(BEDIENELEMENT_PAARE)('%s gegen %s: mindestens 3 : 1 (Bedienelement)', (vordergrund, hintergrund) => {
    const v = farben[vordergrund];
    const h = farben[hintergrund];
    expect(v, `Farbe „${vordergrund}" fehlt`).toBeDefined();
    expect(h, `Farbe „${hintergrund}" fehlt`).toBeDefined();
    const verhaeltnis = kontrast(v as string, h as string);

    expect(verhaeltnis, `${vordergrund} ${String(v)} gegen ${hintergrund} ${String(h)}`).toBeGreaterThanOrEqual(3);
  });

  /*
   * Der Rand des Übernahme-Bands (COPI-85, `accent-rand`) ist Schmuck wie `danger-rand`/`warn-rand`: das Band trägt seine
   * Bedeutung über Text, Schloss und `role="status"`, WCAG 1.4.11 verlangt für ihn keine 3 : 1. Sichtbar soll er
   * trotzdem sein — gegen die eigene Fläche, gegen die Karte und gegen die Seite, und dunkler bzw. heller als die Fläche
   * in dieselbe Richtung wie der Akzent (sonst wirkte er im Dunkelmodus wie ein Loch).
   */
  it.each([['accent-soft'], ['surface'], ['page']])('accent-rand hebt sich von %s ab (mindestens 1,3 : 1)', (hintergrund) => {
    const rand = farben['accent-rand'];
    const h = farben[hintergrund];
    expect(rand, 'Farbe „accent-rand" fehlt').toBeDefined();
    expect(kontrast(rand as string, h as string)).toBeGreaterThanOrEqual(1.3);
  });

  it('accent-rand liegt zwischen weicher Fläche und Akzent', () => {
    const [soft, rand, akzent] = [farben['accent-soft'], farben['accent-rand'], farben.accent].map((wert) => leuchtdichte(wert ?? '#000000')) as [number, number, number];
    expect((rand - soft) * (akzent - soft)).toBeGreaterThan(0);
    expect(Math.abs(rand - soft)).toBeLessThan(Math.abs(akzent - soft));
  });
});

describe('Theme-Werte an einer Stelle', () => {
  it('liest in beiden Modi dieselben Farbnamen', () => {
    expect(Object.keys(hell).length).toBeGreaterThanOrEqual(18);
    expect(Object.keys(dunkel).sort()).toEqual(Object.keys(hell).sort());
  });

  it('hat für jede Farbe genau einen Wert und keinen zweiten Farbblock (COPI-43)', () => {
    const deklariert = [...themeBlock.matchAll(/--color-[a-z0-9-]+:/g)].length;

    expect(Object.keys(hell)).toHaveLength(deklariert);
    // Kein Dunkel-Block mehr, der mit den Werten oben auseinanderlaufen könnte.
    expect(quelle).not.toMatch(/--color-[a-z0-9-]+:\s*#[0-9a-fA-F]{6}[^}]*prefers-color-scheme|prefers-color-scheme[^@]*--color-/);
  });

  it('ändert im Dunkelmodus den Primärknopf nicht auf eine helle Fläche mit weißem Text', () => {
    // Der Prototyp nutzt fest #2954E0 mit Weiß; ein helles Blau (#7DA0FF) darunter fiele durch.
    expect(kontrast(dunkel['on-primary'] ?? '#000000', dunkel.primary ?? '#000000')).toBeGreaterThanOrEqual(4.5);
  });

  it('enthält in den Views keine festen Farbwerte: Farben kommen nur aus den Theme-Werten', () => {
    for (const datei of ['layout.eta', 'uebersicht.eta', 'partials/kopf.eta', 'partials/hinweis.eta', 'partials/feld.eta', 'partials/kachel.eta', 'partials/status-karte.eta', 'agenten.eta', 'zeitplan.eta', 'partials/agent-karte.eta', 'einstellungen.eta', 'mehr.eta', 'meldungen.eta', 'partials/rahmen.eta', 'partials/symbol.eta', 'partials/darstellung.eta', 'partials/seiten-kopf.eta', 'partials/band.eta', 'partials/dienst-karte.eta', 'partials/letzte-meldungen.eta', 'partials/wachen-kacheln.eta', 'partials/woche-diagramm.eta', 'modul.eta', 'partials/modul-kachel.eta', 'partials/dienst-kuerzel.eta', 'modul-detail.eta', 'partials/modul-liste.eta', 'partials/sperr-marke.eta', 'partials/bild-vorschau.eta']) {
      expect(readFileSync(`views/${datei}`, 'utf8'), datei).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/);
    }
  });
});
