/**
 * Die Gruppe „Verwaltung" der Desktop-Sidebar (COPI-108, Entscheidung Stefan, Abweichung vom Prototyp): Am Desktop
 * stehen die Einträge von „Mehr" direkt in der Sidebar, „Mehr" selbst nur noch mobil in der Tab-Leiste. Dieselben
 * Einträge und dieselbe Rechte-Regel wie auf „Mehr" (`nav.mehr`, `navigation.test.ts`); hier geht es ums Markup.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function verwaltung(html: string): string {
  const treffer = /<nav class="verwaltungsnav" aria-label="Verwaltung">([^]*?)<\/nav>/.exec(html);
  return treffer?.[1] ?? '';
}

describe('Gruppe „Verwaltung" in der Desktop-Sidebar', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_FAKTOR });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function html(url: string): Promise<string> {
    const antwort = await app.inject({ method: 'GET', url });
    expect(antwort.statusCode, url).toBe(200);
    return antwort.body;
  }

  it('steht genau einmal in der Sidebar, mit Überschrift und den Einträgen von „Mehr"', async () => {
    const seite = await html('/');
    expect(seite.match(/<nav class="verwaltungsnav"/g)).toHaveLength(1);
    const gruppe = verwaltung(seite);
    expect(gruppe).toContain('<p class="verwaltungsnav-titel">Verwaltung</p>');
    // Ohne Zugang (Tests ohne Konto) gibt es weder „Benutzer" noch „Einladen": dieselbe Regel wie auf „Mehr".
    expect([...gruppe.matchAll(/<a href="([^"]+)" class="hauptnav-eintrag"/g)].map((m) => m[1])).toEqual(['/agenten', '/zeitplan', '/einstellungen']);
    expect(gruppe).not.toContain('aria-current');
  });

  it.each([
    ['/agenten', '/agenten'],
    ['/zeitplan', '/zeitplan'],
    ['/einstellungen', '/einstellungen'],
  ])('markiert auf %s den eigenen Eintrag', async (url, ziel) => {
    expect(verwaltung(await html(url))).toContain(`<a href="${ziel}" class="hauptnav-eintrag" aria-current="page">`);
  });

  it('führt „Mehr" in der Tab-Leiste nur mobil', async () => {
    expect(await html('/agenten')).toMatch(/<li class="hauptnav-nur-mobil">\s*<a href="\/mehr" class="hauptnav-eintrag" aria-current="page">/);
  });
});
