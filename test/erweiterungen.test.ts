/**
 * Der neutrale Erweiterungspunkt des Kerns (COPI-193): Navigation (Position 2 am Desktop, mobil unter „Mehr", Tab-Leiste
 * unverändert), Recht und neutrale 404, Tor (Umleitung), nur GET/HEAD, gesperrte Pfade. Läuft ohne Datenbank.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { OHNE_ZUGANG, ROLLE_BETREUER, type Rolle, type Zugang, type ZugangLesen } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';
import { type Erweiterung } from '../src/server/erweiterungen.js';
import { navigation, navigationFuerZugang } from '../src/server/navigation.js';

/** Der Test steuert Sitzung und Rolle über Kopfzeilen: `x-zustand` (anonym | ohneFaktor | mitFaktor), `x-rolle`. */
const sitzungLesen: SitzungLesen = (request) => {
  const zustand = request.headers['x-zustand'] ?? 'mitFaktor';
  return Promise.resolve({ sitzungVorhanden: zustand !== 'anonym', zweiterFaktorAktiv: zustand === 'mitFaktor' });
};

const zugangLesen: ZugangLesen = (request) => {
  if (request.headers['x-zustand'] === 'anonym') {
    return Promise.resolve(OHNE_ZUGANG);
  }
  const zugang: Zugang = {
    angemeldet: true,
    rolle: (request.headers['x-rolle'] ?? ROLLE_BETREUER) as Rolle,
    zweiterFaktorAktiv: request.headers['x-zustand'] !== 'ohneFaktor',
    benutzerId: 'konto-1',
  };
  return Promise.resolve(zugang);
};

const SEITE: Erweiterung['plugin'] = async (kapsel, kontext) => {
  kapsel.get('/ansicht', async (request, reply) => {
    const nav = navigationFuerZugang('erweiterung', await kontext.zugangLesen(request), 'test');
    const html = await kapsel.render('mehr.eta', { titel: 'Ansicht', nav });
    return reply.type('text/html; charset=utf-8').send(html);
  });
};

const TEST_ERWEITERUNG: Erweiterung = {
  kennung: 'test',
  recht: 'update_beantragen',
  navigation: { text: 'Testansicht', href: '/ansicht' },
  plugin: SEITE,
};

function plugin(registrieren: (kapsel: Parameters<Erweiterung['plugin']>[0]) => void): Erweiterung['plugin'] {
  return async (kapsel) => {
    registrieren(kapsel);
  };
}

describe('Erweiterungen', () => {
  let app: FastifyInstance | undefined;
  const routen: string[] = [];

  async function starten(erweiterungen?: readonly Erweiterung[]): Promise<FastifyInstance> {
    app = buildApp(
      { nodeEnv: 'test' },
      { sitzungLesen, zugangLesen, routenSammler: (route) => routen.push(`${String(route.method)} ${route.url}`), ...(erweiterungen ? { erweiterungen } : {}) },
    );
    await app.ready();
    return app;
  }

  afterEach(async () => {
    routen.length = 0;
    await app?.close();
    app = undefined;
  });

  const holen = (instanz: FastifyInstance, url: string, kopf: Record<string, string> = {}) => instanz.inject({ method: 'GET', url, headers: kopf });

  describe('Navigation', () => {
    it('setzt den Eintrag am Desktop an Position 2, direkt hinter „Übersicht" und vor den angehefteten Modulen', () => {
      const nav = navigation('uebersicht', {
        angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0,
        angeheftet: [{ kennung: 'kommunikation', menuename: 'Kommunikation' }],
        erweiterungen: [{ kennung: 'test', text: 'Testansicht', href: '/ansicht' }],
      });

      expect(nav.eintraege.map((eintrag) => eintrag.text)).toEqual(['Übersicht', 'Testansicht', 'Nachrichten', 'Kommunikation', 'Module', 'Meldungen', 'Mehr']);
      expect(nav.eintraege[1]).toEqual({ text: 'Testansicht', symbol: 'agenten', href: '/ansicht', aktuell: false, folgt: false, ungelesen: undefined, nurMobil: false, nurDesktop: true, punkt: false });
    });

    it('zeigt ihn mobil unter „Mehr" und lässt die Tab-Leiste bei ihren fünf Plätzen', () => {
      const rechte = { angemeldet: true, einladen: true, benutzerSehen: true, chat: true, chatUngelesen: 0 } as const;
      const ohne = navigation('uebersicht', rechte);
      const mit = navigation('uebersicht', { ...rechte, erweiterungen: [{ kennung: 'test', text: 'Testansicht', href: '/ansicht' }] });
      const mobil = (nav: typeof ohne) => nav.eintraege.filter((eintrag) => !eintrag.nurDesktop).map((eintrag) => eintrag.text);

      expect(mobil(mit)).toEqual(mobil(ohne));
      expect(mobil(mit)).toHaveLength(5);
      expect(mit.mehr[0]).toEqual({ text: 'Testansicht', symbol: 'agenten', href: '/ansicht', aktuell: false, punkt: false, nurMobil: true });
      expect(mit.mehr.slice(1)).toEqual(ohne.mehr);
    });

    it('markiert den Eintrag auf der Seite der Erweiterung und lässt den Dark-Mode-Schalter dorthin zurückkehren', () => {
      const nav = navigation('erweiterung', { angemeldet: true, einladen: false, benutzerSehen: false, chat: true, chatUngelesen: 0, erweiterungen: [{ kennung: 'test', text: 'Testansicht', href: '/ansicht' }] }, 'test');

      expect(nav.eintraege.filter((eintrag) => eintrag.aktuell && eintrag.text === 'Testansicht')).toHaveLength(1);
      expect(nav.pfad).toBe('/ansicht');
    });

    it.each([
      [ROLLE_BETREUER, ['Übersicht', 'Nachrichten', 'Module', 'Meldungen', 'Mehr'], ['Benutzer', 'Agenten', 'Zeitplan', 'Einstellungen', 'Einladen']],
      ['betriebs_admin', ['Übersicht', 'Nachrichten', 'Module', 'Meldungen', 'Mehr'], ['Benutzer', 'Agenten', 'Zeitplan', 'Einstellungen', 'Einladen']],
      ['betrieb_mitarbeiter', ['Übersicht', 'Nachrichten', 'Module', 'Meldungen', 'Mehr'], ['Agenten', 'Zeitplan', 'Einstellungen']],
    ] as const)('liefert ohne Erweiterung für %s genau die Einträge von heute', (rolle, haupt, mehr) => {
      const zugang: Zugang = { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'konto-1' };
      const nav = navigationFuerZugang('uebersicht', zugang);

      expect(nav.eintraege.map((eintrag) => eintrag.text)).toEqual(haupt);
      expect(nav.mehr.map((eintrag) => eintrag.text)).toEqual(mehr);
      expect(navigationFuerZugang('uebersicht', { ...zugang, erweiterungen: [] })).toEqual(nav);
      expect(nav.eintraege.filter((eintrag) => eintrag.nurDesktop || eintrag.nurMobil).map((eintrag) => eintrag.text)).toEqual(['Mehr']);
    });

    it('rendert ohne Erweiterung und mit leerer Liste dieselbe Seite', async () => {
      const ohne = await starten();
      const seiteOhne = (await holen(ohne, '/mehr')).body;
      await app?.close();
      const leer = await starten([]);

      expect((await holen(leer, '/mehr')).body).toBe(seiteOhne);
      expect(seiteOhne).not.toContain('Testansicht');
    });

    it('zeigt den Eintrag in der gerenderten Seite nur dem, der das Recht hat', async () => {
      const instanz = await starten([TEST_ERWEITERUNG]);

      const betreuer = (await holen(instanz, '/mehr', { 'x-rolle': ROLLE_BETREUER })).body;
      expect(betreuer).toMatch(/<li class="hauptnav-nur-desktop">\s*<a href="\/ansicht" class="hauptnav-eintrag">/);
      expect(betreuer).toContain('<a href="/ansicht" class="liste-zeile">');
      const admin = (await holen(instanz, '/mehr', { 'x-rolle': 'betriebs_admin' })).body;
      expect(admin).not.toContain('/ansicht');
    });
  });

  describe('Routen und Recht', () => {
    it('legt ohne Erweiterung keine zusätzliche Route an', async () => {
      const ohne = await starten();
      const grundlage = [...routen];
      await ohne.close();
      routen.length = 0;
      await starten([]);

      expect(routen).toEqual(grundlage);
      expect(grundlage.join('\n')).not.toContain('/ansicht');
      expect((await holen(app as FastifyInstance, '/ansicht')).statusCode).toBe(404);
    });

    it('liefert die Seite dem, der das Recht hat, mit markiertem Eintrag', async () => {
      const instanz = await starten([TEST_ERWEITERUNG]);

      const antwort = await holen(instanz, '/ansicht');
      expect(antwort.statusCode).toBe(200);
      expect(antwort.body).toMatch(/<a href="\/ansicht" class="hauptnav-eintrag" aria-current="page">/);
      expect(routen).toContain('GET /ansicht');
    });

    it('antwortet ohne Recht mit der neutralen 404, wortgleich zu einer unbekannten Seite des Tors', async () => {
      const instanz = await starten([TEST_ERWEITERUNG]);

      const ohneRecht = await holen(instanz, '/ansicht', { 'x-rolle': 'betriebs_admin' });
      const neutral = await holen(instanz, '/api/auth/sign-up');
      expect(ohneRecht.statusCode).toBe(404);
      expect(ohneRecht.body).toBe(neutral.body);
    });

    it('lässt anonym zur Anmeldung und ohne zweiten Faktor zur Einrichtung umleiten wie jede geschützte Route', async () => {
      const instanz = await starten([TEST_ERWEITERUNG]);

      const anonym = await holen(instanz, '/ansicht', { 'x-zustand': 'anonym' });
      expect([anonym.statusCode, anonym.headers.location]).toEqual([303, '/anmelden']);
      const ohneFaktor = await holen(instanz, '/ansicht', { 'x-zustand': 'ohneFaktor' });
      expect([ohneFaktor.statusCode, ohneFaktor.headers.location]).toEqual([303, '/zwei-faktor']);
    });
  });

  describe('Wächter beim Start', () => {
    const mit = (...routenDef: readonly (readonly [string, string])[]): Erweiterung => ({
      kennung: 'schlecht',
      recht: 'update_beantragen',
      plugin: plugin((kapsel) => {
        for (const [methode, url] of routenDef) {
          kapsel.route({ method: methode as 'GET', url, handler: () => 'x' });
        }
      }),
    });

    async function startFehler(...liste: Erweiterung[]): Promise<string> {
      app = buildApp({ nodeEnv: 'test' }, { sitzungLesen, zugangLesen, erweiterungen: liste });
      return app.ready().then(
        () => 'gestartet',
        (fehler: unknown) => (fehler instanceof Error ? fehler.message : 'unbekannt'),
      );
    }

    it('erlaubt GET und HEAD', async () => {
      expect(await startFehler(mit(['GET', '/gut'], ['HEAD', '/gut-kopf']))).toBe('gestartet');
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('lässt den Start an %s scheitern', async (methode) => {
      expect(await startFehler(mit([methode, '/schlecht']))).toMatch(/nur GET und HEAD/);
    });

    it('lässt den Start an einer Route mit GET und POST scheitern', async () => {
      const gemischt: Erweiterung = {
        kennung: 'gemischt',
        recht: 'update_beantragen',
        plugin: plugin((kapsel) => {
          kapsel.route({ method: ['GET', 'POST'], url: '/gemischt', handler: () => 'x' });
        }),
      };

      expect(await startFehler(gemischt)).toMatch(/nur GET und HEAD/);
    });

    it.each([
      '/pipeline',
      '/pipeline/lauf',
      '/PIPELINE/lauf',
      '/Pipeline',
      '/intern',
      '/intern/x',
      '/INTERN',
      '/INTERN/x',
      '/%69ntern',
      '/%69ntern/x',
      '/intern%2Fx',
      '/%70ipeline/x',
      '/%49ntern/x',
      '/%50ipeline/x',
    ])('lässt den Start an %s scheitern', async (url) => {
      expect(await startFehler(mit(['GET', url]))).toMatch(/maschinellen Schnittstellen/);
    });

    it.each(['/*', '/ansicht/*', '/:bereich/x', '//intern', 'ansicht'])('lässt den Start an %s scheitern', async (url) => {
      expect(await startFehler(mit(['GET', url]))).toMatch(/Erweiterung „schlecht"/);
    });

    it('lässt den Start an einem Eintrag scheitern, dessen Ziel gesperrt ist', async () => {
      const erweiterung: Erweiterung = { ...TEST_ERWEITERUNG, navigation: { text: 'Falsch', href: '/INTERN/x' } };

      expect(await startFehler(erweiterung)).toMatch(/Ziel des Eintrags/);
    });

    it('lässt den Start an einer doppelten Kennung scheitern', async () => {
      expect(await startFehler(TEST_ERWEITERUNG, TEST_ERWEITERUNG)).toMatch(/doppelt/);
    });

    it('wirkt nur in der Kapsel: Routen des Kerns bleiben ohne Recht erreichbar', async () => {
      const instanz = await starten([TEST_ERWEITERUNG]);

      expect((await holen(instanz, '/gesund')).statusCode).toBe(200);
      expect((await holen(instanz, '/mehr', { 'x-rolle': 'betrieb_mitarbeiter' })).statusCode).toBe(200);
    });
  });
});
