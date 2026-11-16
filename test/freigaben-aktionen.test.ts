/**
 * Die Freigabe-Inbox, Teil 2 (COPI-217): Senden, Ändern und senden, Verwerfen — mit gemocktem Webhook der Repo-Wache.
 * Läuft ohne Datenbank.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLLE_BETREUER, type Rolle, type Zugang, type ZugangLesen } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';

const TOKEN = 'geheimer-repowache-token-0815';
const HOST = 'cockpit.example.test';
const EIGENE = { host: HOST, origin: `https://${HOST}` };
const JETZT = new Date('2026-10-29T12:00:00Z');

const sitzungLesen: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const zugangLesen: ZugangLesen = (request) =>
  Promise.resolve({ angemeldet: true, rolle: (request.headers['x-rolle'] ?? ROLLE_BETREUER) as Rolle, zweiterFaktorAktiv: true, benutzerId: 'konto-1' } satisfies Zugang);

const eintrag = (id: string, status = 'offen') => ({
  id, quelle: 'github', repo: 'beispiel/projekt', nummer: 42, titel: 'Absturz', status, ereignis_am: '2026-10-29T10:00:00Z',
  original_text: 'App crashes', entwurf: 'Thanks <b>we</b> look "now"', entwurf_de: 'Danke',
});

interface Aufruf { readonly url: string; readonly methode: string; readonly authorization: string | undefined; readonly body: unknown }

describe('Freigabe-Inbox, Aktionen (COPI-217)', () => {
  let app: FastifyInstance | undefined;
  const aufrufe: Aufruf[] = [];
  let eintraege = [eintrag('e1'), eintrag('e2')];

  /** `aktion` ist die Antwort auf den POST; Abrufe der Liste liefern `eintraege`. */
  async function starten(aktion: () => Promise<Response> | Response): Promise<FastifyInstance> {
    const holen: typeof fetch = async (eingabe, optionen) => {
      const methode = optionen?.method ?? 'GET';
      aufrufe.push({
        url: String(eingabe), methode, authorization: new Headers(optionen?.headers).get('authorization') ?? undefined,
        body: typeof optionen?.body === 'string' ? JSON.parse(optionen.body) : undefined,
      });
      return methode === 'POST' ? aktion() : new Response(JSON.stringify({ eintraege }), { status: 200 });
    };
    const instanz = buildApp({ nodeEnv: 'test' }, { sitzungLesen, zugangLesen, jetzt: () => JETZT, holen, repowache: { url: 'https://n8n.example.test', token: TOKEN } });
    app = instanz;
    await instanz.ready();
    return instanz;
  }

  const json = (rumpf: unknown, status = 200): Response => new Response(JSON.stringify(rumpf), { status });
  const posts = (): Aufruf[] => aufrufe.filter((aufruf) => aufruf.methode === 'POST');
  /** Holt das Formular der Detailseite (mit seinem CSRF-Token) und schickt es ab; `csrf: false` lässt das Token weg. */
  async function absenden(instanz: FastifyInstance, aktion: string, body: Record<string, string> = {}, kopf: Record<string, string> = EIGENE, csrf = true) {
    const seite = (await instanz.inject({ method: 'GET', url: '/freigaben/e1' })).body;
    const formular = seite.split('<form').find((teil) => teil.includes(`action="/freigaben/e1/${aktion}"`)) ?? '';
    const felder = csrf ? { bis: /name="bis" value="([^"]*)"/.exec(formular)?.[1] ?? '', token: /name="token" value="([^"]*)"/.exec(formular)?.[1] ?? '' } : {};
    return instanz.inject({ method: 'POST', url: `/freigaben/e1/${aktion}`, headers: { ...kopf, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ ...felder, ...body }).toString() });
  }

  afterEach(async () => {
    aufrufe.length = 0;
    eintraege = [eintrag('e1'), eintrag('e2')];
    await app?.close();
    app = undefined;
  });

  it('Senden schickt aktion senden mit der id, Bearer-Token und zeigt Status und Link', async () => {
    const instanz = await starten(() => {
      eintraege = [eintrag('e2')];
      return json({ status: 'gesendet', antwort_url: 'https://github.com/beispiel/projekt/issues/42#issuecomment-1' });
    });
    const antwort = await absenden(instanz, 'senden');
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/freigaben');
    expect(posts()).toEqual([
      { url: 'https://n8n.example.test/webhook/repowache/aktion', methode: 'POST', authorization: `Bearer ${TOKEN}`, body: { id: 'e1', aktion: 'senden' } },
    ]);
    const liste = (await instanz.inject({ method: 'GET', url: '/freigaben' })).body;
    expect(liste).toContain('gesendet');
    expect(liste).toContain('href="https://github.com/beispiel/projekt/issues/42#issuecomment-1"');
    expect((await instanz.inject({ method: 'GET', url: '/freigaben' })).body).not.toContain('Neuer Status');
  });

  it('lässt den Zähler „offen" nach der Aktion stimmen', async () => {
    const instanz = await starten(() => {
      eintraege = [eintrag('e2')];
      return json({ status: 'verworfen' });
    });
    await instanz.inject({ method: 'GET', url: '/mehr' });
    await absenden(instanz, 'verwerfen');
    expect((await instanz.inject({ method: 'GET', url: '/mehr' })).body).toMatch(/, 1 offen</);
  });

  it('Ändern und senden schickt aktion aendern mit dem geänderten Text', async () => {
    const instanz = await starten(() => json({ status: 'gesendet' }));
    await absenden(instanz, 'aendern', { text: 'Danke, behoben in 1.2.' });
    expect(posts()[0]?.body).toEqual({ id: 'e1', aktion: 'aendern', text: 'Danke, behoben in 1.2.' });
  });

  it('Ändern ohne Text ruft den Webhook nicht auf', async () => {
    const instanz = await starten(() => json({ status: 'gesendet' }));
    const antwort = await absenden(instanz, 'aendern', { text: '  ' });
    expect(posts()).toHaveLength(0);
    expect(antwort.body).toContain('Bitte einen Text');
  });

  it('Verwerfen schickt aktion verwerfen ohne Text', async () => {
    const instanz = await starten(() => json({ status: 'verworfen' }));
    await absenden(instanz, 'verwerfen', { text: 'ignoriert' });
    expect(posts()[0]?.body).toEqual({ id: 'e1', aktion: 'verwerfen' });
  });

  it('zeigt bei 409 die Fehlermeldung aus der Antwort, escaped, ohne Absturz', async () => {
    const instanz = await starten(() => json({ fehler: 'Schon <i>beantwortet</i>' }, 409));
    const antwort = await absenden(instanz, 'senden');
    expect(antwort.statusCode).toBe(200);
    expect(antwort.body).toContain('Schon &lt;i&gt;beantwortet&lt;/i&gt;');
  });

  it.each([
    ['Status sendet', () => json({ status: 'sendet' })],
    ['Zeitüberschreitung', () => Promise.reject(new DOMException('zu langsam', 'TimeoutError'))],
  ] as const)('sperrt bei %s die Knöpfe und zeigt den Hinweis', async (_name, aktion) => {
    const instanz = await starten(aktion);
    const antwort = await absenden(instanz, 'senden');
    expect(antwort.body).toContain('Ergebnis unklar, nicht erneut senden');
    expect(antwort.body).toMatch(/<button type="submit" class="knopf" disabled>Senden/);
    expect(antwort.body).not.toMatch(/<button type="submit" class="knopf">/);
  });

  it('zeigt Knöpfe und ein escaptes, vorbefülltes Textfeld in der Detailansicht', async () => {
    const instanz = await starten(() => json({ status: 'gesendet' }));
    const body = (await instanz.inject({ method: 'GET', url: '/freigaben/e1' })).body;
    expect(body).toContain('Ändern und senden');
    expect(body).toContain('action="/freigaben/e1/verwerfen"');
    expect(body).toContain('Thanks &lt;b&gt;we&lt;/b&gt; look &quot;now&quot;');
  });

  it.each([
    ['ohne Herkunft', { 'x-rolle': ROLLE_BETREUER }, 403],
    ['mit fremder Herkunft', { host: HOST, origin: 'https://boese.example.test' }, 403],
    ['ohne Admin-Rolle', { ...EIGENE, 'x-rolle': 'betriebs_admin' }, 404],
  ] as const)('löst %s keine Aktion aus', async (_name, kopf, status) => {
    const instanz = await starten(() => json({ status: 'gesendet' }));
    for (const aktion of ['senden', 'aendern', 'verwerfen']) {
      expect((await absenden(instanz, aktion, { text: 'x' }, kopf)).statusCode).toBe(status);
    }
    expect(posts()).toHaveLength(0);
  });

  it('löst ohne oder mit falschem CSRF-Token keine Aktion aus', async () => {
    const instanz = await starten(() => json({ status: 'gesendet' }));
    for (const aktion of ['senden', 'aendern', 'verwerfen']) {
      expect((await absenden(instanz, aktion, { text: 'x' }, EIGENE, false)).statusCode).toBe(403);
      expect((await absenden(instanz, aktion, { text: 'x', token: 'x'.repeat(43) })).statusCode).toBe(403);
    }
    expect(posts()).toHaveLength(0);
  });

  it('sperrt nach unklarem Ergebnis auch beim erneuten Öffnen und Absenden', async () => {
    const instanz = await starten(() => json({ status: 'sendet' }));
    await absenden(instanz, 'senden');
    const erneut = (await instanz.inject({ method: 'GET', url: '/freigaben/e1' })).body;
    expect(erneut).toContain('Ergebnis unklar, nicht erneut senden');
    expect(erneut).not.toMatch(/<button type="submit" class="knopf">/);
    expect((await absenden(instanz, 'verwerfen')).statusCode).toBe(409);
    expect(posts()).toHaveLength(1);
  });

  /** Formularfelder der Detailseite von e1, solange der Eintrag noch gelistet ist. */
  async function felder(instanz: FastifyInstance, aktion: string): Promise<Record<string, string>> {
    const seite = (await instanz.inject({ method: 'GET', url: '/freigaben/e1' })).body;
    const formular = seite.split('<form').find((teil) => teil.includes(`action="/freigaben/e1/${aktion}"`)) ?? '';
    return { bis: /name="bis" value="([^"]*)"/.exec(formular)?.[1] ?? '', token: /name="token" value="([^"]*)"/.exec(formular)?.[1] ?? '' };
  }
  const abschicken = (instanz: FastifyInstance, aktion: string, felder_: Record<string, string>) =>
    instanz.inject({ method: 'POST', url: `/freigaben/e1/${aktion}`, headers: { ...EIGENE, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(felder_).toString() });

  it('hält die Sperre nach unklarem Ergebnis, auch wenn der Eintrag aus der Liste fällt', async () => {
    const instanz = await starten(() => {
      eintraege = [eintrag('e2')];
      return json({ status: 'sendet' });
    });
    const verwerfen = await felder(instanz, 'verwerfen');
    const erste = await abschicken(instanz, 'senden', await felder(instanz, 'senden'));
    expect(erste.statusCode).toBe(303);
    const liste = (await instanz.inject({ method: 'GET', url: '/freigaben' })).body;
    expect(liste).toContain('Ergebnis unklar, nicht erneut senden');
    const zweite = await abschicken(instanz, 'verwerfen', verwerfen);
    expect(zweite.statusCode).toBe(303);
    expect(posts()).toHaveLength(1);
    expect((await instanz.inject({ method: 'GET', url: '/freigaben' })).body).toContain('Ergebnis unklar, nicht erneut senden');
  });

  it('zeigt die Fehlermeldung bei 409 auch, wenn der Eintrag danach nicht mehr gelistet ist', async () => {
    const instanz = await starten(() => {
      eintraege = [eintrag('e2')];
      return json({ fehler: 'Schon <i>beantwortet</i>' }, 409);
    });
    const antwort = await abschicken(instanz, 'senden', await felder(instanz, 'senden'));
    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/freigaben');
    expect((await instanz.inject({ method: 'GET', url: '/freigaben' })).body).toContain('Schon &lt;i&gt;beantwortet&lt;/i&gt;');
  });

  it('gibt den Token in keiner Antwort an den Browser preis', async () => {
    const instanz = await starten(() => json({ status: 'gesendet', antwort_url: 'https://github.com/x' }));
    const antworten = [await absenden(instanz, 'senden'), await instanz.inject({ method: 'GET', url: '/freigaben/e1' })];
    for (const antwort of antworten) {
      expect(antwort.body).not.toContain(TOKEN);
      expect(antwort.body).not.toContain('n8n.example.test');
      expect(JSON.stringify(antwort.headers)).not.toContain(TOKEN);
    }
  });
});
