/**
 * Der Anbieter-Zustand der Entwicklungspipeline (COPI-181) gegen eine echte PostgreSQL: setzen, überschreiben,
 * Anlegen bei fehlender Zeile, `until` wird geleert, ungültiger Anbieter.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anbieterLesen, anbieterSetzen } from '../src/pipeline/anbieter.js';
import { testDatenbankUrl } from './testdatenbank.js';

const JETZT = new Date('2026-10-17T08:00:00Z');
const SPAETER = new Date('2026-10-17T09:00:00Z');

describe.skipIf(!testDatenbankUrl)('Pipeline-Anbieter (echte Datenbank)', () => {
  let pool: pg.Pool;

  const leeren = async (): Promise<void> => {
    await pool.query('TRUNCATE cockpit.pipeline_provider_state');
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDatenbankUrl });
  });

  beforeEach(leeren);

  afterAll(async () => {
    await leeren();
    await pool.end();
  });

  it('liefert ohne Einträge eine leere Liste', async () => {
    expect(await anbieterLesen(pool)).toEqual([]);
  });

  it('legt eine fehlende Zeile an und liest sie nach Anbieter sortiert', async () => {
    await anbieterSetzen(pool, { provider: 'gemini', state: 'disabled', jetzt: JETZT });
    await anbieterSetzen(pool, { provider: 'codex', state: 'ok', jetzt: JETZT });
    expect(await anbieterLesen(pool)).toEqual([
      { provider: 'codex', state: 'ok', until: null, updatedAt: JETZT },
      { provider: 'gemini', state: 'disabled', until: null, updatedAt: JETZT },
    ]);
  });

  it('überschreibt einen Eintrag und leert until', async () => {
    await pool.query(
      `INSERT INTO cockpit.pipeline_provider_state (provider, state, until, updated_at)
       VALUES ('codex', 'exhausted', $1, $2)`,
      [SPAETER, JETZT],
    );
    await anbieterSetzen(pool, { provider: 'codex', state: 'ok', jetzt: SPAETER });
    expect(await anbieterLesen(pool)).toEqual([{ provider: 'codex', state: 'ok', until: null, updatedAt: SPAETER }]);

    await anbieterSetzen(pool, { provider: 'codex', state: 'disabled', jetzt: SPAETER });
    expect((await anbieterLesen(pool))[0]?.state).toBe('disabled');
  });

  it('lehnt einen ungültigen Anbieter ab und schreibt nichts', async () => {
    await expect(anbieterSetzen(pool, { provider: 'openai', state: 'ok', jetzt: JETZT })).rejects.toThrow('Unbekannter Anbieter');
    expect(await anbieterLesen(pool)).toEqual([]);
  });

  it('lehnt exhausted von Hand ab', async () => {
    await expect(
      anbieterSetzen(pool, { provider: 'codex', state: 'exhausted' as never, jetzt: JETZT }),
    ).rejects.toThrow('ok oder disabled');
    expect(await anbieterLesen(pool)).toEqual([]);
  });
});
