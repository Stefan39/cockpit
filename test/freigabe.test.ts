/**
 * „Antwort freigeben" (COPI-90) ohne Datenbank: der Abschnitt `freigabe:` im Block, der Zustand eines Entwurfs und der
 * Hash, den Cockpit und Agent gleich rechnen müssen.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { freigabeErlaubt, freigabeSpalten, modulBlockPruefen } from '../src/module/block.js';
import { entwurfHash, freigabeZustand, passendeFreigabe, type Entwurf, type Freigabe } from '../src/module/freigabe.js';
import { empfaengerName } from '../src/posteingang/lesen.js';

const BLOCK = {
  kennung: 'kommunikation',
  menuename: 'Kommunikation',
  ansicht: 'liste-detail',
  view: 'v_modul_kommunikation',
  spalten: [{ name: 'zusammenfassung', label: 'Worum es geht' }],
  rollen: ['betreuer', 'betriebs_admin'],
  eingriffe: ['uebernehmen', 'antwort_freigeben'],
  freigabe: { entwurf: 'entwurf', fassung: 'entwurf_fassung', empfaenger: 'entwurf_an' },
};

function grund(daten: unknown): string {
  const ergebnis = modulBlockPruefen(daten);
  expect(ergebnis.ok).toBe(false);
  return ergebnis.ok ? '' : ergebnis.grund;
}

describe('modulBlockPruefen — antwort_freigeben und freigabe: (COPI-90)', () => {
  it('nimmt Eingriff und Abschnitt zusammen an und verlangt die Typen der Spalten', () => {
    const ergebnis = modulBlockPruefen(BLOCK);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.ok && freigabeErlaubt(ergebnis.block)).toBe(true);
    expect(freigabeSpalten({ ...BLOCK.freigabe, gesendet_am: 'gesendet_am' })).toEqual({
      entwurf: 'text',
      entwurf_fassung: 'integer',
      entwurf_an: 'text',
      gesendet_am: 'timestamp with time zone',
    });
  });

  it('verlangt den Abschnitt zum Eingriff und den Eingriff zum Abschnitt', () => {
    expect(grund({ ...BLOCK, freigabe: undefined })).toContain('freigabe: fehlt');
    expect(grund({ ...BLOCK, eingriffe: ['uebernehmen'] })).toContain('freigabe: nur zusammen mit dem Eingriff „antwort_freigeben".');
  });

  it('weist doppelte Spalten, unbekannte Felder und Kennzahlen-Module ab', () => {
    expect(grund({ ...BLOCK, freigabe: { entwurf: 'x', fassung: 'x' } })).toContain('Die Spalte „x" ist mehrfach genannt.');
    expect(grund({ ...BLOCK, freigabe: { ...BLOCK.freigabe, absender: 'y' } })).toContain('freigabe.absender: unbekanntes Feld');
    expect(grund({ ...BLOCK, freigabe: { entwurf: 'entwurf' } })).toContain('freigabe.fassung');
  });
});

const ENTWURF: Entwurf = { text: 'Hallo', fassung: 2, hash: entwurfHash('Hallo'), empfaenger: undefined, betreff: undefined, gesendetAm: undefined };

function freigabe(teil: Partial<Freigabe>): Freigabe {
  return { id: 1, fassung: 2, hash: entwurfHash('Hallo'), vonId: 'k', von: 'Stefan', am: new Date('2026-10-02T10:00:00Z'), zurueckgezogenAm: undefined, ...teil };
}

describe('entwurfHash', () => {
  it('ist SHA-256 über UTF-8, Hex — so rechnet auch der Agent', () => {
    expect(entwurfHash('Grüße')).toBe(createHash('sha256').update(Buffer.from('Grüße', 'utf8')).digest('hex'));
    expect(entwurfHash('Grüße')).toMatch(/^[0-9a-f]{64}$/);
    expect(entwurfHash('a')).not.toBe(entwurfHash('a '));
  });
});

describe('freigabeZustand', () => {
  it('ist offen ohne Freigabe, freigegeben mit passender aktiver', () => {
    expect(freigabeZustand(ENTWURF, [])).toEqual({ art: 'offen', veraltet: undefined });
    expect(freigabeZustand(ENTWURF, [freigabe({})])).toMatchObject({ art: 'freigegeben' });
  });

  it('zählt eine zurückgezogene, eine andere Fassung oder einen anderen Text nicht als Freigabe', () => {
    expect(freigabeZustand(ENTWURF, [freigabe({ zurueckgezogenAm: new Date() })]).art).toBe('offen');
    expect(freigabeZustand(ENTWURF, [freigabe({ hash: entwurfHash('Anders') })]).art).toBe('offen');
    const alt = freigabe({ fassung: 1, hash: entwurfHash('Alt') });
    expect(freigabeZustand(ENTWURF, [alt])).toEqual({ art: 'offen', veraltet: alt });
    expect(passendeFreigabe([alt], 2, ENTWURF.hash)).toBeUndefined();
  });

  it('ist gesendet, sobald die View es meldet — mit der Freigabe dieser Fassung als Nachweis', () => {
    const am = new Date('2026-10-02T10:05:00Z');
    expect(freigabeZustand({ ...ENTWURF, gesendetAm: am }, [freigabe({})])).toMatchObject({ art: 'gesendet', am, freigabe: { von: 'Stefan' } });
  });
});

describe('empfaengerName', () => {
  it('zeigt im Posteingang nur den Namen, ohne Namen die Adresse', () => {
    expect(empfaengerName('Jana Peters <j.peters@example.org>')).toBe('Jana Peters');
    expect(empfaengerName('<j.peters@example.org>')).toBe('j.peters@example.org');
    expect(empfaengerName('j.peters@example.org')).toBe('j.peters@example.org');
  });
});
