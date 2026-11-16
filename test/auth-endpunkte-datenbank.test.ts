/**
 * Messreihe der rohen Better-Auth-Endpunkte unter `/api/auth/*` (COPI-20).
 *
 * Läuft nur mit `TEST_DATABASE_URL` (echte PostgreSQL) und räumt dort
 * `cockpit."user"`, `cockpit.einladung` und `cockpit.erststart_token` ab.
 * Niemals gegen eine Kundendatenbank laufen lassen.
 *
 * „Erreichbar" heißt: die Anfrage kommt bei `auth.handler` an. Die Kandidaten
 * stammen aus den registrierten Endpunkten der installierten better-auth-Version
 * (`auth.api`), nicht aus einer festen Liste — ein Versionssprung, der einen
 * neuen Endpunkt mitbringt, wird so mitgemessen und fällt auf, sobald er
 * erreichbar wäre. Die Erwartung dagegen steht hier als Literal: würde der Test
 * die Freigabeliste des Produktivcodes benutzen, rechnete er eine versehentlich
 * erweiterte Freigabe einfach mit.
 *
 * Der Handler ist in der Messreihe ersetzt, damit erreichbare Endpunkte keine
 * Nebenwirkung haben (`sign-out` beendete die Sitzung, `disable` schaltete den
 * Faktor ab) und die Reihenfolge der Anfragen nichts ausmacht. Dass die
 * freigegebenen Endpunkte wirklich arbeiten und die gesperrten nichts
 * anrichten, zeigen die Tests danach mit dem echten Handler.
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { buildApp } from '../src/server/app.js';
import { geheimnisAusUri } from '../src/server/routes/zwei-faktor.js';
import {
  formular,
  FORMULAR_KOPF,
  kontenLoeschen,
  kontoEinrichten,
  totpCode,
  type Konto,
} from './hilfen.js';
import { qrAusSeiteLesen } from './qr-lesen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const AUTH_PRAEFIX = '/api/auth';
const PASSWORT = 'ein-ausreichend-langes-passwort';

/** Pfade (ohne Präfix), die mit Sitzung erreichbar sein dürfen — nur diese. */
const ERREICHBAR_MIT_SITZUNG = ['/get-session', '/sign-out'];

/** Sicherheitsnetz: diese Endpunkte muss die Kandidatenliste kennen, sonst misst der Test ins Leere. */
const BEKANNTE_PFADE = [
  '/get-session',
  '/sign-out',
  '/sign-in/email',
  '/sign-up/email',
  '/update-user',
  '/change-email',
  '/change-password',
  '/list-sessions',
  '/revoke-sessions',
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
  '/two-factor/verify-totp',
  '/two-factor/disable',
];

interface Kandidat {
  readonly methode: NonNullable<InjectOptions['method']>;
  /** Pfad ohne `/api/auth`, Pfadparameter mit einem Beispielwert belegt. */
  readonly pfad: string;
}

interface Endpunkt {
  readonly path?: string;
  readonly options?: { readonly method?: string | readonly string[] };
}

/**
 * Alle HTTP-erreichbaren Endpunkte der installierten Version, je deklarierter
 * Methode. Serverinterne Endpunkte haben keinen Pfad und fehlen hier zu Recht.
 */
function kandidatenAusAuth(auth: CockpitAuth): Kandidat[] {
  const endpunkte: Endpunkt[] = Object.values(auth.api);
  return endpunkte.flatMap(({ path, options }) => {
    if (path === undefined) {
      return [];
    }
    const deklariert = [options?.method ?? '*'].flat();
    const methoden = deklariert.includes('*') ? ['GET', 'POST'] : deklariert;
    return methoden.map((methode) => ({
      methode: methode as Kandidat['methode'],
      pfad: path.replace(/:[^/]+/g, 'beispiel'),
    }));
  });
}

describe.skipIf(!datenbankUrl)('Rohe Better-Auth-Endpunkte (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let kandidaten: Kandidat[];
  let ohneFaktor: Konto;
  let mitFaktor: Konto;

  function anfrage(kandidat: Kandidat, cookie: string | undefined) {
    const mitKoerper = kandidat.methode !== 'GET';
    return app.inject({
      method: kandidat.methode,
      url: `${AUTH_PRAEFIX}${kandidat.pfad}`,
      headers: {
        origin: BASIS_URL,
        ...(cookie ? { cookie } : {}),
        ...(mitKoerper ? { 'content-type': 'application/json' } : {}),
      },
      ...(mitKoerper ? { payload: {} } : {}),
    });
  }

  /** Schickt jeden Kandidaten; `erreicht` sagt, ob er beim Handler ankam. */
  async function messen(cookie: string | undefined) {
    const handler = vi
      .spyOn(auth, 'handler')
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    const ergebnisse = [];
    for (const kandidat of kandidaten) {
      handler.mockClear();
      const antwort = await anfrage(kandidat, cookie);
      ergebnisse.push({ kandidat, antwort, erreicht: handler.mock.calls.length > 0 });
    }
    return ergebnisse;
  }

  function erreichbarePfade(ergebnisse: Awaited<ReturnType<typeof messen>>): string[] {
    const pfade = ergebnisse.filter((e) => e.erreicht).map((e) => e.kandidat.pfad);
    return [...new Set(pfade)].sort();
  }

  /** Was der Anfragende sieht — ohne Kopfzeilen, die je Antwort schwanken (Datum, ETag). */
  function sichtbar(antwort: LightMyRequestResponse): string {
    return `${antwort.statusCode} ${String(antwort.headers['content-type'])}\n${antwort.body}`;
  }

  async function zweiterFaktorAktiv(id: string): Promise<boolean> {
    const ergebnis = await pool.query<{ aktiv: boolean | null }>(
      'SELECT "twoFactorEnabled" AS aktiv FROM cockpit."user" WHERE id = $1',
      [id],
    );
    return ergebnis.rows[0]?.aktiv === true;
  }

  function neuesKonto(name: string, mitZweitemFaktor: boolean): Promise<Konto> {
    return kontoEinrichten(app, auth, {
      email: `${name}@example.org`,
      passwort: PASSWORT,
      name,
      mitZweitemFaktor,
    });
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool });
    kandidaten = kandidatenAusAuth(auth);

    await pool.query('DELETE FROM cockpit.einladung');
    await pool.query('DELETE FROM cockpit.erststart_token');
    await kontenLoeschen(pool);
    ohneFaktor = await neuesKonto('ohne-faktor', false);
    mitFaktor = await neuesKonto('mit-faktor', true);
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('Messreihe', () => {
    it('kennt die Better-Auth-Endpunkte der installierten Version', () => {
      const pfade = kandidaten.map((kandidat) => kandidat.pfad);

      for (const bekannt of BEKANNTE_PFADE) {
        expect(pfade, `Kandidatenliste kennt ${bekannt} nicht`).toContain(bekannt);
      }
    });

    it('erreicht ohne Sitzung keinen einzigen Endpunkt', async () => {
      const ergebnisse = await messen(undefined);

      expect(erreichbarePfade(ergebnisse)).toEqual([]);
    });

    it('erreicht mit Sitzung ohne zweiten Faktor genau get-session und sign-out', async () => {
      const ergebnisse = await messen(ohneFaktor.cookie);

      expect(erreichbarePfade(ergebnisse)).toEqual(ERREICHBAR_MIT_SITZUNG);
    });

    it('erreicht mit Sitzung und zweitem Faktor genau get-session und sign-out', async () => {
      const ergebnisse = await messen(mitFaktor.cookie);

      expect(erreichbarePfade(ergebnisse)).toEqual(ERREICHBAR_MIT_SITZUNG);
    });

    it('erreicht auch über Umweg-Schreibweisen nichts außer den exakten Pfaden', async () => {
      const handler = vi
        .spyOn(auth, 'handler')
        .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
      const umwege = [
        // Freigegebene Pfade, abgewandelt: nur der exakte Pfad ist frei.
        `${AUTH_PRAEFIX}/get-session/`,
        `${AUTH_PRAEFIX}/get-session/x`,
        `${AUTH_PRAEFIX}/sign-out/`,
        '/API/AUTH/get-session',
        `${AUTH_PRAEFIX}/%67et-session`,
        // Gesperrte Pfade in fremder Verkleidung.
        `//api/auth/update-user`,
        `${AUTH_PRAEFIX}/update-user/`,
        `${AUTH_PRAEFIX}/UPDATE-USER`,
        `${AUTH_PRAEFIX}/%75pdate-user`,
        `${AUTH_PRAEFIX}/./update-user`,
        `${AUTH_PRAEFIX}/x/../update-user`,
        `${AUTH_PRAEFIX}/get-session/../update-user`,
        '/%61pi/auth/update-user',
      ];

      for (const url of umwege) {
        for (const methode of ['GET', 'POST'] as const) {
          await app.inject({ method: methode, url, headers: { cookie: mitFaktor.cookie } });
        }
      }

      expect(handler).not.toHaveBeenCalled();
    });

    it('antwortet auf jeden verborgenen Endpunkt in jedem Zustand gleich', async () => {
      const referenz = sichtbar(
        await anfrage({ methode: 'POST', pfad: '/sign-in/email' }, undefined),
      );
      expect(referenz).toContain('404');
      expect(referenz).toContain('Nicht gefunden');

      for (const cookie of [undefined, ohneFaktor.cookie, mitFaktor.cookie]) {
        const verborgen = (await messen(cookie)).filter((e) => !e.erreicht);

        expect(verborgen.length).toBeGreaterThan(0);
        for (const { antwort } of verborgen) {
          expect(sichtbar(antwort)).toBe(referenz);
        }
      }
    });
  });

  describe('mit dem echten Handler', () => {
    it('schaltet den zweiten Faktor mit Sitzung und richtigem Passwort nicht ab', async () => {
      const konto = await neuesKonto('faktor-abschalten', true);
      const handler = vi.spyOn(auth, 'handler');

      const antwort = await app.inject({
        method: 'POST',
        url: `${AUTH_PRAEFIX}/two-factor/disable`,
        headers: {
          cookie: konto.cookie,
          origin: BASIS_URL,
          'content-type': 'application/json',
        },
        payload: { password: PASSWORT },
      });

      expect(antwort.statusCode).toBe(404);
      expect(handler).not.toHaveBeenCalled();
      expect(await zweiterFaktorAktiv(konto.id)).toBe(true);
    });

    it('bindet ohne Faktor über den rohen Endpunkt keinen Faktor, die Einrichtungsseite schon', async () => {
      const konto = await neuesKonto('roher-endpunkt', false);
      const einrichten = await app.inject({
        method: 'POST',
        url: '/zwei-faktor/einrichten',
        headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
        payload: formular({ passwort: PASSWORT }),
      });
      const code = await totpCode(auth, geheimnisAusUri(qrAusSeiteLesen(einrichten.body)));

      const roh = await app.inject({
        method: 'POST',
        url: `${AUTH_PRAEFIX}/two-factor/verify-totp`,
        headers: { cookie: konto.cookie, origin: BASIS_URL, 'content-type': 'application/json' },
        payload: { code },
      });
      expect(roh.statusCode).toBe(404);
      expect(await zweiterFaktorAktiv(konto.id)).toBe(false);

      const seite = await app.inject({
        method: 'POST',
        url: '/zwei-faktor/pruefen',
        headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
        payload: formular({ code }),
      });
      expect(seite.statusCode).toBeLessThan(400);
      expect(await zweiterFaktorAktiv(konto.id)).toBe(true);
    });

    it.each([
      ['ohne zweiten Faktor', false],
      ['mit zweitem Faktor', true],
    ])('liest die Sitzung über get-session %s', async (_, mitZweitemFaktor) => {
      const konto = await neuesKonto(`lesen-${mitZweitemFaktor}`, mitZweitemFaktor);

      const antwort = await app.inject({
        method: 'GET',
        url: `${AUTH_PRAEFIX}/get-session`,
        headers: { cookie: konto.cookie },
      });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.json<{ user: { id: string } }>().user.id).toBe(konto.id);
    });

    it.each([
      ['ohne zweiten Faktor', false],
      ['mit zweitem Faktor', true],
    ])('meldet über sign-out %s ab', async (_, mitZweitemFaktor) => {
      const konto = await neuesKonto(`abmelden-${mitZweitemFaktor}`, mitZweitemFaktor);
      const kopf = { cookie: konto.cookie, origin: BASIS_URL, 'content-type': 'application/json' };

      const abmelden = await app.inject({
        method: 'POST',
        url: `${AUTH_PRAEFIX}/sign-out`,
        headers: kopf,
        payload: {},
      });
      expect(abmelden.statusCode).toBe(200);

      // Dieselbe Sitzung ist danach ungültig: das Tor kennt sie nicht mehr.
      const danach = await app.inject({
        method: 'GET',
        url: `${AUTH_PRAEFIX}/get-session`,
        headers: { cookie: konto.cookie },
      });
      expect(danach.statusCode).toBe(404);
    });
  });
});
