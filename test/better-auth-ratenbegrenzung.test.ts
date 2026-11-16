/**
 * Warum das Cockpit eine eigene Ratenbegrenzung braucht (COPI-13) — gemessen,
 * nicht behauptet. Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * Im Quelltext von better-auth 1.7.5 hängt die Ratenbegrenzung im Router-Haken
 * (`api/index.mjs`, `onRequest` → `onRequestRateLimit`). Die Anmeldeseite ruft
 * aber `auth.api.signInEmail` direkt auf, nicht über `auth.handler`. Dieser
 * Test hält beides gegeneinander, mit **derselben** Auth-Instanz und demselben
 * Pfad:
 *
 *   * über `auth.api.*` — die Begrenzung greift nicht,
 *   * über `auth.handler` — sie greift (Gegenprobe, damit der erste Teil nicht
 *     bloß deshalb grün ist, weil die Begrenzung gar nicht eingeschaltet war).
 *
 * Zusätzlich abgesichert: sie ist von sich aus nur in Produktion aktiv.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const GEHEIMNIS = 'test-geheimnis-mit-mehr-als-32-zeichen-laenge';
const VERSUCHE = 6;

/** Statuscode eines abgewiesenen Anmeldeversuchs, oder 0 bei Erfolg. */
function statusVon(fehler: unknown): number {
  if (typeof fehler === 'object' && fehler !== null && 'statusCode' in fehler) {
    const wert = (fehler as { statusCode: unknown }).statusCode;
    return typeof wert === 'number' ? wert : -1;
  }
  return -1;
}

describe.skipIf(!datenbankUrl)('Better-Auth-Ratenbegrenzung', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;

  function anfrage(): Request {
    return new Request(`${BASIS_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'niemand@example.org',
        password: 'ein-ausreichend-langes-passwort',
      }),
    });
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: GEHEIMNIS,
      pool,
      // Sonst wäre sie hier gar nicht an — und der Test bewiese nichts.
      ratenbegrenzungErzwingen: true,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('greift bei direkten auth.api-Aufrufen nicht', async () => {
    const stati: number[] = [];
    for (let versuch = 1; versuch <= VERSUCHE; versuch += 1) {
      try {
        await auth.api.signInEmail({
          body: { email: 'niemand@example.org', password: 'ein-ausreichend-langes-passwort' },
        });
        stati.push(0);
      } catch (fehler) {
        stati.push(statusVon(fehler));
      }
    }

    // Immer dieselbe Abweisung, nie 429 — obwohl die Regel für `/sign-in*`
    // nur 3 Versuche in 10 Sekunden erlaubt.
    expect(stati).toEqual(Array.from({ length: VERSUCHE }, () => 401));
  });

  it('greift über auth.handler — und hat die Aufrufe von oben nicht mitgezählt', async () => {
    const stati: number[] = [];
    for (let versuch = 1; versuch <= VERSUCHE; versuch += 1) {
      stati.push((await auth.handler(anfrage())).status);
    }

    // Erster Durchlauf noch normal abgewiesen: der Zähler stand bei null,
    // die sechs `auth.api`-Aufrufe von oben haben ihn nicht angerührt.
    expect(stati[0]).toBe(401);
    // Und irgendwann kommt die Begrenzung — sie ist also wirklich aktiv.
    expect(stati).toContain(429);
  });

  it('ist ohne ausdrückliches Einschalten außerhalb der Produktion aus', async () => {
    const ohne = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: GEHEIMNIS,
      pool,
    });

    const stati: number[] = [];
    for (let versuch = 1; versuch <= VERSUCHE; versuch += 1) {
      stati.push((await ohne.handler(anfrage())).status);
    }

    expect(stati).not.toContain(429);
  });
});
