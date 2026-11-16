import { describe, expect, it } from 'vitest';
import {
  erststartTokenErzeugen,
  istAbgelaufen,
  tokenHashVergleichen,
  tokenHashen,
  GUELTIGKEIT_MS,
  TOKEN_LAENGE_BYTES,
} from '../src/auth/erststart-token.js';

describe('erststartTokenErzeugen', () => {
  it('erzeugt 32 Byte Zufall, url-tauglich kodiert', () => {
    const token = erststartTokenErzeugen();

    expect(Buffer.from(token.token, 'base64url')).toHaveLength(TOKEN_LAENGE_BYTES);
    expect(token.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('liefert nie zweimal dasselbe Token', () => {
    const werte = new Set(
      Array.from({ length: 50 }, () => erststartTokenErzeugen().token),
    );

    expect(werte.size).toBe(50);
  });

  it('speichert nur den Hash, nicht das Token selbst', () => {
    const token = erststartTokenErzeugen();

    expect(token.hash).toBe(tokenHashen(token.token));
    expect(token.hash).not.toContain(token.token);
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('läuft nach 24 Stunden ab', () => {
    const jetzt = new Date('2026-09-18T10:00:00.000Z');

    const token = erststartTokenErzeugen(jetzt);

    expect(token.ablaufAm.getTime() - jetzt.getTime()).toBe(GUELTIGKEIT_MS);
    expect(GUELTIGKEIT_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('tokenHashVergleichen', () => {
  it('erkennt den gleichen Hash', () => {
    const hash = tokenHashen('irgendein-token');

    expect(tokenHashVergleichen(hash, hash)).toBe(true);
  });

  it('weist einen abweichenden Hash ab', () => {
    expect(tokenHashVergleichen(tokenHashen('a'), tokenHashen('b'))).toBe(false);
  });

  it('weist leere und unterschiedlich lange Werte ab', () => {
    expect(tokenHashVergleichen('', '')).toBe(false);
    expect(tokenHashVergleichen('ab', tokenHashen('a'))).toBe(false);
    expect(tokenHashVergleichen('keine-hex-zeichen', tokenHashen('a'))).toBe(false);
  });
});

describe('istAbgelaufen', () => {
  const jetzt = new Date('2026-09-18T10:00:00.000Z');

  it('ist vor dem Ablaufzeitpunkt nicht abgelaufen', () => {
    expect(istAbgelaufen(new Date(jetzt.getTime() + 1000), jetzt)).toBe(false);
  });

  it('ist genau auf dem Ablaufzeitpunkt abgelaufen', () => {
    expect(istAbgelaufen(new Date(jetzt.getTime()), jetzt)).toBe(true);
  });

  it('ist nach dem Ablaufzeitpunkt abgelaufen', () => {
    expect(istAbgelaufen(new Date(jetzt.getTime() - 1000), jetzt)).toBe(true);
  });
});
