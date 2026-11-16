/**
 * Zweite Faktoren verwalten (COPI-94, `src/auth/faktoren.ts`) gegen eine echte PostgreSQL: lesen, entfernen (nie den
 * letzten, archiviert statt verloren, protokolliert) und Ersatzcodes neu erzeugen (alle bisherigen entwertet, auch die
 * der Authenticator-App). Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * ACHTUNG: räumt `cockpit."user"` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ersatzcodeEinloesen } from '../src/auth/ersatzcode.js';
import { ersatzcodesErneuern, faktorEntfernen, faktorenLesen } from '../src/auth/faktoren.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { zweiterFaktorAktiv } from '../src/auth/zweiter-faktor.js';
import { buildApp } from '../src/server/app.js';
import { kontenLoeschen, kontoEinrichten, passkeyEinrichten, protokollMarke, protokollSeit, type Konto } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';

describe.skipIf(!datenbankUrl)('Zweite Faktoren verwalten (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let nummer = 0;

  async function konto(mitTotp: boolean): Promise<Konto> {
    nummer += 1;
    return kontoEinrichten(app, auth, { email: `faktoren-${String(nummer)}@example.org`, passwort: PASSWORT, name: 'Faktoren', mitZweitemFaktor: mitTotp });
  }

  /** Ein Konto, dessen erster Faktor ein Passkey ist (über die echten Routen), samt den zehn Ersatzcodes. */
  async function kontoMitPasskey(): Promise<{ konto: Konto; ersatzcodes: string[] }> {
    const neu = await konto(false);
    const { ersatzcodes } = await passkeyEinrichten(app, neu, PASSWORT, BASIS_URL);
    return { konto: neu, ersatzcodes };
  }

  /** Ein weiterer Passkey, direkt in der Tabelle: hier geht es um die Regeln, nicht um die Zeremonie. */
  async function passkeyDazu(benutzerId: string, id: string, name: string): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit.passkey (id, benutzer_id, oeffentlicher_schluessel, zaehler, transports, name)
       VALUES ($1, $2, '\\x00', 0, '{}', $3)`,
      [id, benutzerId, name],
    );
  }

  async function archiv(benutzerId: string): Promise<{ art: string; ursprung_id: string }[]> {
    const ergebnis = await pool.query<{ art: string; ursprung_id: string }>(
      'SELECT art, ursprung_id FROM cockpit.zugangsmittel_archiv WHERE benutzer_id = $1 ORDER BY id',
      [benutzerId],
    );
    return ergebnis.rows;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, jetzt: () => new Date() });
  }, 60_000);

  beforeEach(async () => {
    await kontenLoeschen(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('faktorenLesen', () => {
    it('nennt Passkeys mit Name und Datum, keine App und die zehn eigenen Ersatzcodes', async () => {
      const { konto: k } = await kontoMitPasskey();

      const faktoren = await faktorenLesen(pool, auth, k.id);

      expect(faktoren.totp).toBe(false);
      expect(faktoren.ersatzcodes).toBe(10);
      expect(faktoren.passkeys).toHaveLength(1);
      expect(faktoren.passkeys[0]?.name).toBe('Testgerät');
      expect(faktoren.passkeys[0]?.angelegtAm).toBeInstanceOf(Date);
    });

    it('zählt bei einer App deren Ersatzcodes, verbrauchte nicht', async () => {
      const k = await konto(true);
      const vorher = await faktorenLesen(pool, auth, k.id);
      expect(vorher).toMatchObject({ totp: true, passkeys: [], ersatzcodes: 10 });

      await auth.api.verifyBackupCode({ body: { code: k.ersatzcodes[0] ?? '' }, headers: new Headers({ cookie: k.cookie }) });

      expect((await faktorenLesen(pool, auth, k.id)).ersatzcodes).toBe(9);
    });
  });

  describe('faktorEntfernen', () => {
    it('entfernt nie den letzten Faktor: der einzige Passkey bleibt', async () => {
      const { konto: k } = await kontoMitPasskey();
      const id = (await faktorenLesen(pool, auth, k.id)).passkeys[0]?.id ?? '';

      expect(await faktorEntfernen(pool, k.id, { art: 'passkey', id })).toEqual({ ok: false, grund: 'letzter' });
      expect((await faktorenLesen(pool, auth, k.id)).passkeys).toHaveLength(1);
    });

    it('entfernt nie den letzten Faktor: die einzige App bleibt', async () => {
      const k = await konto(true);

      expect(await faktorEntfernen(pool, k.id, { art: 'totp' })).toEqual({ ok: false, grund: 'letzter' });
      expect((await faktorenLesen(pool, auth, k.id)).totp).toBe(true);
    });

    it('entfernt einen von zwei Passkeys, archiviert ihn ohne Schlüssel und protokolliert, wer es war', async () => {
      const { konto: k } = await kontoMitPasskey();
      await passkeyDazu(k.id, 'zweiter-passkey', 'iPhone');
      const marke = await protokollMarke(pool);

      expect(await faktorEntfernen(pool, k.id, { art: 'passkey', id: 'zweiter-passkey' })).toEqual({ ok: true, name: 'iPhone' });

      expect((await faktorenLesen(pool, auth, k.id)).passkeys.map((p) => p.name)).toEqual(['Testgerät']);
      expect(await archiv(k.id)).toContainEqual({ art: 'passkey', ursprung_id: 'zweiter-passkey' });
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'zweiter_faktor_entfernt', akteur: k.id, ziel: null, einzelheiten: { faktor: 'passkey' } },
      ]);
    });

    it('entfernt die App neben einem Passkey: danach ist nur noch der Passkey aktiv', async () => {
      const k = await konto(true);
      await passkeyDazu(k.id, 'passkey-neben-app', 'iMac');

      expect(await faktorEntfernen(pool, k.id, { art: 'totp' })).toEqual({ ok: true });

      const faktoren = await faktorenLesen(pool, auth, k.id);
      expect(faktoren.totp).toBe(false);
      expect(faktoren.ersatzcodes).toBe(0);
      expect(await zweiterFaktorAktiv(pool, k.id)).toBe(true);
      expect((await archiv(k.id)).map((zeile) => zeile.art)).toContain('totp');
    });

    it('kennt keinen fremden Passkey und keine App, die es nicht gibt', async () => {
      const { konto: a } = await kontoMitPasskey();
      const { konto: b } = await kontoMitPasskey();
      await passkeyDazu(a.id, 'dritter', 'Laptop');
      const fremd = (await faktorenLesen(pool, auth, b.id)).passkeys[0]?.id ?? '';

      expect(await faktorEntfernen(pool, a.id, { art: 'passkey', id: fremd })).toEqual({ ok: false, grund: 'unbekannt' });
      expect(await faktorEntfernen(pool, a.id, { art: 'totp' })).toEqual({ ok: false, grund: 'unbekannt' });
      expect((await faktorenLesen(pool, auth, b.id)).passkeys).toHaveLength(1);
    });

    it('lässt bei zwei gleichzeitigen Anfragen, die je einen von zwei Faktoren entfernen, einen übrig', async () => {
      const { konto: k } = await kontoMitPasskey();
      await passkeyDazu(k.id, 'gleichzeitig', 'iPhone');
      const erster = (await faktorenLesen(pool, auth, k.id)).passkeys.find((p) => p.id !== 'gleichzeitig')?.id ?? '';

      const ergebnisse = await Promise.all([
        faktorEntfernen(pool, k.id, { art: 'passkey', id: erster }),
        faktorEntfernen(pool, k.id, { art: 'passkey', id: 'gleichzeitig' }),
      ]);

      expect(ergebnisse.filter((e) => e.ok)).toHaveLength(1);
      expect((await faktorenLesen(pool, auth, k.id)).passkeys).toHaveLength(1);
    });
  });

  describe('ersatzcodesErneuern', () => {
    it('erzeugt zehn neue eigene Codes und entwertet die alten, ohne sie zu löschen', async () => {
      const { konto: k, ersatzcodes: alte } = await kontoMitPasskey();
      const marke = await protokollMarke(pool);

      const neue = await ersatzcodesErneuern(pool, auth, k.id);

      expect(neue).toHaveLength(10);
      expect(neue.some((code) => alte.includes(code))).toBe(false);
      expect(await ersatzcodeEinloesen(pool, k.id, alte[0] ?? '')).toBe(false);
      expect(await ersatzcodeEinloesen(pool, k.id, neue[0] ?? '')).toBe(true);
      const zeilen = await pool.query<{ entwertet: number }>(
        'SELECT count(*)::int AS entwertet FROM cockpit.ersatzcode WHERE benutzer_id = $1 AND entwertet_am IS NOT NULL',
        [k.id],
      );
      expect(zeilen.rows[0]?.entwertet).toBe(10);
      expect((await faktorenLesen(pool, auth, k.id)).ersatzcodes).toBe(9);
      expect(await protokollSeit(pool, marke)).toEqual([{ art: 'ersatzcodes_erneuert', akteur: k.id, ziel: null, einzelheiten: {} }]);
    });

    it('entwertet auch die Ersatzcodes der Authenticator-App: danach gelten nur die neuen', async () => {
      const k = await konto(true);

      const neue = await ersatzcodesErneuern(pool, auth, k.id);

      const { backupCodes } = await auth.api.viewBackupCodes({ body: { userId: k.id } });
      expect(backupCodes).toEqual([]);
      await expect(
        auth.api.verifyBackupCode({ body: { code: k.ersatzcodes[0] ?? '' }, headers: new Headers({ cookie: k.cookie }) }),
      ).rejects.toThrow();
      expect((await faktorenLesen(pool, auth, k.id)).ersatzcodes).toBe(10);
      expect(await ersatzcodeEinloesen(pool, k.id, neue[0] ?? '')).toBe(true);
    });
  });
});
