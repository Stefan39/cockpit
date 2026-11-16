/**
 * Konsolenblock mit dem Erststart-Link (`erststartBlockBauen`).
 * Reine Textfunktion, kein Datenbankzugriff.
 */
import { describe, expect, it } from 'vitest';
import { erststartBlockBauen } from '../src/auth/erststart-ausgabe.js';
import type { ErststartToken } from '../src/auth/erststart-token.js';

const TOKEN: ErststartToken = {
  token: 'Testtoken_abc-123',
  hash: 'a'.repeat(64),
  ablaufAm: new Date('2026-10-18T12:34:56.000Z'),
};
const BASIS_URL = 'https://cockpit.example.test';
const RAHMEN = '='.repeat(72);

describe('erststartBlockBauen', () => {
  it('enthält den Erststart-Link genau einmal', () => {
    const block = erststartBlockBauen(TOKEN, BASIS_URL);
    const link = `${BASIS_URL}/erststart/${TOKEN.token}`;

    expect(block.split(link)).toHaveLength(2);
  });

  it('nennt den Ablaufzeitpunkt als ISO-Zeitstempel', () => {
    const block = erststartBlockBauen(TOKEN, BASIS_URL);

    expect(block).toContain('Gültig bis: 2026-10-18T12:34:56.000Z');
  });

  it('beginnt und endet mit einer Leerzeile', () => {
    const zeilen = erststartBlockBauen(TOKEN, BASIS_URL).split('\n');

    expect(zeilen[0]).toBe('');
    expect(zeilen[zeilen.length - 1]).toBe('');
  });

  it('rahmt den Text oben und unten mit 72 Gleichheitszeichen', () => {
    const zeilen = erststartBlockBauen(TOKEN, BASIS_URL).split('\n');

    expect(zeilen[1]).toBe(RAHMEN);
    expect(zeilen[zeilen.length - 2]).toBe(RAHMEN);
  });

  it('erzeugt bei einer Basis-URL ohne Schrägstrich am Ende kein doppeltes //', () => {
    const block = erststartBlockBauen(TOKEN, BASIS_URL);

    expect(block).not.toContain('.test//erststart');
    expect(block.replace('https://', '')).not.toContain('//');
  });
});
