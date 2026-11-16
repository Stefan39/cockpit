/**
 * Die Weiterleitung an den Koordinator (COPI-54): Konfiguration aus der Umgebung, Signatur, Weiterleiten gegen einen
 * Fake und gegen einen echten HTTP-Server, der wie n8n prüft — und der Stand der Antwort als reine Funktion.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  antwortStand,
  koordinatorAusUmgebung,
  rumpfBauen,
  signatur,
  weiterleiten,
  type Auftrag,
  type KoordinatorKonfiguration,
} from '../src/chat/koordinator.js';
import type { Nachricht } from '../src/chat/nachricht-speicher.js';

const GEHEIMNIS = 'ein-gemeinsames-geheimnis-mit-mehr-als-32-zeichen';
const KONFIGURATION: KoordinatorKonfiguration = { url: 'https://n8n.example.org/webhook/koordinator', geheimnis: GEHEIMNIS, fristMs: 120_000 };
const JETZT = new Date('2026-09-23T08:15:00.000Z');
const AUFTRAG: Auftrag = {
  nachrichtId: 17,
  benutzer: { id: 'anna', rolle: 'betrieb_mitarbeiter', name: 'Anna Berg' },
  text: 'Wie viele Gäste reisen heute an?',
  zeitpunkt: new Date('2026-09-23T08:14:59.000Z'),
};

describe('koordinatorAusUmgebung', () => {
  const umgebung = (url?: string, geheimnis?: string, frist?: number) => ({
    koordinatorUrl: url,
    koordinatorGeheimnis: geheimnis,
    koordinatorFristSekunden: frist,
  });

  it('gibt ohne Adresse und Geheimnis keinen Koordinator', () => {
    expect(koordinatorAusUmgebung(umgebung())).toBeUndefined();
    expect(koordinatorAusUmgebung(umgebung('  ', ''))).toBeUndefined();
  });

  it('liest Adresse, Geheimnis und Frist; ohne Frist gelten 120 Sekunden', () => {
    expect(koordinatorAusUmgebung(umgebung('http://n8n:5678/webhook/k', GEHEIMNIS))).toEqual({
      url: 'http://n8n:5678/webhook/k',
      geheimnis: GEHEIMNIS,
      fristMs: 120_000,
    });
    expect(koordinatorAusUmgebung(umgebung('https://n8n.example.org/webhook/k', GEHEIMNIS, 30))?.fristMs).toBe(30_000);
  });

  it.each([
    ['nur die Adresse', umgebung('https://n8n.example.org/webhook/k'), 'gehören zusammen'],
    ['nur das Geheimnis', umgebung(undefined, GEHEIMNIS), 'gehören zusammen'],
    ['eine ungültige Adresse', umgebung('kein url', GEHEIMNIS), 'keine gültige Adresse'],
    ['ein anderes Schema', umgebung('ftp://n8n.example.org/k', GEHEIMNIS), 'http:// oder https://'],
    ['ein zu kurzes Geheimnis', umgebung('https://n8n.example.org/k', 'kurz'), 'mindestens 32 Zeichen'],
  ])('hält den Start an bei %s', (_fall, eingabe, meldung) => {
    expect(() => koordinatorAusUmgebung(eingabe)).toThrow(meldung);
  });

  it('nennt das Geheimnis in keiner Fehlermeldung', () => {
    expect(() => koordinatorAusUmgebung(umgebung('ftp://x', GEHEIMNIS))).not.toThrow(GEHEIMNIS);
  });
});

describe('signatur und Rumpf', () => {
  it('signiert <zeitpunkt>.<rumpf> mit HMAC-SHA256 und schreibt sha256=<hex>', () => {
    const erwartet = createHmac('sha256', GEHEIMNIS).update('1790150100.{"a":1}').digest('hex');
    expect(signatur(GEHEIMNIS, 1790150100, '{"a":1}')).toBe(`sha256=${erwartet}`);
    expect(signatur(GEHEIMNIS, 1790150101, '{"a":1}')).not.toBe(`sha256=${erwartet}`);
    expect(signatur('ein-anderes-geheimnis-mit-mehr-als-32-zeichen', 1790150100, '{"a":1}')).not.toBe(`sha256=${erwartet}`);
  });

  it('trägt genau Nachricht, Kanal, Konto, Text und Zeitpunkt — nichts sonst', () => {
    expect(JSON.parse(rumpfBauen(AUFTRAG))).toEqual({
      nachricht_id: 17,
      kanal: 'assistent',
      benutzer: { id: 'anna', rolle: 'betrieb_mitarbeiter', name: 'Anna Berg' },
      text: 'Wie viele Gäste reisen heute an?',
      zeitpunkt: '2026-09-23T08:14:59.000Z',
    });
    expect(JSON.parse(rumpfBauen({ ...AUFTRAG, benutzer: { ...AUFTRAG.benutzer, name: undefined } })).benutzer.name).toBeNull();
  });
});

describe('weiterleiten (Fake)', () => {
  type Aufruf = { url: string; init: RequestInit };

  function fake(antwort: () => Promise<Response>): { holen: typeof fetch; aufrufe: Aufruf[] } {
    const aufrufe: Aufruf[] = [];
    const holen = ((url: string, init: RequestInit) => {
      aufrufe.push({ url, init });
      return antwort();
    }) as unknown as typeof fetch;
    return { holen, aufrufe };
  }

  it('schickt POST mit JSON, Zeitpunkt und Signatur, folgt keiner Umleitung, und meldet 2xx als angenommen', async () => {
    const { holen, aufrufe } = fake(() => Promise.resolve(new Response('ok', { status: 200 })));

    expect(await weiterleiten(KONFIGURATION, AUFTRAG, JETZT, { holen })).toEqual({ ok: true });

    const aufruf = aufrufe[0];
    expect(aufruf?.url).toBe(KONFIGURATION.url);
    expect(aufruf?.init).toMatchObject({ method: 'POST', redirect: 'error', body: rumpfBauen(AUFTRAG) });
    const kopf = aufruf?.init.headers as Record<string, string>;
    expect(kopf).toEqual({
      'content-type': 'application/json',
      'x-cockpit-zeitpunkt': '1790151300',
      'x-cockpit-signatur': signatur(GEHEIMNIS, 1790151300, rumpfBauen(AUFTRAG)),
    });
    expect(JSON.stringify(aufruf?.init)).not.toContain(GEHEIMNIS);
  });

  it.each([
    [500, { ok: false, grund: 'status', status: 500 }],
    [404, { ok: false, grund: 'status', status: 404 }],
    [401, { ok: false, grund: 'status', status: 401 }],
  ])('meldet eine Antwort mit %i als gescheitert', async (status, erwartet) => {
    const { holen } = fake(() => Promise.resolve(new Response('', { status })));
    expect(await weiterleiten(KONFIGURATION, AUFTRAG, JETZT, { holen })).toEqual(erwartet);
  });

  it('meldet einen Netzfehler, ohne zu werfen', async () => {
    const { holen } = fake(() => Promise.reject(new TypeError('fetch failed')));
    expect(await weiterleiten(KONFIGURATION, AUFTRAG, JETZT, { holen })).toEqual({ ok: false, grund: 'netz' });
  });

  it('bricht nach dem Zeitlimit ab und meldet es', async () => {
    const holen = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_erfuellt, abgelehnt) => {
        init.signal?.addEventListener('abort', () => {
          abgelehnt(init.signal?.reason);
        });
      })) as unknown as typeof fetch;

    expect(await weiterleiten(KONFIGURATION, AUFTRAG, JETZT, { holen, zeitlimitMs: 50 })).toEqual({ ok: false, grund: 'zeitlimit' });
  });
});

describe('weiterleiten (echter HTTP-Server, prüft wie n8n)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((fertig) => (server ? server.close(() => { fertig(); }) : fertig()));
    server = undefined;
  });

  /** Ein Webhook, der die Signatur prüft wie der Koordinator-Workflow: sonst 401. */
  async function webhook(): Promise<{ url: string; empfangen: { kopf: IncomingHttpHeaders; rumpf: string }[] }> {
    const empfangen: { kopf: IncomingHttpHeaders; rumpf: string }[] = [];
    server = createServer((anfrage, antwort) => {
      let rumpf = '';
      anfrage.on('data', (teil: Buffer) => (rumpf += teil.toString('utf8')));
      anfrage.on('end', () => {
        empfangen.push({ kopf: anfrage.headers, rumpf });
        const zeitpunkt = String(anfrage.headers['x-cockpit-zeitpunkt']);
        const erwartet = Buffer.from(signatur(GEHEIMNIS, Number(zeitpunkt), rumpf));
        const gemeldet = Buffer.from(String(anfrage.headers['x-cockpit-signatur']));
        const echt = erwartet.length === gemeldet.length && timingSafeEqual(erwartet, gemeldet);
        antwort.writeHead(echt ? 200 : 401).end();
      });
    });
    await new Promise<void>((bereit) => server?.listen(0, '127.0.0.1', bereit));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${String(port)}/webhook/koordinator`, empfangen };
  }

  it('kommt an und besteht die Prüfung; mit falschem Geheimnis nicht', async () => {
    const { url, empfangen } = await webhook();

    expect(await weiterleiten({ ...KONFIGURATION, url }, AUFTRAG, JETZT)).toEqual({ ok: true });
    expect(JSON.parse(empfangen[0]?.rumpf ?? '{}')).toMatchObject({ nachricht_id: 17, text: 'Wie viele Gäste reisen heute an?' });
    expect(empfangen[0]?.kopf.cookie).toBeUndefined();
    expect(empfangen[0]?.kopf.authorization).toBeUndefined();

    const falsch = { ...KONFIGURATION, url, geheimnis: 'ein-anderes-geheimnis-mit-mehr-als-32-zeichen' };
    expect(await weiterleiten(falsch, AUFTRAG, JETZT)).toEqual({ ok: false, grund: 'status', status: 401 });
  });
});

describe('antwortStand', () => {
  function nachricht(teil: Partial<Nachricht>): Nachricht {
    return {
      id: 1,
      kanalId: 1,
      absenderArt: 'mensch',
      absenderId: 'anna',
      absenderName: 'Anna',
      inhalt: 'Frage',
      dringend: false,
      antwortAuf: undefined,
      erstelltAm: new Date(JETZT.getTime() - 60_000),
      geloeschtAm: undefined,
      ...teil,
    };
  }

  it('wartet in der Frist, ist danach überfällig — genau ab der Frist', () => {
    expect(antwortStand([nachricht({})], JETZT, 120_000)).toBe('wartet');
    expect(antwortStand([nachricht({ erstelltAm: new Date(JETZT.getTime() - 119_999) })], JETZT, 120_000)).toBe('wartet');
    expect(antwortStand([nachricht({ erstelltAm: new Date(JETZT.getTime() - 120_000) })], JETZT, 120_000)).toBe('ueberfaellig');
  });

  it('steht nichts aus, wenn nach der Frage eine Antwort oder eine Meldung des Cockpits kam, oder es keine Frage gibt', () => {
    const frage = nachricht({ erstelltAm: new Date(JETZT.getTime() - 600_000) });
    expect(antwortStand([frage, nachricht({ id: 2, absenderArt: 'agent', absenderId: undefined, antwortAuf: 1 })], JETZT, 120_000)).toBeUndefined();
    expect(antwortStand([frage, nachricht({ id: 2, absenderArt: 'system', absenderId: undefined, antwortAuf: 1 })], JETZT, 120_000)).toBeUndefined();
    expect(antwortStand([], JETZT, 120_000)).toBeUndefined();
  });

  it('wartet auf keine Antwort zu einer als gelöscht markierten Frage', () => {
    expect(antwortStand([nachricht({ inhalt: undefined, geloeschtAm: JETZT })], JETZT, 120_000)).toBeUndefined();
  });
});
