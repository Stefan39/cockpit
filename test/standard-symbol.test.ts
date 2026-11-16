/**
 * Das Standard-Symbol wird je Prozess höchstens einmal je Kantenlänge gezeichnet (COPI-207), nicht bei jedem `buildApp`.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as icon from '../src/pwa/icon.js';
import { buildApp } from '../src/server/app.js';
import { SYMBOL_DATEIEN, standardSymbolSatz } from '../src/pwa/symbol.js';

const gezeichnet: number[] = [];

vi.mock('../src/pwa/icon.js', async (original) => {
  const echt = await original<typeof icon>();
  return {
    ...echt,
    iconPng: (groesse: number) => {
      gezeichnet.push(groesse);
      return echt.iconPng(groesse);
    },
  };
});

describe('Standard-Symbol', () => {
  it('wird bei mehreren buildApp-Aufrufen nur einmal je Kantenlänge gezeichnet und liefert dieselben Bytes', async () => {
    const erste = buildApp({ nodeEnv: 'test' }, { instanzName: 'A' });
    const zweite = buildApp({ nodeEnv: 'test' }, { instanzName: 'B' });
    await Promise.all([erste.ready(), zweite.ready()]);

    const antworten = await Promise.all(
      [erste, zweite].map((app) => app.inject({ method: 'GET', url: '/icons/icon-192.png' })),
    );
    await Promise.all([erste.close(), zweite.close()]);

    expect(antworten[0]?.statusCode).toBe(200);
    expect(antworten[0]?.rawPayload.equals(antworten[1]?.rawPayload ?? Buffer.alloc(0))).toBe(true);
    expect([...gezeichnet].sort()).toEqual(Object.values(SYMBOL_DATEIEN).map(String).sort().map(Number));
    expect(standardSymbolSatz()).toBe(standardSymbolSatz());
    expect(gezeichnet).toHaveLength(Object.keys(SYMBOL_DATEIEN).length);
  });
});
