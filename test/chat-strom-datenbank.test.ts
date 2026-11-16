/**
 * Server-Sent Events des Chats (COPI-56) gegen einen echten, lauschenden Server und die echte Datenbank.
 *
 * Geprüft wird, was ein Stream halten muss: nur mit Recht und nur der eigene Kanal, Ereignisse mit der Nachrichten-ID,
 * Verpasstes nach `Last-Event-ID` bzw. `?seit=` in der richtigen Reihenfolge und ohne Doppelte, Heartbeat, eine
 * Obergrenze je Konto, und nach dem Abbruch ist alles aufgeräumt. `app.inject` genügt dafür nicht — ein Stream endet
 * nie —, deshalb echte HTTP-Verbindungen. Läuft nur mit `TEST_DATABASE_URL` und räumt dort Chat und Konten ab.
 */
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { ChatEreignisse } from '../src/chat/ereignisse.js';
import { assistentKanal, nachrichtAnlegen, teamKanal, type Nachricht } from '../src/chat/nachricht-speicher.js';
import { buildApp } from '../src/server/app.js';
import { SICHERHEITS_KOPF } from '../src/server/sicherheit.js';
import { chatLeeren, FORMULAR_KOPF, formular, kontenLoeschen } from './hilfen.js';
import { ids, stromOeffnen, type Strom } from './strom-hilfe.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

describe.skipIf(!datenbankUrl)('Chat-Stream (echte Datenbank, echter Server)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let basis: string;
  let angemeldet: Zugang;
  const chatEreignisse = new ChatEreignisse();
  const offen: Strom[] = [];

  function als(benutzerId: string, rolle: Rolle | 'ohne' = 'betrieb_mitarbeiter'): void {
    angemeldet = { angemeldet: true, rolle: rolle === 'ohne' ? undefined : rolle, zweiterFaktorAktiv: true, benutzerId };
  }

  const oeffnen = (pfad: string, kopf: Record<string, string> = {}): Promise<Strom> => stromOeffnen(`${basis}${pfad}`, offen, kopf);

  async function nachricht(kanal: 'assistent' | 'team', absender: string, inhalt: string): Promise<Nachricht> {
    const kanalId = kanal === 'team' ? (await teamKanal(pool)).id : (await assistentKanal(pool, absender)).id;
    return nachrichtAnlegen(pool, { kanalId, absenderArt: 'mensch', absenderId: absender, inhalt });
  }

  /** Wartet, bis der Server den Abbruch bemerkt hat. */
  async function bisAbonnenten(anzahl: number): Promise<void> {
    for (let versuch = 0; versuch < 100 && chatEreignisse.anzahl !== anzahl; versuch++) {
      await new Promise((weiter) => setTimeout(weiter, 20));
    }
    expect(chatEreignisse.anzahl).toBe(anzahl);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    app = buildApp(
      { nodeEnv: 'test' },
      { pool, sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(angemeldet), chatEreignisse, chatPulsMs: 50 },
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    basis = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
  });

  beforeEach(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    for (const [id, name] of [
      ['anna', 'Anna Berg'],
      ['bert', 'Bert Vogt'],
    ]) {
      await pool.query(
        `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1 || '@example.org', $2, true, now(), now())`,
        [id, name],
      );
    }
    als('anna');
  });

  afterEach(async () => {
    for (const strom of offen.splice(0)) {
      strom.schliessen();
    }
    await bisAbonnenten(0);
  });

  afterAll(async () => {
    await app.close();
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.end();
  });

  it('antwortet ohne Recht mit der neutralen 404 und öffnet keinen Stream', async () => {
    als('anna', 'ohne');
    const strom = await oeffnen('/chat/ereignisse');

    expect(strom.status).toBe(404);
    expect(chatEreignisse.anzahl).toBe(0);
  });

  it('öffnet einen Stream, der nie aus dem Cache kommt und nichts puffert, mit Wiederverbindungshinweis', async () => {
    const strom = await oeffnen('/chat/team/ereignisse');

    expect(strom.status).toBe(200);
    expect(strom.kopf['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(strom.kopf['cache-control']).toBe('no-store, no-transform');
    expect(strom.kopf['x-accel-buffering']).toBe('no');
    // `hijack` umgeht die Haken: die Sicherheits-Header stehen trotzdem darin (COPI-93).
    expect(strom.kopf).toMatchObject(SICHERHEITS_KOPF);
    await strom.warten((text) => text.startsWith('retry: 5000\n\n'));
  });

  it('liefert eine neue Nachricht als escaptes HTML-Fragment mit ihrer ID — aus Sicht dessen, der zuhört', async () => {
    als('bert');
    const strom = await oeffnen('/chat/team/ereignisse');
    await bisAbonnenten(1);
    als('anna');

    const antwort = await app.inject({
      method: 'POST',
      url: '/chat/team',
      headers: { ...FORMULAR_KOPF, host: 'localhost:3000', origin: 'http://localhost:3000' },
      payload: formular({ inhalt: '<script>alert(1)</script>\nzweite Zeile' }),
    });
    expect(antwort.statusCode).toBe(303);

    const text = await strom.warten((t) => t.includes('event: nachricht'));
    const [id] = ids(text);
    expect(text).toContain(`id: ${String(id)}\nevent: nachricht\ndata: <article class="chat-nachricht" id="nachricht-${String(id)}">`);
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;\ndata: zweite Zeile');
    expect(text).not.toContain('<script>');
    expect(text).toContain('Anna Berg · <time');
  });

  it('liefert nur den eigenen Kanal: fremde Assistenten-Kanäle nie, den Team-Kanal nicht im Assistenten-Stream', async () => {
    const eigen = await oeffnen('/chat/ereignisse');
    als('bert');
    const fremd = await oeffnen('/chat/ereignisse');
    await bisAbonnenten(2);

    chatEreignisse.melden(await nachricht('assistent', 'anna', 'nur für Anna'));
    chatEreignisse.melden(await nachricht('team', 'anna', 'ans Team'));

    await eigen.warten((text) => text.includes('nur für Anna'));
    await new Promise((weiter) => setTimeout(weiter, 150));
    expect(eigen.text()).not.toContain('ans Team');
    expect(fremd.text()).not.toContain('nur für Anna');
    expect(ids(fremd.text())).toEqual([]);
  });

  it('liefert nach Last-Event-ID das Verpasste in Reihenfolge — und die Kopfzeile geht vor ?seit=', async () => {
    const [erste, zweite, dritte] = [
      await nachricht('team', 'bert', 'eins'),
      await nachricht('team', 'bert', 'zwei'),
      await nachricht('team', 'bert', 'drei'),
    ];

    const strom = await oeffnen(`/chat/team/ereignisse?seit=${String(dritte.id)}`, { 'last-event-id': String(erste.id) });

    const text = await strom.warten((t) => ids(t).length === 2);
    expect(ids(text)).toEqual([zweite.id, dritte.id]);
  });

  it('liefert beim ersten Öffnen ab ?seit= und ohne Angabe nur Neues', async () => {
    const erste = await nachricht('team', 'bert', 'eins');
    await nachricht('team', 'bert', 'zwei');

    const mitSeit = await oeffnen(`/chat/team/ereignisse?seit=${String(erste.id)}`);
    const ohne = await oeffnen('/chat/team/ereignisse');

    await mitSeit.warten((t) => t.includes('zwei'));
    await new Promise((weiter) => setTimeout(weiter, 150));
    expect(ids(ohne.text())).toEqual([]);
  });

  it('schickt keine Nachricht zweimal, auch wenn sie nach dem Nachliefern noch einmal gemeldet wird', async () => {
    const erste = await nachricht('team', 'bert', 'eins');
    const zweite = await nachricht('team', 'bert', 'zwei');
    const strom = await oeffnen('/chat/team/ereignisse', { 'last-event-id': String(erste.id) });
    await strom.warten((t) => ids(t).length === 1);

    chatEreignisse.melden(zweite);
    chatEreignisse.melden(erste);
    const dritte = await nachricht('team', 'bert', 'drei');
    chatEreignisse.melden(dritte);

    const text = await strom.warten((t) => t.includes('drei'));
    expect(ids(text)).toEqual([zweite.id, dritte.id]);
  });

  it('bittet ums Neuladen, wenn mehr verpasst ist, als eine Seite fasst', async () => {
    const team = await teamKanal(pool);
    await pool.query(
      `INSERT INTO cockpit.nachricht (kanal_id, absender_art, absender_id, inhalt) SELECT $1, 'mensch', 'bert', 'N' || i FROM generate_series(1, 60) i`,
      [team.id],
    );
    const erste = (await pool.query<{ id: number }>('SELECT min(id)::int AS id FROM cockpit.nachricht')).rows[0]?.id ?? 0;

    const strom = await oeffnen('/chat/team/ereignisse', { 'last-event-id': String(erste) });

    const text = await strom.warten((t) => t.includes('event: neuladen'));
    expect(ids(text)).toHaveLength(50);
  });

  it('schickt einen Heartbeat, solange nichts passiert', async () => {
    const strom = await oeffnen('/chat/ereignisse');
    await strom.warten((text) => text.includes(': puls\n\n'));
  });

  it('räumt nach dem Abbruch auf und lässt höchstens fünf Streams je Konto zu', async () => {
    const stroeme = await Promise.all([1, 2, 3, 4, 5].map(() => oeffnen('/chat/ereignisse')));
    await bisAbonnenten(5);

    const sechster = await oeffnen('/chat/ereignisse');
    expect(sechster.status).toBe(429);
    als('bert');
    expect((await oeffnen('/chat/ereignisse')).status).toBe(200);
    await bisAbonnenten(6);

    stroeme[0]?.schliessen();
    await bisAbonnenten(5);
    als('anna');
    expect((await oeffnen('/chat/ereignisse')).status).toBe(200);
  });
});
