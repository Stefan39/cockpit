/**
 * Seiten, die sich selbst neu laden (COPI-105): In der installierten App gibt es keine Neuladen-Geste. Übersicht und
 * Meldungen tragen deshalb `data-aktualisieren` (Sekunden) und den Stand; `assets/js/pwa.js` lädt sie neu, sobald der
 * Stand älter ist. Seiten mit Eingaben oder Einstellungen tragen es nie. Die Modulseiten prüfen die Modultests.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function aktualisierenAus(html: string): string[] {
  return [...html.matchAll(/data-aktualisieren="([^"]*)"/g)].map((m) => m[1] ?? '');
}

describe('Selbst aktualisierende Seiten', () => {
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

  it.each(['/', '/meldungen'])('%s lädt sich alle 60 s neu und zeigt seinen Stand', async (url) => {
    const seite = await html(url);
    expect(aktualisierenAus(seite)).toEqual(['60']);
    expect(seite).toMatch(/Stand: heute, \d{2}:\d{2}/);
  });

  it.each(['/mehr', '/agenten', '/zeitplan', '/einstellungen'])('%s lädt sich nicht selbst neu', async (url) => {
    expect(aktualisierenAus(await html(url))).toEqual([]);
  });
});
