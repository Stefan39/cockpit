/**
 * „Jede Route ohne zweiten Faktor zu" über **alle** registrierten Routen (COPI-29).
 * Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist (echte Sitzungen und der echte zweite Faktor
 * aus der Datenbank; das Tor liest beides aus ihr).
 *
 * ACHTUNG: Der Test räumt `cockpit."user"` und `cockpit.einladung` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 *
 * Bisher war die Aussage des Tors („deny by default") für ausgewählte Pfade geprüft; eine später
 * ergänzte Route hätte kein Test erfasst. Hier sammelt Fastifys `onRoute` **jede** Route ein, die
 * die fertige Anwendung kennt, und der Test verlangt zweierlei:
 *
 *   1. Jede Route steht in `routen-kategorien.ts`, und jede dort genannte Route gibt es. Eine neue
 *      Route ohne Kategorie lässt den Test scheitern — die Person, die sie ergänzt, muss
 *      entscheiden, ob sie für Anonyme, für Konten ohne Faktor oder nur mit Faktor erreichbar ist.
 *   2. Jede Route antwortet in jedem der drei Zustände (anonym, Sitzung ohne Faktor, Sitzung mit
 *      Faktor) so, wie die Tabelle es sagt. Gemessen wird mit echten Anfragen: ein vorgeschalteter
 *      Haken beantwortet die Anfrage mit einer Marke, **wenn sie den Handler erreicht** — und
 *      verhindert, dass der Handler tatsächlich läuft. Erreicht ein Zustand den Handler nicht, kam die
 *      Antwort vom Tor.
 *
 * Die Erwartung ist unabhängig geschrieben (Literale, nicht `torEntscheidung`); eine Route, die
 * das Tor versehentlich öffnet, fällt so auf, auch wenn Weiche und Erwartung dasselbe falsch machten.
 *
 * Nicht Teil dieses Tests, aber gemessen: eine Route, die **vor** dem Tor-Haken oder in einem Plugin
 * registriert wird, liegt trotzdem dahinter (Fastify 5). Die Reihenfolge in `buildApp` ist also keine
 * Lücke; `fastify-haken.test.ts` hält das fest, damit ein Update es nicht unbemerkt ändert.
 */
import type { FastifyInstance, RouteOptions } from 'fastify';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { torEntscheidung, type TorEntscheidung } from '../src/auth/zwei-faktor-tor.js';
import { mailversandBauen } from '../src/mail/versand.js';
import { buildApp } from '../src/server/app.js';
import { FORMULAR_KOPF, kontenLoeschen, kontoEinrichten } from './hilfen.js';
import {
  AUTH_PFADE,
  beispielPfad,
  KATEGORIEN,
  ROUTEN,
  UNBEKANNTE_PFADE,
  ZUSTAENDE,
  type Erwartung,
  type KategorieName,
  type Zustand,
} from './routen-kategorien.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const PASSWORT = 'ein-ausreichend-langes-passwort';
const MARKE = 'x-route-erreicht';
/** Die neutrale Seite des Tors und der Routen — ihr Text, nicht ihr Status, unterscheidet sie von Fastifys 404. */
const NEUTRAL_TEXT = 'Diese Seite gibt es nicht.';

interface GesammelteRoute {
  readonly methode: string;
  readonly muster: string;
}

interface Fall {
  readonly methode: 'GET' | 'HEAD' | 'POST';
  readonly pfad: string;
  readonly kategorie: KategorieName;
  /** Wie der Fall im Bericht heißt. */
  readonly name: string;
}

describe.skipIf(!datenbankUrl)('Routen und Tor (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  /** Die Anwendung mit dem Sammler: ihre Handler sind durch die Marke ersetzt. */
  let app: FastifyInstance;
  /** Dieselbe Anwendung ohne Sammler, nur um die Konten der beiden Zustände richtig anzulegen. */
  let einrichtung: FastifyInstance;
  const gesammelt: GesammelteRoute[] = [];
  const cookies: Record<Zustand, string> = { anonym: '', ohneFaktor: '', mitFaktor: '' };

  /** Der Haken, der jede Route beobachtet und ihren Handler durch eine Marke ersetzt. */
  function routenSammler(route: RouteOptions): void {
    for (const methode of [route.method].flat()) {
      gesammelt.push({ methode, muster: route.url });
    }
    // Vorn, vor allen Haken der Route selbst: wer hier ankommt, hat das Tor passiert.
    route.preHandler = [
      async (_anfrage, antwort) => antwort.header(MARKE, 'ja').code(200).send('Handler erreicht'),
    ];
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: BASIS_URL,
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    // Mit Mailversand, sonst fehlen die Einladungsroutes und der Test sähe sie nicht.
    const versand = mailversandBauen(nodemailer.createTransport({ jsonTransport: true }), 'cockpit@example.org');
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, versand, basisUrl: BASIS_URL, routenSammler });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, versand, basisUrl: BASIS_URL });
    await app.ready();
    const ohneFaktor = await kontoEinrichten(einrichtung, auth, {
      email: 'ohne-faktor@example.org',
      passwort: PASSWORT,
      name: 'Ohne Faktor',
      mitZweitemFaktor: false,
    });
    const mitFaktor = await kontoEinrichten(einrichtung, auth, {
      email: 'mit-faktor@example.org',
      passwort: PASSWORT,
      name: 'Mit Faktor',
      mitZweitemFaktor: true,
    });
    cookies.ohneFaktor = ohneFaktor.cookie;
    cookies.mitFaktor = mitFaktor.cookie;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await kontenLoeschen(pool);
    await pool.end();
  });

  /** Was auf die Anfrage geantwortet wurde, in den Begriffen der Tabelle. */
  function einordnen(
    antwort: { statusCode: number; headers: Record<string, unknown>; body: string },
  ): Erwartung | { readonly art: 'unerwartet'; readonly status: number } {
    if (antwort.headers[MARKE] === 'ja') {
      return { art: 'erreichbar' };
    }
    if (antwort.statusCode === 303) {
      return { art: 'umleiten', ziel: String(antwort.headers.location) };
    }
    // Agenten-API (COPI-35): 401 mit `WWW-Authenticate: Bearer` — die Antwort der Route, nicht die des Tors.
    if (antwort.statusCode === 401 && String(antwort.headers['www-authenticate']).startsWith('Bearer')) {
      return { art: 'token401' };
    }
    // Pipeline-API (COPI-145): 401 mit `WWW-Authenticate: HMAC-SHA256` — ebenso die Antwort der Route.
    if (antwort.statusCode === 401 && String(antwort.headers['www-authenticate']).startsWith('HMAC-SHA256')) {
      return { art: 'signatur401' };
    }
    if (antwort.statusCode === 404) {
      // Die neutrale Seite ist HTML; Fastifys eigene 404 ist JSON. Der Inhaltstyp trägt auch bei HEAD.
      const html = String(antwort.headers['content-type']).startsWith('text/html');
      return html && (antwort.body === '' || antwort.body.includes(NEUTRAL_TEXT))
        ? { art: 'neutral404' }
        : { art: 'unbekannt404' };
    }
    return { art: 'unerwartet', status: antwort.statusCode };
  }

  /**
   * Jede Anfrage kommt von einer eigenen Client-IP. Unter `/intern` zählt jede Anfrage ohne Token als
   * Fehlversuch (Ratenbegrenzung der Agenten-API, COPI-35): teilten sich alle Fälle eine Adresse, würde die
   * Bremse ab dem 21. Fall mit 429 antworten. Dieser Test prüft das Tor, nicht die Bremse (die hat ihre
   * eigenen Tests in `intern-zugang-datenbank.test.ts`).
   */
  let naechsteIp = 0;
  function eigeneIp(): string {
    naechsteIp += 1;
    return `10.${String((naechsteIp >> 16) & 255)}.${String((naechsteIp >> 8) & 255)}.${String(naechsteIp & 255)}`;
  }

  async function anfragen(fall: Fall, zustand: Zustand) {
    return app.inject({
      method: fall.methode,
      url: fall.pfad,
      headers: {
        'x-forwarded-for': eigeneIp(),
        ...(fall.methode === 'POST' ? FORMULAR_KOPF : {}),
        ...(cookies[zustand] === '' ? {} : { cookie: cookies[zustand] }),
      },
      ...(fall.methode === 'POST' ? { payload: '' } : {}),
    });
  }

  /** Alle Fälle: jede Route mit ihrer Methode (und HEAD zu jedem GET), die Joker-Pfade, die unbekannten. */
  function faelle(): Fall[] {
    const liste: Fall[] = [];
    for (const [schluessel, kategorie] of Object.entries(ROUTEN)) {
      const [methode = '', muster = ''] = schluessel.split(' ');
      if (muster.includes('*')) {
        continue;
      }
      const methoden = methode === 'GET' ? (['GET', 'HEAD'] as const) : ([methode] as ('POST')[]);
      for (const m of methoden) {
        liste.push({ methode: m, pfad: beispielPfad(muster), kategorie, name: `${m} ${muster}` });
      }
    }
    for (const eintrag of AUTH_PFADE) {
      for (const m of ['GET', 'POST'] as const) {
        liste.push({ methode: m, pfad: eintrag.pfad, kategorie: eintrag.kategorie, name: `${m} ${eintrag.pfad}` });
      }
    }
    for (const eintrag of UNBEKANNTE_PFADE) {
      liste.push({ methode: 'GET', pfad: eintrag.pfad, kategorie: eintrag.kategorie, name: `GET ${eintrag.pfad}` });
    }
    return liste;
  }

  describe('Jede Route ist eingeordnet', () => {
    const registriert = () =>
      [...new Set(gesammelt.filter((route) => route.methode !== 'HEAD').map((route) => `${route.methode} ${route.muster}`))].sort();

    it('kennt jede registrierte Route: eine neue Route muss sich in die Tabelle einordnen', () => {
      const unbekannt = registriert().filter((schluessel) => !(schluessel in ROUTEN));

      expect(unbekannt, 'Diese Routen fehlen in test/routen-kategorien.ts (ROUTEN): ordne sie ein').toEqual([]);
    });

    it('hat für jeden Eintrag der Tabelle eine Route: nichts steht dort, was es nicht mehr gibt', () => {
      const veraltet = Object.keys(ROUTEN).filter((schluessel) => !registriert().includes(schluessel));

      expect(veraltet, 'Diese Einträge in ROUTEN gibt es nicht mehr').toEqual([]);
    });

    it('registriert HEAD nur als Ergänzung eines GET: keine Route, die nur HEAD kennt', () => {
      const heads = gesammelt.filter((route) => route.methode === 'HEAD').map((route) => route.muster);
      const gets = new Set(gesammelt.filter((route) => route.methode === 'GET').map((route) => route.muster));

      expect(heads.length).toBeGreaterThan(5);
      expect(heads.filter((muster) => !gets.has(muster))).toEqual([]);
    });

    it('sieht wirklich viele Routen: der Sammler hängt vor allen Registrierungen', () => {
      // Ein Sammler, der zu spät hinge, sähe nichts, und alle Prüfungen oben wären leer.
      expect(registriert().length).toBe(Object.keys(ROUTEN).length);
      expect(registriert().length).toBeGreaterThan(20);
    });

    it.each(Object.entries(ROUTEN))('ordnet %s einer bekannten Kategorie zu (%s)', (_route, kategorie) => {
      expect(Object.keys(KATEGORIEN)).toContain(kategorie);
    });

    it('kennt die Ausnahme der Agenten-API genau: jede Route unter /intern ist maschinell, und nur sie (COPI-35)', () => {
      // Das Tor lässt `/intern` ohne Sitzung durch. Das darf nur für Routen gelten, die selbst ein Token prüfen —
      // und keine gewöhnliche Route darf sich in die Kategorie schleichen. Eine neue Route unter /intern
      // muss hier auffallen: wer sie ergänzt, entscheidet bewusst, dass sie maschinell erreichbar ist.
      const unterIntern = registriert().filter((schluessel) => (schluessel.split(' ')[1] ?? '').startsWith('/intern/'));
      const maschinell = Object.entries(ROUTEN)
        .filter(([, kategorie]) => kategorie === 'maschinell')
        .map(([schluessel]) => schluessel)
        .sort();

      expect(unterIntern).toEqual(maschinell);
      expect(unterIntern).toEqual([
        'GET /intern/chat/verbrauch',
        'GET /intern/eingriffe',
        'GET /intern/eingriffe/:id',
        'GET /intern/ping',
        'GET /intern/pipeline/freigaben',
        'GET /intern/pipeline/jobs',
        'GET /intern/pipeline/jobs/:id',
        'GET /intern/pipeline/verbrauch',
        'GET /intern/verbrauch/tickets',
        'GET /intern/vorgaenge/entscheidungen',
        'GET /intern/vorgaenge/freigabe',
        'GET /intern/vorgaenge/sperre',
        'GET /intern/zustand',
        'POST /intern/agenten/ereignis',
        'POST /intern/befund',
        'POST /intern/chat/agenten',
        'POST /intern/chat/antwort',
        'POST /intern/eingriffe/:id/status',
        'POST /intern/pipeline/aufraeumen',
        'POST /intern/pipeline/aufwand',
        'POST /intern/pipeline/jobs',
        'POST /intern/pipeline/jobs/:id/freigabe-erledigt',
        'POST /intern/pipeline/merkmal',
        'POST /intern/verbrauch',
        'POST /intern/wechselkurs',
        'PUT /intern/agenten',
      ]);
    });

    it('kennt die Ausnahme der Pipeline-API genau (COPI-145): jede Route unter /pipeline ist signiert, und nur sie', () => {
      const unterPipeline = registriert().filter((schluessel) => (schluessel.split(' ')[1] ?? '').startsWith('/pipeline/'));
      const signiert = Object.entries(ROUTEN)
        .filter(([, kategorie]) => kategorie === 'signiert')
        .map(([schluessel]) => schluessel)
        .sort();

      expect(unterPipeline).toEqual(signiert);
      expect(unterPipeline).toEqual(['POST /pipeline/claim', 'POST /pipeline/complete', 'POST /pipeline/event', 'POST /pipeline/heartbeat']);
    });
  });

  describe.each(ZUSTAENDE)('Zustand %s', (zustand) => {
    it('beantwortet jede Route, jeden Joker-Pfad und jeden unbekannten Pfad so, wie die Tabelle es sagt', async () => {
      const abweichungen: string[] = [];
      let geprueft = 0;

      for (const fall of faelle()) {
        const erwartet = KATEGORIEN[fall.kategorie].erwartung[zustand];
        const tatsaechlich = einordnen(await anfragen(fall, zustand));
        geprueft += 1;
        if (JSON.stringify(tatsaechlich) !== JSON.stringify(erwartet)) {
          abweichungen.push(`${fall.name}: erwartet ${JSON.stringify(erwartet)}, war ${JSON.stringify(tatsaechlich)}`);
        }
      }

      expect(geprueft).toBeGreaterThan(50);
      expect(abweichungen).toEqual([]);
    });
  });

  describe('Das Tor entscheidet vor jedem Handler', () => {
    it('lässt keinen Handler laufen, dessen Route für den Zustand zu ist', async () => {
      // Der Marker-Haken ersetzt den Handler; hier zählt nur, ob er erreicht wird. Für jeden Fall,
      // den die Tabelle nicht `erreichbar` nennt, darf er es nicht.
      const erreicht: string[] = [];
      for (const zustand of ZUSTAENDE) {
        for (const fall of faelle()) {
          if (KATEGORIEN[fall.kategorie].erwartung[zustand].art === 'erreichbar') {
            continue;
          }
          const antwort = await anfragen(fall, zustand);
          if (antwort.headers[MARKE] === 'ja') {
            erreicht.push(`${fall.name} (${zustand})`);
          }
        }
      }

      expect(erreicht).toEqual([]);
    });

    it('stimmt in jedem Fall mit der reinen Entscheidungsfunktion überein (zweite Meinung, nicht die Erwartung)', () => {
      const abweichungen: string[] = [];
      for (const zustand of ZUSTAENDE) {
        for (const fall of faelle()) {
          const erwartet = KATEGORIEN[fall.kategorie].erwartung[zustand];
          const entscheidung: TorEntscheidung = torEntscheidung({
            pfad: fall.pfad,
            sitzungVorhanden: zustand !== 'anonym',
            zweiterFaktorAktiv: zustand === 'mitFaktor',
          });
          const passt =
            (entscheidung.art === 'weiter' &&
              (erwartet.art === 'erreichbar' || erwartet.art === 'unbekannt404' || erwartet.art === 'token401' || erwartet.art === 'signatur401')) ||
            (entscheidung.art === 'blockieren' && erwartet.art === 'neutral404') ||
            (entscheidung.art === 'umleiten' && erwartet.art === 'umleiten' && entscheidung.ziel === erwartet.ziel);
          if (!passt) {
            abweichungen.push(`${fall.name} (${zustand}): Weiche ${JSON.stringify(entscheidung)}, Tabelle ${JSON.stringify(erwartet)}`);
          }
        }
      }

      expect(abweichungen).toEqual([]);
    });
  });
});
