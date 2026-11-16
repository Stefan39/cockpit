/**
 * Der `cockpit:`-Block des Ansichtstyps `kennzahlen` (COPI-98) — Schema-Regeln, ohne Datenbank.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { kennzahlenSpalten, modulBlockAusText, modulBlockPruefen } from '../src/module/block.js';

const BLOCK = {
  kennung: 'ki-verbrauch',
  menuename: 'KI-Verbrauch',
  ansicht: 'kennzahlen',
  view: 'v_modul_ki_verbrauch',
  spalten: [
    { name: 'wert', label: 'Kosten', format: 'euro' },
    { name: 'tokens', label: 'Tokens', format: 'zahl', davon: { name: 'tokens_cache_lesen', text: 'aus dem Cache gelesen' } },
  ],
  aufteilungen: [
    { name: 'projekt', label: 'Je Projekt', filter: true, darunter: { name: 'ticket', label: 'Je Ticket' } },
    { name: 'modell', label: 'Je Modell' },
  ],
  anteile: [{ name: 'wert_geschaetzt', label: 'geschätzt' }],
  hinweise: 'v_modul_ki_verbrauch_hinweise',
  rollen: ['betreuer'],
  eingriffe: [],
  uebersicht: { titel: 'KI-Verbrauch', reihenfolge: 20 },
};

const LISTE = {
  kennung: 'server-zustand',
  menuename: 'Server & Dienste',
  ansicht: 'liste-detail',
  view: 'v_modul_server_zustand',
  spalten: [{ name: 'titel', label: 'Bereich' }],
  rollen: ['betreuer'],
  eingriffe: [],
};

function mit(aenderung: Record<string, unknown>, basis: Record<string, unknown> = BLOCK): unknown {
  return { ...basis, ...aenderung };
}

function grund(daten: unknown): string {
  const ergebnis = modulBlockPruefen(daten);
  return ergebnis.ok ? '' : ergebnis.grund;
}

describe('Modul-Block: ansicht kennzahlen', () => {
  it('nimmt einen vollständigen Kennzahlen-Block an', () => {
    expect(grund(BLOCK)).toBe('');
  });

  it('kommt ohne Aufteilungen, Anteile, Hinweise und Übersicht aus', () => {
    expect(grund(mit({ aufteilungen: undefined, anteile: undefined, hinweise: undefined, uebersicht: undefined }))).toBe('');
  });

  it('liest das Beispiel aus docs/beispiele aus echtem YAML', () => {
    const ergebnis = modulBlockAusText(readFileSync('docs/beispiele/ki-verbrauch.cockpit.yaml', 'utf8'));

    expect(ergebnis.ok, !ergebnis.ok ? ergebnis.grund : undefined).toBe(true);
    expect(ergebnis.ok && ergebnis.block.ansicht).toBe('kennzahlen');
  });

  it('verlangt als erste Kennzahl den Hauptwert „wert"', () => {
    expect(grund(mit({ spalten: [{ name: 'tokens', label: 'Tokens' }] }))).toContain('Die erste Kennzahl muss die Spalte „wert" sein');
  });

  it.each(['text', 'zeitpunkt'])('lehnt das Format „%s" für eine Kennzahl ab', (format) => {
    expect(grund(mit({ spalten: [{ name: 'wert', label: 'Kosten', format }] }))).toContain('spalten.0.format: Eine Kennzahl ist „zahl" oder „euro".');
  });

  it('lehnt mehr als vier Kennzahlen ab', () => {
    const spalten = ['wert', 'a', 'b', 'c', 'd'].map((name) => ({ name, label: name }));

    expect(grund(mit({ spalten }))).toContain('höchstens 4 Kennzahlen');
  });

  it('kennt keine Eingriffe und keine Darstellung', () => {
    expect(grund(mit({ eingriffe: ['uebernehmen'] }))).toContain('kennt keine Eingriffe');
    expect(grund(mit({ darstellung: 'kacheln' }))).toContain('darstellung: nur für den Ansichtstyp');
  });

  it('erlaubt höchstens eine Aufteilung mit Filter, und darunter nur mit Filter', () => {
    const zwei = [
      { name: 'projekt', label: 'Je Projekt', filter: true },
      { name: 'modell', label: 'Je Modell', filter: true },
    ];
    expect(grund(mit({ aufteilungen: zwei }))).toContain('aufteilungen: höchstens eine Aufteilung mit filter.');
    expect(grund(mit({ aufteilungen: [{ name: 'projekt', label: 'Je Projekt', darunter: { name: 'ticket', label: 'Je Ticket' } }] }))).toContain(
      'aufteilungen.0.darunter: nur zusammen mit filter: true.',
    );
  });

  it('lehnt eine doppelt deklarierte Spalte ab', () => {
    expect(grund(mit({ anteile: [{ name: 'tokens', label: 'Tokens' }] }))).toContain('Die Spalte „tokens" ist mehrfach deklariert.');
  });

  it('kennt in der Übersicht weder kurztext noch verlauf', () => {
    expect(grund(mit({ uebersicht: { kurztext: 'wert' } }))).toContain('uebersicht.kurztext: nur für den Ansichtstyp');
    expect(grund(mit({ uebersicht: { verlauf: 'v_modul_ki_verbrauch_verlauf' } }))).toContain('uebersicht.verlauf: nur für den Ansichtstyp');
  });

  it.each(['aufteilungen', 'anteile', 'hinweise'] as const)('weist unbekannte Felder in %s ab', (feld) => {
    const wert = feld === 'hinweise' ? 'hinweise_ohne_praefix' : [{ name: 'x', label: 'X', farbe: 'rot' }];

    expect(grund(mit({ [feld]: wert }))).toContain(feld);
  });

  it('nennt die Spalten der View nach Typ: Zahlen und Texte', () => {
    const ergebnis = modulBlockPruefen(BLOCK);

    expect(ergebnis.ok && kennzahlenSpalten(ergebnis.block)).toEqual({
      zahlen: ['wert', 'tokens', 'tokens_cache_lesen', 'wert_geschaetzt'],
      texte: ['projekt', 'ticket', 'modell'],
    });
  });
});

describe('Modul-Block: liste-detail bleibt ohne Kennzahlen-Felder', () => {
  it.each([
    ['aufteilungen', [{ name: 'projekt', label: 'Je Projekt' }]],
    ['anteile', [{ name: 'wert_geschaetzt', label: 'geschätzt' }]],
    ['hinweise', 'v_modul_hinweise'],
  ])('lehnt %s ab', (feld, wert) => {
    expect(grund(mit({ [feld]: wert }, LISTE))).toContain(`${feld}: nur für den Ansichtstyp „kennzahlen" möglich.`);
  });

  it('lehnt davon in den Spalten ab, erlaubt aber das Format euro (COPI-137)', () => {
    expect(grund(mit({ spalten: [{ name: 'titel', label: 'Bereich', davon: { name: 'x', text: 'y' } }] }, LISTE))).toContain('spalten.0.davon: nur für den Ansichtstyp');
    expect(grund(mit({ spalten: [{ name: 'umsatz', label: 'Umsatz', format: 'euro' }] }, LISTE))).toBe('');
  });
});
