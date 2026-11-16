/**
 * Der Abschnitt `uebersicht:` im `cockpit:`-Block (COPI-81, `src/module/block.ts`) — ohne Datenbank. Geprüft
 * werden: gültige Formen, jede verletzte Regel einzeln, die strikte Ablehnung unbekannter Felder, `kurztext` muss
 * deklariert sein, nur für Liste+Detail, und das Beispiel aus `docs/beispiele`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modulBlockAusText, modulBlockPruefen } from '../src/module/block.js';

const BLOCK = {
  kennung: 'server-zustand',
  menuename: 'Server & Dienste',
  ansicht: 'liste-detail',
  view: 'v_modul_server_zustand',
  spalten: [
    { name: 'titel', label: 'Bereich' },
    { name: 'text', label: 'Meldung' },
  ],
  rollen: ['betreuer', 'betriebs_admin'],
  eingriffe: [],
};

const UEBERSICHT = { titel: 'Server & Dienste', kurztext: 'text', verlauf: 'v_modul_server_zustand_verlauf', reihenfolge: 10 };

function mit(aenderung: Record<string, unknown>): unknown {
  return { ...BLOCK, ...aenderung };
}

function grund(daten: unknown): string {
  const ergebnis = modulBlockPruefen(daten);
  expect(ergebnis.ok).toBe(false);
  return ergebnis.ok ? '' : ergebnis.grund;
}

describe('modulBlockPruefen — der Abschnitt uebersicht: (COPI-81)', () => {
  it('nimmt den vollständigen Abschnitt an und liefert ihn unverändert zurück', () => {
    const ergebnis = modulBlockPruefen(mit({ uebersicht: UEBERSICHT }));
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.ok && ergebnis.block.uebersicht).toEqual(UEBERSICHT);
  });

  it('braucht nur kurztext; titel, verlauf und reihenfolge sind optional', () => {
    const ergebnis = modulBlockPruefen(mit({ uebersicht: { kurztext: 'text' } }));
    expect(ergebnis.ok && ergebnis.block.uebersicht).toEqual({ kurztext: 'text' });
  });

  it('lässt den Abschnitt ganz weg: ohne uebersicht bleibt der Block wie bisher', () => {
    const ergebnis = modulBlockPruefen(BLOCK);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.ok && ergebnis.block.uebersicht).toBeUndefined();
  });

  it('lehnt einen kurztext ab, der nicht in spalten deklariert ist', () => {
    const text = grund(mit({ uebersicht: { kurztext: 'text_kunde' } }));
    expect(text).toContain('uebersicht.kurztext');
    expect(text).toContain('nicht in spalten deklariert');
  });

  it('lehnt ein unbekanntes Feld im Abschnitt ab (strict)', () => {
    expect(grund(mit({ uebersicht: { kurztext: 'text', farbe: 'rot' } }))).toContain('uebersicht.farbe: unbekanntes Feld');
  });

  it('lehnt einen fehlenden kurztext ab', () => {
    expect(grund(mit({ uebersicht: { titel: 'Server' } }))).toContain('uebersicht.kurztext');
  });

  it.each(['', '   ', 'x'.repeat(41)])('lehnt den Titel %j ab', (titel) => {
    expect(grund(mit({ uebersicht: { kurztext: 'text', titel } }))).toContain('uebersicht.titel');
  });

  it.each(['server_zustand_verlauf', 'v_modul_', 'V_MODUL_X'])('lehnt die Verlaufs-View „%s" ab (Präfix v_modul_ wie immer)', (verlauf) => {
    expect(grund(mit({ uebersicht: { kurztext: 'text', verlauf } }))).toContain('uebersicht.verlauf');
  });

  it.each([-1, 1001, 2.5, '10'])('lehnt die Reihenfolge %j ab (ganze Zahl 0–1000)', (reihenfolge) => {
    expect(grund(mit({ uebersicht: { kurztext: 'text', reihenfolge } }))).toContain('uebersicht.reihenfolge');
  });

  it.each([0, 1000])('nimmt die Reihenfolge %j an (Grenzwert)', (reihenfolge) => {
    expect(modulBlockPruefen(mit({ uebersicht: { kurztext: 'text', reihenfolge } })).ok).toBe(true);
  });

  it('lehnt uebersicht bei einem anderen Ansichtstyp ab (nur liste-detail)', () => {
    expect(grund(mit({ ansicht: 'verlauf', uebersicht: { kurztext: 'text' } }))).toContain('uebersicht: nur für den Ansichtstyp');
  });

  it('verlangt bei liste-detail den kurztext', () => {
    expect(grund(mit({ uebersicht: { titel: 'Ohne Kurztext' } }))).toContain('uebersicht.kurztext: fehlt.');
  });

  it('liest das Beispiel aus docs/beispiele (mit uebersicht) aus echtem YAML', () => {
    const ergebnis = modulBlockAusText(readFileSync('docs/beispiele/server-zustand.cockpit.yaml', 'utf8'));
    expect(ergebnis.ok, !ergebnis.ok ? ergebnis.grund : undefined).toBe(true);
    expect(ergebnis.ok && ergebnis.block.uebersicht).toEqual(UEBERSICHT);
  });
});

describe('modulBlockPruefen — uebersicht.art (COPI-122)', () => {
  it('nimmt „karten" und „liste" an; ohne Angabe bleibt es bei Karten', () => {
    for (const art of ['karten', 'liste'] as const) {
      const ergebnis = modulBlockPruefen(mit({ uebersicht: { kurztext: 'text', art } }));
      expect(ergebnis.ok && ergebnis.block.uebersicht?.art, art).toBe(art);
    }
    const ohne = modulBlockPruefen(mit({ uebersicht: { kurztext: 'text' } }));
    expect(ohne.ok && ohne.block.uebersicht?.art).toBeUndefined();
  });

  it('lehnt einen unbekannten Wert ab', () => {
    expect(grund(mit({ uebersicht: { kurztext: 'text', art: 'kacheln' } }))).toContain('uebersicht.art');
  });

  it('lehnt eine Verlaufs-View bei der Liste ab: eine Liste zeigt keine Bänder', () => {
    expect(grund(mit({ uebersicht: { kurztext: 'text', art: 'liste', verlauf: 'v_modul_server_zustand_verlauf' } }))).toContain('uebersicht.verlauf');
  });

  it('lehnt art bei Kennzahlen ab', () => {
    const kennzahlen = {
      kennung: 'ki-verbrauch',
      menuename: 'KI-Verbrauch',
      ansicht: 'kennzahlen',
      view: 'v_modul_ki_verbrauch',
      spalten: [{ name: 'wert', label: 'Kosten', format: 'euro' }],
      rollen: ['betreuer'],
      eingriffe: [],
      uebersicht: { art: 'liste' },
    };
    expect(grund(kennzahlen)).toContain('uebersicht.art');
  });
});
