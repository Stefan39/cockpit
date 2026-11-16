/**
 * Sicherheits-Header (COPI-93): jede Antwort trägt sie — Seiten, Dateien, API, Weiterleitungen, Fehler und 404,
 * angemeldet wie nicht angemeldet. Die CSP lässt nur eigene Quellen zu und nichts Inline.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';
import { SICHERHEITS_KOPF } from '../src/server/sicherheit.js';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function direktiven(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((teil) => {
      const [name = '', ...werte] = teil.trim().split(/\s+/);
      return [name, werte.join(' ')];
    }),
  );
}

describe('Die Content-Security-Policy', () => {
  const csp = direktiven(SICHERHEITS_KOPF['content-security-policy'] ?? '');

  it('lässt nur den eigenen Ursprung zu, ohne Inline und ohne eval', () => {
    for (const name of ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'worker-src', 'manifest-src']) {
      expect(csp.get(name), name).toBe("'self'");
    }
    expect(SICHERHEITS_KOPF['content-security-policy']).not.toMatch(/unsafe-|data:|blob:|\*/);
  });

  it('verbietet Rahmen, Plugins, fremde Formularziele und eine fremde Basis', () => {
    expect(csp.get('frame-ancestors')).toBe("'none'");
    expect(csp.get('object-src')).toBe("'none'");
    expect(csp.get('base-uri')).toBe("'none'");
    expect(csp.get('form-action')).toBe("'self'");
  });

  it('legt HSTS nicht auf Subdomains fest: die Domain ist ein Parameter', () => {
    expect(SICHERHEITS_KOPF['strict-transport-security']).toBe('max-age=31536000');
  });
});

describe('Sicherheits-Header auf jeder Antwort', () => {
  let angemeldet: FastifyInstance;
  let anonym: FastifyInstance;

  beforeAll(async () => {
    angemeldet = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_FAKTOR });
    angemeldet.get('/kaputt', () => {
      throw new Error('absichtlich');
    });
    anonym = buildApp({ nodeEnv: 'test' });
    await Promise.all([angemeldet.ready(), anonym.ready()]);
  });

  afterAll(async () => {
    await Promise.all([angemeldet.close(), anonym.close()]);
  });

  function pruefen(kopf: Record<string, unknown>, wo: string): void {
    for (const [name, wert] of Object.entries(SICHERHEITS_KOPF)) {
      expect(kopf[name], `${name} bei ${wo}`).toBe(wert);
    }
  }

  it.each([
    ['die Übersicht', 'GET', '/', 200],
    ['eine Unterseite', 'GET', '/agenten', 200],
    ['den Gesundheitscheck', 'GET', '/gesund', 200],
    ['ein Skript', 'GET', '/pwa.js', 200],
    ['eine unbekannte Seite', 'GET', '/gibt-es-nicht', 404],
    ['eine Weiterleitung', 'POST', '/darstellung', 303],
    ['einen Fehler', 'GET', '/kaputt', 500],
  ] as const)('angemeldet: %s', async (_name, method, url, status) => {
    const antwort = await angemeldet.inject({ method, url });

    expect(antwort.statusCode).toBe(status);
    pruefen(antwort.headers, url);
  });

  it.each([
    ['die Übersicht hinter dem Tor', '/'],
    ['die Anmeldung', '/anmelden'],
    ['eine unbekannte Seite', '/gibt-es-nicht'],
    ['den Gesundheitscheck', '/gesund'],
  ])('nicht angemeldet: %s', async (_name, url) => {
    const antwort = await anonym.inject({ method: 'GET', url });

    pruefen(antwort.headers, url);
  });
});
