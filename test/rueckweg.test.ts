/**
 * Der Rückweg im Seitenkopf (COPI-100): Auf dem Telefon gibt es keine Browserleiste (installierte App), also braucht
 * jede Unterseite einen sichtbaren Weg zurück — der runde Knopf links neben dem Titel wie im Prototyp. Die Hauptseiten
 * der Tab-Leiste haben keinen. Die Modulseiten prüfen die Datenbanktests der Module.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';
import { rueckwegMitHerkunft } from '../src/module/rueckweg.js';
import { rueckwege } from './hilfen.js';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

describe('rueckwegMitHerkunft', () => {
  const LISTE = { href: '/module/x', ziel: 'Liste' };

  it('führt von einer Übersichtskarte zurück zur Übersicht', () => {
    expect(rueckwegMitHerkunft(LISTE, 'uebersicht')).toEqual({ href: '/', ziel: 'Übersicht' });
  });

  it.each([undefined, '', 'Uebersicht', 'https://boese.example', '//boese.example', ['uebersicht'], 1])('bleibt bei %j beim gewöhnlichen Rückweg', (von) => {
    expect(rueckwegMitHerkunft(LISTE, von)).toEqual(LISTE);
  });
});

describe('Rückweg im Seitenkopf', () => {
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

  it.each(['/', '/mehr', '/meldungen'])('hat auf der Hauptseite %s keinen', async (url) => {
    expect(rueckwege(await html(url))).toEqual([]);
  });

  it.each(['/agenten', '/zeitplan', '/einstellungen'])('führt von %s zurück zu „Mehr"', async (url) => {
    expect(rueckwege(await html(url))).toEqual([{ href: '/mehr', ziel: 'Mehr' }]);
  });

  it('ist ein Link mit Beschriftung, kein Skript, und nur auf dem Telefon sichtbar', async () => {
    const seite = await html('/agenten');
    expect(seite).toMatch(/<a href="\/mehr" class="seiten-zurueck" aria-label="Zurück zu Mehr"><svg class="symbol"/);
  });
});
