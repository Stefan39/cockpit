import { describe, expect, it } from 'vitest';
import { qrCodeSvg } from '../src/auth/qr.js';
import { qrSvgLesen } from './qr-lesen.js';

const KURZ = 'otpauth://totp/Cockpit:a%40b.de?secret=JBSWY3DPEHPK3PXP&issuer=Cockpit';
// Länger, damit eine größere QR-Version entsteht.
const LANG =
  'otpauth://totp/Cockpit:eine.sehr.lange.adresse%40beispiel-betrieb.example.org' +
  '?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cockpit' +
  '&algorithm=SHA1&digits=6&period=30';

describe('qrCodeSvg', () => {
  it.each([
    ['kurze URI', KURZ],
    ['lange URI', LANG],
  ])('liefert einen QR-Code, der als %s exakt zurückgelesen wird', (_name, inhalt) => {
    const svg = qrCodeSvg(inhalt, 'QR-Code');

    expect(qrSvgLesen(svg)).toBe(inhalt);
  });

  it('hält eine Ruhezone von vier Modulen um den Code frei', () => {
    const svg = qrCodeSvg(KURZ, 'QR-Code');
    const groesse = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]);

    const reihen = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)].map((treffer) => ({
      x: Number(treffer[1]),
      y: Number(treffer[2]),
      breite: Number(treffer[3]),
    }));

    expect(reihen.length).toBeGreaterThan(0);
    expect(Math.min(...reihen.map((r) => r.x))).toBeGreaterThanOrEqual(4);
    expect(Math.min(...reihen.map((r) => r.y))).toBeGreaterThanOrEqual(4);
    expect(Math.max(...reihen.map((r) => r.x + r.breite))).toBeLessThanOrEqual(groesse - 4);
    expect(Math.max(...reihen.map((r) => r.y + 1))).toBeLessThanOrEqual(groesse - 4);
  });

  it('hat einen weißen Grund, damit der Code auch im dunklen Modus scannbar bleibt', () => {
    const svg = qrCodeSvg(KURZ, 'QR-Code');

    expect(svg).toMatch(/<rect [^>]*fill="#fff"/);
    expect(svg).toMatch(/<path [^>]*fill="#000"/);
  });

  it('ist für Screenreader beschriftet', () => {
    const svg = qrCodeSvg(KURZ, 'QR-Code für die Authenticator-App');

    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="QR-Code für die Authenticator-App"');
  });

  it('trägt kein style-Attribut: die Größe setzt das Stylesheet (COPI-30, Stil-Regel ohne unsafe-inline)', () => {
    const svg = qrCodeSvg(KURZ, 'QR-Code');

    expect(svg).not.toMatch(/\sstyle\s*=/i);
    expect(svg).toContain('viewBox=');
  });

  it('maskiert die Beschriftung, statt sie ins Markup zu übernehmen', () => {
    const svg = qrCodeSvg(KURZ, '"><script>alert(1)</script>');

    expect(svg).not.toContain('<script');
    expect(svg).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('enthält keine Verweise nach außen und kein Skript', () => {
    const svg = qrCodeSvg(KURZ, 'QR-Code');

    expect(svg).not.toMatch(/href|<script|<image|<foreignObject|on\w+=/i);
    // Einziger Fremdverweis ist der XML-Namensraum.
    expect([...svg.matchAll(/https?:\/\/[^"]+/g)].map((t) => t[0])).toEqual([
      'http://www.w3.org/2000/svg',
    ]);
  });

  it('verweigert leeren Inhalt, statt einen nutzlosen Code zu liefern', () => {
    expect(() => qrCodeSvg('', 'QR-Code')).toThrow();
  });
});
