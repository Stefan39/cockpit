import { describe, expect, it } from 'vitest';
import { einmalTokenErzeugen, gueltigeZeile, tokenHashen } from '../src/auth/einmal-token.js';

describe('einmalTokenErzeugen', () => {
  const jetzt = new Date('2026-10-17T12:00:00.000Z');

  it('erzeugt ein base64url-Token mit 43 Zeichen (32 Byte)', () => {
    const { token } = einmalTokenErzeugen(1000, jetzt);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('liefert als hash den SHA-256-Hex des Tokens', () => {
    const { token, hash } = einmalTokenErzeugen(1000, jetzt);
    expect(hash).toBe(tokenHashen(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('setzt ablaufAm auf jetzt plus Gültigkeit', () => {
    const { ablaufAm } = einmalTokenErzeugen(3 * 60 * 60 * 1000, jetzt);
    expect(ablaufAm.getTime()).toBe(jetzt.getTime() + 3 * 60 * 60 * 1000);
  });

  it('erzeugt bei zwei Aufrufen verschiedene Tokens', () => {
    const a = einmalTokenErzeugen(1000, jetzt);
    const b = einmalTokenErzeugen(1000, jetzt);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('gueltigeZeile', () => {
  const jetzt = new Date('2026-10-17T12:00:00.000Z');
  const hash = tokenHashen('beispiel-token');
  const zeile = (ablaufAm: Date) => ({ token_hash: hash, ablauf_am: ablaufAm });

  it('gibt für undefined undefined zurück', () => {
    expect(gueltigeZeile(undefined, hash, jetzt)).toBeUndefined();
  });

  it('gibt bei passendem Hash und Ablauf in der Zukunft die Zeile selbst zurück', () => {
    const z = zeile(new Date(jetzt.getTime() + 60_000));
    expect(gueltigeZeile(z, hash, jetzt)).toBe(z);
  });

  it('weist falschen Hash, Hash anderer Länge und leeren Hash ab', () => {
    const z = zeile(new Date(jetzt.getTime() + 60_000));
    expect(gueltigeZeile(z, tokenHashen('anderes-token'), jetzt)).toBeUndefined();
    expect(gueltigeZeile(z, hash.slice(0, 32), jetzt)).toBeUndefined();
    expect(gueltigeZeile(z, '', jetzt)).toBeUndefined();
  });

  it('behandelt Ablauf genau jetzt als abgelaufen, eine Millisekunde später als gültig', () => {
    expect(gueltigeZeile(zeile(new Date(jetzt.getTime())), hash, jetzt)).toBeUndefined();
    const z = zeile(new Date(jetzt.getTime() + 1));
    expect(gueltigeZeile(z, hash, jetzt)).toBe(z);
  });
});
