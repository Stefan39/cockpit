/**
 * Web Push (COPI-59) ohne Datenbank: Konfiguration aus der Umgebung, was einen Push auslöst, was darin steht (nie der
 * Text einer Nachricht), wie ein Gerät heißt, der CLI-Befehl `vapid-erzeugen` — und dass `web-push` mit einem Paar aus
 * `vapid-erzeugen` eine echte, verschlüsselte und signierte Anfrage baut.
 */
import { createECDH, randomBytes } from 'node:crypto';
import type pg from 'pg';
import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { geraetName, loestPushAus, pushAusUmgebung, pushRumpf, vapidErzeugen } from '../src/chat/push.js';
import type { Nachricht } from '../src/chat/nachricht-speicher.js';
import { cliAusfuehren } from '../src/cli/befehle.js';

const PAAR = vapidErzeugen();

function nachricht(teil: Partial<Nachricht> = {}): Nachricht {
  return {
    id: 1,
    kanalId: 1,
    absenderArt: 'agent',
    absenderId: undefined,
    absenderName: undefined,
    inhalt: 'GEHEIM: Familie Brandt, Kaution 500 €',
    dringend: false,
    antwortAuf: 1,
    erstelltAm: new Date(),
    geloeschtAm: undefined,
    ...teil,
  };
}

describe('pushAusUmgebung', () => {
  const umgebung = (oeffentlich?: string, privat?: string, kontakt?: string) => ({
    vapidOeffentlich: oeffentlich,
    vapidPrivat: privat,
    vapidKontakt: kontakt,
  });

  it('gibt ohne Schlüssel keinen Push', () => {
    expect(pushAusUmgebung(umgebung(), 'https://kunde.example.com')).toBeUndefined();
  });

  it('liest das Paar; ohne Kontakt gilt die Adresse des Cockpits (https), lokal eine mailto-Adresse', () => {
    expect(pushAusUmgebung(umgebung(PAAR.oeffentlich, PAAR.privat), 'https://kunde.example.com')).toEqual({
      oeffentlich: PAAR.oeffentlich,
      privat: PAAR.privat,
      kontakt: 'https://kunde.example.com',
    });
    expect(pushAusUmgebung(umgebung(PAAR.oeffentlich, PAAR.privat), 'http://localhost:3000')?.kontakt).toBe('mailto:cockpit@localhost');
    expect(pushAusUmgebung(umgebung(PAAR.oeffentlich, PAAR.privat, 'mailto:betrieb@example.org'), undefined)?.kontakt).toBe('mailto:betrieb@example.org');
  });

  it.each([
    ['nur der öffentliche Schlüssel', umgebung(PAAR.oeffentlich), 'gehören zusammen'],
    ['nur der private Schlüssel', umgebung(undefined, PAAR.privat), 'gehören zusammen'],
    ['vertauschte Schlüssel', umgebung(PAAR.privat, PAAR.oeffentlich), 'nicht die Form'],
    ['ein Kontakt ohne mailto/https', umgebung(PAAR.oeffentlich, PAAR.privat, 'http://example.org'), 'mailto: oder https://'],
  ])('hält den Start an bei %s — ohne einen Schlüssel zu nennen', (_fall, eingabe, meldung) => {
    let fehler: unknown;
    try {
      pushAusUmgebung(eingabe, undefined);
    } catch (grund) {
      fehler = grund;
    }
    expect(fehler).toBeInstanceOf(Error);
    expect((fehler as Error).message).toContain(meldung);
    expect((fehler as Error).message).not.toContain(PAAR.privat);
  });
});

describe('was einen Push auslöst und was darin steht', () => {
  it('löst bei einer Antwort des Koordinators und bei allem Dringenden aus, sonst nicht', () => {
    expect(loestPushAus(nachricht())).toBe(true);
    expect(loestPushAus(nachricht({ absenderArt: 'system', dringend: true }))).toBe(true);
    expect(loestPushAus(nachricht({ absenderArt: 'system' }))).toBe(false);
    expect(loestPushAus(nachricht({ absenderArt: 'mensch', absenderId: 'anna' }))).toBe(false);
  });

  it('trägt nur einen Hinweis — nie den Text der Nachricht, keine Adresse', () => {
    expect(JSON.parse(pushRumpf(nachricht()))).toEqual({ titel: 'Cockpit', text: 'Neue Antwort des Assistenten', ziel: 'chat' });
    expect(JSON.parse(pushRumpf(nachricht({ dringend: true })))).toEqual({ titel: 'Cockpit', text: 'Dringende Nachricht im Chat', ziel: 'chat' });
    expect(pushRumpf(nachricht())).not.toContain('GEHEIM');
  });
});

describe('geraetName', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc', 'Chrome, Edge oder Android'],
    ['https://web.push.apple.com/QGx…', 'iPhone, iPad oder Mac (Safari)'],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', 'Firefox'],
    ['https://wns2-par02p.notify.windows.com/w/?token=abc', 'Windows'],
    ['https://push.example.org/abc', 'Anderer Browser'],
    ['kein url', 'Unbekanntes Gerät'],
  ])('%s → %s', (endpoint, name) => {
    expect(geraetName(endpoint)).toBe(name);
  });
});

describe('vapid-erzeugen', () => {
  it('gibt ein gültiges Paar einmal aus, ohne Datenbank', async () => {
    const ausgabe: string[] = [];
    const code = await cliAusfuehren(['vapid-erzeugen'], {
      pool: undefined as unknown as pg.Pool,
      basisUrl: 'http://localhost:3000',
      ausgabe: (text) => ausgabe.push(text),
      fehlerausgabe: (text) => ausgabe.push(text),
    });

    expect(code).toBe(0);
    const text = ausgabe.join('\n');
    const oeffentlich = /COCKPIT_VAPID_PUBLIC_KEY=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
    const privat = /COCKPIT_VAPID_PRIVATE_KEY=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
    expect(pushAusUmgebung({ vapidOeffentlich: oeffentlich, vapidPrivat: privat, vapidKontakt: undefined }, undefined)).toMatchObject({ oeffentlich, privat });
  });

  it('nimmt keine Optionen an', async () => {
    const fehler: string[] = [];
    const code = await cliAusfuehren(['vapid-erzeugen', '--name', 'x'], {
      pool: undefined as unknown as pg.Pool,
      basisUrl: 'http://localhost:3000',
      ausgabe: () => undefined,
      fehlerausgabe: (text) => fehler.push(text),
    });
    expect(code).toBe(2);
  });
});

describe('web-push baut mit dem Paar eine echte Anfrage', () => {
  it('verschlüsselt (aes128gcm), signiert (VAPID mit unserem öffentlichen Schlüssel) — und der Klartext steht nirgends', () => {
    const geraet = createECDH('prime256v1');
    geraet.generateKeys();
    const abo = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/geraet-1',
      keys: { p256dh: geraet.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') },
    };
    const rumpf = pushRumpf(nachricht());

    const anfrage = webpush.generateRequestDetails(abo, rumpf, {
      vapidDetails: { subject: 'mailto:cockpit@localhost', publicKey: PAAR.oeffentlich, privateKey: PAAR.privat },
      TTL: 60,
    });

    expect(anfrage.method).toBe('POST');
    expect(anfrage.endpoint).toBe(abo.endpoint);
    expect(anfrage.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(anfrage.headers.Authorization)).toMatch(new RegExp(`^vapid t=[A-Za-z0-9_.-]+, k=${PAAR.oeffentlich}$`));
    expect(Buffer.isBuffer(anfrage.body)).toBe(true);
    expect((anfrage.body as Buffer).toString('latin1')).not.toContain('Neue Antwort');
  });
});
