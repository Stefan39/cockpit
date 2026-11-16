/**
 * Die Abnahme von E4 (COPI-61): der ganze Weg einer Frage an den Assistenten, gegen einen lauschenden Server und die
 * echte Datenbank — nur der Koordinator (n8n) und der Push-Dienst sind Fakes.
 *
 *   Frage im Browser → signierter Webhook an den Koordinator → Antwort über die Agenten-API (echte HTTP-Anfrage mit
 *   eigenem Zugang) → SSE-Ereignis im offenen Stream → Push an das Gerät (ohne Text) → Lesestand beim Öffnen des Chats
 *   → kein E-Mail-Zweitkanal für Gelesenes → das Tageslimit greift, und die Budget-Wache sieht es.
 *
 * Genau so beschreibt es `docs/koordinator-api.md`; Echte Geräte (Android, iPhone nach „Zum Home-Bildschirm") weist
 * FEWOTEST-69 nach, nicht dieser Test. Läuft nur mit `TEST_DATABASE_URL` und räumt dort Chat, Konten und Zugänge ab.
 */
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { ChatEreignisse } from '../src/chat/ereignisse.js';
import { signatur } from '../src/chat/koordinator.js';
import { ungeleseneGesamt } from '../src/chat/nachricht-speicher.js';
import { vapidErzeugen, type Versender } from '../src/chat/push.js';
import { aboSpeichern } from '../src/chat/push-speicher.js';
import { zweitkanalKandidaten } from '../src/chat/zweitkanal-speicher.js';
import { apiTokenAnlegen } from '../src/intern/token-speicher.js';
import { buildApp } from '../src/server/app.js';
import { chatLeeren, FORMULAR_KOPF, formular, kontenLoeschen } from './hilfen.js';
import { ids, stromOeffnen, type Strom } from './strom-hilfe.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HERKUNFT = { host: 'localhost:3000', origin: 'http://localhost:3000' };
const KOORDINATOR = { url: 'https://n8n.example.org/webhook/koordinator', geheimnis: 'ein-gemeinsames-geheimnis-mit-mehr-als-32-zeichen', fristMs: 120_000 };
const PAAR = vapidErzeugen();
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/geraet-anna-1';
const ANTWORT = 'Heute reisen 3 Gäste an: <b>Familie Brandt</b>.';

interface Webhook {
  readonly kopf: Record<string, string>;
  readonly rumpf: string;
}

/** Wartet, bis die Bedingung gilt (höchstens 2 s): Push und Stream laufen neben der Anfrage her. */
async function bis(bedingung: () => boolean): Promise<void> {
  for (let versuch = 0; versuch < 100 && !bedingung(); versuch++) {
    await new Promise((weiter) => setTimeout(weiter, 20));
  }
  expect(bedingung()).toBe(true);
}

describe.skipIf(!datenbankUrl)('Chat Ende zu Ende (echte Datenbank, echter Server, Fake-Koordinator und Fake-Push)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let basis: string;
  const offen: Strom[] = [];
  const angemeldet: Zugang = { angemeldet: true, rolle: 'betrieb_mitarbeiter', zweiterFaktorAktiv: true, benutzerId: 'anna' };
  const chatEreignisse = new ChatEreignisse();
  let webhooks: Webhook[];
  let pushes: { endpoint: string; rumpf: string }[];

  /** Der Fake-Koordinator: nimmt den Webhook an und quittiert sofort, wie n8n. */
  const holen = ((_url: string, init: RequestInit) => {
    webhooks.push({ kopf: init.headers as Record<string, string>, rumpf: String(init.body) });
    return Promise.resolve(new Response('', { status: 200 }));
  }) as unknown as typeof fetch;

  const pushVersender: Versender = (abo, rumpf) => {
    pushes.push({ endpoint: abo.endpoint, rumpf });
    return Promise.resolve({ statusCode: 201 });
  };

  function fragen(inhalt: string) {
    return app.inject({ method: 'POST', url: '/chat', headers: { ...FORMULAR_KOPF, ...HERKUNFT }, payload: formular({ inhalt }) });
  }

  /** Der Agentenlauf in n8n antwortet über die Agenten-API — über das Netz, wie im Betrieb. */
  function antworten(token: string, koerper: unknown): Promise<Response> {
    return fetch(`${basis}/intern/chat/antwort`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(koerper),
    });
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    app = buildApp(
      { nodeEnv: 'test' },
      {
        pool,
        sitzungLesen: MIT_FAKTOR,
        zugangLesen: () => Promise.resolve(angemeldet),
        koordinator: KOORDINATOR,
        holen,
        chatEreignisse,
        chatTageslimit: 2,
        push: { oeffentlich: PAAR.oeffentlich, privat: PAAR.privat, kontakt: 'mailto:cockpit@localhost' },
        pushVersender,
      },
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    basis = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
  });

  beforeEach(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.query(
      `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt") VALUES ('anna', 'anna@example.org', 'Anna Berg', true, now(), now())`,
    );
    webhooks = [];
    pushes = [];
  });

  afterEach(() => {
    for (const strom of offen.splice(0)) {
      strom.schliessen();
    }
  });

  afterAll(async () => {
    await app.close();
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.api_token');
    await pool.end();
  });

  it('Frage → Webhook → Antwort über die API → SSE → Push → Lesestand → Tageslimit', async () => {
    const koordinator = await apiTokenAnlegen(pool, { name: 'koordinator', scopes: ['chat_antworten', 'zustand_lesen'] });
    await aboSpeichern(pool, 'anna', { endpoint: ENDPOINT, p256dh: 'BNcR', auth: 'auth' });
    const strom = await stromOeffnen(`${basis}/chat/ereignisse`, offen);
    await bis(() => chatEreignisse.anzahl > 0);

    // 1. Die Frage: gespeichert, sofort zurück zum Chat.
    const gefragt = await fragen('Wer reist heute an?');
    expect(gefragt.statusCode).toBe(303);

    // 2. Der Webhook: signiert, mit genau dem Rumpf des Vertrags.
    expect(webhooks).toHaveLength(1);
    const [webhook] = webhooks;
    const zeitpunkt = Number(webhook?.kopf['x-cockpit-zeitpunkt']);
    expect(webhook?.kopf['x-cockpit-signatur']).toBe(signatur(KOORDINATOR.geheimnis, zeitpunkt, webhook?.rumpf ?? ''));
    const auftrag = JSON.parse(webhook?.rumpf ?? '{}') as { nachricht_id: number; kanal: string; benutzer: unknown; text: string };
    expect(auftrag).toMatchObject({ kanal: 'assistent', benutzer: { id: 'anna', rolle: 'betrieb_mitarbeiter', name: 'Anna Berg' }, text: 'Wer reist heute an?' });

    // 3. Die Antwort des Agentenlaufs, dringend — und eine Wiederholung desselben Laufs wird abgewiesen.
    const beantwortet = await antworten(koordinator.token, { nachricht_id: auftrag.nachricht_id, text: ANTWORT, dringend: true });
    expect(beantwortet.status).toBe(201);
    const { id: antwortId } = (await beantwortet.json()) as { id: number };
    expect((await antworten(koordinator.token, { nachricht_id: auftrag.nachricht_id, text: 'nochmal' })).status).toBe(409);

    // 4. Im offenen Stream: erst die Frage, dann die Antwort — escaped.
    const text = await strom.warten((bisher) => ids(bisher).includes(antwortId));
    expect(ids(text)).toEqual([auftrag.nachricht_id, antwortId]);
    expect(text).toContain('&lt;b&gt;Familie Brandt&lt;/b&gt;');
    expect(text).not.toContain('<b>Familie Brandt</b>');

    // 5. Push an das Gerät der Fragenden, ohne den Text.
    await bis(() => pushes.length > 0);
    expect(pushes.map((push) => push.endpoint)).toEqual([ENDPOINT]);
    expect(pushes[0]?.rumpf).not.toContain('Brandt');

    // 6. Ungelesen, bis der Chat geöffnet wird; dann gelesen — und der E-Mail-Zweitkanal hat nichts zu melden.
    expect(await ungeleseneGesamt(pool, 'anna')).toBe(1);
    expect(await zweitkanalKandidaten(pool, new Date(Date.now() + 60 * 60 * 1000))).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/chat' })).statusCode).toBe(200);
    expect(await ungeleseneGesamt(pool, 'anna')).toBe(0);
    expect(await zweitkanalKandidaten(pool, new Date(Date.now() + 60 * 60 * 1000))).toEqual([]);

    // 7. Das Tageslimit (hier 2): die zweite Frage geht noch, die dritte nicht — nicht gespeichert, nicht weitergeleitet.
    expect((await fragen('Und morgen?')).statusCode).toBe(303);
    const abgewiesen = await fragen('Und übermorgen?');
    expect(abgewiesen.statusCode).toBe(429);
    expect(abgewiesen.body).toContain('Das Tageslimit von 2 Nachrichten an den Assistenten ist erreicht.');
    expect(webhooks).toHaveLength(2);
    const gespeichert = await pool.query<{ anzahl: number }>(`SELECT count(*)::int AS anzahl FROM cockpit.nachricht WHERE absender_art = 'mensch'`);
    expect(gespeichert.rows[0]?.anzahl).toBe(2);

    // 8. Die Budget-Wache sieht den Verbrauch — nur Summen.
    const verbrauch = await fetch(`${basis}/intern/chat/verbrauch?tage=1`, { headers: { authorization: `Bearer ${koordinator.token}` } });
    expect(verbrauch.status).toBe(200);
    expect(await verbrauch.json()).toMatchObject({ limit: 2, tage: [{ nachrichten: 2, benutzer: 1, am_limit: 1 }] });
  });
});
