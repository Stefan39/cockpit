/**
 * Die Einstellungen mit dem Abschnitt „Versionen" (COPI-39), mit echten Anfragen gegen die echte Datenbank.
 * Vorbild ist der Bildschirm „Einstellungen" des Prototyps: der Abschnitt trägt beim Betreuer die Marke „Nur
 * Betreuer", der Betriebs-Admin liest dort nur „Aktuell.".
 *
 * Sichtbarkeit je Rolle (ADR 13.1): der Betreuer sieht laufenden Digest, Soll-Digest, verfügbare Version und den
 * Stand der Versions-Wache; Betriebs-Admin und Mitarbeiter einen Klartextsatz je Bereich — **keine Digests, keine
 * Versionsnummern**. Der stärkste Beleg steht unten: die Kundenseite ist mit und ohne Selbstmeldung und Befund der
 * Versions-Wache Byte für Byte dieselbe.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.instanz`, `cockpit.eingriff`, `cockpit.befund`,
 * `cockpit.wache` und (im letzten Abschnitt) `cockpit."user"` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { instanzMelden } from '../src/status/instanz-speicher.js';
import { kundenVersionenLesen } from '../src/status/versionen-speicher.js';
import type { AntragStatus } from '../src/status/versionen.js';
import { eingriffIn, kontenLoeschen, kontoEinrichten } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-21T12:00:00.000Z');
const vor = (sekunden: number): Date => new Date(JETZT.getTime() - sekunden * 1000);
const LAUFEND = `sha256:${'9f'.repeat(32)}`;
const ZIEL = `sha256:${'e7'.repeat(32)}`;
const VERSION = '1.4.0+0123456';
const WACHEN_TEXT = 'verfügbar: 1.5.0 (sha256:e77b40)';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function zugangMit(rolle: Rolle | undefined): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
}

async function antragIn(pool: pg.Pool, status: AntragStatus): Promise<void> {
  await eingriffIn(pool, status, { ziel: ZIEL, vorher: LAUFEND });
}

/** Alles, was nur der Betreuer sehen darf: Selbstmeldung und ein Befund der Versions-Wache. */
async function technikAnlegen(pool: pg.Pool): Promise<void> {
  await instanzMelden(pool, { version: VERSION, digest: LAUFEND }, vor(3 * 86_400));
  await befundMelden(pool, {
    wache: 'version-cockpit',
    status: 'gelb',
    textIntern: WACHEN_TEXT,
    kundensichtbar: false,
    taktSekunden: 7 * 86_400,
    quelle: 'admin-agent',
    jetzt: vor(2 * 86_400),
  });
}

async function aufraeumen(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM cockpit.instanz');
  await pool.query('DELETE FROM cockpit.eingriff');
  await pool.query('DELETE FROM cockpit.befund');
  await pool.query('DELETE FROM cockpit.wache');
}

describe.skipIf(!datenbankUrl)('Einstellungen: Versionen (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await aufraeumen(pool);
  });

  afterAll(async () => {
    await aufraeumen(pool);
    await pool.end();
  });

  async function seite(rolle: Rolle | undefined, jetzt = JETZT): Promise<{ html: string; status: number; kopf: Record<string, unknown> }> {
    const app: FastifyInstance = buildApp(
      { nodeEnv: 'test' },
      { pool, jetzt: () => jetzt, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugangMit(rolle)) },
    );
    try {
      const antwort = await app.inject({ method: 'GET', url: '/einstellungen' });
      return { html: antwort.body, status: antwort.statusCode, kopf: antwort.headers };
    } finally {
      await app.close();
    }
  }

  describe.each<[Rolle, string]>([
    ['betriebs_admin', 'Betriebs-Admin'],
    ['betrieb_mitarbeiter', 'Mitarbeiter'],
  ])('Kundensicht: %s', (rolle, rollenName) => {
    it('zeigt den Abschnitt Versionen mit einem Satz für das Cockpit und nennt die Ansicht', async () => {
      const { html, status } = await seite(rolle);

      expect(status).toBe(200);
      expect(html).toContain('<h1>Einstellungen</h1>');
      expect(html).toContain(`Ansicht: ${rollenName}`);
      expect(html).toContain('Versionen');
      expect(html).toContain('<p class="bereich-satz">Aktuell.</p>');
      expect(html).not.toContain('Nur Betreuer');
    });

    it.each<[AntragStatus, string]>([
      ['beantragt', 'Update angefragt.'],
      ['laeuft', 'Update angefragt.'],
      ['fehlgeschlagen', 'Update fehlgeschlagen, Betreuer ist informiert.'],
      ['erledigt', 'Aktuell.'],
      ['zurueckgezogen', 'Aktuell.'],
    ])('sagt bei einem Antrag im Status %s: „%s"', async (antragStatus, satz) => {
      await antragIn(pool, antragStatus);

      const { html } = await seite(rolle);

      expect(html).toContain(`<p class="bereich-satz">${satz}</p>`);
    });

    it('zeigt keinen letzten Antrag und kein „hängt": nur „Update angefragt." (COPI-41)', async () => {
      await technikAnlegen(pool);
      await antragIn(pool, 'laeuft');

      const { html } = await seite(rolle, new Date(Date.now() + 16 * 60_000));

      expect(html).toContain('<p class="bereich-satz">Update angefragt.</p>');
      expect(html).not.toContain('Letzter Antrag');
      expect(html).not.toContain('Weg zurück');
      expect(html).not.toContain('hängt');
      expect(html).not.toContain('sha256');
    });

    it('zeigt an keiner Stelle einen Digest, eine Versionsnummer oder den Befund der Versions-Wache', async () => {
      await technikAnlegen(pool);
      await antragIn(pool, 'beantragt');

      const { html } = await seite(rolle);

      expect(html).not.toContain('sha256');
      expect(html).not.toContain(VERSION);
      expect(html).not.toContain('1.4.0');
      expect(html).not.toContain('1.5.0');
      expect(html).not.toContain('verfügbar');
      expect(html).not.toContain('<code');
    });

    it('ist mit und ohne Selbstmeldung und Befund der Versions-Wache Byte für Byte dieselbe Seite', async () => {
      const ohne = (await seite(rolle)).html;
      await technikAnlegen(pool);

      const mit = (await seite(rolle)).html;

      expect(mit).toBe(ohne);
    });

    it('antwortet als HTML und lässt keinen Zwischenspeicher die rollenabhängige Seite aufbewahren', async () => {
      const { kopf } = await seite(rolle);

      expect(String(kopf['content-type'])).toContain('text/html');
      expect(kopf['cache-control']).toBe('no-store');
    });
  });

  describe('ein Konto mit unbekannter Rolle', () => {
    it('bekommt die Kundensicht und keine Angabe zur Ansicht', async () => {
      await technikAnlegen(pool);

      const { html } = await seite(undefined);

      expect(html).toContain('<p class="bereich-satz">Aktuell.</p>');
      expect(html).not.toContain('sha256');
      expect(html).not.toContain('Ansicht:');
    });
  });

  describe('Betreuersicht', () => {
    it('zeigt Version, laufenden Digest, verfügbare Version und den Stand der Versions-Wache, mit der Marke „Nur Betreuer"', async () => {
      await technikAnlegen(pool);

      const { html } = await seite('betreuer');

      expect(html).toContain('Ansicht: Betreuer');
      expect(html).toContain('Nur Betreuer');
      expect(html).toContain(`<dd>${VERSION}</dd>`);
      expect(html).toContain(`<code class="digest">${LAUFEND}</code>`);
      expect(html).toContain(WACHEN_TEXT);
      expect(html).toContain('<dt>Versions-Wache</dt><dd>zuletzt geprüft vor 2 Tagen</dd>');
      expect(html).toContain('<dt>Gestartet</dt><dd>vor 3 Tagen</dd>');
      expect(html).toContain('<span class="plakette plakette-gelb">Update verfügbar</span>');
      expect(html).toContain('kein Update beantragt');
    });

    it('nennt den Soll-Digest eines offenen Antrags und markiert ihn', async () => {
      await technikAnlegen(pool);
      await antragIn(pool, 'freigegeben');

      const { html } = await seite('betreuer');

      expect(html).toContain(`<code class="digest">${ZIEL}</code>`);
      expect(html).toContain('<span class="plakette plakette-info">Update angefragt</span>');
    });

    it('zeigt den letzten Antrag mit Ziel-Version, Weg zurück und Stufen, auch nach dem Fehlschlag (COPI-41)', async () => {
      await technikAnlegen(pool);
      await antragIn(pool, 'fehlgeschlagen');

      const { html } = await seite('betreuer', new Date());

      expect(html).toMatch(/<h4 id="letzter-antrag-\d+" class="letzter-antrag-titel">Letzter Antrag Nr\. \d+<\/h4>/);
      expect(html).toContain('<dt>Stand</dt><dd>fehlgeschlagen</dd>');
      expect(html).toContain('<dt>Ziel-Version</dt><dd>1.4.0</dd>');
      expect(html).toContain(`<dt>Weg zurück</dt><dd class="digest-wert"><code class="digest">${LAUFEND}</code></dd>`);
      for (const stufe of ['Beantragt', 'Freigegeben', 'Gestartet', 'Fehlgeschlagen']) {
        expect(html).toContain(`<dt>${stufe}</dt><dd>gerade eben</dd>`);
      }
      expect(html).toContain('<span class="plakette plakette-rot">Update fehlgeschlagen</span>');
    });

    it('markiert einen Antrag, der länger als 15 Minuten läuft, als hängend', async () => {
      await technikAnlegen(pool);
      await antragIn(pool, 'laeuft');

      const { html } = await seite('betreuer', new Date(Date.now() + 16 * 60_000));

      expect(html).toContain('<span class="plakette plakette-rot">Update hängt</span>');
      expect(html).toContain('<dt>Stand</dt><dd class="wert-rot">hängt</dd>');
      expect(html).toMatch(/Antrag Nr\. \d+ hängt: er läuft seit über 15 Minuten, ohne dass sich das neue Cockpit gemeldet hat\./);
    });

    it('sagt ohne Selbstmeldung und ohne Versions-Wache, was fehlt, statt Werte zu erfinden', async () => {
      const { html } = await seite('betreuer');

      expect(html).toContain('<dt>Version</dt><dd>noch nicht gemeldet</dd>');
      expect(html).toContain('<dt>Versions-Wache</dt><dd>noch nicht gemeldet</dd>');
      expect(html).not.toContain('sha256');
      expect(html).not.toContain('plakette');
    });

    it('maskiert den Text der Versions-Wache und verlinkt ihn nie', async () => {
      await befundMelden(pool, {
        wache: 'version-cockpit',
        status: 'gelb',
        textIntern: '<img src=x onerror=alert(1)> https://boese.example',
        kundensichtbar: false,
        taktSekunden: 7 * 86_400,
        quelle: 'admin-agent',
        jetzt: vor(60),
      });

      const { html } = await seite('betreuer');

      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('href="https://boese.example');
    });
  });

  describe('Abfragen', () => {
    it('liest für die Kundensicht nur den Status des jüngsten Antrags', async () => {
      await technikAnlegen(pool);
      await antragIn(pool, 'erledigt');
      await antragIn(pool, 'beantragt');

      expect(await kundenVersionenLesen(pool)).toEqual({ antragStatus: 'beantragt' });
    });
  });

  describe('ohne Datenbank', () => {
    it('zeigt die Seite statt zu scheitern (Tests und Entwicklung ohne Datenbank)', async () => {
      const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_FAKTOR });
      try {
        const antwort = await app.inject({ method: 'GET', url: '/einstellungen' });

        expect(antwort.statusCode).toBe(200);
        expect(antwort.body).toContain('Versionen');
      } finally {
        await app.close();
      }
    });
  });
});

describe.skipIf(!datenbankUrl)('Einstellungen mit echten Sitzungen je Rolle (echte Datenbank)', () => {
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
    await aufraeumen(pool);
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, jetzt: () => JETZT });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();

    const rollen: Record<keyof typeof cookies, Rolle> = { mitarbeiter: 'betrieb_mitarbeiter', admin: 'betriebs_admin', betreuer: 'betreuer' };
    for (const name of Object.keys(cookies) as (keyof typeof cookies)[]) {
      const konto = await kontoEinrichten(einrichtung, auth, { email: `${name}@example.org`, passwort: PASSWORT, name, mitZweitemFaktor: true });
      cookies[name] = konto.cookie;
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rollen[name]]);
    }
    await technikAnlegen(pool);
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await aufraeumen(pool);
    await kontenLoeschen(pool);
    await pool.end();
  });

  it.each(['mitarbeiter', 'admin'] as const)('gibt dem Konto %s die Kundensicht: kein Digest, keine Version', async (name) => {
    const antwort = await app.inject({ method: 'GET', url: '/einstellungen', headers: { cookie: cookies[name] } });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain('Aktuell.');
    expect(antwort.body).not.toContain('sha256');
    expect(antwort.body).not.toContain(VERSION);
  });

  it('gibt dem Betreuer Digest und Version', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/einstellungen', headers: { cookie: cookies.betreuer } });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain(LAUFEND);
    expect(antwort.body).toContain(VERSION);
  });

  it('schickt ein Konto ohne Sitzung zur Anmeldung und zeigt ihm nichts', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/einstellungen' });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden');
    expect(antwort.body).not.toContain('Versionen');
  });

  it('liegt im App-Rahmen unter „Mehr": der Eintrag „Mehr" ist markiert (COPI-43)', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/einstellungen', headers: { cookie: cookies.mitarbeiter } });

    expect(antwort.body).toContain('<a href="/mehr" class="hauptnav-eintrag" aria-current="page">');
  });
});
