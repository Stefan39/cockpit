/**
 * Die Seite Benutzer (COPI-45), mit echten Sitzungen je Rolle gegen die echte Datenbank.
 *
 * Betreuer und Betriebs-Admin sehen jedes Konto — auch den Betreuer-Zugang — und die offenen Einladungen; der
 * Mitarbeiter bekommt die neutrale 404 und keinen Eintrag in der Navigation. Auf der Seite steht nichts, was ein
 * Geheimnis ist (Passwort-Hash, TOTP-Geheimnis, Einladungs-Hash), und Namen werden maskiert.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit."user"` und `cockpit.einladung` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Rolle } from '../src/auth/berechtigung.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { buildApp } from '../src/server/app.js';
import { kontenLoeschen, kontoEinrichten } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const PASSWORT = 'ein-ausreichend-langes-passwort';
const BASIS_URL = 'http://localhost:3000';
/** Ein Hash, wie ihn eine Einladung trägt: er darf nie auf der Seite stehen. */
const EINLADUNGS_HASH = 'ab'.repeat(32);
const BOESER_NAME = '<img src=x onerror=alert(1)>';

type Name = 'betreuer' | 'admin' | 'mitarbeiter';

describe.skipIf(!datenbankUrl)('Seite Benutzer mit echten Sitzungen je Rolle (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let einrichtung: FastifyInstance;
  const cookies: Record<Name, string> = { betreuer: '', admin: '', mitarbeiter: '' };
  const geheimnisse: string[] = [];

  async function aufraeumen(): Promise<void> {
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await aufraeumen();
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();

    const rollen: Record<Name, Rolle> = { betreuer: 'betreuer', admin: 'betriebs_admin', mitarbeiter: 'betrieb_mitarbeiter' };
    let betreuerId = '';
    for (const name of Object.keys(cookies) as Name[]) {
      const konto = await kontoEinrichten(einrichtung, auth, { email: `${name}@example.org`, passwort: PASSWORT, name, mitZweitemFaktor: true });
      cookies[name] = konto.cookie;
      geheimnisse.push(konto.geheimnis);
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rollen[name]]);
      if (name === 'betreuer') {
        betreuerId = konto.id;
      }
      if (name === 'mitarbeiter') {
        // Dazu ein Passkey: dann hat das Konto beide Arten des zweiten Faktors.
        await pool.query(
          `INSERT INTO cockpit.passkey (id, benutzer_id, oeffentlicher_schluessel, name) VALUES ('passkey-1', $1, '\\x00', 'Telefon')`,
          [konto.id],
        );
      }
    }

    // Ein Konto, dessen zweiter Faktor noch fehlt — mit einem Namen, der HTML wäre, würde er nicht maskiert.
    const offen = await kontoEinrichten(einrichtung, auth, { email: 'offen@example.org', passwort: PASSWORT, name: 'offen', mitZweitemFaktor: false });
    await pool.query('UPDATE cockpit."user" SET name = $2 WHERE id = $1', [offen.id, BOESER_NAME]);

    // Eine offene, eine abgelaufene und eine eingelöste Einladung: nur die offene gehört auf die Seite.
    await pool.query(
      `INSERT INTO cockpit.einladung (email, token_hash, eingeladen_von, ablauf_am, rolle, verbraucht_am) VALUES
         ('neu@example.org', $1, $2, now() + interval '2 hours', 'betrieb_mitarbeiter', NULL),
         ('abgelaufen@example.org', $3, $2, now() - interval '1 minute', 'betrieb_mitarbeiter', NULL),
         ('eingeloest@example.org', $4, $2, now() + interval '2 hours', 'betrieb_mitarbeiter', now())`,
      [EINLADUNGS_HASH, betreuerId, 'cd'.repeat(32), 'ef'.repeat(32)],
    );
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await aufraeumen();
    await pool.end();
  });

  function seite(name: Name, url = '/benutzer') {
    return app.inject({ method: 'GET', url, headers: { cookie: cookies[name] } });
  }

  describe.each(['betreuer', 'admin'] as const)('als %s', (name) => {
    it('zeigt jedes Konto mit Rolle — auch den Betreuer-Zugang — und markiert das eigene', async () => {
      const antwort = await seite(name);

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['cache-control']).toBe('no-store');
      for (const adresse of ['betreuer@example.org', 'admin@example.org', 'mitarbeiter@example.org', 'offen@example.org']) {
        expect(antwort.body).toContain(adresse);
      }
      for (const rolle of ['Betreuer', 'Betriebs-Admin', 'Mitarbeiter']) {
        expect(antwort.body).toContain(`<dt>Rolle</dt><dd>${rolle}</dd>`);
      }
      expect(antwort.body).toContain(`<h3 class="agent-name">${name} <span class="marke">Sie</span></h3>`);
      expect(antwort.body.match(/<span class="marke">Sie<\/span>/g)).toHaveLength(1);
    });

    it('zeigt den Stand des zweiten Faktors: aktiv mit Authenticator-App, und „Einrichtung offen" mit Verfall', async () => {
      const antwort = await seite(name);

      expect(antwort.body).toContain('<span class="plakette plakette-gruen">aktiv</span>');
      expect(antwort.body).toContain('<dt>Zweiter Faktor</dt><dd>Authenticator-App</dd>');
      expect(antwort.body).toContain('<dt>Zweiter Faktor</dt><dd>Passkey und Authenticator-App</dd>');
      expect(antwort.body).toContain('<span class="plakette plakette-gelb">Einrichtung offen</span>');
      expect(antwort.body).toMatch(/<dd class="wert-warn">verfällt in (?:\d+ Stunden|\d+ Tagen?)<\/dd>/);
    });

    it('zeigt nur die offene Einladung, mit Rolle, wer eingeladen hat und wann sie abläuft', async () => {
      const antwort = await seite(name);

      expect(antwort.body).toContain('neu@example.org');
      expect(antwort.body).toContain('<dt>Eingeladen von</dt><dd>betreuer</dd>');
      expect(antwort.body).toMatch(/<dt>Gültigkeit<\/dt><dd>läuft ab in (?:1 Stunde|\d+ Minuten)<\/dd>/);
      expect(antwort.body).not.toContain('abgelaufen@example.org');
      expect(antwort.body).not.toContain('eingeloest@example.org');
    });

    it('bietet „Jemanden einladen" an: beide dürfen einladen', async () => {
      const antwort = await seite(name);

      expect(antwort.body).toContain('<a href="/einladung" class="knopf knopf-akzent">Jemanden einladen</a>');
    });

    it('verlinkt die Seite unter „Mehr"', async () => {
      const antwort = await seite(name, '/mehr');

      expect(antwort.body).toContain('href="/benutzer"');
    });
  });

  it('gibt dem Mitarbeiter die neutrale 404 und keinen Eintrag unter „Mehr"', async () => {
    const antwort = await seite('mitarbeiter');
    const mehr = await seite('mitarbeiter', '/mehr');

    expect(antwort.statusCode).toBe(404);
    expect(antwort.body).not.toContain('example.org');
    expect(mehr.statusCode).toBe(200);
    expect(mehr.body).not.toContain('href="/benutzer"');
  });

  it('nimmt einem herabgestuften Admin die Seite sofort: die Rolle kommt aus der Datenbank, nicht aus der Sitzung', async () => {
    await pool.query(`UPDATE cockpit."user" SET rolle = 'betrieb_mitarbeiter' WHERE email = 'admin@example.org'`);
    try {
      expect((await seite('admin')).statusCode).toBe(404);
    } finally {
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betriebs_admin' WHERE email = 'admin@example.org'`);
    }
  });

  it('maskiert Namen: ein Name, der HTML wäre, erscheint als Text', async () => {
    const antwort = await seite('betreuer');

    expect(antwort.body).not.toContain(BOESER_NAME);
    expect(antwort.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('zeigt kein Geheimnis: keinen Passwort-Hash, kein TOTP-Geheimnis, keinen Hash einer Einladung', async () => {
    const antwort = await seite('betreuer');

    expect(antwort.body).not.toContain('$argon2');
    expect(antwort.body).not.toContain(EINLADUNGS_HASH);
    for (const geheimnis of geheimnisse) {
      expect(antwort.body).not.toContain(geheimnis);
    }
  });

  it('bleibt ohne Anmeldung zu (Umleitung zur Anmeldung, wie jede geschützte Seite)', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/benutzer' });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toMatch(/^\/anmelden/);
  });
});

describe('Seite Benutzer ohne Anmeldung eingerichtet', () => {
  it('bleibt zu: ohne Zugangsleser hat niemand das Recht', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true }) });
    try {
      const antwort = await app.inject({ method: 'GET', url: '/benutzer' });

      expect(antwort.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
