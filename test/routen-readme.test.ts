/**
 * Die Tabelle „Route × Zustand" im README ist dieselbe wie die, die der Routen-Test prüft
 * (COPI-29) — rein, ohne Datenbank.
 *
 * Sie steht im README zwischen zwei Markierungen und wird Zeichen für Zeichen mit
 * `tabelleBauen()` aus `routen-kategorien.ts` verglichen. Ändert jemand das Tor, ordnet eine
 * Route um oder ergänzt eine, muss das README mit: der Test nennt die richtige Tabelle.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tabelleBauen } from './routen-kategorien.js';

const START = '<!-- e2-routen:start -->';
const ENDE = '<!-- e2-routen:ende -->';

function readmeTabelle(): string {
  const readme = readFileSync('README.md', 'utf8');
  const von = readme.indexOf(START);
  const bis = readme.indexOf(ENDE);
  if (von < 0 || bis < von) {
    return '';
  }
  return readme.slice(von + START.length, bis).trim();
}

describe('README: E2, was erreichbar ist', () => {
  it('enthält die Tabelle zwischen den Markierungen', () => {
    expect(readmeTabelle()).not.toBe('');
  });

  it('gleicht der Tabelle, die der Routen-Test prüft, Zeichen für Zeichen', () => {
    // Bei Abweichung: den Abschnitt zwischen den Markierungen durch `tabelleBauen()` ersetzen.
    expect(readmeTabelle()).toBe(tabelleBauen());
  });
});
