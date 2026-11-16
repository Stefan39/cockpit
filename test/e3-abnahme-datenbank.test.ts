/**
 * E3-Abnahme (COPI-42): das Zustandsbild ohne Doppelprüfung, als durchgehender Ablauf gegen eine echte PostgreSQL.
 * Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * ACHTUNG: Der Test räumt die Tabellen des Zustandsbilds, `cockpit.api_token`, `cockpit.einladung` und
 * `cockpit."user"` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 *
 * Die Definition of Done der ADR (Abschnitt 11) für E3: „Gestoppter Container erscheint im Cockpit; ausbleibende Wache
 * wird gelb; Update-Antrag erzeugt nachweislich eine `cockpit.eingriff`-Zeile, Admin-Agent führt sie nach Freigabe
 * aus." Die Teile sind in COPI-34 bis COPI-41 einzeln getestet; hier der Beleg, dass sie **zusammen** halten — über die
 * echten Wege: der Zugang des Agenten aus dem Server-Kommando, jede Meldung über die Agenten-API mit diesem Token, der
 * Antrag über die Formulare der Einstellungen, der „Neustart" über die Selbstmeldung, die auch der Start des Servers
 * aufruft (`src/server/index.ts`; als echter Prozess belegt in `start-pruefung-prozess-datenbank.test.ts`).
 *
 * **Abgrenzung** (Ticket): Der Admin-Agent ist hier simuliert — er ruft die Endpunkte so auf, wie `docs/agenten-api.md`
 * es ihm vorschreibt. Die echte Ausführung entsteht in `agent-blueprints`, der Nachweis auf einer echten Instanz gehört
 * zu E6 (Pilot FEWOTEST). Die Konten der Menschen legen die Hilfen aus E2 an (dort durchgehend belegt, COPI-29).
 *
 * Die Schritte bauen aufeinander auf und laufen in dieser Reihenfolge:
 *
 *   1. Server-Kommando `api-token-erzeugen` → das Token öffnet die Agenten-API        (Vorbedingung)
 *   2. Der Agent meldet das Inventar → Seite Agenten                                   (Vorbedingung)
 *   3. Ein Container stoppt → der Befund erscheint als rote Kachel                     (DoD: gestoppter Container)
 *   4. Eine Wache bleibt aus → ihre Kachel wird gelb                                  (DoD: ausbleibende Wache)
 *   5. Der Betreuer beantragt ein Update → genau eine Zeile `cockpit.eingriff`         (DoD: Update-Antrag)
 *   6. Der Agent holt ihn ab, meldet Freigabe und Start                                (DoD: nach Freigabe ausführen)
 *   7. Ein Cockpit mit Ziel-Digest und Ziel-Version meldet sich → `erledigt`           (DoD: Erfolgsbeleg)
 *   8. Ein Update, das nicht ankommt, hängt und wird als Fehlschlag gemeldet           (ADR 13.1: haengt, Fehlschlag)
 *   9. Das Protokoll erzählt die Geschichte
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { cliAusfuehren } from '../src/cli/befehle.js';
import { buildApp } from '../src/server/app.js';
import { instanzMelden } from '../src/status/instanz-speicher.js';
import { FORMULAR_KOPF, formular, kontenLoeschen, kontoEinrichten, protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const BASIS_URL = 'http://localhost:3000';
const HERKUNFT = { host: 'localhost:3000', origin: BASIS_URL };
const PASSWORT = 'ein-ausreichend-langes-passwort';

const LAUFEND = `sha256:${'a1'.repeat(32)}`;
const ZIEL = `sha256:${'b2'.repeat(32)}`;
const NOCH_EINS = `sha256:${'c3'.repeat(32)}`;

interface Eingriff {
  readonly id: number;
  readonly status: string;
  readonly haengt: boolean;
  readonly ziel_digest: string;
  readonly digest_vorher: string;
}

describe.skipIf(!datenbankUrl)('E3-Abnahme: Zustandsbild ohne Doppelprüfung (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let einrichtung: FastifyInstance;
  /** Die Uhr des Cockpits: die echte, um diesen Versatz verschoben — so bleibt eine Wache aus, ohne zu warten. */
  let versatzMs = 0;
  const cookies = { betreuer: '', mitarbeiter: '' };
  let agentToken = '';
  let marke = 0;
  let antragNr = 0;

  async function abraeumen(): Promise<void> {
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DELETE FROM cockpit.agent');
    await pool.query('DELETE FROM cockpit.eingriff');
    await pool.query('DELETE FROM cockpit.instanz');
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await abraeumen();
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL, jetzt: () => new Date(Date.now() + versatzMs) });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();
    marke = await protokollMarke(pool);
    for (const [name, rolle] of [
      ['betreuer', 'betreuer'],
      ['mitarbeiter', 'betrieb_mitarbeiter'],
    ] as const) {
      const konto = await kontoEinrichten(einrichtung, auth, { email: `${name}@example.org`, passwort: PASSWORT, name, mitZweitemFaktor: true });
      cookies[name] = konto.cookie;
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rolle]);
    }
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await abraeumen();
    await pool.end();
  });

  /** Der Agent: JSON mit seinem Bearer-Token, wie `docs/agenten-api.md` es beschreibt. */
  function agent(method: 'GET' | 'POST' | 'PUT', url: string, koerper?: unknown) {
    return app.inject({
      method,
      url: `/intern${url}`,
      headers: { authorization: `Bearer ${agentToken}`, ...(koerper === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(koerper === undefined ? {} : { payload: JSON.stringify(koerper) }),
    });
  }

  function seite(wer: keyof typeof cookies, url: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: cookies[wer] } });
  }

  function formularSenden(url: string, felder: Record<string, string>) {
    return app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...HERKUNFT, cookie: cookies.betreuer }, payload: formular(felder) });
  }

  /** Die Farbe der Kachel mit diesem Namen auf der Übersicht. */
  function kachelFarbe(html: string, name: string): string | undefined {
    const treffer = new RegExp(`<li class="kachel kachel-(\\w+)">(?:(?!</li>)[\\s\\S])*?<span class="kachel-name">${name}</span>`).exec(html);
    return treffer?.[1];
  }

  /** Der Betreuer stellt den Antrag über die beiden Formulare der Einstellungen. */
  async function updateBeantragen(ziel: string): Promise<void> {
    const schritt1 = await formularSenden('/einstellungen/update', { ziel });
    expect(schritt1.statusCode).toBe(200);
    const bis = /name="bis" value="(\d+)"/.exec(schritt1.body)?.[1] ?? '';
    const token = /name="token" value="([A-Za-z0-9_-]{43})"/.exec(schritt1.body)?.[1] ?? '';
    const schritt2 = await formularSenden('/einstellungen/update/bestaetigen', { ziel, bis, token });
    expect(schritt2.statusCode).toBe(303);
  }

  async function eingriffe(filter = ''): Promise<Eingriff[]> {
    const antwort = await agent('GET', `/eingriffe${filter}`);
    expect(antwort.statusCode).toBe(200);
    return (antwort.json() as { eingriffe: Eingriff[] }).eingriffe;
  }

  it('1. Der Betreuer legt den Zugang des Admin-Agenten per Server-Kommando an; das Token öffnet die Agenten-API', async () => {
    const ausgabe: string[] = [];
    const code = await cliAusfuehren(
      ['api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben', '--scope', 'agenten_schreiben', '--scope', 'eingriff_verwalten'],
      { pool, basisUrl: BASIS_URL, ausgabe: (text) => ausgabe.push(text), fehlerausgabe: (text) => ausgabe.push(text) },
    );
    agentToken = /cpk_[A-Za-z0-9_-]{43}/.exec(ausgabe.join('\n'))?.[0] ?? '';

    expect(code).toBe(0);
    const ping = await agent('GET', '/ping');
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toEqual({ status: 'ok', name: 'admin-agent', scopes: ['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten'] });
  });

  it('2. Der Agent meldet das Inventar; die Seite Agenten zeigt es', async () => {
    const antwort = await agent('PUT', '/agenten', {
      agenten: [{ kennung: 'buchung', rolle: 'Buchungs-Agent', version: '1.2.0', grenzen: { 'darf stornieren': false }, zeitplan: [{ name: 'Anfragen prüfen', wann: 'alle 5 Minuten' }] }],
    });

    expect(antwort.statusCode).toBe(200);
    expect((await seite('mitarbeiter', '/agenten')).body).toContain('Buchungs-Agent');
  });

  it('3. Ein Container stoppt: der Befund erscheint als rote Kachel — für den Kunden im Klartext, für den Betreuer roh', async () => {
    const gesund = await agent('POST', '/befund', {
      wache: 'buchung-container', status: 'gruen', text_intern: 'container buchung: running', takt_sekunden: 300,
      anzeigename: 'Buchungs-Agent', kundensichtbar: true, text_kunde: 'Die Buchungen laufen.',
    });
    const gestoppt = await agent('POST', '/befund', {
      wache: 'buchung-container', status: 'rot', text_intern: 'container buchung: exited (137)',
      kundensichtbar: true, text_kunde: 'Die Buchungen sind gerade nicht erreichbar.',
    });

    expect([gesund.statusCode, gestoppt.statusCode]).toEqual([201, 201]);
    const kunde = (await seite('mitarbeiter', '/')).body;
    expect(kachelFarbe(kunde, 'Buchungs-Agent')).toBe('rot');
    expect(kunde).toContain('Die Buchungen sind gerade nicht erreichbar.');
    expect(kunde).not.toContain('exited (137)');
    const betreuer = (await seite('betreuer', '/')).body;
    expect(betreuer).toContain('container buchung: exited (137)');
  });

  it('4. Eine Wache bleibt aus: ihre Kachel wird gelb, „zuletzt geprüft" sagt, wie lange schon', async () => {
    const gemeldet = await agent('POST', '/befund', {
      wache: 'datensicherung', status: 'gruen', text_intern: 'backup ok', takt_sekunden: 3600,
      anzeigename: 'Datensicherung', kundensichtbar: true, text_kunde: 'Die Datensicherung ist aktuell.',
    });
    expect(gemeldet.statusCode).toBe(201);
    expect(kachelFarbe((await seite('mitarbeiter', '/')).body, 'Datensicherung')).toBe('gruen');

    // Zwei Stunden ohne Meldung: länger als Takt (1 Std.) und Toleranz (30 Min.).
    versatzMs = 2 * 60 * 60_000;
    try {
      const html = (await seite('mitarbeiter', '/')).body;

      expect(kachelFarbe(html, 'Datensicherung')).toBe('gelb');
      expect(html).toContain('vor 2 Std. geprüft');
      // Eine Störung wird durch Schweigen nicht besser: der gestoppte Container bleibt rot.
      expect(kachelFarbe(html, 'Buchungs-Agent')).toBe('rot');
    } finally {
      versatzMs = 0;
    }
  });

  it('5. Der Betreuer beantragt ein Update: genau eine Zeile cockpit.eingriff, beantragt, mit dem Weg zurück', async () => {
    // Das laufende Cockpit hat sich beim Start gemeldet.
    await instanzMelden(pool, { version: '1.4.0+0123456', digest: LAUFEND }, new Date());

    await updateBeantragen(ZIEL);

    const zeilen = await pool.query<{ id: number; status: string; ziel_digest: string; digest_vorher: string }>(
      'SELECT id::int AS id, status, ziel_digest, digest_vorher FROM cockpit.eingriff',
    );
    expect(zeilen.rows).toHaveLength(1);
    expect(zeilen.rows[0]).toMatchObject({ status: 'beantragt', ziel_digest: ZIEL, digest_vorher: LAUFEND });
    antragNr = zeilen.rows[0]?.id ?? 0;
    expect((await seite('mitarbeiter', '/einstellungen')).body).toContain('<p class="bereich-satz">Update angefragt.</p>');
  });

  it('6. Der Agent holt den Antrag ab und meldet — nach Stefans Freigabe außerhalb des Cockpits — Freigabe und Start', async () => {
    const offen = await eingriffe('?status=beantragt');
    expect(offen.map((eingriff) => [eingriff.id, eingriff.ziel_digest, eingriff.digest_vorher])).toEqual([[antragNr, ZIEL, LAUFEND]]);

    const freigabe = await agent('POST', `/eingriffe/${String(antragNr)}/status`, { status: 'freigegeben', ziel_digest: ZIEL, ziel_version: '1.5.0' });
    const start = await agent('POST', `/eingriffe/${String(antragNr)}/status`, { status: 'laeuft' });

    expect([freigabe.statusCode, start.statusCode]).toEqual([200, 200]);
    expect((await seite('betreuer', '/einstellungen')).body).toContain('läuft: das Update wird gerade eingespielt.');
  });

  it('7. Ein Cockpit mit Ziel-Digest und Ziel-Version meldet sich beim Start: das Cockpit selbst setzt erledigt', async () => {
    // Der Agent kann erledigt nicht setzen.
    expect((await agent('POST', `/eingriffe/${String(antragNr)}/status`, { status: 'erledigt' })).statusCode).toBe(400);

    const ergebnis = await instanzMelden(pool, { version: '1.5.0+89abcde', digest: ZIEL }, new Date());

    expect(ergebnis).toEqual({ erledigt: antragNr });
    expect((await agent('GET', `/eingriffe/${String(antragNr)}`)).json()).toMatchObject({ eingriff: { status: 'erledigt' } });
    const betreuer = (await seite('betreuer', '/einstellungen')).body;
    expect(betreuer).toContain('<dd>1.5.0+89abcde</dd>');
    expect(betreuer).toContain('<dt>Stand</dt><dd>erledigt</dd>');
    expect(betreuer).toContain(`<dt>Weg zurück</dt><dd class="digest-wert"><code class="digest">${LAUFEND}</code></dd>`);
    expect((await seite('mitarbeiter', '/einstellungen')).body).toContain('<p class="bereich-satz">Aktuell.</p>');
  });

  it('8. Ein Update, das nicht ankommt, hängt nach 15 Minuten — die Wache des Agenten sieht es, der Agent meldet den Fehlschlag', async () => {
    await updateBeantragen(NOCH_EINS);
    const [antrag] = await eingriffe('?status=beantragt');
    const nr = antrag?.id ?? 0;
    await agent('POST', `/eingriffe/${String(nr)}/status`, { status: 'freigegeben', ziel_digest: NOCH_EINS, ziel_version: '1.6.0' });
    await agent('POST', `/eingriffe/${String(nr)}/status`, { status: 'laeuft' });

    versatzMs = 16 * 60_000;
    try {
      expect((await eingriffe('?status=haengt')).map((eingriff) => eingriff.id)).toEqual([nr]);
      expect((await seite('betreuer', '/einstellungen')).body).toContain('<span class="plakette plakette-rot">Update hängt</span>');

      const fehlschlag = await agent('POST', `/eingriffe/${String(nr)}/status`, { status: 'fehlgeschlagen' });

      expect(fehlschlag.statusCode).toBe(200);
    } finally {
      versatzMs = 0;
    }
    // Auch wenn die Seite ausfällt: die API sagt es.
    expect((await eingriffe('?status=fehlgeschlagen')).map((eingriff) => eingriff.id)).toEqual([nr]);
    expect((await seite('mitarbeiter', '/einstellungen')).body).toContain('Update fehlgeschlagen, Betreuer ist informiert.');
    // Der Weg zurück ist der laufende Digest aus dem erfolgreichen Update.
    expect((await seite('betreuer', '/einstellungen')).body).toContain(`<code class="digest">${ZIEL}</code>`);
  });

  it('9. Das Protokoll erzählt die Geschichte: Zugang, zwei Anträge, ihre Übergänge — ohne Digest und ohne Token', async () => {
    const eintraege = await protokollSeit(pool, marke);
    const geschichte = eintraege.map((eintrag) => eintrag.art).filter((art) => art.startsWith('update_') || art.startsWith('api_token_'));

    expect(geschichte).toEqual([
      'api_token_erzeugt',
      'update_beantragt',
      'update_freigegeben',
      'update_gestartet',
      'update_erledigt',
      'update_beantragt',
      'update_freigegeben',
      'update_gestartet',
      'update_fehlgeschlagen',
    ]);
    const alles = JSON.stringify(eintraege);
    expect(alles).not.toContain('sha256');
    expect(alles).not.toContain(agentToken);
  });
});
