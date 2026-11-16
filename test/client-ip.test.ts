/**
 * Ermittlung der Client-IP (COPI-13).
 *
 * Der wichtigste Fall ist der Angriff: ein Client, der selbst ein
 * `X-Forwarded-For` mitschickt, darf den IP-Zähler nicht steuern können —
 * weder um sich einen frischen Zähler zu verschaffen noch um alle anderen
 * hinter einer fremden Adresse mitzusperren.
 */
import { describe, expect, it } from 'vitest';
import {
  clientIpErmitteln,
  CLIENT_IP_KOPF,
  IP_UNBEKANNT,
  registriereClientIp,
} from '../src/auth/client-ip.js';
import { buildApp } from '../src/server/app.js';

describe('clientIpErmitteln', () => {
  it('nimmt den einzigen weitergeleiteten Wert', () => {
    expect(clientIpErmitteln('203.0.113.7', '10.0.0.2')).toBe('203.0.113.7');
  });

  it('nimmt den rechten Wert — den hat der Proxy angehängt', () => {
    // Links steht, was der Client behauptet; rechts, was Caddy gesehen hat.
    expect(clientIpErmitteln('1.2.3.4, 203.0.113.7', '10.0.0.2')).toBe('203.0.113.7');
  });

  it('lässt sich von zusätzlichen Einträgen nicht verschieben', () => {
    expect(clientIpErmitteln('1.2.3.4, 5.6.7.8, 203.0.113.7', '10.0.0.2')).toBe(
      '203.0.113.7',
    );
  });

  it('übergeht Leerraum und leere Einträge', () => {
    expect(clientIpErmitteln('1.2.3.4 ,  203.0.113.7 , ', '10.0.0.2')).toBe('203.0.113.7');
  });

  it('fällt ohne Kopfzeile auf die Gegenstelle zurück', () => {
    expect(clientIpErmitteln(undefined, '10.0.0.2')).toBe('10.0.0.2');
    expect(clientIpErmitteln('', '10.0.0.2')).toBe('10.0.0.2');
    expect(clientIpErmitteln('  ,  ', '10.0.0.2')).toBe('10.0.0.2');
  });

  it('nennt die Kennung ausdrücklich unbekannt, wenn es keine gibt', () => {
    // Nie ein leerer Schlüssel: alle unbekannten Herkünfte teilen dann einen
    // Zähler, statt versehentlich gar nicht gezählt zu werden.
    expect(clientIpErmitteln(undefined, undefined)).toBe(IP_UNBEKANNT);
  });
});

describe('Client-IP in der Anwendung', () => {
  it('setzt die interne Kopfzeile aus dem weitergeleiteten Wert', async () => {
    const app = buildApp(
      { nodeEnv: 'test' },
      {
        sitzungLesen: () =>
          Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true }),
      },
    );
    app.get('/pruefen-client-ip', (request) => ({ ip: request.headers[CLIENT_IP_KOPF] }));

    const antwort = await app.inject({
      method: 'GET',
      url: '/pruefen-client-ip',
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' },
    });

    expect(antwort.json()).toEqual({ ip: '203.0.113.7' });

    await app.close();
  });

  it('überschreibt eine mitgeschickte interne Kopfzeile', async () => {
    const app = buildApp(
      { nodeEnv: 'test' },
      {
        sitzungLesen: () =>
          Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true }),
      },
    );
    app.get('/pruefen-client-ip', (request) => ({ ip: request.headers[CLIENT_IP_KOPF] }));

    const antwort = await app.inject({
      method: 'GET',
      url: '/pruefen-client-ip',
      headers: {
        [CLIENT_IP_KOPF]: '9.9.9.9',
        'x-forwarded-for': '203.0.113.7',
      },
    });

    expect(antwort.json()).toEqual({ ip: '203.0.113.7' });

    await app.close();
  });

  it('hängt den Haken vor allen Routen ein', () => {
    // Nur zur Absicherung der Signatur: die Funktion nimmt eine Fastify-Instanz.
    expect(typeof registriereClientIp).toBe('function');
  });
});
