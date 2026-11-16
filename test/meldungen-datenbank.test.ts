/**
 * Die Seite „Meldungen" (COPI-43, Prototyp), mit echten Anfragen gegen die echte Datenbank: Suche, Filter
 * (Alle, Warnung, Fehler, Info) und die Liste der Wechsel, je Rolle getrennt.
 *
 * Betriebs-Admin und Mitarbeiter sehen nur kundensichtbare Befunde mit ihrem Klartext; ein interner Befund taucht an
 * keiner Stelle der Seite auf, auch nicht über die Suche. Der Betreuer (Recht `rohbefunde_sehen`) sieht alle, mit
 * Rohbefund und der Marke „nur intern". Ohne Skript: die Filter sind Links, die Suche ist ein GET-Formular.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.befund`, `cockpit.wache` und (im letzten Abschnitt)
 * `cockpit."user"` ab.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden, type BefundMeldung } from '../src/status/befund-speicher.js';
import { kontenLoeschen, kontoEinrichten } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const JETZT = new Date('2026-09-21T12:00:00.000Z');
const GEHEIM = 'GEHEIM-INTERN-4711';
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

let minute = 0;
function meldung(teil: Partial<BefundMeldung> = {}): BefundMeldung {
  minute += 1;
  return {
    wache: 'rechnung',
    status: 'gelb',
    textIntern: 'roh: smtp 550',
    textKunde: 'Zustellung fehlgeschlagen.',
    kundensichtbar: true,
    anzeigename: 'Rechnungs-Agent',
    taktSekunden: 300,
    quelle: 'admin-agent',
    jetzt: new Date(JETZT.getTime() - (200 - minute) * 60_000),
    ...teil,
  };
}

async function beispielAnlegen(pool: pg.Pool): Promise<void> {
  await befundMelden(pool, meldung());
  await befundMelden(pool, meldung({ wache: 'reinigung', status: 'gruen', textIntern: 'roh: ok', textKunde: 'Reinigungsplan bestätigt.', anzeigename: 'Reinigungs-Agent' }));
  await befundMelden(pool, meldung({ wache: 'container', status: 'rot', textIntern: GEHEIM, textKunde: undefined, kundensichtbar: false, anzeigename: undefined }));
}

async function aufraeumen(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM cockpit.befund');
  await pool.query('DELETE FROM cockpit.wache');
}

const zeilen = (html: string): number => (html.match(/<li class="meldungen-zeile">/g) ?? []).length;

describe.skipIf(!datenbankUrl)('Seite Meldungen (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    minute = 0;
    await aufraeumen(pool);
  });

  afterAll(async () => {
    await aufraeumen(pool);
    await pool.end();
  });

  async function seite(rolle: Rolle | undefined, anfrage = ''): Promise<{ html: string; status: number; kopf: Record<string, unknown> }> {
    const zugang: Zugang = { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
    const app: FastifyInstance = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => JETZT, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugang) });
    try {
      const antwort = await app.inject({ method: 'GET', url: `/meldungen${anfrage}` });
      return { html: antwort.body, status: antwort.statusCode, kopf: antwort.headers };
    } finally {
      await app.close();
    }
  }

  describe.each<Rolle>(['betriebs_admin', 'betrieb_mitarbeiter'])('Kundensicht: %s', (rolle) => {
    it('zeigt die kundensichtbaren Wechsel, neueste zuerst, mit „vor … · Name"', async () => {
      await beispielAnlegen(pool);

      const { html, status } = await seite(rolle);

      expect(status).toBe(200);
      expect(zeilen(html)).toBe(2);
      expect(html.indexOf('Reinigungsplan bestätigt.')).toBeLessThan(html.indexOf('Zustellung fehlgeschlagen.'));
      expect(html).toContain('vor 3 Std. · Rechnungs-Agent');
    });

    // Je Anfrage ein eigener Fall (COPI-111): jede baut eine App auf, vier in einem Fall liefen in CI an die 5 s.
    it.each(['', `?q=${GEHEIM}`, '?q=container', '?art=fehler'])('zeigt einen internen Befund an keiner Stelle, auch nicht über die Suche (Anfrage „%s“)', async (anfrage) => {
      await beispielAnlegen(pool);

      const { html } = await seite(rolle, anfrage);

      expect(html).not.toContain(`>${GEHEIM}<`);
      expect(html).not.toContain('nur intern');
      expect(html).not.toMatch(/meldungen-symbol-rot/);
    });

    it('antwortet als HTML und lässt keinen Zwischenspeicher die rollenabhängige Seite aufbewahren', async () => {
      const { kopf } = await seite(rolle);

      expect(String(kopf['content-type'])).toContain('text/html');
      expect(kopf['cache-control']).toBe('no-store');
    });
  });

  describe('Filter und Suche', () => {
    beforeEach(async () => {
      await beispielAnlegen(pool);
    });

    it.each([
      ['?art=warnung', ['Zustellung fehlgeschlagen.']],
      ['?art=info', ['Reinigungsplan bestätigt.']],
      ['?art=fehler', []],
      ['?q=reinigung', ['Reinigungsplan bestätigt.']],
      ['?q=ZUSTELLUNG&art=warnung', ['Zustellung fehlgeschlagen.']],
      ['?art=lila', ['Reinigungsplan bestätigt.', 'Zustellung fehlgeschlagen.']],
    ])('zeigt für %s genau diese', async (anfrage, texte) => {
      const { html } = await seite('betriebs_admin', anfrage);

      const titel = [...html.matchAll(/<p class="meldungen-titel">([^<]*)<\/p>/g)].map((treffer) => treffer[1]);
      expect(titel).toEqual(texte);
    });

    it('markiert den aktiven Filter und nimmt die Suche in die anderen Filter mit', async () => {
      const { html } = await seite('betriebs_admin', '?art=warnung&q=Zust');

      expect(html).toContain('<a href="/meldungen?art=warnung&amp;q=Zust" class="chip" aria-current="true">Warnung</a>');
      expect(html).toContain('<a href="/meldungen?q=Zust" class="chip">Alle</a>');
      expect(html).toContain('<input type="hidden" name="art" value="warnung" />');
      expect(html).toContain('value="Zust"');
    });

    it('sagt ohne Treffer, dass nichts passt, statt „noch keine Meldungen"', async () => {
      const { html } = await seite('betriebs_admin', '?q=gibt-es-nicht');

      expect(zeilen(html)).toBe(0);
      expect(html).toContain('Keine passenden Meldungen');
    });

    it('maskiert die Suche im Formular und in den Filter-Links', async () => {
      const { html } = await seite('betriebs_admin', `?q=${encodeURIComponent('"><script>alert(1)</script>')}`);

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&quot;&gt;&lt;script&gt;');
    });
  });

  describe('Betreuersicht', () => {
    it('zeigt zusätzlich die internen Wechsel mit Rohbefund, Kennung und der Marke „nur intern"', async () => {
      await beispielAnlegen(pool);

      const { html } = await seite('betreuer');

      expect(zeilen(html)).toBe(3);
      expect(html).toContain(`<p class="meldungen-titel">${GEHEIM}</p>`);
      expect(html).toContain('container');
      expect(html).toContain('nur intern');
      expect(html).toMatch(/meldungen-symbol-rot/);
    });
  });

  it('maskiert Fremdtext und verlinkt ihn nie', async () => {
    await befundMelden(pool, meldung({ textKunde: '<img src=x onerror=alert(1)> https://boese.example' }));

    const { html } = await seite('betriebs_admin');

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('href="https://boese.example');
  });

  it('zeigt ohne jede Meldung einen Leerzustand', async () => {
    const { html } = await seite('betriebs_admin');

    expect(zeilen(html)).toBe(0);
    expect(html).toContain('Noch keine Meldungen');
  });

  it('zeigt ohne Datenbank den Leerzustand statt zu scheitern', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_FAKTOR });
    try {
      const antwort = await app.inject({ method: 'GET', url: '/meldungen' });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.body).toContain('Noch keine Meldungen');
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!datenbankUrl)('Meldungen mit echten Sitzungen je Rolle (echte Datenbank)', () => {
  const PASSWORT = 'ein-ausreichend-langes-passwort';
  const BASIS_URL = 'http://localhost:3000';
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let einrichtung: FastifyInstance;
  const cookies: Record<'mitarbeiter' | 'betreuer', string> = { mitarbeiter: '', betreuer: '' };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    minute = 0;
    await aufraeumen(pool);
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, jetzt: () => JETZT });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();
    const rollen: Record<keyof typeof cookies, Rolle> = { mitarbeiter: 'betrieb_mitarbeiter', betreuer: 'betreuer' };
    for (const name of Object.keys(cookies) as (keyof typeof cookies)[]) {
      const konto = await kontoEinrichten(einrichtung, auth, { email: `${name}@example.org`, passwort: PASSWORT, name, mitZweitemFaktor: true });
      cookies[name] = konto.cookie;
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rollen[name]]);
    }
    await beispielAnlegen(pool);
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await aufraeumen(pool);
    await kontenLoeschen(pool);
    await pool.end();
  });

  it('gibt dem Mitarbeiter die Kundensicht und markiert „Meldungen" in der Navigation', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/meldungen', headers: { cookie: cookies.mitarbeiter } });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).not.toContain(GEHEIM);
    expect(antwort.body).toContain('<a href="/meldungen" class="hauptnav-eintrag" aria-current="page">');
  });

  it('gibt dem Betreuer die internen Wechsel', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/meldungen', headers: { cookie: cookies.betreuer } });

    expect(antwort.body).toContain(GEHEIM);
  });

  it('schickt ein Konto ohne Sitzung zur Anmeldung', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/meldungen' });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden');
  });
});
