/**
 * Zweiter Riegel der Benutzeranlage (AsyncLocalStorage): nur innerhalb von `mitBenutzerAnlage` ist sie erlaubt.
 */
import { describe, expect, it } from 'vitest';
import { benutzerAnlageErlaubt, mitBenutzerAnlage } from '../src/auth/benutzer-anlage.js';

const warte = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('benutzerAnlageErlaubt', () => {
  it('ist außerhalb von mitBenutzerAnlage false', () => {
    expect(benutzerAnlageErlaubt()).toBe(false);
  });

  it('ist innerhalb true, auch nach einem await', async () => {
    await mitBenutzerAnlage(async () => {
      expect(benutzerAnlageErlaubt()).toBe(true);
      await warte(1);
      expect(benutzerAnlageErlaubt()).toBe(true);
    });
  });

  it('ist nach dem Ende von mitBenutzerAnlage wieder false', async () => {
    await mitBenutzerAnlage(async () => undefined);
    expect(benutzerAnlageErlaubt()).toBe(false);
  });

  it('gilt nicht für eine parallele Aufgabe außerhalb', async () => {
    const [innen, aussen] = await Promise.all([
      mitBenutzerAnlage(async () => {
        await warte(5);
        return benutzerAnlageErlaubt();
      }),
      (async () => {
        await warte(1);
        return benutzerAnlageErlaubt();
      })(),
    ]);
    expect(innen).toBe(true);
    expect(aussen).toBe(false);
  });

  it('reicht den Rückgabewert der Aufgabe durch', async () => {
    await expect(mitBenutzerAnlage(async () => 42)).resolves.toBe(42);
  });
});
