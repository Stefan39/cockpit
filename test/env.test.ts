import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instanzNameAus, loadEnv } from '../src/server/env.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('loadEnv', () => {
  it('setzt sinnvolle Defaults ohne Umgebungsvariablen', () => {
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.NODE_ENV;

    const env = loadEnv();

    expect(env.port).toBe(3000);
    expect(env.host).toBe('0.0.0.0');
    expect(env.nodeEnv).toBe('development');
  });

  it('lehnt einen ungültigen PORT-Wert ab', () => {
    process.env.PORT = 'nicht-numerisch';

    expect(() => loadEnv()).toThrowError(/Ungültiger PORT-Wert/);
  });

  it('übernimmt einen gültigen PORT-Wert', () => {
    process.env.PORT = '4000';

    expect(loadEnv().port).toBe(4000);
  });
});

describe('COCKPIT_WARTUNGSFENSTER (COPI-235)', () => {
  it.each([undefined, ''])('gilt als di 07-09 bei %j', (wert) => {
    if (wert === undefined) {
      delete process.env.COCKPIT_WARTUNGSFENSTER;
    } else {
      process.env.COCKPIT_WARTUNGSFENSTER = wert;
    }

    expect(loadEnv().wartungsfenster).toBe('di 07-09');
  });

  it.each(['di 07-09', 'jederzeit'])('übernimmt %s', (wert) => {
    process.env.COCKPIT_WARTUNGSFENSTER = wert;

    expect(loadEnv().wartungsfenster).toBe(wert);
  });

  it.each(['  ', ' jederzeit ', 'jederzeit\n', ' di 07-09', 'Jederzeit'])('verhindert den Start bei %j: nur die exakten Werte gelten', (wert) => {
    process.env.COCKPIT_WARTUNGSFENSTER = wert;

    expect(() => loadEnv()).toThrowError(/COCKPIT_WARTUNGSFENSTER/);
  });

  it('verhindert den Start bei jedem anderen Wert, nennt Variable und erlaubte Werte, aber nicht die Eingabe', () => {
    process.env.COCKPIT_WARTUNGSFENSTER = 'immer-geheim-42';

    expect(() => loadEnv()).toThrowError(/COCKPIT_WARTUNGSFENSTER.*"di 07-09".*"jederzeit"/);
    expect(() => loadEnv()).not.toThrowError(/immer-geheim-42/);
  });
});

describe('instanzNameAus (COPI-43)', () => {
  it('übernimmt den Namen der Instanz, an den Rändern gekürzt', () => {
    expect(instanzNameAus('  Fewotest  ')).toBe('Fewotest');
  });

  it.each([undefined, '', '   '])('kennt ohne Angabe (%j) keinen Namen: die Seite zeigt dann keinen', (roh) => {
    expect(instanzNameAus(roh)).toBeUndefined();
  });

  it('kürzt einen zu langen Namen auf 40 Zeichen: es ist eine Beschriftung, kein Text', () => {
    expect(instanzNameAus('x'.repeat(60))).toBe('x'.repeat(40));
  });

  it('liest Adresse, Geheimnis und Frist des Koordinators (COPI-54)', () => {
    // Unabhängig von einer lokalen .env, die `./dev test` lädt.
    delete process.env.COCKPIT_KOORDINATOR_URL;
    delete process.env.COCKPIT_KOORDINATOR_SECRET;
    delete process.env.COCKPIT_KOORDINATOR_FRIST;
    expect(loadEnv()).toMatchObject({ koordinatorUrl: undefined, koordinatorGeheimnis: undefined, koordinatorFristSekunden: undefined });
    process.env.COCKPIT_KOORDINATOR_URL = 'http://n8n:5678/webhook/koordinator';
    process.env.COCKPIT_KOORDINATOR_SECRET = 'geheim';
    process.env.COCKPIT_KOORDINATOR_FRIST = '90';

    expect(loadEnv()).toMatchObject({
      koordinatorUrl: 'http://n8n:5678/webhook/koordinator',
      koordinatorGeheimnis: 'geheim',
      koordinatorFristSekunden: 90,
    });
    process.env.COCKPIT_KOORDINATOR_FRIST = 'bald';
    expect(() => loadEnv()).toThrow('COCKPIT_KOORDINATOR_FRIST');
  });

  it('liest das Tageslimit des Chats (COPI-57)', () => {
    delete process.env.COCKPIT_CHAT_TAGESLIMIT;
    expect(loadEnv().chatTageslimit).toBeUndefined();
    process.env.COCKPIT_CHAT_TAGESLIMIT = '80';
    expect(loadEnv().chatTageslimit).toBe(80);
    process.env.COCKPIT_CHAT_TAGESLIMIT = '0';
    expect(() => loadEnv()).toThrow('COCKPIT_CHAT_TAGESLIMIT');
  });

  it('liest die Frist des E-Mail-Zweitkanals (COPI-60)', () => {
    delete process.env.COCKPIT_CHAT_MAIL_NACH_MINUTEN;
    expect(loadEnv().chatMailNachMinuten).toBeUndefined();
    process.env.COCKPIT_CHAT_MAIL_NACH_MINUTEN = '30';
    expect(loadEnv().chatMailNachMinuten).toBe(30);
    process.env.COCKPIT_CHAT_MAIL_NACH_MINUTEN = 'bald';
    expect(() => loadEnv()).toThrow('COCKPIT_CHAT_MAIL_NACH_MINUTEN');
  });

  it('liest das VAPID-Paar und den Kontakt (COPI-59)', () => {
    process.env.COCKPIT_VAPID_PUBLIC_KEY = 'oeffentlich';
    process.env.COCKPIT_VAPID_PRIVATE_KEY = 'privat';
    process.env.COCKPIT_VAPID_KONTAKT = 'mailto:betrieb@example.org';
    expect(loadEnv()).toMatchObject({ vapidOeffentlich: 'oeffentlich', vapidPrivat: 'privat', vapidKontakt: 'mailto:betrieb@example.org' });
  });

  it('liest COCKPIT_INSTANZ_NAME', () => {
    process.env.COCKPIT_INSTANZ_NAME = 'Fewotest';

    expect(loadEnv().instanzName).toBe('Fewotest');
  });
});
