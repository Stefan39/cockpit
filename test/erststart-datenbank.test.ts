/**
 * Durchlauf gegen eine echte PostgreSQL. Läuft nur, wenn `TEST_DATABASE_URL`
 * gesetzt ist — in der CI über den Postgres-Service-Container, lokal nur mit
 * einer eigens dafür bereitgestellten Datenbank.
 *
 * ACHTUNG: Der Test räumt die Tabellen `cockpit."user"` und
 * `cockpit.erststart_token` ab. Niemals gegen eine Kundendatenbank laufen
 * lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import {
  benutzerVorhanden,
  neuesErststartTokenAnlegen,
  tokenPruefen,
} from '../src/auth/erststart-speicher.js';
import { erststartTokenErzeugen } from '../src/auth/erststart-token.js';
import { geheimnisAusUri } from '../src/server/routes/zwei-faktor.js';
import { buildApp } from '../src/server/app.js';
import { qrAusSeiteLesen } from './qr-lesen.js';
import type { FastifyInstance } from 'fastify';
import { kontenLoeschen, protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const EMAIL = 'betreuer@example.org';
const PASSWORT = 'ein-ausreichend-langes-passwort';

function formular(daten: Record<string, string>): string {
  return new URLSearchParams(daten).toString();
}

const FORMULAR_KOPF = { 'content-type': 'application/x-www-form-urlencoded' };

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Die `otpauth://`-URI trägt das Geheimnis base32-kodiert (so erwarten es
 * Authenticator-Apps), Better Auth prüft intern aber gegen den unkodierten
 * Wert. Für den Test wird deshalb zurück dekodiert. Reine Kodierung, kein
 * Krypto — in der Anwendung selbst wird das nicht gebraucht.
 */
function base32Dekodieren(wert: string): string {
  let sammler = 0;
  let bits = 0;
  let ausgabe = '';
  for (const zeichen of wert.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(zeichen);
    if (index < 0) {
      continue;
    }
    sammler = (sammler << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      ausgabe += String.fromCharCode((sammler >> bits) & 0xff);
    }
  }
  return ausgabe;
}

function cookieKopf(setCookie: string | string[] | undefined): string {
  const cookies = typeof setCookie === 'string' ? [setCookie] : (setCookie ?? []);
  return cookies.map((eintrag) => eintrag.split(';')[0]).join('; ');
}

describe.skipIf(!datenbankUrl)('Erststart gegen echte Datenbank', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let sitzungsCookie = '';
  let sitzungsCookieRoh = '';

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.erststart_token');
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: 'http://localhost:3000',
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('zeigt das Formular nur für ein gültiges Token', async () => {
    const token = await neuesErststartTokenAnlegen(pool);

    const gueltig = await app.inject({ method: 'GET', url: `/erststart/${token.token}` });
    const erfunden = await app.inject({
      method: 'GET',
      url: `/erststart/${erststartTokenErzeugen().token}`,
    });

    expect(gueltig.statusCode).toBe(200);
    expect(gueltig.body).toContain('Cockpit einrichten');
    expect(erfunden.statusCode).toBe(404);
    expect(erfunden.body).not.toContain('Cockpit einrichten');
  });

  it('hält ein neues Token im Protokoll fest: Akteur system beim Start, konsole auf Wunsch, nie das Token', async () => {
    const marke = await protokollMarke(pool);

    const beimStart = await neuesErststartTokenAnlegen(pool);
    const perKommando = await neuesErststartTokenAnlegen(pool, new Date(), 'konsole');

    const eintraege = await protokollSeit(pool, marke);
    expect(eintraege).toEqual([
      { art: 'erststart_token_erzeugt', akteur: 'system', ziel: null, einzelheiten: {} },
      { art: 'erststart_token_erzeugt', akteur: 'konsole', ziel: null, einzelheiten: {} },
    ]);
    expect(JSON.stringify(eintraege)).not.toContain(beimStart.token);
    expect(JSON.stringify(eintraege)).not.toContain(perKommando.token);
  });

  it('weist ein abgelaufenes Token ab', async () => {
    const token = await neuesErststartTokenAnlegen(pool);
    await pool.query(
      "UPDATE cockpit.erststart_token SET ablauf_am = now() - interval '1 minute' WHERE verbraucht_am IS NULL",
    );

    const antwort = await app.inject({ method: 'GET', url: `/erststart/${token.token}` });

    expect(antwort.statusCode).toBe(404);
  });

  it('verbrennt das Token bei einem Eingabefehler nicht', async () => {
    const token = await neuesErststartTokenAnlegen(pool);

    const antwort = await app.inject({
      method: 'POST',
      url: `/erststart/${token.token}`,
      headers: FORMULAR_KOPF,
      payload: formular({
        email: EMAIL,
        passwort: 'zu-kurz',
        passwortWiederholung: 'zu-kurz',
      }),
    });

    expect(antwort.statusCode).toBe(400);
    expect((await tokenPruefen(pool, token.token)).gueltig).toBe(true);
    expect(await benutzerVorhanden(pool)).toBe(false);
  });

  it('legt das Konto an, entwertet das Token und leitet zur 2FA-Einrichtung', async () => {
    const token = await neuesErststartTokenAnlegen(pool);
    const marke = await protokollMarke(pool);

    const antwort = await app.inject({
      method: 'POST',
      url: `/erststart/${token.token}`,
      headers: FORMULAR_KOPF,
      payload: formular({
        email: EMAIL,
        passwort: PASSWORT,
        passwortWiederholung: PASSWORT,
      }),
    });
    sitzungsCookie = cookieKopf(antwort.headers['set-cookie']);
    const gesetzt = antwort.headers['set-cookie'];
    sitzungsCookieRoh =
      (typeof gesetzt === 'string' ? [gesetzt] : (gesetzt ?? [])).find((eintrag) =>
        eintrag.includes('session_token'),
      ) ?? '';

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/zwei-faktor');
    expect(await benutzerVorhanden(pool)).toBe(true);
    expect(sitzungsCookie).toContain('__Host-cockpit.session_token');

    // Token ist verbraucht und auch mit korrektem Wert nicht mehr nutzbar.
    expect((await tokenPruefen(pool, token.token)).gueltig).toBe(false);
    const nochmal = await app.inject({ method: 'GET', url: `/erststart/${token.token}` });
    expect(nochmal.statusCode).toBe(404);

    // Das Protokoll (COPI-23) hat das Anlegen genau einmal festgehalten — mit der
    // Kennung des Kontos, nicht mit der Adresse.
    const konto = await pool.query<{ id: string }>('SELECT id FROM cockpit."user"');
    expect(await protokollSeit(pool, marke)).toEqual([
      {
        art: 'konto_angelegt',
        akteur: 'erststart',
        ziel: konto.rows[0]?.id,
        einzelheiten: { weg: 'erststart', rolle: 'betreuer' },
      },
    ]);
  });

  it('macht das Erststart-Konto zum Betreuer', async () => {
    // ADR 13.2: Wer die Instanz über das Konsolen-Token einrichtet, ist ihr Betreuer —
    // nicht Betriebs-Admin und nicht Mitarbeiter (COPI-22).
    const konten = await pool.query<{ rolle: string }>('SELECT rolle FROM cockpit."user"');

    expect(konten.rows).toHaveLength(1);
    expect(konten.rows[0]?.rolle).toBe('betreuer');
  });

  it('setzt den Sitzungs-Cookie als echten __Host--Cookie', () => {
    // `__Host-` wirkt nur am Namensanfang und verlangt Secure, Path=/ und
    // kein Domain-Attribut. Ein vorangestelltes `__Secure-` (Better-Auth-
    // Default) würde das Präfix wirkungslos machen — siehe konfiguration.ts.
    expect(sitzungsCookieRoh.startsWith('__Host-cockpit.session_token=')).toBe(true);
    expect(sitzungsCookieRoh).toContain('Secure');
    expect(sitzungsCookieRoh).toContain('Path=/');
    expect(sitzungsCookieRoh).toContain('HttpOnly');
    expect(sitzungsCookieRoh.toLowerCase()).not.toContain('domain=');
  });

  it('speichert das Passwort als Argon2id-Hash', async () => {
    const konten = await pool.query<{ password: string | null }>(
      'SELECT password FROM cockpit."account"',
    );

    expect(konten.rows).toHaveLength(1);
    expect(konten.rows[0]?.password ?? '').toMatch(/^\$argon2id\$/);
  });

  it('sperrt den Zugang, solange der zweite Faktor fehlt', async () => {
    const antwort = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: sitzungsCookie },
    });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/zwei-faktor');
  });

  it('gibt den Zugang erst nach erfolgreicher TOTP-Prüfung frei', async () => {
    const einrichten = await app.inject({
      method: 'POST',
      url: '/zwei-faktor/einrichten',
      headers: { ...FORMULAR_KOPF, cookie: sitzungsCookie },
      payload: formular({ passwort: PASSWORT }),
    });
    expect(einrichten.statusCode).toBe(200);

    const geheimnis = geheimnisAusUri(qrAusSeiteLesen(einrichten.body));
    expect(geheimnis).not.toBe('');

    // Vor der Prüfung bleibt das Tor zu.
    const nochGesperrt = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: sitzungsCookie },
    });
    expect(nochGesperrt.statusCode).toBe(303);

    // Ein falscher Code schaltet nicht frei.
    const falsch = await app.inject({
      method: 'POST',
      url: '/zwei-faktor/pruefen',
      headers: { ...FORMULAR_KOPF, cookie: sitzungsCookie },
      payload: formular({ code: '000000' }),
    });
    expect(falsch.statusCode).toBe(400);
    const weiterGesperrt = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: sitzungsCookie },
    });
    expect(weiterGesperrt.statusCode).toBe(303);

    // Der Code wird von Better Auth selbst erzeugt (`generateTOTP` ist ein
    // reiner Server-Endpunkt, über HTTP nicht erreichbar). Damit prüft der
    // Test gegen dieselbe Implementierung, die auch verifiziert — eine
    // zweite TOTP-Bibliothek im Test würde nur deren Version testen.
    const { code } = await auth.api.generateTOTP({
      body: { secret: base32Dekodieren(geheimnis) },
    });
    const pruefen = await app.inject({
      method: 'POST',
      url: '/zwei-faktor/pruefen',
      headers: { ...FORMULAR_KOPF, cookie: sitzungsCookie },
      payload: formular({ code }),
    });
    expect(pruefen.statusCode).toBe(303);
    expect(pruefen.headers.location).toBe('/');

    const offen = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieKopf(pruefen.headers['set-cookie']) || sitzungsCookie },
    });
    expect(offen.statusCode).toBe(200);
  });

  it('lässt keine Selbstregistrierung über die Better-Auth-Endpunkte zu', async () => {
    const antwort = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'fremd@example.org', password: PASSWORT, name: 'Fremd' },
    });

    const benutzer = await pool.query<{ anzahl: string }>(
      'SELECT count(*)::text AS anzahl FROM cockpit."user"',
    );

    expect(antwort.statusCode).toBe(404);
    expect(benutzer.rows[0]?.anzahl).toBe('1');
  });
  describe('scheitert die Rollenvergabe', () => {
    it('nimmt das Konto wieder zurück und lässt den Erststart wiederholbar', async () => {
      await kontenLoeschen(pool);
      const token = await neuesErststartTokenAnlegen(pool);
      const marke = await protokollMarke(pool);
      // Erzwingt den Fehler: jede Änderung der Rolle schlägt fehl. Die Funktion
      // heißt so, dass sie nie mit einem Produktivobjekt verwechselt wird, und
      // wird in jedem Fall wieder entfernt.
      await pool.query(`
        CREATE FUNCTION cockpit.test_rollenvergabe_scheitert() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_rollenvergabe_scheitert'; END $$`);
      await pool.query(`
        CREATE TRIGGER test_rollenvergabe_scheitert BEFORE UPDATE OF rolle ON cockpit."user"
        FOR EACH ROW EXECUTE FUNCTION cockpit.test_rollenvergabe_scheitert()`);
      try {
        const antwort = await app.inject({
          method: 'POST',
          url: `/erststart/${token.token}`,
          headers: FORMULAR_KOPF,
          payload: formular({ email: EMAIL, passwort: PASSWORT, passwortWiederholung: PASSWORT }),
        });

        expect(antwort.statusCode).toBe(500);
        // Kein Konto ohne Betreuerrolle bleibt zurück, und es gibt keine Sitzung.
        expect(await benutzerVorhanden(pool)).toBe(false);
        expect(antwort.headers['set-cookie']).toBeUndefined();
        // Ein zurückgenommenes Konto hinterlässt keinen Eintrag „angelegt".
        expect(await protokollSeit(pool, marke)).toEqual([]);
      } finally {
        await pool.query('DROP TRIGGER test_rollenvergabe_scheitert ON cockpit."user"');
        await pool.query('DROP FUNCTION cockpit.test_rollenvergabe_scheitert()');
      }

      // Der Betreiber startet neu, bekommt ein frisches Token, und diesmal klappt es.
      const neu = await neuesErststartTokenAnlegen(pool);
      const zweiter = await app.inject({
        method: 'POST',
        url: `/erststart/${neu.token}`,
        headers: FORMULAR_KOPF,
        payload: formular({ email: EMAIL, passwort: PASSWORT, passwortWiederholung: PASSWORT }),
      });

      expect(zweiter.statusCode).toBe(303);
      const konten = await pool.query<{ rolle: string }>('SELECT rolle FROM cockpit."user" WHERE geloescht_am IS NULL');
      expect(konten.rows.map((zeile) => zeile.rolle)).toEqual(['betreuer']);
      // Das zurückgenommene Konto bleibt als gelöscht markiert im Bestand (COPI-62); seine Adresse war wieder frei.
      const zurueck = await pool.query('SELECT geloescht_von, geloescht_email FROM cockpit."user" WHERE geloescht_am IS NOT NULL');
      expect(zurueck.rows).toEqual([{ geloescht_von: 'erststart', geloescht_email: EMAIL }]);
      // Das frische Token nach dem Neustart steht im Protokoll, dann das angelegte Konto.
      expect((await protokollSeit(pool, marke)).map((zeile) => zeile.art)).toEqual([
        'erststart_token_erzeugt',
        'konto_angelegt',
      ]);
    });
  });
});
