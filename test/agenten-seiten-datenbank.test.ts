/**
 * Die Seiten „Agenten" und „Zeitplan" (COPI-38), mit echten Anfragen gegen die echte Datenbank.
 *
 * Sichtbarkeit je Rolle (mit Stefan abgestimmt): jedes angemeldete Konto sieht Rolle, Grenzen und Zeitplan der
 * Agenten; **Kennung und Version sieht nur der Betreuer** (Recht `technik_sehen`). Der Zeitplan ist für alle
 * Rollen derselbe Inhalt. Fremdtext aus dem Inventar wird maskiert und nie verlinkt.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.agent` und (im letzten Abschnitt)
 * `cockpit."user"` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';
import { inventarErsetzen, type AgentInventar } from '../src/status/agenten-speicher.js';
import { kontenLoeschen, kontoEinrichten } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-21T12:00:00.000Z');
const vor = (sekunden: number): Date => new Date(JETZT.getTime() - sekunden * 1000);

const GEHEIME_KENNUNG = 'agent-rechnung-intern';
const GEHEIME_VERSION = '9.9.9-intern';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function zugangMit(rolle: Rolle | undefined): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
}

const RECHNUNG: AgentInventar = {
  kennung: GEHEIME_KENNUNG,
  rolle: 'Rechnungs-Agent',
  version: GEHEIME_VERSION,
  grenzen: { 'Betrag je Rechnung': 5000, 'darf löschen': false },
  zeitplan: [
    { name: 'Rechnungslauf', wann: 'täglich 07:00' },
    { name: 'Mahnungen', wann: 'montags 09:00' },
  ],
};

const BUCHUNG: AgentInventar = {
  kennung: 'buchung',
  rolle: 'Buchungs-Agent',
  version: '1.4.0',
  grenzen: {},
  zeitplan: [{ name: 'Anfragen prüfen', wann: 'alle 5 Minuten' }],
};

/** Die Zahl der Agentenkarten auf der Seite. */
const karten = (html: string): number => (html.match(/<li class="agent( agent-verlinkt)?">/g) ?? []).length;

describe.skipIf(!datenbankUrl)('Agenten und Zeitplan (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.agent');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.agent');
    await pool.end();
  });

  /** Ruft die Seite mit der Rolle auf; ohne Rolle (`undefined`) wie ein Konto mit unbekannter Rolle. */
  async function seite(url: '/agenten' | '/zeitplan', rolle: Rolle | undefined): Promise<{ html: string; status: number; kopf: Record<string, unknown> }> {
    const app: FastifyInstance = buildApp(
      { nodeEnv: 'test' },
      { pool, jetzt: () => JETZT, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugangMit(rolle)) },
    );
    try {
      const antwort = await app.inject({ method: 'GET', url });
      return { html: antwort.body, status: antwort.statusCode, kopf: antwort.headers };
    } finally {
      await app.close();
    }
  }

  describe.each<Rolle>(['betriebs_admin', 'betrieb_mitarbeiter'])('Kundensicht: %s', (rolle) => {
    it('zeigt auf der Seite Agenten Rolle, Grenzen und den Stand des Inventars', async () => {
      await inventarErsetzen(pool, [RECHNUNG, BUCHUNG], vor(300));

      const { html, status } = await seite('/agenten', rolle);

      expect(status).toBe(200);
      expect(karten(html)).toBe(2);
      expect(html).toContain('Rechnungs-Agent');
      expect(html).toContain('Buchungs-Agent');
      expect(html).toContain('<dt>Betrag je Rechnung</dt>');
      expect(html).toContain('<dd>5.000</dd>');
      expect(html).toContain('<dd>Nein</dd>');
      expect(html).toContain('Stand des Inventars: gemeldet vor 5 Minuten');
    });

    it('zeigt weder Kennung noch Version an irgendeiner Stelle der Seite', async () => {
      await inventarErsetzen(pool, [RECHNUNG, BUCHUNG], vor(300));

      for (const url of ['/agenten', '/zeitplan'] as const) {
        const { html } = await seite(url, rolle);

        expect(html, url).not.toContain(GEHEIME_KENNUNG);
        expect(html, url).not.toContain(GEHEIME_VERSION);
        expect(html, url).not.toContain('1.4.0');
        expect(html, url).not.toContain('<code>');
        expect(html, url).not.toContain('Version');
      }
    });

    it('zeigt auf der Seite Zeitplan alle Takte je Agent', async () => {
      await inventarErsetzen(pool, [RECHNUNG, BUCHUNG], vor(60));

      const { html, status } = await seite('/zeitplan', rolle);

      expect(status).toBe(200);
      expect(karten(html)).toBe(2);
      expect(html).toContain('<dt>Anfragen prüfen</dt>');
      expect(html).toContain('<dd>alle 5 Minuten</dd>');
      expect(html).toContain('<dt>Mahnungen</dt>');
      expect(html).toContain('<dd>montags 09:00</dd>');
      expect(html).toContain('Stand des Inventars: gemeldet vor 1 Minute');
    });

    it.each(['/agenten', '/zeitplan'] as const)('zeigt %s ohne Inventar einen Leerzustand statt einer leeren Seite', async (url) => {
      const { html, status } = await seite(url, rolle);

      expect(status).toBe(200);
      expect(karten(html)).toBe(0);
      expect(html).toContain('Noch kein Inventar gemeldet');
      expect(html).not.toContain('Stand des Inventars');
    });

    it('sagt beim Zeitplan „keine Zeitpläne", wenn es ein Inventar ohne einen einzigen Takt gibt', async () => {
      await inventarErsetzen(pool, [{ ...BUCHUNG, zeitplan: [] }], vor(60));

      const { html } = await seite('/zeitplan', rolle);

      expect(html).toContain('Keine Zeitpläne gemeldet');
      expect(karten(html)).toBe(0);
    });

    it('maskiert Fremdtext aus dem Inventar und verlinkt ihn nie', async () => {
      const fremd = '<img src=x onerror=alert(1)> https://boese.example';
      await inventarErsetzen(
        pool,
        [{ kennung: 'fremd', rolle: fremd, version: '1', grenzen: { [fremd]: fremd }, zeitplan: [{ name: fremd, wann: fremd }] }],
        vor(60),
      );

      for (const url of ['/agenten', '/zeitplan'] as const) {
        const { html } = await seite(url, rolle);

        expect(html, url).not.toContain('<img src=x');
        expect(html, url).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html, url).not.toContain('href="https://boese.example');
      }
    });

    it.each(['/agenten', '/zeitplan'] as const)('antwortet %s als HTML und lässt keinen Zwischenspeicher die rollenabhängige Seite aufbewahren', async (url) => {
      const { kopf } = await seite(url, rolle);

      expect(String(kopf['content-type'])).toContain('text/html');
      expect(kopf['cache-control']).toBe('no-store');
    });
  });

  describe('ein Konto mit unbekannter Rolle', () => {
    it('bekommt die Kundensicht: im Zweifel sieht es weniger', async () => {
      await inventarErsetzen(pool, [RECHNUNG], vor(60));

      const { html } = await seite('/agenten', undefined);

      expect(html).toContain('Rechnungs-Agent');
      expect(html).not.toContain(GEHEIME_KENNUNG);
      expect(html).not.toContain(GEHEIME_VERSION);
    });
  });

  describe('Betreuersicht', () => {
    it('zeigt auf der Seite Agenten zusätzlich Kennung und Version', async () => {
      await inventarErsetzen(pool, [RECHNUNG, BUCHUNG], vor(60));

      const { html } = await seite('/agenten', 'betreuer');

      expect(html).toContain(`<code>${GEHEIME_KENNUNG}</code>`);
      expect(html).toContain(`Version ${GEHEIME_VERSION}`);
      expect(html).toContain('<code>buchung</code>');
      expect(html).toContain('Version 1.4.0');
      expect(karten(html)).toBe(2);
    });

    it('zeigt auf der Seite Zeitplan denselben Inhalt wie dem Kunden: Kennung und Version gehören nicht dazu', async () => {
      await inventarErsetzen(pool, [RECHNUNG, BUCHUNG], vor(60));

      const { html } = await seite('/zeitplan', 'betreuer');

      expect(html).toContain('<dt>Rechnungslauf</dt>');
      expect(html).not.toContain(GEHEIME_KENNUNG);
      expect(html).not.toContain(GEHEIME_VERSION);
    });

    it('zeigt ohne Inventar denselben Leerzustand', async () => {
      const { html } = await seite('/agenten', 'betreuer');

      expect(html).toContain('Noch kein Inventar gemeldet');
      expect(karten(html)).toBe(0);
    });
  });

  describe('ohne Datenbank', () => {
    it.each(['/agenten', '/zeitplan'] as const)('zeigt %s den Leerzustand statt zu scheitern (Tests und Entwicklung ohne Datenbank)', async (url) => {
      const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_FAKTOR });
      try {
        const antwort = await app.inject({ method: 'GET', url });

        expect(antwort.statusCode).toBe(200);
        expect(antwort.body).toContain('Noch kein Inventar gemeldet');
      } finally {
        await app.close();
      }
    });
  });
});

describe.skipIf(!datenbankUrl)('Agenten und Zeitplan mit echten Sitzungen je Rolle (echte Datenbank)', () => {
  const PASSWORT = 'ein-ausreichend-langes-passwort';
  const BASIS_URL = 'http://localhost:3000';
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let einrichtung: FastifyInstance;
  const cookies: Record<'mitarbeiter' | 'admin' | 'betreuer', string> = { mitarbeiter: '', admin: '', betreuer: '' };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.agent');
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, jetzt: () => JETZT });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();

    const rollen: Record<keyof typeof cookies, Rolle> = {
      mitarbeiter: 'betrieb_mitarbeiter',
      admin: 'betriebs_admin',
      betreuer: 'betreuer',
    };
    for (const name of Object.keys(cookies) as (keyof typeof cookies)[]) {
      const konto = await kontoEinrichten(einrichtung, auth, {
        email: `${name}@example.org`,
        passwort: PASSWORT,
        name,
        mitZweitemFaktor: true,
      });
      cookies[name] = konto.cookie;
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rollen[name]]);
    }
    await inventarErsetzen(pool, [RECHNUNG, BUCHUNG], vor(60));
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await pool.query('DELETE FROM cockpit.agent');
    await kontenLoeschen(pool);
    await pool.end();
  });

  it.each(['mitarbeiter', 'admin'] as const)('gibt dem Konto %s die Kundensicht: keine Kennung, keine Version', async (name) => {
    const antwort = await app.inject({ method: 'GET', url: '/agenten', headers: { cookie: cookies[name] } });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain('Rechnungs-Agent');
    expect(antwort.body).not.toContain(GEHEIME_KENNUNG);
    expect(antwort.body).not.toContain(GEHEIME_VERSION);
  });

  it('gibt dem Betreuer Kennung und Version', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/agenten', headers: { cookie: cookies.betreuer } });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain(`<code>${GEHEIME_KENNUNG}</code>`);
    expect(antwort.body).toContain(`Version ${GEHEIME_VERSION}`);
  });

  it.each(['mitarbeiter', 'admin', 'betreuer'] as const)('zeigt dem Konto %s den Zeitplan mit dem Zeitplan aller Agenten', async (name) => {
    const antwort = await app.inject({ method: 'GET', url: '/zeitplan', headers: { cookie: cookies[name] } });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain('<dd>täglich 07:00</dd>');
    expect(antwort.body).toContain('<dd>alle 5 Minuten</dd>');
  });

  it.each(['/agenten', '/zeitplan'])('schickt ein Konto ohne Sitzung von %s zur Anmeldung und zeigt ihm nichts', async (url) => {
    const antwort = await app.inject({ method: 'GET', url });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden');
    expect(antwort.body).not.toContain('Rechnungs-Agent');
  });

  it('liegt im App-Rahmen unter „Mehr": der Eintrag „Mehr" ist markiert, die Übersicht ein Weg zurück (COPI-43)', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/agenten', headers: { cookie: cookies.mitarbeiter } });

    expect(antwort.body).toContain('<a href="/" class="hauptnav-eintrag">');
    expect(antwort.body).toContain('<a href="/mehr" class="hauptnav-eintrag" aria-current="page">');
  });
});
