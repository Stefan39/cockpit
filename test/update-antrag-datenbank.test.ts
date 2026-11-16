/**
 * Der Update-Antrag (COPI-40, ADR 13.1) mit echten Anfragen gegen die echte Datenbank.
 *
 * „Das Cockpit aktualisiert nichts. Es beantragt." Nur der Betreuer stellt einen Antrag; er schreibt genau eine Zeile
 * `cockpit.eingriff` (Status `beantragt`) und einen Protokolleintrag, beides in einer Transaktion. Der Weg hat zwei
 * Schritte gegen Fehlklicks: das Formular in den Einstellungen führt auf eine Bestätigungsseite mit beiden Digests,
 * erst deren Formular stellt den Antrag. Gegen fremde Formulare (CSRF) helfen die Pflicht-Herkunft (`Origin` oder
 * `Referer` muss die eigene Adresse sein) und die signierte Bestätigung. Höchstens ein offener Antrag zur Zeit; einen,
 * der noch nicht freigegeben ist, zieht der Betreuer zurück. Freigabe und Ausführung liegen außerhalb des Cockpits.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.instanz`, `cockpit.eingriff` und (im letzten Abschnitt)
 * `cockpit."user"` ab. Das Protokoll lässt sich nicht abräumen: gezählt wird seit einer Marke. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { instanzMelden } from '../src/status/instanz-speicher.js';
import { FORMULAR_KOPF, formular, kontenLoeschen, kontoEinrichten, protokollMarke, protokollSchreibenScheitern, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const JETZT = new Date('2026-09-21T12:00:00.000Z');
const LAUFEND = `sha256:${'9f'.repeat(32)}`;
const ZIEL = `sha256:${'e7'.repeat(32)}`;
const ANDERES_ZIEL = `sha256:${'e8'.repeat(32)}`;
const HOST = 'cockpit.example';
const EIGENE_HERKUNFT = { host: HOST, origin: `https://${HOST}` };

const BEANTRAGEN = '/einstellungen/update';
const BESTAETIGEN = '/einstellungen/update/bestaetigen';
const ZURUECKZIEHEN = '/einstellungen/update/zurueckziehen';

const KONTO: Readonly<Record<Rolle, string>> = {
  betreuer: 'konto-betreuer',
  betriebs_admin: 'konto-admin',
  betrieb_mitarbeiter: 'konto-mitarbeiter',
};

const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

function zugangMit(rolle: Rolle | undefined): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: rolle === undefined ? 'konto-unbekannt' : KONTO[rolle] };
}

interface EingriffZeile {
  readonly id: number;
  readonly art: string;
  readonly ziel_digest: string;
  readonly digest_vorher: string;
  readonly beantragt_von: string;
  readonly status: string;
}

async function eingriffe(pool: pg.Pool): Promise<EingriffZeile[]> {
  const ergebnis = await pool.query<EingriffZeile>(
    'SELECT id::int AS id, art, ziel_digest, digest_vorher, beantragt_von, status FROM cockpit.eingriff ORDER BY id',
  );
  return ergebnis.rows;
}

/** Die versteckten Felder der Bestätigungsseite, wie ein Browser sie abschickt. */
function bestaetigungAus(html: string): { ziel: string; bis: string; token: string } {
  const feld = (name: string): string => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';
  return { ziel: feld('ziel'), bis: feld('bis'), token: feld('token') };
}

describe.skipIf(!datenbankUrl)('Update-Antrag (echte Datenbank)', () => {
  let pool: pg.Pool;
  let uhr: Date;
  let app: FastifyInstance;
  let rolle: Rolle | undefined;
  let marke: number;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.instanz');
    await instanzMelden(pool, { version: '1.4.0+0123456', digest: LAUFEND }, JETZT);
    uhr = JETZT;
    rolle = 'betreuer';
    app = buildApp(
      { nodeEnv: 'test' },
      { pool, jetzt: () => uhr, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugangMit(rolle)) },
    );
    marke = await protokollMarke(pool);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.instanz');
    await pool.end();
  });

  function senden(url: string, felder: Record<string, string>, kopf: Record<string, string> = EIGENE_HERKUNFT): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...kopf }, payload: formular(felder) });
  }

  async function bestaetigungHolen(ziel = ZIEL): Promise<{ ziel: string; bis: string; token: string }> {
    const antwort = await senden(BEANTRAGEN, { ziel });
    expect(antwort.statusCode).toBe(200);
    return bestaetigungAus(antwort.body);
  }

  async function antragStellen(ziel = ZIEL): Promise<LightMyRequestResponse> {
    return senden(BESTAETIGEN, await bestaetigungHolen(ziel));
  }

  async function einstellungen(url = '/einstellungen'): Promise<string> {
    return (await app.inject({ method: 'GET', url })).body;
  }

  describe('Update installieren (COPI-140)', () => {
    beforeEach(async () => {
      await pool.query(`DELETE FROM cockpit.befund WHERE wache = 'version-cockpit'`);
      await pool.query(`DELETE FROM cockpit.wache WHERE kennung = 'version-cockpit'`);
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM cockpit.befund WHERE wache = 'version-cockpit'`);
      await pool.query(`DELETE FROM cockpit.wache WHERE kennung = 'version-cockpit'`);
    });

    async function wacheMeldet(ziel: string, version: string): Promise<void> {
      await befundMelden(pool, {
        wache: 'version-cockpit',
        status: 'gelb',
        textIntern: `Neue Version ${version}`,
        kundensichtbar: false,
        taktSekunden: 21_600,
        updateZiel: { art: 'cockpit', ziel, version, seit: '2026-09-21T10:00:00+02:00' },
        quelle: 'test',
        jetzt: JETZT,
      });
    }

    function mitQuelle(seite: LightMyRequestResponse): Record<string, string> {
      return { ...bestaetigungAus(seite.body), quelle: 'wache' };
    }

    it('zeigt Version und Ziel an der Karte und führt mit einem Klick zur Bestätigung', async () => {
      await wacheMeldet(ZIEL, '1.5.0');

      expect(await einstellungen()).toContain('Update verfügbar: 1.5.0 · seit 21.09.2026');
      const seite = await senden(BEANTRAGEN, { quelle: 'wache' });

      expect(seite.statusCode).toBe(200);
      expect(seite.body).toContain('Ziel (Version 1.5.0)');
      expect(bestaetigungAus(seite.body).ziel).toBe(ZIEL);
      expect(seite.body).toContain('name="quelle" value="wache"');
      expect(await eingriffe(pool)).toEqual([]);

      expect((await senden(BESTAETIGEN, mitQuelle(seite))).statusCode).toBe(303);
      expect(await eingriffe(pool)).toEqual([expect.objectContaining({ ziel_digest: ZIEL, digest_vorher: LAUFEND, status: 'beantragt' })]);
    });

    it('macht die Bestätigung ungültig, wenn die Wache inzwischen ein anderes Ziel meldet, und zeigt das neue', async () => {
      await wacheMeldet(ZIEL, '1.5.0');
      const seite = await senden(BEANTRAGEN, { quelle: 'wache' });
      await wacheMeldet(ANDERES_ZIEL, '1.5.1');

      const neu = await senden(BESTAETIGEN, mitQuelle(seite));

      expect(neu.statusCode).toBe(409);
      expect(neu.body).toContain('Die Versions-Wache meldet inzwischen ein anderes Ziel.');
      expect(neu.body).toContain('Ziel (Version 1.5.1)');
      expect(bestaetigungAus(neu.body).ziel).toBe(ANDERES_ZIEL);
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('stellt ohne gemeldetes Ziel keinen Antrag', async () => {
      const antwort = await senden(BEANTRAGEN, { quelle: 'wache' });

      expect(antwort.statusCode).toBe(409);
      expect(antwort.body).toContain('Die Versions-Wache meldet kein Update mehr.');
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('bietet bei einem offenen Antrag keinen zweiten Knopf an', async () => {
      await wacheMeldet(ZIEL, '1.5.0');
      await senden(BESTAETIGEN, mitQuelle(await senden(BEANTRAGEN, { quelle: 'wache' })));

      const html = await einstellungen();

      expect(html).not.toContain('Update installieren');
      expect(html).toContain('wartet auf die Freigabe');
    });
  });

  describe('das Formular in den Einstellungen', () => {
    it('bietet dem Betreuer „Update beantragen" mit einem Feld für den Ziel-Digest an', async () => {
      const html = await einstellungen();

      expect(html).toContain(`<form method="post" action="${BEANTRAGEN}"`);
      expect(html).toContain('name="ziel"');
      expect(html).toContain('Diesen Stand beantragen');
    });

    it.each<Rolle | undefined>(['betriebs_admin', 'betrieb_mitarbeiter', undefined])(
      'zeigt der Rolle %s keinen Knopf und kein Formular — und kein „Jetzt aktualisieren"',
      async (andere) => {
        rolle = andere;

        const html = await einstellungen();

        expect(html).not.toContain('Update beantragen');
        expect(html).not.toContain('/einstellungen/update');
        expect(html).not.toContain('aktualisieren');
      },
    );

    it('bietet keinen Antrag an, solange der laufende Digest fehlt: ohne ihn gäbe es keinen Weg zurück', async () => {
      await pool.query('DELETE FROM cockpit.instanz');
      await instanzMelden(pool, { version: '0.1.0+lokal', digest: undefined }, JETZT);

      const html = await einstellungen();

      expect(html).not.toContain(`action="${BEANTRAGEN}"`);
      expect(html).toContain('Ein Update lässt sich erst beantragen, wenn das Cockpit seinen laufenden Digest meldet.');
    });
  });

  describe('Schritt 1: die Bestätigungsseite', () => {
    it('zeigt beide Digests vollständig und legt noch nichts an', async () => {
      const antwort = await senden(BEANTRAGEN, { ziel: ` ${ZIEL} ` });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['cache-control']).toBe('no-store');
      expect(antwort.body).toContain(`<code class="digest-voll">${LAUFEND}</code>`);
      expect(antwort.body).toContain(`<code class="digest-voll">${ZIEL}</code>`);
      expect(antwort.body).toContain(`<form method="post" action="${BESTAETIGEN}"`);
      expect(antwort.body).toContain('Antrag stellen');
      expect(antwort.body).toContain('href="/einstellungen"');
      expect(bestaetigungAus(antwort.body)).toMatchObject({ ziel: ZIEL, bis: String(JETZT.getTime() + 10 * 60_000) });
      expect(await eingriffe(pool)).toEqual([]);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });
  });

  describe('Schritt 2: der Antrag', () => {
    it('schreibt als Betreuer genau eine Zeile „beantragt" und genau einen Protokolleintrag', async () => {
      const antwort = await antragStellen();

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/einstellungen?antrag=gestellt');
      const zeilen = await eingriffe(pool);
      expect(zeilen).toEqual([
        {
          id: expect.any(Number) as number,
          art: 'cockpit-image',
          ziel_digest: ZIEL,
          digest_vorher: LAUFEND,
          beantragt_von: KONTO.betreuer,
          status: 'beantragt',
        },
      ]);
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'update_beantragt', akteur: KONTO.betreuer, ziel: null, einzelheiten: { eingriff_id: zeilen[0]?.id } },
      ]);
    });

    it('zeigt danach den Antrag mit Nummer, Soll-Digest und „Antrag zurückziehen" — und kein zweites Formular', async () => {
      await antragStellen();
      const [zeile] = await eingriffe(pool);

      const html = await einstellungen('/einstellungen?antrag=gestellt');

      expect(html).toContain('Antrag gestellt. Die Freigabe erfolgt außerhalb des Cockpits.');
      expect(html).toContain(`<code class="digest">${ZIEL}</code>`);
      expect(html).toContain(`Antrag Nr. ${String(zeile?.id)} wartet auf die Freigabe.`);
      expect(html).toContain(`<form method="post" action="${ZURUECKZIEHEN}"`);
      expect(html).toContain(`name="id" value="${String(zeile?.id)}"`);
      expect(html).not.toContain(`action="${BEANTRAGEN}"`);
    });

    it('sagt dem Kunden danach nur „Update angefragt."', async () => {
      await antragStellen();
      rolle = 'betriebs_admin';

      const html = await einstellungen('/einstellungen?antrag=gestellt');

      expect(html).toContain('<p class="bereich-satz">Update angefragt.</p>');
      expect(html).not.toContain('sha256');
      expect(html).not.toContain('Antrag gestellt');
    });

    it('nimmt nur bekannte Hinweise aus der Adresse: alles andere zeigt nichts', async () => {
      const html = await einstellungen('/einstellungen?antrag=%3Cb%3Ehallo%3C%2Fb%3E');

      expect(html).not.toContain('hallo');
      expect(html).not.toContain('role="status"');
    });

    it('lässt nichts stehen, wenn der Protokolleintrag scheitert: Antrag und Eintrag gehören zu einer Transaktion', async () => {
      const bestaetigung = await bestaetigungHolen();
      const entfernen = await protokollSchreibenScheitern(pool, 'update_beantragt');
      try {
        const antwort = await senden(BESTAETIGEN, bestaetigung);

        expect(antwort.statusCode).toBe(500);
        expect(antwort.body).not.toContain('test_protokoll_scheitert');
      } finally {
        await entfernen();
      }
      expect(await eingriffe(pool)).toEqual([]);
    });
  });

  describe('nur der Betreuer', () => {
    it.each<[string, Rolle | undefined]>([
      ['Betriebs-Admin', 'betriebs_admin'],
      ['Mitarbeiter', 'betrieb_mitarbeiter'],
      ['unbekannte Rolle', undefined],
    ])('%s bekommt beim direkten POST auf jeden Schritt 403, und es entsteht keine Zeile', async (_name, andere) => {
      const bestaetigung = await bestaetigungHolen();
      rolle = andere;

      const antworten = [
        await senden(BEANTRAGEN, { ziel: ZIEL }),
        await senden(BESTAETIGEN, bestaetigung),
        await senden(ZURUECKZIEHEN, { id: '1' }),
      ];

      expect(antworten.map((antwort) => antwort.statusCode)).toEqual([403, 403, 403]);
      for (const antwort of antworten) {
        expect(antwort.body).not.toContain('sha256');
      }
      expect(await eingriffe(pool)).toEqual([]);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it('lässt einen Betriebs-Admin auch keinen Antrag des Betreuers zurückziehen', async () => {
      await antragStellen();
      const [zeile] = await eingriffe(pool);
      rolle = 'betriebs_admin';

      const antwort = await senden(ZURUECKZIEHEN, { id: String(zeile?.id) });

      expect(antwort.statusCode).toBe(403);
      expect((await eingriffe(pool))[0]?.status).toBe('beantragt');
    });
  });

  describe('der Ziel-Digest', () => {
    it.each([
      ['ein Tag', 'latest'],
      ['ein gekürzter Digest', 'sha256:e77b40'],
      ['Großbuchstaben', `sha256:${'E7'.repeat(32)}`],
      ['ein Bild mit Digest', `ghcr.io/stefan39/cockpit@${ZIEL}`],
      ['leer', ''],
    ])('weist %s ab, mit Hinweis und ohne Zeile', async (_name, ziel) => {
      const antwort = await senden(BEANTRAGEN, { ziel });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain('Bitte den vollständigen Digest angeben: sha256: und 64 Zeichen 0–9, a–f.');
      expect(antwort.body).not.toContain(`action="${BESTAETIGEN}"`);
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('weist ihn auch im zweiten Schritt ab, wenn jemand die Bestätigungsseite umgeht', async () => {
      const bestaetigung = await bestaetigungHolen();

      const antwort = await senden(BESTAETIGEN, { ...bestaetigung, ziel: 'latest' });

      expect(antwort.statusCode).toBe(400);
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('gibt eine falsche Eingabe maskiert zurück, nie als Markup', async () => {
      const antwort = await senden(BEANTRAGEN, { ziel: '<img src=x onerror=alert(1)>' });

      expect(antwort.body).not.toContain('<img src=x');
      expect(antwort.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('weist den laufenden Digest als Ziel ab: das wäre kein Update', async () => {
      const antwort = await senden(BEANTRAGEN, { ziel: LAUFEND });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain('Dieser Digest läuft bereits.');
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('stellt ohne laufenden Digest keinen Antrag, auch nicht per direktem POST', async () => {
      const bestaetigung = await bestaetigungHolen();
      await pool.query('DELETE FROM cockpit.instanz');

      const antworten = [await senden(BEANTRAGEN, { ziel: ZIEL }), await senden(BESTAETIGEN, bestaetigung)];

      expect(antworten.map((antwort) => antwort.statusCode)).toEqual([409, 409]);
      expect(antworten[0]?.body).toContain('Ein Update lässt sich erst beantragen, wenn das Cockpit seinen laufenden Digest meldet.');
      expect(await eingriffe(pool)).toEqual([]);
    });
  });

  describe('CSRF', () => {
    it('weist den zweiten Schritt ohne Bestätigung ab', async () => {
      const antwort = await senden(BESTAETIGEN, { ziel: ZIEL });

      expect(antwort.statusCode).toBe(403);
      expect(antwort.body).toContain('Die Bestätigung ist abgelaufen oder ungültig.');
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('weist eine Bestätigung ab, deren Ziel nachträglich geändert wurde', async () => {
      const bestaetigung = await bestaetigungHolen();

      const antwort = await senden(BESTAETIGEN, { ...bestaetigung, ziel: ANDERES_ZIEL });

      expect(antwort.statusCode).toBe(403);
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('weist eine Bestätigung ab, die älter ist als zehn Minuten', async () => {
      const bestaetigung = await bestaetigungHolen();
      uhr = new Date(JETZT.getTime() + 10 * 60_000);

      const antwort = await senden(BESTAETIGEN, bestaetigung);

      expect(antwort.statusCode).toBe(403);
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('weist eine Bestätigung ab, wenn das Cockpit inzwischen einen anderen Digest meldet', async () => {
      const bestaetigung = await bestaetigungHolen();
      await instanzMelden(pool, { version: '1.4.1+0123457', digest: `sha256:${'9e'.repeat(32)}` }, JETZT);

      const antwort = await senden(BESTAETIGEN, bestaetigung);

      expect(antwort.statusCode).toBe(403);
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('weist eine Bestätigung ab, die eine andere App-Instanz ausgestellt hat (Schlüssel je Prozess)', async () => {
      const bestaetigung = await bestaetigungHolen();
      const andere = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => uhr, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugangMit('betreuer')) });
      try {
        const antwort = await andere.inject({
          method: 'POST',
          url: BESTAETIGEN,
          headers: { ...FORMULAR_KOPF, ...EIGENE_HERKUNFT },
          payload: formular(bestaetigung),
        });

        expect(antwort.statusCode).toBe(403);
      } finally {
        await andere.close();
      }
      expect(await eingriffe(pool)).toEqual([]);
    });

    it.each<[string, Record<string, string>]>([
      ['ohne Origin und Referer', { host: HOST }],
      ['mit fremder Origin', { host: HOST, origin: 'https://boese.example' }],
      ['mit Origin einer Nachbar-Subdomain', { host: HOST, origin: `https://nachbar.${HOST}` }],
      ['mit „Origin: null"', { host: HOST, origin: 'null' }],
      ['mit fremdem Referer', { host: HOST, referer: 'https://boese.example/formular' }],
    ])('weist jeden Schritt %s ab', async (_name, kopf) => {
      const bestaetigung = await bestaetigungHolen();

      const antworten = [
        await senden(BEANTRAGEN, { ziel: ZIEL }, kopf),
        await senden(BESTAETIGEN, bestaetigung, kopf),
        await senden(ZURUECKZIEHEN, { id: '1' }, kopf),
      ];

      expect(antworten.map((antwort) => antwort.statusCode)).toEqual([403, 403, 403]);
      expect(await eingriffe(pool)).toEqual([]);
    });

    it('nimmt die eigene Adresse auch als Referer an (ohne Origin)', async () => {
      const antwort = await senden(BEANTRAGEN, { ziel: ZIEL }, { host: HOST, referer: `https://${HOST}/einstellungen` });

      expect(antwort.statusCode).toBe(200);
    });
  });

  describe('Doppelantrag', () => {
    it('stellt eine doppelt abgeschickte Bestätigung nur einmal', async () => {
      const bestaetigung = await bestaetigungHolen();

      const erste = await senden(BESTAETIGEN, bestaetigung);
      const zweite = await senden(BESTAETIGEN, bestaetigung);

      expect([erste.statusCode, zweite.statusCode]).toEqual([303, 409]);
      expect(zweite.body).toContain('Es gibt schon einen offenen Antrag.');
      expect(await eingriffe(pool)).toHaveLength(1);
      expect(await protokollSeit(pool, marke)).toHaveLength(1);
    });

    it('stellt auch gleichzeitig abgeschickte Bestätigungen nur einmal', async () => {
      const bestaetigung = await bestaetigungHolen();

      const antworten = await Promise.all([senden(BESTAETIGEN, bestaetigung), senden(BESTAETIGEN, bestaetigung), senden(BESTAETIGEN, bestaetigung)]);

      expect(antworten.map((antwort) => antwort.statusCode).sort()).toEqual([303, 409, 409]);
      expect(await eingriffe(pool)).toHaveLength(1);
      expect(await protokollSeit(pool, marke)).toHaveLength(1);
    });

    it.each(['beantragt', 'freigegeben'] as const)(
      'lehnt einen zweiten Antrag ab, solange einer „%s" ist — auch mit anderem Ziel',
      async (status) => {
        await antragStellen();
        if (status === 'freigegeben') {
          await pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben', ziel_version = '0.2.0'`);
        }

        const schritt1 = await senden(BEANTRAGEN, { ziel: ANDERES_ZIEL });

        expect(schritt1.statusCode).toBe(409);
        expect(schritt1.body).toContain('Es gibt schon einen offenen Antrag.');
        expect(await eingriffe(pool)).toHaveLength(1);
      },
    );
  });

  describe('zurückziehen', () => {
    it('zieht einen beantragten Antrag zurück, mit Protokolleintrag, und macht den Weg für einen neuen frei', async () => {
      await antragStellen();
      const [zeile] = await eingriffe(pool);
      const vorher = await protokollMarke(pool);

      const antwort = await senden(ZURUECKZIEHEN, { id: String(zeile?.id) });

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/einstellungen?antrag=zurueckgezogen');
      expect((await eingriffe(pool))[0]?.status).toBe('zurueckgezogen');
      expect(await protokollSeit(pool, vorher)).toEqual([
        { art: 'update_zurueckgezogen', akteur: KONTO.betreuer, ziel: null, einzelheiten: { eingriff_id: zeile?.id } },
      ]);
      expect(await einstellungen('/einstellungen?antrag=zurueckgezogen')).toContain('Antrag zurückgezogen.');
      expect((await antragStellen(ANDERES_ZIEL)).statusCode).toBe(303);
    });

    it.each(['freigegeben', 'laeuft'] as const)('lässt einen Antrag im Status „%s" stehen', async (status) => {
      await antragStellen();
      const [zeile] = await eingriffe(pool);
      await pool.query(`UPDATE cockpit.eingriff SET status = 'freigegeben', ziel_version = '0.2.0'`);
      if (status === 'laeuft') {
        await pool.query(`UPDATE cockpit.eingriff SET status = 'laeuft'`);
      }
      const vorher = await protokollMarke(pool);

      const antwort = await senden(ZURUECKZIEHEN, { id: String(zeile?.id) });

      expect(antwort.statusCode).toBe(409);
      expect(antwort.body).toContain('Dieser Antrag lässt sich nicht mehr zurückziehen: er ist schon freigegeben, gestartet oder abgeschlossen.');
      expect((await eingriffe(pool))[0]?.status).toBe(status);
      expect(await protokollSeit(pool, vorher)).toEqual([]);
    });

    it('antwortet für eine unbekannte Nummer wie für einen freigegebenen Antrag', async () => {
      const antwort = await senden(ZURUECKZIEHEN, { id: '999999' });

      expect(antwort.statusCode).toBe(409);
    });

    it.each(['', 'abc', '-1', '0', '1.5', '1e3', '99999999999999999999'])('weist die Nummer „%s" ab', async (id) => {
      const antwort = await senden(ZURUECKZIEHEN, { id });

      expect(antwort.statusCode).toBe(400);
    });

    it('lässt den Antrag stehen, wenn der Protokolleintrag scheitert', async () => {
      await antragStellen();
      const [zeile] = await eingriffe(pool);
      const entfernen = await protokollSchreibenScheitern(pool, 'update_zurueckgezogen');
      try {
        const antwort = await senden(ZURUECKZIEHEN, { id: String(zeile?.id) });

        expect(antwort.statusCode).toBe(500);
      } finally {
        await entfernen();
      }
      expect((await eingriffe(pool))[0]?.status).toBe('beantragt');
    });
  });
});

describe.skipIf(!datenbankUrl)('Update-Antrag mit echten Sitzungen je Rolle (echte Datenbank)', () => {
  const PASSWORT = 'ein-ausreichend-langes-passwort';
  const BASIS_URL = 'http://localhost:3000';
  const HERKUNFT = { host: 'localhost:3000', origin: BASIS_URL };
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let einrichtung: FastifyInstance;
  const cookies: Record<'mitarbeiter' | 'admin' | 'betreuer', string> = { mitarbeiter: '', admin: '', betreuer: '' };
  const ids: Record<'mitarbeiter' | 'admin' | 'betreuer', string> = { mitarbeiter: '', admin: '', betreuer: '' };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.instanz');
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();

    const rollen: Record<keyof typeof cookies, Rolle> = { mitarbeiter: 'betrieb_mitarbeiter', admin: 'betriebs_admin', betreuer: 'betreuer' };
    for (const name of Object.keys(cookies) as (keyof typeof cookies)[]) {
      const konto = await kontoEinrichten(einrichtung, auth, { email: `${name}@example.org`, passwort: PASSWORT, name, mitZweitemFaktor: true });
      cookies[name] = konto.cookie;
      ids[name] = konto.id;
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rollen[name]]);
    }
    await instanzMelden(pool, { version: '1.4.0+0123456', digest: LAUFEND }, new Date());
  }, 90_000);

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.eingriff');
  });

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.instanz');
    await kontenLoeschen(pool);
    await pool.end();
  });

  function senden(url: string, felder: Record<string, string>, cookie: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...HERKUNFT, cookie }, payload: formular(felder) });
  }

  it('lässt den Betreuer den Antrag über beide Schritte stellen: die Zeile nennt sein Konto', async () => {
    const schritt1 = await senden(BEANTRAGEN, { ziel: ZIEL }, cookies.betreuer);
    const schritt2 = await senden(BESTAETIGEN, bestaetigungAus(schritt1.body), cookies.betreuer);

    expect([schritt1.statusCode, schritt2.statusCode]).toEqual([200, 303]);
    expect((await eingriffe(pool)).map((zeile) => zeile.beantragt_von)).toEqual([ids.betreuer]);
  });

  it.each(['admin', 'mitarbeiter'] as const)('gibt dem Konto %s beim direkten POST 403, und es entsteht keine Zeile', async (name) => {
    const schritt1 = await senden(BEANTRAGEN, { ziel: ZIEL }, cookies.betreuer);
    const bestaetigung = bestaetigungAus(schritt1.body);

    const antworten = [
      await senden(BEANTRAGEN, { ziel: ZIEL }, cookies[name]),
      await senden(BESTAETIGEN, bestaetigung, cookies[name]),
      await senden(ZURUECKZIEHEN, { id: '1' }, cookies[name]),
    ];

    expect(antworten.map((antwort) => antwort.statusCode)).toEqual([403, 403, 403]);
    expect(await eingriffe(pool)).toEqual([]);
  });

  it('schickt einen POST ohne Sitzung zur Anmeldung: das Tor lässt ihn nicht bis zur Route', async () => {
    const antwort = await app.inject({ method: 'POST', url: BEANTRAGEN, headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: formular({ ziel: ZIEL }) });

    expect(antwort.statusCode).toBe(303);
    expect(antwort.headers.location).toBe('/anmelden');
    expect(await eingriffe(pool)).toEqual([]);
  });
});
