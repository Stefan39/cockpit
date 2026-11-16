import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';

describe('GET /gesund', () => {
  it('antwortet mit status ok', async () => {
    const app = buildApp({ nodeEnv: 'test' });

    const response = await app.inject({ method: 'GET', url: '/gesund' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });

    await app.close();
  });
});

describe('GET /', () => {
  it('rendert die Übersicht für eine Sitzung mit zweitem Faktor', async () => {
    const app = buildApp(
      { nodeEnv: 'test' },
      {
        sitzungLesen: () =>
          Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true }),
      },
    );

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Cockpit');

    await app.close();
  });

  it('verlangt ohne Sitzung eine Anmeldung (COPI-13)', async () => {
    const app = buildApp({ nodeEnv: 'test' });

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/anmelden');

    await app.close();
  });
});
