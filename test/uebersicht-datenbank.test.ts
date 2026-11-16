/**
 * Die Übersicht `/` (COPI-37), mit echten Anfragen gegen die echte Datenbank.
 *
 * Zwei Sichten auf dieselben Daten. Der Betriebs-Admin und der Mitarbeiter sehen **nur** Befunde, die
 * kundensichtbar sind, samt ihrem Klartext; der Betreuer sieht zusätzlich die Rohbefunde. Ein interner
 * Befund taucht für den Kunden **an keiner Stelle** der Seite auf — nicht als Text, nicht als Zähler,
 * nicht als Farbe einer Kachel. Der stärkste Beleg steht unten: die Kundenseite ist mit und ohne
 * internen Befund Byte für Byte dieselbe.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.befund`, `cockpit.wache` und (im letzten
 * Abschnitt) `cockpit."user"` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden, type BefundMeldung } from '../src/status/befund-speicher.js';
import { kontenLoeschen, kontoEinrichten } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-21T12:00:00.000Z');
const vor = (sekunden: number): Date => new Date(JETZT.getTime() - sekunden * 1000);
const GEHEIM = 'GEHEIM-INTERN-4711';

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function zugangMit(rolle: Rolle | undefined): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
}

function meldung(teil: Partial<BefundMeldung> = {}): BefundMeldung {
  return {
    wache: 'buchung',
    status: 'gruen',
    textIntern: 'intern',
    kundensichtbar: false,
    taktSekunden: 300,
    quelle: 'admin-agent',
    jetzt: vor(60),
    ...teil,
  };
}

/** Die Zahl der Kacheln auf der Seite. */
const kacheln = (html: string): number => (html.match(/<li class="kachel\b/g) ?? []).length;

describe.skipIf(!datenbankUrl)('Übersicht (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.end();
  });

  /** Ruft `/` mit der Rolle auf; ohne Rolle (`undefined`) wie ein Konto mit unbekannter Rolle. */
  async function seite(rolle: Rolle | undefined): Promise<{ html: string; status: number; kopf: Record<string, unknown> }> {
    const app: FastifyInstance = buildApp(
      { nodeEnv: 'test' },
      { pool, jetzt: () => JETZT, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugangMit(rolle)) },
    );
    try {
      const antwort = await app.inject({ method: 'GET', url: '/' });
      return { html: antwort.body, status: antwort.statusCode, kopf: antwort.headers };
    } finally {
      await app.close();
    }
  }

  describe.each<Rolle>(['betriebs_admin', 'betrieb_mitarbeiter'])('Kundensicht: %s', (rolle) => {
    it('zeigt eine Kachel mit Namen, Klartext, Statuswort und „zuletzt geprüft", dazu die Statuskarte', async () => {
      await befundMelden(
        pool,
        meldung({
          status: 'rot',
          textKunde: 'Die Buchungen sind gerade nicht erreichbar.',
          kundensichtbar: true,
          anzeigename: 'Buchungs-Agent',
        }),
      );

      const { html, status } = await seite(rolle);

      expect(status).toBe(200);
      expect(html).toContain('Buchungs-Agent');
      expect(html).toContain('Die Buchungen sind gerade nicht erreichbar.');
      expect(html).toContain('Störung');
      expect(html).toContain('vor 1 Min. geprüft');
      expect(html).toContain('1 Sache braucht Ihre Aufmerksamkeit');
      expect(html).toMatch(/class="status status-rot"/);
      expect(kacheln(html)).toBe(1);
    });

    it('lässt einen internen Befund an keiner Stelle der Seite auftauchen: kein Text, keine Kennung, kein Zähler, keine Farbe', async () => {
      // Eine Wache mit sichtbarem Befund und einem jüngeren, internen Rot, dazu eine, die nur intern meldet.
      await befundMelden(pool, meldung({ status: 'gruen', textKunde: 'Alles läuft.', kundensichtbar: true, anzeigename: 'Buchungs-Agent', jetzt: vor(120) }));
      await befundMelden(pool, meldung({ status: 'rot', textIntern: `${GEHEIM}-a`, jetzt: vor(60) }));
      await befundMelden(pool, meldung({ wache: 'interne-wache', status: 'rot', textIntern: `${GEHEIM}-b`, quelle: 'geheime-quelle' }));

      const { html } = await seite(rolle);

      for (const verboten of [GEHEIM, 'interne-wache', 'geheime-quelle', 'admin-agent']) {
        expect(html, `Die Seite enthält „${verboten}"`).not.toContain(verboten);
      }
      // Zähler: die interne Wache ist keine Kachel, und das interne Rot zählt nicht.
      expect(kacheln(html)).toBe(1);
      expect(html).toContain('Alles läuft');
      expect(html).not.toContain('Aufmerksamkeit');
      // Farbe: die Kachel bleibt grün, die Karte auch.
      expect(html).toMatch(/class="status status-gruen"/);
      expect(html).not.toMatch(/status-rot|kachel-rot|punkt-rot/);
      expect(html).not.toContain('Störung');
    });

    it('ist mit und ohne internen Befund Byte für Byte dieselbe Seite', async () => {
      await befundMelden(pool, meldung({ status: 'gruen', textKunde: 'Alles läuft.', kundensichtbar: true, anzeigename: 'Buchungs-Agent', jetzt: vor(120) }));
      await befundMelden(pool, meldung({ wache: 'reinigung', status: 'gelb', textKunde: 'Ein Termin wartet.', kundensichtbar: true, anzeigename: 'Reinigung', jetzt: vor(200) }));
      const vorher = (await seite(rolle)).html;

      // Interne Befunde für dieselben Wachen (ohne Takt und Namen zu ändern) und für eine, die nur intern meldet.
      await befundMelden(pool, meldung({ status: 'rot', textIntern: `${GEHEIM}-a`, taktSekunden: undefined, jetzt: vor(30) }));
      await befundMelden(pool, meldung({ wache: 'reinigung', status: 'rot', textIntern: `${GEHEIM}-b`, taktSekunden: undefined, jetzt: vor(20) }));
      await befundMelden(pool, meldung({ wache: 'interne-wache', status: 'rot', textIntern: `${GEHEIM}-c` }));
      const nachher = (await seite(rolle)).html;

      expect(nachher).toBe(vorher);
    });

    it('zeigt ohne jede Meldung einen Leerzustand und keine Kachelliste', async () => {
      const { html, status } = await seite(rolle);

      expect(status).toBe(200);
      expect(html).toContain('Noch keine Meldungen');
      expect(html).toContain('Sobald der Betrieb meldet, erscheint hier der Stand.');
      expect(html).toMatch(/class="status status-leer"/);
      expect(kacheln(html)).toBe(0);
      expect(html).not.toContain('class="kacheln"');
    });

    it('zeigt auch dann einen Leerzustand, wenn es nur interne Meldungen gibt', async () => {
      await befundMelden(pool, meldung({ status: 'rot', textIntern: GEHEIM }));

      const { html } = await seite(rolle);

      expect(html).toContain('Noch keine Meldungen');
      expect(html).not.toContain(GEHEIM);
      expect(kacheln(html)).toBe(0);
    });

    it('zeigt eine Wache, die ausbleibt, gelb und sagt, wie lange es her ist', async () => {
      await befundMelden(pool, meldung({ status: 'gruen', textKunde: 'Alles läuft.', kundensichtbar: true, anzeigename: 'Buchungs-Agent', jetzt: vor(3 * 86_400) }));

      const { html } = await seite(rolle);

      expect(html).toContain('Achtung');
      expect(html).toContain('vor 3 Tagen geprüft');
      expect(html).toMatch(/kachel-gelb/);
      expect(html).toContain('Alles läuft, 1 Sache im Blick');
    });

    it('nennt eine Kachel ohne Anzeigenamen „Bereich" und nie die technische Kennung', async () => {
      await befundMelden(pool, meldung({ wache: 'postgres-container-7', textKunde: 'Alles läuft.', kundensichtbar: true }));

      const { html } = await seite(rolle);

      expect(html).toContain('Bereich');
      expect(html).not.toContain('postgres-container-7');
    });

    it('maskiert Fremdtext und verlinkt ihn nie', async () => {
      const fremd = '<script>alert(1)</script> & "Zitat" https://boese.example/x <a href="https://boese.example">Klick</a>';
      await befundMelden(pool, meldung({ textKunde: fremd, kundensichtbar: true, anzeigename: '<b>Name</b>' }));

      const { html } = await seite(rolle);

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<b>Name</b>');
      expect(html).toContain('&lt;b&gt;Name&lt;/b&gt;');
      expect(html).not.toContain('href="https://boese.example');
      // Jeder Verweis der Seite führt auf eine eigene Seite: der Fremdtext hat keinen hinzugefügt (COPI-43: die
      // Seite hat jetzt eigene Links wie „Alle ansehen", darum wird nicht mehr gezählt).
      const ziele = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((treffer) => treffer[1] ?? '');
      expect(ziele.length).toBeGreaterThan(0);
      expect(ziele.filter((ziel) => !/^(?:\/(?!\/)|#)/.test(ziel))).toEqual([]);
      expect(html).not.toMatch(/<a\b[^>]*>Klick/);
    });

    it('antwortet als HTML und lässt keinen Zwischenspeicher die rollenabhängige Seite aufbewahren', async () => {
      const { kopf } = await seite(rolle);

      expect(String(kopf['content-type'])).toMatch(/^text\/html/);
      expect(kopf['cache-control']).toBe('no-store');
    });
  });

  describe('Aufbau wie im Prototyp (COPI-43)', () => {
    const letzte = (html: string): string[] => [...html.matchAll(/<p class="letzte-titel">([^<]*)<\/p>/g)].map((treffer) => treffer[1] ?? '');

    it('zeigt „Letzte Meldungen": höchstens drei Wechsel, neueste zuerst, mit einem Link zu allen', async () => {
      for (const [i, text] of ['Eins.', 'Zwei.', 'Drei.', 'Vier.'].entries()) {
        await befundMelden(pool, meldung({ textKunde: text, kundensichtbar: true, anzeigename: 'Buchungs-Agent', jetzt: vor(600 - i * 60) }));
      }

      const { html } = await seite('betriebs_admin');

      expect(letzte(html)).toEqual(['Vier.', 'Drei.', 'Zwei.']);
      expect(html).toMatch(/<a href="\/meldungen" class="abschnitt-link">Alle/);
    });

    it('lässt einen internen Befund auch in „Letzte Meldungen" weg; der Betreuer sieht ihn', async () => {
      await befundMelden(pool, meldung({ textKunde: 'Alles läuft.', kundensichtbar: true, anzeigename: 'Buchungs-Agent', jetzt: vor(120) }));
      await befundMelden(pool, meldung({ wache: 'container', status: 'rot', textIntern: GEHEIM, jetzt: vor(60) }));

      expect(letzte((await seite('betrieb_mitarbeiter')).html)).toEqual(['Alles läuft.']);
      expect(letzte((await seite('betreuer')).html)).toEqual([GEHEIM, 'intern']);
    });

    it('lässt „Letzte Meldungen" ohne jede Meldung ganz weg: die Statuskarte sagt es schon', async () => {
      const { html } = await seite('betriebs_admin');

      expect(html).not.toContain('Letzte Meldungen');
    });

    it.each([
      ['rot', true],
      ['gelb', true],
      ['gruen', false],
    ] as const)('bietet bei %s „Jetzt ansehen" an: %s', async (status, angeboten) => {
      await befundMelden(pool, meldung({ status, textKunde: 'Text.', kundensichtbar: true, anzeigename: 'Buchungs-Agent' }));

      const { html } = await seite('betriebs_admin');

      expect(html.includes('>Jetzt ansehen</a>')).toBe(angeboten);
      if (angeboten) {
        expect(html).toContain(`<a href="/meldungen" class="status-aktion status-aktion-${status}">Jetzt ansehen</a>`);
      }
    });

    it('zeigt die Kachel kompakt: Punkt, Name, Statuswort und „vor … geprüft" — der Text steht in den Meldungen', async () => {
      await befundMelden(pool, meldung({ status: 'gelb', textKunde: 'Zustellung fehlgeschlagen.', kundensichtbar: true, anzeigename: 'Rechnungs-Agent', jetzt: vor(2 * 3600) }));

      const { html } = await seite('betriebs_admin');
      const kachel = /<li class="kachel kachel-gelb">[^]*?<\/li>/.exec(html)?.[0] ?? '';

      expect(kachel).toContain('<span class="kachel-name">Rechnungs-Agent</span>');
      expect(kachel).toMatch(/<span class="kachel-wort kachel-wort-gelb">Achtung<\/span> · vor 2 Std\. geprüft/);
      expect(kachel).not.toContain('Zustellung fehlgeschlagen.');
    });
  });

  describe('ein Konto mit unbekannter Rolle', () => {
    it('bekommt die Kundensicht: im Zweifel sieht es weniger', async () => {
      await befundMelden(pool, meldung({ status: 'rot', textIntern: GEHEIM }));
      await befundMelden(pool, meldung({ wache: 'sichtbar', textKunde: 'Alles läuft.', kundensichtbar: true }));

      const { html } = await seite(undefined);

      expect(html).not.toContain(GEHEIM);
      expect(html).toContain('Alles läuft.');
    });
  });

  describe('Betreuersicht', () => {
    it('zeigt zusätzlich die Rohbefunde, die Kennung und ob ein Befund für Kunden sichtbar ist', async () => {
      await befundMelden(pool, meldung({ wache: 'container', status: 'rot', textIntern: `postgres beendet (Exit 137) ${GEHEIM}`, jetzt: vor(60) }));
      await befundMelden(
        pool,
        meldung({ wache: 'buchung', status: 'gruen', textIntern: 'roh', textKunde: 'Alles läuft.', kundensichtbar: true, anzeigename: 'Buchungs-Agent', jetzt: vor(120) }),
      );

      const { html } = await seite('betreuer');

      expect(html).toContain(GEHEIM);
      // Ohne Anzeigenamen ist die Kennung der Titel und steht nicht noch einmal darunter, mit Anzeigenamen daneben.
      expect(html).toContain('<span class="kachel-name">container</span>');
      expect(html).not.toContain('<code>container</code>');
      expect(html).toContain('<span class="kachel-name">Buchungs-Agent</span>');
      expect(html).toContain('<code>buchung</code>');
      expect(html).toContain('nur intern');
      expect(html).toContain('für Kunden sichtbar');
      expect(html).toContain('Buchungs-Agent');
      expect(kacheln(html)).toBe(2);
    });

    it('zählt für die Statuskarte alle Wachen, auch die, die der Kunde nie sähe', async () => {
      await befundMelden(pool, meldung({ wache: 'container', status: 'rot', textIntern: 'postgres beendet' }));

      const { html } = await seite('betreuer');

      expect(html).toContain('1 Sache braucht Ihre Aufmerksamkeit');
      expect(html).toContain('postgres beendet');
      expect(html).toMatch(/class="status status-rot"/);
    });

    it('zeigt einen gestoppten Container (Rot) und eine ausbleibende Wache (überfällig) als Kachel', async () => {
      await befundMelden(pool, meldung({ wache: 'container', status: 'rot', textIntern: 'postgres beendet', jetzt: vor(30) }));
      await befundMelden(pool, meldung({ wache: 'backup', status: 'gruen', textIntern: 'Backup ok', jetzt: vor(2 * 86_400) }));

      const { html } = await seite('betreuer');

      expect(kacheln(html)).toBe(2);
      expect(html).toMatch(/kachel-rot[\s\S]*postgres beendet/);
      expect(html).toMatch(/kachel-gelb[\s\S]*vor 2 Tagen geprüft/);
    });

    it('maskiert auch den Rohbefund', async () => {
      await befundMelden(pool, meldung({ textIntern: '<img src=x onerror=alert(1)> https://boese.example' }));

      const { html } = await seite('betreuer');

      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('href="https://boese.example');
    });

    it('zeigt ohne jede Meldung denselben Leerzustand wie die Kundensicht', async () => {
      const { html } = await seite('betreuer');

      expect(html).toContain('Noch keine Meldungen');
      expect(kacheln(html)).toBe(0);
    });
  });

  describe('ohne Datenbank', () => {
    it('zeigt den Leerzustand statt zu scheitern (Tests und Entwicklung ohne Datenbank)', async () => {
      const app = buildApp({ nodeEnv: 'test' }, { sitzungLesen: MIT_FAKTOR });
      try {
        const antwort = await app.inject({ method: 'GET', url: '/' });

        expect(antwort.statusCode).toBe(200);
        expect(antwort.body).toContain('Noch keine Meldungen');
      } finally {
        await app.close();
      }
    });
  });
});

describe.skipIf(!datenbankUrl)('Übersicht mit echten Sitzungen je Rolle (echte Datenbank)', () => {
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
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
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

    await befundMelden(pool, meldung({ status: 'rot', textIntern: GEHEIM }));
    await befundMelden(pool, meldung({ wache: 'sichtbar', status: 'gruen', textKunde: 'Alles läuft.', kundensichtbar: true, anzeigename: 'Buchungen' }));
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await kontenLoeschen(pool);
    await pool.end();
  });

  it.each(['mitarbeiter', 'admin'] as const)('gibt dem Konto %s die Kundensicht: kein Rohbefund', async (name) => {
    const antwort = await app.inject({ method: 'GET', url: '/', headers: { cookie: cookies[name] } });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain('Alles läuft.');
    expect(antwort.body).not.toContain(GEHEIM);
    expect(antwort.body).not.toContain('nur intern');
  });

  it('gibt dem Betreuer die Betreuersicht: mit Rohbefund', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/', headers: { cookie: cookies.betreuer } });

    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain(GEHEIM);
    expect(antwort.body).toContain('nur intern');
  });

  it('schickt ein Konto ohne Sitzung zur Anmeldung und zeigt ihm keine Daten', async () => {
    const antwort = await app.inject({ method: 'GET', url: '/' });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden');
    expect(antwort.body).not.toContain('Alles läuft.');
  });

  it.each([
    ['mitarbeiter', false],
    ['admin', true],
    ['betreuer', true],
  ] as const)('zeigt dem Konto %s die Navigation, unter „Mehr" „Einladen" %s, das Abmelden immer (COPI-38, COPI-43)', async (name, einladen) => {
    const uebersicht = await app.inject({ method: 'GET', url: '/', headers: { cookie: cookies[name] } });
    const mehr = await app.inject({ method: 'GET', url: '/mehr', headers: { cookie: cookies[name] } });

    expect(uebersicht.body).toContain('<a href="/" class="hauptnav-eintrag" aria-current="page">');
    expect(uebersicht.body).toContain('<form method="post" action="/abmelden"');
    expect(mehr.statusCode).toBe(200);
    // Die Navigation zeigt nur, was die Route auch durchlässt: ohne das Recht kein Link, der auf eine 404 führt.
    expect(mehr.body.includes('href="/einladung"')).toBe(einladen);
    expect(mehr.body).toContain('<a href="/mehr" class="hauptnav-eintrag" aria-current="page">');
  });

  it('meldet über das Formular der Seite wirklich ab: dieselbe Sitzung ist danach ungültig (COPI-38)', async () => {
    const konto = await kontoEinrichten(einrichtung, auth, {
      email: 'abmelden@example.org',
      passwort: PASSWORT,
      name: 'abmelden',
      mitZweitemFaktor: true,
    });
    const seite = await app.inject({ method: 'GET', url: '/', headers: { cookie: konto.cookie } });
    // Das Ziel steht in der Seite selbst: was der Knopf „Abmelden" abschickt, ist das, was hier geprüft wird.
    const ziel = /<form method="post" action="([^"]+)">\s*<button type="submit" class="rahmen-knopf">/.exec(seite.body)?.[1];
    expect(ziel).toBe('/abmelden');

    const abmelden = await app.inject({ method: 'POST', url: ziel ?? '', headers: { cookie: konto.cookie } });
    const danach = await app.inject({ method: 'GET', url: '/', headers: { cookie: konto.cookie } });

    expect(abmelden.statusCode).toBe(303);
    expect(abmelden.headers.location).toBe('/anmelden');
    expect(danach.statusCode).toBe(303);
    expect(danach.headers.location).toBe('/anmelden');
  });

  it('richtet sich nach der Rolle in der Datenbank, nicht nach der beim Anmelden: eine Herabstufung wirkt sofort', async () => {
    // Der Betreuer wird zum Mitarbeiter (in der Datenbank gilt: nur die Übergabe darf das, sie setzt die Markierung).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('cockpit.betreuer_aenderung', 'ja', true)");
      await client.query(`UPDATE cockpit."user" SET rolle = 'betrieb_mitarbeiter' WHERE email = 'betreuer@example.org'`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const antwort = await app.inject({ method: 'GET', url: '/', headers: { cookie: cookies.betreuer } });

    expect(antwort.body).not.toContain(GEHEIM);
  });
});
