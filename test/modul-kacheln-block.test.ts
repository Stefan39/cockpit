/**
 * Das Feld `darstellung` im `cockpit:`-Block (COPI-82, `src/module/block.ts`) — ohne Datenbank. Geprüft werden:
 * gültige Werte, ein ungültiger Wert, ein fehlendes Feld (Standard `liste`, genau das bisherige Verhalten), nur
 * für `ansicht: liste-detail`, und das Beispiel aus `docs/beispiele`.
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

function mit(aenderung: Record<string, unknown>): unknown {
  return { ...BLOCK, ...aenderung };
}

function grund(daten: unknown): string {
  const ergebnis = modulBlockPruefen(daten);
  expect(ergebnis.ok).toBe(false);
  return ergebnis.ok ? '' : ergebnis.grund;
}

describe('modulBlockPruefen — das Feld darstellung (COPI-82)', () => {
  it('fehlt das Feld, bleibt darstellung undefined (genau das Verhalten vor COPI-82)', () => {
    const ergebnis = modulBlockPruefen(BLOCK);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.ok && ergebnis.block.darstellung).toBeUndefined();
  });

  it.each(['liste', 'kacheln'] as const)('nimmt den Wert „%s" an', (darstellung) => {
    const ergebnis = modulBlockPruefen(mit({ darstellung }));
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.ok && ergebnis.block.darstellung).toBe(darstellung);
  });

  it.each(['Liste', 'kachel', '', 'tabelle'])('lehnt den Wert „%s" ab', (darstellung) => {
    const text = grund(mit({ darstellung }));
    expect(text).toContain('darstellung');
  });

  it('lehnt darstellung bei einem anderen Ansichtstyp ab (nur liste-detail)', () => {
    const text = grund(mit({ ansicht: 'verlauf', darstellung: 'kacheln' }));
    expect(text).toContain('darstellung: nur für den Ansichtstyp');
  });

  it('liest das Beispiel aus docs/beispiele (mit darstellung: kacheln) aus echtem YAML', () => {
    const ergebnis = modulBlockAusText(readFileSync('docs/beispiele/server-zustand.cockpit.yaml', 'utf8'));
    expect(ergebnis.ok, !ergebnis.ok ? ergebnis.grund : undefined).toBe(true);
    expect(ergebnis.ok && ergebnis.block.darstellung).toBe('kacheln');
  });
});
