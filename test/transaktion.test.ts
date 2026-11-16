/**
 * Commit und Rollback von `inTransaktion` (COPI-40/85), ohne Datenbank: ein Fake-Pool mit Fake-Client schreibt die
 * Abfragen mit und zählt `release()`.
 */
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { inTransaktion } from '../src/datenbank/transaktion.js';

function fakePoolBauen(): { pool: pg.Pool; abfragen: string[]; freigaben: () => number } {
  const abfragen: string[] = [];
  let freigaben = 0;
  const client = {
    query: async (sql: string) => {
      abfragen.push(sql);
      return { rows: [] };
    },
    release: () => {
      freigaben += 1;
    },
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, abfragen, freigaben: () => freigaben };
}

describe('inTransaktion', () => {
  it('schreibt mit Ergebnis BEGIN und COMMIT und gibt das Ergebnis zurück', async () => {
    const { pool, abfragen, freigaben } = fakePoolBauen();

    const ergebnis = await inTransaktion(pool, async () => 'fertig');

    expect(ergebnis).toBe('fertig');
    expect(abfragen).toEqual(['BEGIN', 'COMMIT']);
    expect(freigaben()).toBe(1);
  });

  it('nimmt bei undefined als Ergebnis zurück und gibt undefined zurück', async () => {
    const { pool, abfragen, freigaben } = fakePoolBauen();

    const ergebnis = await inTransaktion(pool, async () => undefined);

    expect(ergebnis).toBeUndefined();
    expect(abfragen).toEqual(['BEGIN', 'ROLLBACK']);
    expect(freigaben()).toBe(1);
  });

  it('nimmt bei einer Ausnahme zurück und wirft sie weiter', async () => {
    const { pool, abfragen, freigaben } = fakePoolBauen();
    const fehler = new Error('kaputt');

    await expect(
      inTransaktion(pool, async () => {
        throw fehler;
      }),
    ).rejects.toBe(fehler);

    expect(abfragen).toEqual(['BEGIN', 'ROLLBACK']);
    expect(freigaben()).toBe(1);
  });
});
