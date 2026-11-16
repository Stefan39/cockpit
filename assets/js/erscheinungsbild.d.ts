/**
 * Typen für `erscheinungsbild.js` (COPI-101), damit die Tests das Browser-Skript typgeprüft einbinden. Das Skript selbst
 * ist reines JavaScript ohne Build-Schritt und wird unverändert ausgeliefert.
 */
export type SymbolFehler = 'svg' | 'typ' | 'gross' | 'klein' | 'unlesbar' | 'server';

export interface Rechteck {
  readonly x: number;
  readonly y: number;
  readonly b: number;
  readonly h: number;
}

export const HOECHSTENS_BYTES: number;
export const MINDESTENS_PIXEL: number;
export const GROESSE: number;
export const HINTERGRUND: string;

export function dateiFehler(datei: { readonly name: string; readonly type: string; readonly size: number }): 'svg' | 'typ' | 'gross' | undefined;
export function grossGenug(breite: number, hoehe: number): boolean;
export function meldung(fehler: SymbolFehler, breite?: number, hoehe?: number): string;
export function zeichenFlaeche(breite: number, hoehe: number, rand: boolean, groesse?: number): { quelle: Rechteck; ziel: Rechteck };
