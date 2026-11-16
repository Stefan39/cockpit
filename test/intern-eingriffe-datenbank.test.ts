/**
 * Die Eingriffe für den Admin-Agenten (COPI-41, ADR 13.1), mit echten Anfragen gegen die echte Datenbank:
 * `GET /intern/eingriffe`, `GET /intern/eingriffe/:id`, `POST /intern/eingriffe/:id/status`.
 *
 * Sicherheitskritisch: an dieser Kette hängt, ob ein Image auf dem Host gestartet wird. Hier steht, was die API
 * aushalten muss — jede erlaubte und jede verbotene Kante, ein Ziel, das nicht zur Freigabe passt, ein doppelter
 * Wechsel (auch gleichzeitig), fehlende oder falsche Rechte, und kein Weg, sich selbst „erledigt" zu melden. Was
 * scheitert, ändert weder die Zeile noch das Protokoll. `haengt` wird nach 15 Minuten in `laeuft` sichtbar, und ein
 * Fehlschlag bleibt für die Wachen des Agenten abfragbar.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit.eingriff`, `cockpit.instanz` und `cockpit.api_token` ab.
 * Erwartete Werte (Statuscodes, Fehlernamen, Felder) stehen als Literale.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAnlegen, apiTokenWiderrufen } from '../src/intern/token-speicher.js';
import type { ApiScope } from '../src/intern/token.js';
import { buildApp } from '../src/server/app.js';
import type { EingriffStatus } from '../src/status/eingriff.js';
import { eingriffIn, protokollMarke, protokollSchreibenScheitern, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const ZIEL = `sha256:${'b'.repeat(64)}`;
const VORHER = `sha256:${'a'.repeat(64)}`;
const ANDERES_ZIEL = `sha256:${'c'.repeat(64)}`;
const FREIGABE = { status: 'freigegeben', ziel_digest: ZIEL, ziel_version: '1.4.0' };

const STATUS: readonly EingriffStatus[] = ['beantragt', 'freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen', 'zurueckgezogen'];

/** Was der Agent setzen darf, und woher allein. */
const ERLAUBT: Readonly<Record<'freigegeben' | 'laeuft' | 'fehlgeschlagen', EingriffStatus>> = {
  freigegeben: 'beantragt',
  laeuft: 'freigegeben',
  fehlgeschlagen: 'laeuft',
};

function rumpfFuer(nach: keyof typeof ERLAUBT): Record<string, string> {
  return nach === 'freigegeben' ? FREIGABE : { status: nach };
}

describe.skipIf(!datenbankUrl)('Eingriffe für den Admin-Agenten (echte Datenbank)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  /** `undefined`: die echte Uhr — `laeuft_seit` setzt die Datenbank mit ihrer eigenen. */
  let jetzt: Date | undefined;
  let token: string;
  let tokenId: number;

  async function abraeumen(): Promise<void> {
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.instanz');
    await pool.query('DELETE FROM cockpit.api_token');
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    jetzt = undefined;
    await abraeumen();
    const zugang = await apiTokenAnlegen(pool, { name: 'admin-agent', scopes: ['eingriff_verwalten'] });
    token = zugang.token;
    tokenId = zugang.id;
    app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => jetzt ?? new Date() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await abraeumen();
    await pool.end();
  });

  /** `mit`: das Token der Anfrage; `null` schickt keins. */
  function lesen(url: string, mit: string | null = token) {
    return app.inject({ method: 'GET', url, headers: mit === null ? {} : { authorization: `Bearer ${mit}` } });
  }

  function schalten(id: number | string, rumpf: unknown, mit: string | null = token) {
    return app.inject({
      method: 'POST',
      url: `/intern/eingriffe/${String(id)}/status`,
      headers: { ...(mit === null ? {} : { authorization: `Bearer ${mit}` }), 'content-type': 'application/json' },
      payload: JSON.stringify(rumpf),
    });
  }

  async function zeile(id: number): Promise<Record<string, unknown> | undefined> {
    const ergebnis = await pool.query<Record<string, unknown>>(
      'SELECT status, ziel_version, freigegeben_am, laeuft_seit, abgeschlossen_am FROM cockpit.eingriff WHERE id = $1',
      [id],
    );
    return ergebnis.rows[0];
  }

  async function zugangMit(scopes: readonly ApiScope[]): Promise<string> {
    return (await apiTokenAnlegen(pool, { name: 'anderer-agent', scopes })).token;
  }

  describe('Zugang', () => {
    const ROUTEN = [
      ['GET /intern/eingriffe', (mit: string | null) => lesen('/intern/eingriffe', mit)],
      ['GET /intern/eingriffe/:id', (mit: string | null) => lesen('/intern/eingriffe/1', mit)],
      ['POST /intern/eingriffe/:id/status', (mit: string | null) => schalten(1, { status: 'laeuft' }, mit)],
    ] as const;

    it.each(ROUTEN)('%s: ohne Token 401', async (_name, anfrage) => {
      const antwort = await anfrage(null);

      expect(antwort.statusCode).toBe(401);
      expect(antwort.json()).toEqual({ fehler: 'nicht_angemeldet' });
    });

    it.each(ROUTEN)('%s: mit einem Token ohne das Recht `eingriff_verwalten` 403', async (_name, anfrage) => {
      const fremd = await zugangMit(['befund_schreiben', 'agenten_schreiben']);

      const antwort = await anfrage(fremd);

      expect(antwort.statusCode).toBe(403);
      expect(antwort.json()).toEqual({ fehler: 'nicht_erlaubt' });
    });

    it('lässt einen Zugang ohne das Recht nichts weiterschalten und nichts protokollieren außer der Ablehnung', async () => {
      const id = await eingriffIn(pool, 'beantragt');
      const fremd = await zugangMit(['befund_schreiben']);
      const marke = await protokollMarke(pool);

      const antwort = await schalten(id, FREIGABE, fremd);

      expect(antwort.statusCode).toBe(403);
      expect((await zeile(id))?.status).toBe('beantragt');
      expect((await protokollSeit(pool, marke)).map((eintrag) => eintrag.art)).toEqual(['api_zugriff_abgelehnt']);
    });

    it('lässt einen widerrufenen Zugang nicht mehr schalten', async () => {
      const id = await eingriffIn(pool, 'beantragt');
      await apiTokenWiderrufen(pool, tokenId);

      const antwort = await schalten(id, FREIGABE);

      expect(antwort.statusCode).toBe(401);
      expect((await zeile(id))?.status).toBe('beantragt');
    });
  });

  describe('lesen', () => {
    it('liefert einen Eingriff mit allen Feldern des Vertrags — und ohne `beantragt_von`', async () => {
      const id = await eingriffIn(pool, 'laeuft', { ziel: ZIEL, vorher: VORHER, zielVersion: '1.4.0' });
      const gespeichert = await pool.query<{ beantragt_am: Date; freigegeben_am: Date; laeuft_seit: Date }>(
        'SELECT beantragt_am, freigegeben_am, laeuft_seit FROM cockpit.eingriff WHERE id = $1',
        [id],
      );
      const zeiten = gespeichert.rows[0];

      const antwort = await lesen(`/intern/eingriffe/${String(id)}`);

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['cache-control']).toBe('no-store');
      expect(antwort.json()).toEqual({
        eingriff: {
          id,
          art: 'cockpit-image',
          status: 'laeuft',
          haengt: false,
          ziel_digest: ZIEL,
          ziel_version: '1.4.0',
          digest_vorher: VORHER,
          modul: null,
          ziel_commit: null,
          herkunft_vorher: null,
          grund: null,
          freigabe_modus: 'rueckfrage',
          automatisch: false,
          beantragt_am: zeiten?.beantragt_am.toISOString(),
          freigegeben_am: zeiten?.freigegeben_am.toISOString(),
          laeuft_seit: zeiten?.laeuft_seit.toISOString(),
          abgeschlossen_am: null,
        },
      });
      expect(antwort.body).not.toContain('konto-1');
    });

    it('kennt einen unbekannten Eingriff nicht: 404', async () => {
      const antwort = await lesen('/intern/eingriffe/999999');

      expect(antwort.statusCode).toBe(404);
      expect(antwort.json()).toEqual({ fehler: 'nicht_gefunden' });
    });

    it.each(['abc', '0', '01', '-1', '1e3', '1.5', '9999999999999999'])('weist die Nummer „%s" ab', async (nummer) => {
      const antwort = await lesen(`/intern/eingriffe/${nummer}`);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder: ['id'] });
    });

    it('listet die jüngsten zuerst', async () => {
      const erster = await eingriffIn(pool, 'erledigt');
      const zweiter = await eingriffIn(pool, 'fehlgeschlagen');
      const dritter = await eingriffIn(pool, 'beantragt');

      const antwort = await lesen('/intern/eingriffe');

      expect(antwort.statusCode).toBe(200);
      const liste = (antwort.json() as { eingriffe: { id: number; status: string }[] }).eingriffe;
      expect(liste.map((eingriff) => [eingriff.id, eingriff.status])).toEqual([
        [dritter, 'beantragt'],
        [zweiter, 'fehlgeschlagen'],
        [erster, 'erledigt'],
      ]);
    });

    it('liefert höchstens 50', async () => {
      for (let i = 0; i < 52; i += 1) {
        await eingriffIn(pool, 'zurueckgezogen');
      }

      const antwort = await lesen('/intern/eingriffe');

      expect((antwort.json() as { eingriffe: unknown[] }).eingriffe).toHaveLength(50);
    });

    it('lässt einen Fehlschlag abfragen: die Wachen des Agenten sehen ihn auch, wenn die Seite Versionen ausfällt', async () => {
      await eingriffIn(pool, 'erledigt');
      const gescheitert = await eingriffIn(pool, 'fehlgeschlagen');
      await eingriffIn(pool, 'beantragt');

      const antwort = await lesen('/intern/eingriffe?status=fehlgeschlagen');

      const liste = (antwort.json() as { eingriffe: { id: number; status: string }[] }).eingriffe;
      expect(liste.map((eingriff) => [eingriff.id, eingriff.status])).toEqual([[gescheitert, 'fehlgeschlagen']]);
    });

    it('filtert „offen": beantragt, freigegeben, laeuft', async () => {
      for (const status of ['erledigt', 'fehlgeschlagen', 'zurueckgezogen'] as const) {
        await eingriffIn(pool, status);
      }
      const offen = await eingriffIn(pool, 'freigegeben');

      const antwort = await lesen('/intern/eingriffe?status=offen');

      expect((antwort.json() as { eingriffe: { id: number }[] }).eingriffe.map((eingriff) => eingriff.id)).toEqual([offen]);
    });

    it.each([
      ['status=haengen', ['status']],
      ['status=', ['status']],
      ['status=erledigt&status=laeuft', ['status']],
      ['limit=500', ['limit']],
    ])('weist den Filter „%s" ab', async (abfrage, felder) => {
      const antwort = await lesen(`/intern/eingriffe?${abfrage}`);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder });
    });
  });

  /** ADR 13.1: länger als 15 Minuten in `laeuft` — beim Lesen berechnet, nie gespeichert, kein Scheduler. */
  describe('haengt', () => {
    async function laufendSeit(): Promise<{ id: number; seit: Date }> {
      const id = await eingriffIn(pool, 'laeuft');
      const ergebnis = await pool.query<{ laeuft_seit: Date }>('SELECT laeuft_seit FROM cockpit.eingriff WHERE id = $1', [id]);
      const seit = ergebnis.rows[0]?.laeuft_seit;
      if (seit === undefined) {
        throw new Error('laeuft_seit fehlt');
      }
      return { id, seit };
    }

    it('hängt nach genau 15 Minuten noch nicht, eine Millisekunde später schon', async () => {
      const { id, seit } = await laufendSeit();

      jetzt = new Date(seit.getTime() + 15 * 60_000);
      const vorher = await lesen(`/intern/eingriffe/${String(id)}`);
      const vorherGefiltert = await lesen('/intern/eingriffe?status=haengt');
      jetzt = new Date(seit.getTime() + 15 * 60_000 + 1);
      const nachher = await lesen(`/intern/eingriffe/${String(id)}`);
      const nachherGefiltert = await lesen('/intern/eingriffe?status=haengt');

      expect((vorher.json() as { eingriff: { haengt: boolean } }).eingriff.haengt).toBe(false);
      expect((vorherGefiltert.json() as { eingriffe: unknown[] }).eingriffe).toEqual([]);
      expect((nachher.json() as { eingriff: { haengt: boolean; status: string } }).eingriff).toMatchObject({
        haengt: true,
        status: 'laeuft',
      });
      expect((nachherGefiltert.json() as { eingriffe: { id: number }[] }).eingriffe.map((eingriff) => eingriff.id)).toEqual([id]);
    });

    it('speichert nichts: die Zeile bleibt „laeuft"', async () => {
      const { id, seit } = await laufendSeit();
      jetzt = new Date(seit.getTime() + 60 * 60_000);

      await lesen('/intern/eingriffe?status=haengt');

      expect((await zeile(id))?.status).toBe('laeuft');
    });

    it.each(['freigegeben', 'erledigt', 'fehlgeschlagen'] as const)('kennt „%s" nicht als hängend, egal wie alt', async (status) => {
      await eingriffIn(pool, status);
      jetzt = new Date(Date.now() + 24 * 60 * 60_000);

      const antwort = await lesen('/intern/eingriffe');

      expect((antwort.json() as { eingriffe: { haengt: boolean }[] }).eingriffe.map((eingriff) => eingriff.haengt)).toEqual([false]);
    });

    it('lässt einen hängenden Eingriff als gescheitert melden', async () => {
      const { id, seit } = await laufendSeit();
      jetzt = new Date(seit.getTime() + 20 * 60_000);

      const antwort = await schalten(id, { status: 'fehlgeschlagen' });

      expect(antwort.statusCode).toBe(200);
      expect((antwort.json() as { eingriff: { status: string; haengt: boolean } }).eingriff).toMatchObject({
        status: 'fehlgeschlagen',
        haengt: false,
      });
    });
  });

  describe('weiterschalten: die erlaubten Kanten', () => {
    it('gibt frei mit Vorgangs-ID, Ziel-Digest und Ziel-Version, und protokolliert es mit dem Zugang als Akteur', async () => {
      const id = await eingriffIn(pool, 'beantragt');
      const marke = await protokollMarke(pool);

      const antwort = await schalten(id, FREIGABE);

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['cache-control']).toBe('no-store');
      expect((antwort.json() as { eingriff: Record<string, unknown> }).eingriff).toMatchObject({
        id,
        status: 'freigegeben',
        ziel_digest: ZIEL,
        ziel_version: '1.4.0',
        laeuft_seit: null,
      });
      expect(await zeile(id)).toMatchObject({ status: 'freigegeben', ziel_version: '1.4.0', laeuft_seit: null });
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'update_freigegeben', akteur: `api_token_${String(tokenId)}`, ziel: null, einzelheiten: { eingriff_id: id } },
      ]);
    });

    it('startet einen freigegebenen Eingriff', async () => {
      const id = await eingriffIn(pool, 'freigegeben');
      const marke = await protokollMarke(pool);

      const antwort = await schalten(id, { status: 'laeuft' });

      expect(antwort.statusCode).toBe(200);
      expect((antwort.json() as { eingriff: { status: string; laeuft_seit: string | null } }).eingriff.laeuft_seit).not.toBeNull();
      expect((await zeile(id))?.status).toBe('laeuft');
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'update_gestartet', akteur: `api_token_${String(tokenId)}`, ziel: null, einzelheiten: { eingriff_id: id } },
      ]);
    });

    it('meldet einen laufenden Eingriff als gescheitert', async () => {
      const id = await eingriffIn(pool, 'laeuft');
      const marke = await protokollMarke(pool);

      const antwort = await schalten(id, { status: 'fehlgeschlagen' });

      expect(antwort.statusCode).toBe(200);
      expect((await zeile(id))?.status).toBe('fehlgeschlagen');
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'update_fehlgeschlagen', akteur: `api_token_${String(tokenId)}`, ziel: null, einzelheiten: { eingriff_id: id } },
      ]);
    });
  });

  describe('weiterschalten: was nicht geht', () => {
    // Jede Kombination aus Ausgangsstatus und Ziel, die nicht erlaubt ist: rückwärts, überspringen, aus einem Endzustand.
    const VERBOTEN = STATUS.flatMap((von) =>
      (Object.keys(ERLAUBT) as (keyof typeof ERLAUBT)[]).filter((nach) => ERLAUBT[nach] !== von).map((nach) => [von, nach] as const),
    );

    it('kennt drei erlaubte und fünfzehn verbotene Kanten für den Agenten', () => {
      expect(VERBOTEN).toHaveLength(15);
    });

    it.each(VERBOTEN)('lehnt %s → %s mit 409 ab, nennt den aktuellen Status und ändert nichts', async (von, nach) => {
      const id = await eingriffIn(pool, von);
      const vorher = await zeile(id);
      const marke = await protokollMarke(pool);

      const antwort = await schalten(id, rumpfFuer(nach));

      expect(antwort.statusCode).toBe(409);
      expect(antwort.json()).toEqual({ fehler: 'status_passt_nicht', status: von });
      expect(await zeile(id)).toEqual(vorher);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });

    it.each(['erledigt', 'beantragt', 'zurueckgezogen', 'haengt', 'unsinn'])(
      'kennt das Ziel „%s" nicht: 400, auch wenn eine passende Selbstmeldung da ist',
      async (nach) => {
        const id = await eingriffIn(pool, 'laeuft');
        // Ein Cockpit mit genau Ziel-Digest und Ziel-Version hat sich gemeldet: trotzdem darf der Agent nicht „erledigt" sagen.
        await pool.query(`INSERT INTO cockpit.instanz (version, digest) VALUES ('1.4.0+0123456', $1)`, [ZIEL]);
        const marke = await protokollMarke(pool);

        const antwort = await schalten(id, { status: nach });

        expect(antwort.statusCode).toBe(400);
        expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder: ['status'] });
        expect((await zeile(id))?.status).toBe('laeuft');
        expect(await protokollSeit(pool, marke)).toEqual([]);
      },
    );

    it('lehnt eine Freigabe auf einen anderen Digest ab: 409 `ziel_passt_nicht`', async () => {
      const id = await eingriffIn(pool, 'beantragt');

      const antwort = await schalten(id, { ...FREIGABE, ziel_digest: ANDERES_ZIEL });

      expect(antwort.statusCode).toBe(409);
      expect(antwort.json()).toEqual({ fehler: 'ziel_passt_nicht' });
      expect(await zeile(id)).toMatchObject({ status: 'beantragt', ziel_version: null });
    });

    it('lehnt die Freigabe einer fremden Zeile ab: der Digest gehört zu einem anderen Antrag', async () => {
      const alt = await eingriffIn(pool, 'zurueckgezogen', { ziel: ANDERES_ZIEL });
      const neu = await eingriffIn(pool, 'beantragt', { ziel: ZIEL });

      const aufNeu = await schalten(neu, { ...FREIGABE, ziel_digest: ANDERES_ZIEL });
      const aufAlt = await schalten(alt, { ...FREIGABE, ziel_digest: ANDERES_ZIEL });

      expect(aufNeu.json()).toEqual({ fehler: 'ziel_passt_nicht' });
      expect(aufAlt.json()).toEqual({ fehler: 'status_passt_nicht', status: 'zurueckgezogen' });
      expect((await zeile(neu))?.status).toBe('beantragt');
      expect((await zeile(alt))?.status).toBe('zurueckgezogen');
    });

    it('lehnt einen doppelten Wechsel ab: die zweite Freigabe ist ein Konflikt, kein Nichtstun', async () => {
      const id = await eingriffIn(pool, 'beantragt');
      const marke = await protokollMarke(pool);

      const erste = await schalten(id, FREIGABE);
      const zweite = await schalten(id, FREIGABE);

      expect(erste.statusCode).toBe(200);
      expect(zweite.statusCode).toBe(409);
      expect(zweite.json()).toEqual({ fehler: 'status_passt_nicht', status: 'freigegeben' });
      expect((await protokollSeit(pool, marke)).map((eintrag) => eintrag.art)).toEqual(['update_freigegeben']);
    });

    it('lässt von zwei gleichzeitigen Wechseln genau einen durch', async () => {
      const id = await eingriffIn(pool, 'freigegeben');
      const marke = await protokollMarke(pool);

      const antworten = await Promise.all([schalten(id, { status: 'laeuft' }), schalten(id, { status: 'laeuft' })]);

      expect(antworten.map((antwort) => antwort.statusCode).sort()).toEqual([200, 409]);
      expect((await protokollSeit(pool, marke)).map((eintrag) => eintrag.art)).toEqual(['update_gestartet']);
    });

    it.each(['abc', '0', '-1'])('weist die Nummer „%s" auch beim Weiterschalten ab', async (nummer) => {
      const antwort = await schalten(nummer, { status: 'laeuft' });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder: ['id'] });
    });

    it('kennt einen unbekannten Eingriff nicht: 404', async () => {
      const antwort = await schalten(999999, { status: 'laeuft' });

      expect(antwort.statusCode).toBe(404);
      expect(antwort.json()).toEqual({ fehler: 'nicht_gefunden' });
    });

    it.each([
      ['ohne Ziel-Version', { status: 'freigegeben', ziel_digest: ZIEL }, ['ziel_version']],
      ['ohne Ziel-Digest', { status: 'freigegeben', ziel_version: '1.4.0' }, ['ziel_digest']],
      ['mit einem Tag statt Digest', { ...FREIGABE, ziel_digest: 'latest' }, ['ziel_digest']],
      ['mit Build-Metadaten', { ...FREIGABE, ziel_version: '1.4.0+0123456' }, ['ziel_version']],
      ['mit „v" davor', { ...FREIGABE, ziel_version: 'v1.4.0' }, ['ziel_version']],
      ['mit einer Version über 64 Zeichen', { ...FREIGABE, ziel_version: `1.4.0-${'x'.repeat(59)}` }, ['ziel_version']],
      ['mit einem unbekannten Feld', { ...FREIGABE, freigegeben_von: 'stefan' }, ['freigegeben_von']],
      ['mit einem Digest beim Start', { status: 'laeuft', ziel_digest: ZIEL }, ['ziel_digest']],
      ['ohne Status', { ziel_digest: ZIEL }, ['status']],
    ])('weist eine Freigabe %s ab, ohne etwas zu ändern', async (_name, rumpf, felder) => {
      const id = await eingriffIn(pool, 'beantragt');

      const antwort = await schalten(id, rumpf);

      expect(antwort.statusCode).toBe(400);
      expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder });
      expect(await zeile(id)).toMatchObject({ status: 'beantragt', ziel_version: null });
    });

    it('weist einen Rumpf über 4 KiB ab', async () => {
      const id = await eingriffIn(pool, 'freigegeben');

      const antwort = await schalten(id, { status: 'laeuft', polster: 'x'.repeat(5000) });

      expect(antwort.statusCode).toBe(413);
      expect((await zeile(id))?.status).toBe('freigegeben');
    });

    it('lässt die Zeile stehen, wenn der Protokolleintrag scheitert: beides gilt oder keins', async () => {
      const id = await eingriffIn(pool, 'freigegeben');
      const entfernen = await protokollSchreibenScheitern(pool, 'update_gestartet');
      try {
        const antwort = await schalten(id, { status: 'laeuft' });

        expect(antwort.statusCode).toBe(500);
        expect(antwort.json()).toEqual({ fehler: 'interner_fehler' });
      } finally {
        await entfernen();
      }
      expect(await zeile(id)).toMatchObject({ status: 'freigegeben', laeuft_seit: null });
    });
  });
});
