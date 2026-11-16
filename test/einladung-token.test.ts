/**
 * Einladungs-Token: Erzeugung, Hashing, Vergleich, Ablauf — ohne Datenbank.
 */
import { describe, expect, it } from 'vitest';
import {
  einladungsTokenErzeugen,
  EINLADUNG_GUELTIGKEIT_MS,
} from '../src/auth/einladung-token.js';
import { GUELTIGKEIT_MS } from '../src/auth/erststart-token.js';
import {
  istAbgelaufen,
  tokenHashVergleichen,
  tokenHashen,
} from '../src/auth/einmal-token.js';

describe('Einladungs-Token', () => {
  it('gilt 3 Stunden — nicht 24 wie das Erststart-Token', () => {
    expect(EINLADUNG_GUELTIGKEIT_MS).toBe(3 * 60 * 60 * 1000);
    expect(EINLADUNG_GUELTIGKEIT_MS).toBeLessThan(GUELTIGKEIT_MS);

    const jetzt = new Date('2026-09-18T10:00:00.000Z');
    const token = einladungsTokenErzeugen(jetzt);

    expect(token.ablaufAm.toISOString()).toBe('2026-09-18T13:00:00.000Z');
  });

  it('ist nach 3 Stunden abgelaufen, vorher nicht', () => {
    const jetzt = new Date('2026-09-18T10:00:00.000Z');
    const token = einladungsTokenErzeugen(jetzt);

    const kurzDavor = new Date(jetzt.getTime() + EINLADUNG_GUELTIGKEIT_MS - 1000);
    const kurzDanach = new Date(jetzt.getTime() + EINLADUNG_GUELTIGKEIT_MS + 1000);

    expect(istAbgelaufen(token.ablaufAm, kurzDavor)).toBe(false);
    expect(istAbgelaufen(token.ablaufAm, kurzDanach)).toBe(true);
  });

  it('liefert 32 Byte Zufall, jedes Mal verschieden', () => {
    const werte = new Set<string>();
    for (let lauf = 0; lauf < 50; lauf += 1) {
      const token = einladungsTokenErzeugen();
      expect(Buffer.from(token.token, 'base64url')).toHaveLength(32);
      werte.add(token.token);
    }
    expect(werte.size).toBe(50);
  });

  it('trägt den SHA-256-Hash bei sich, nicht das Token selbst', () => {
    const token = einladungsTokenErzeugen();

    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hash).toBe(tokenHashen(token.token));
    expect(token.hash).not.toContain(token.token);
  });

  it('vergleicht Hashes laufzeitkonstant und weist Abweichungen ab', () => {
    const token = einladungsTokenErzeugen();
    const anderer = einladungsTokenErzeugen();

    expect(tokenHashVergleichen(token.hash, tokenHashen(token.token))).toBe(true);
    expect(tokenHashVergleichen(token.hash, anderer.hash)).toBe(false);
    expect(tokenHashVergleichen(token.hash, '')).toBe(false);
    expect(tokenHashVergleichen('', '')).toBe(false);
    expect(tokenHashVergleichen(token.hash, token.hash.slice(0, 62))).toBe(false);
  });
});
