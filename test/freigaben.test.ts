/**
 * Die Freigabe-Inbox, Teil 1 (COPI-139): Liste, Detail, Navigationszähler, Fehlerfälle und Ausblenden — mit gemocktem
 * Webhook der Repo-Wache. Läuft ohne Datenbank.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { OHNE_ZUGANG, ROLLE_BETREUER, type Rolle, type Zugang, type ZugangLesen } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { repowacheAusUmgebung, type RepowacheKonfiguration } from '../src/freigaben/repowache.js';
import { buildApp } from '../src/server/app.js';

const TOKEN = 'geheimer-repowache-token-0815';
const KONFIGURATION: RepowacheKonfiguration = { url: 'https://n8n.example.test', token: TOKEN };
const JETZT = new Date('2026-10-29T12:00:00Z');

const sitzungLesen: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

const zugangLesen: ZugangLesen = (request) => {
  const rolle = (request.headers['x-rolle'] ?? ROLLE_BETREUER) as Rolle;
  return Promise.resolve({ angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'konto-1' } satisfies Zugang);
};

const EINTRAEGE = [
  {
    id: 'e1', quelle: 'github', repo: 'beispiel/projekt', nummer: 42, titel: 'Absturz beim Start', url: 'https://github.com/beispiel/projekt/issues/42',
    einordnung: 'Fehlermeldung', status: 'offen', ereignis_am: '2026-10-29T10:00:00Z',
    original_text: 'App crashes <script>alert(1)</script> on <b>start</b>', uebersetzung_de: 'App stürzt beim Start ab', entwurf: 'Thanks, we will look.', entwurf_de: 'Danke, wir schauen nach.',
  },
  {
    id: 'e2', quelle: 'github', repo: 'beispiel/projekt', nummer: 7, url: 'javascript:alert(1)', einordnung: 'Frage', status: 'offen', ereignis_am: '2026-10-27T12:00:00Z',
    original_text: 'Wie installiere ich das?', uebersetzung_de: null, entwurf: 'See README.', entwurf_de: 'Siehe README.',
  },
  { id: 'e3', quelle: 'github', repo: 'beispiel/anderes', nummer: 3, einordnung: 'Lob', status: 'info', ereignis_am: '2026-10-29T11:59:00Z', original_text: 'Great!', uebersetzung_de: 'Toll!', entwurf: null, entwurf_de: null },
];

interface Aufruf { readonly url: string; readonly authorization: string | undefined }

describe('Freigabe-Inbox (COPI-139)', () => {
  let app: FastifyInstance | undefined;
  const aufrufe: Aufruf[] = [];

  async function starten(holen: typeof fetch, repowache: RepowacheKonfiguration | null = KONFIGURATION): Promise<FastifyInstance> {
    const instanz = buildApp({ nodeEnv: 'test' }, { sitzungLesen, zugangLesen, jetzt: () => JETZT, holen, ...(repowache ? { repowache } : {}) });
    app = instanz;
    await instanz.ready();
    return instanz;
  }

  const antwortMit = (rumpf: unknown, status = 200): typeof fetch => (eingabe, optionen) => {
    const kopf = new Headers(optionen?.headers);
    aufrufe.push({ url: String(eingabe), authorization: kopf.get('authorization') ?? undefined });
    return Promise.resolve(new Response(JSON.stringify(rumpf), { status, headers: { 'content-type': 'application/json' } }));
  };

  const lesen = (instanz: FastifyInstance, url: string, kopf: Record<string, string> = {}) => instanz.inject({ method: 'GET', url, headers: kopf });

  afterEach(async () => {
    aufrufe.length = 0;
    await app?.close();
    app = undefined;
  });

  it('ruft den Webhook mit Bearer-Token und dem festen Filter ab', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    await lesen(instanz, '/freigaben');
    expect(aufrufe[0]).toEqual({
      url: 'https://n8n.example.test/webhook/repowache/eintraege?status=offen,info&limit=100',
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('zeigt in der Liste Repo, Nummer, Einordnung, Alter, Agent und Status', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    const antwort = await lesen(instanz, '/freigaben');
    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain('beispiel/projekt#42');
    expect(antwort.body).toContain('Fehlermeldung');
    expect(antwort.body).toContain('vor 2 Std.');
    expect(antwort.body).toContain('vor 2 Tagen');
    expect(antwort.body).toContain('Repo-Wache');
    expect(antwort.body).toContain('Info');
    expect(antwort.body).toContain('href="/freigaben/e1"');
  });

  it('zeigt schon in der Liste die Quelladresse als Text und nur bei http(s) den ausdrücklich zu öffnenden Link', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    const body = (await lesen(instanz, '/freigaben')).body;
    expect(body).toContain('<code>https://github.com/beispiel/projekt/issues/42</code>');
    expect(body).toContain('href="https://github.com/beispiel/projekt/issues/42" target="_blank" rel="noopener noreferrer nofollow"');
    expect(body).toContain('<code>javascript:alert(1)</code>');
    expect(body).not.toContain('href="javascript:');
  });

  it('nimmt auch eine nackte Liste als Antwort', async () => {
    const instanz = await starten(antwortMit(EINTRAEGE));
    expect((await lesen(instanz, '/freigaben')).body).toContain('beispiel/anderes#3');
  });

  it('zeigt den Zähler „offen" in der Navigation: nur Einträge mit Status offen', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    const antwort = await lesen(instanz, '/mehr');
    expect(antwort.body).toContain('Freigaben');
    expect(antwort.body).toMatch(/hauptnav-zahl[^>]*><span aria-hidden="true">2<\/span><span class="sr-only">, 2 offen</);
  });

  it('zeigt den Zähler „offen" auch auf der mobilen Seite „Mehr"', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    const body = (await lesen(instanz, '/mehr')).body;
    const liste = body.slice(body.indexOf('<ul class="liste">'));
    expect(liste).toMatch(/liste-text">Freigaben<\/span>\s*<span class="hauptnav-zahl"><span aria-hidden="true">2<\/span><span class="sr-only">, 2 offen</);
  });

  it('zeigt in der Detailansicht Deutsch zuerst und das Original darunter, daneben den Entwurf', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    const body = (await lesen(instanz, '/freigaben/e1')).body;
    expect(body.indexOf('App stürzt beim Start ab')).toBeGreaterThan(-1);
    expect(body.indexOf('App stürzt beim Start ab')).toBeLessThan(body.indexOf('App crashes'));
    expect(body).toContain('Thanks, we will look.');
    expect(body).toContain('Danke, wir schauen nach.');
  });

  it('zeigt bei fehlender Übersetzung den Originaltext und darunter noch einmal das Original', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    const body = (await lesen(instanz, '/freigaben/e2')).body;
    expect(body.split('Wie installiere ich das?')).toHaveLength(3);
  });

  it('escaped fremde Texte und verlinkt nur http(s)-Adressen', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    const body = (await lesen(instanz, '/freigaben/e1')).body;
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).toContain('&lt;b&gt;start&lt;/b&gt;');
    expect(body).toContain('href="https://github.com/beispiel/projekt/issues/42"');
    expect(body).toContain('<code>https://github.com/beispiel/projekt/issues/42</code>');
    const gefaehrlich = (await lesen(instanz, '/freigaben/e2')).body;
    expect(gefaehrlich).not.toContain('href="javascript:');
  });

  it('gibt den Token in keiner Antwort an den Browser preis', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    for (const url of ['/freigaben', '/freigaben/e1', '/mehr']) {
      const antwort = await lesen(instanz, url);
      expect(antwort.body).not.toContain(TOKEN);
      expect(JSON.stringify(antwort.headers)).not.toContain(TOKEN);
      expect(antwort.body).not.toContain('n8n.example.test');
    }
  });

  it.each([
    ['403', antwortMit({}, 403), 'abgelehnt'],
    ['Zeitüberschreitung', () => Promise.reject(new DOMException('zu langsam', 'TimeoutError')), 'nicht rechtzeitig'],
    ['nicht erreichbares n8n', () => Promise.reject(new TypeError('fetch failed')), 'nicht erreichbar'],
  ] as const)('zeigt bei %s einen Hinweistext statt eines Fehlers', async (_name, holen, text) => {
    const instanz = await starten(holen);
    for (const url of ['/freigaben', '/freigaben/e1']) {
      const antwort = await lesen(instanz, url);
      expect(antwort.statusCode).toBe(200);
      expect(antwort.body).toContain(text);
    }
    expect((await lesen(instanz, '/mehr')).statusCode).toBe(200);
  });

  it('antwortet auf eine unbekannte Nummer mit der neutralen 404', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    expect((await lesen(instanz, '/freigaben/gibt-es-nicht')).statusCode).toBe(404);
  });

  it('ist ohne Recht technik_sehen nicht zu sehen: 404 und kein Abruf, kein Navigationseintrag', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }));
    const kopf = { 'x-rolle': 'betriebs_admin' };
    expect((await lesen(instanz, '/freigaben', kopf)).statusCode).toBe(404);
    expect((await lesen(instanz, '/freigaben/e1', kopf)).statusCode).toBe(404);
    expect((await lesen(instanz, '/mehr', kopf)).body).not.toContain('Freigaben');
    expect(aufrufe).toHaveLength(0);
  });

  it('blendet das Modul ohne Konfiguration aus: keine Route, kein Eintrag', async () => {
    const instanz = await starten(antwortMit({ eintraege: EINTRAEGE }), null);
    expect((await lesen(instanz, '/freigaben')).statusCode).toBe(404);
    expect((await lesen(instanz, '/mehr')).body).not.toContain('Freigaben');
    expect(aufrufe).toHaveLength(0);
  });

  it('wirkt ohne Anmeldung nicht', async () => {
    app = buildApp({ nodeEnv: 'test' }, { zugangLesen: () => Promise.resolve(OHNE_ZUGANG), repowache: KONFIGURATION, holen: antwortMit({ eintraege: [] }) });
    await app.ready();
    expect((await lesen(app, '/freigaben')).statusCode).not.toBe(200);
  });

  describe('Kennzahlen (COPI-218)', () => {
    const KENNZAHLEN = [
      { repo: 'beispiel/projekt', beitraege: 12, beantwortet: 9, unbeantwortet: 3, median_stunden: 4.25, max_stunden: 30, stars: 1234, forks: 56, stand: '2026-10-29T06:00:00Z' },
      { repo: 'beispiel/anderes', beitraege: 2, beantwortet: 2, unbeantwortet: 0, median_stunden: 0.04, max_stunden: 1.5, stars: 7, forks: 1, stand: '2026-10-29T06:00:00Z' },
    ];

    it('zeigt je Repo Beiträge, Antworten, Median und Maximum (Komma, eine Stelle), Stars und Forks', async () => {
      const instanz = await starten(antwortMit({ eintraege: EINTRAEGE, kennzahlen: KENNZAHLEN }));
      const koerper = (await lesen(instanz, '/freigaben')).body;
      const zeile = (repo: string): string => koerper.slice(koerper.indexOf(`>${repo}</th>`)).split('</tr>')[0] ?? '';
      const zellen = (repo: string): string[] => [...zeile(repo).matchAll(/<td>([^<]*)<\/td>/g)].map((treffer) => treffer[1] ?? '');
      expect(zellen('beispiel/projekt').slice(0, 7)).toEqual(['12', '9', '3', '4,3', '30,0', '1.234', '56']);
      expect(zellen('beispiel/anderes').slice(0, 7)).toEqual(['2', '2', '0', '0,0', '1,5', '7', '1']);
      expect(koerper).not.toContain('noch keine Daten');
    });

    it.each([
      ['ohne Feld', { eintraege: EINTRAEGE }],
      ['mit leerer Liste', { eintraege: EINTRAEGE, kennzahlen: [] }],
      ['mit leerem Objekt', { eintraege: EINTRAEGE, kennzahlen: {} }],
    ])('zeigt %s „noch keine Daten“', async (_name, rumpf) => {
      const instanz = await starten(antwortMit(rumpf));
      expect((await lesen(instanz, '/freigaben')).body).toContain('noch keine Daten');
    });

    it('escaped Repo-Namen', async () => {
      const instanz = await starten(antwortMit({ eintraege: [], kennzahlen: [{ repo: '<b>x</b>', beitraege: 1 }] }));
      const koerper = (await lesen(instanz, '/freigaben')).body;
      expect(koerper).not.toContain('<b>x</b>');
      expect(koerper).toContain('&lt;b&gt;x&lt;/b&gt;');
    });
  });
});

describe('repowacheAusUmgebung', () => {
  it('liefert nur bei Adresse und Token eine Konfiguration', () => {
    expect(repowacheAusUmgebung({ repowacheUrl: 'https://n8n.example.test', repowacheToken: 'x' })).toEqual({ url: 'https://n8n.example.test', token: 'x' });
    expect(repowacheAusUmgebung({ repowacheUrl: 'https://n8n.example.test' })).toBeUndefined();
    expect(repowacheAusUmgebung({ repowacheToken: 'x' })).toBeUndefined();
    expect(repowacheAusUmgebung({ repowacheUrl: '  ', repowacheToken: 'x' })).toBeUndefined();
    expect(repowacheAusUmgebung({ repowacheUrl: 'kein-url', repowacheToken: 'x' })).toBeUndefined();
    expect(repowacheAusUmgebung({ repowacheUrl: 'ftp://n8n.example.test', repowacheToken: 'x' })).toBeUndefined();
  });

});
