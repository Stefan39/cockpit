/**
 * Der Update-Antrag (COPI-40) — reine Funktionen: die strenge Form des Ziel-Digests und die Bestätigung, die die
 * Bestätigungsseite dem Formular mitgibt.
 *
 * Die Bestätigung ist ein HMAC über Konto, Ziel-Digest, laufenden Digest und Ablauf. Sie beweist, dass der zweite
 * Schritt von der Bestätigungsseite kommt, die **dieses** Konto für **dieses** Ziel und **diesen** Rückweg gesehen
 * hat — ein fremdes Formular kennt sie nicht (CSRF), ein nachträglich geänderter Digest passt nicht mehr, und nach
 * zehn Minuten ist sie verfallen.
 */
import { describe, expect, it } from 'vitest';
import {
  BESTAETIGUNG_GUELTIG_MS,
  bestaetigungAusstellen,
  bestaetigungPruefen,
  zielDigestAus,
} from '../src/status/update-antrag.js';

const JETZT = new Date('2026-09-21T12:00:00.000Z');
const LAUFEND = `sha256:${'9f'.repeat(32)}`;
const ZIEL = `sha256:${'e7'.repeat(32)}`;
const SCHLUESSEL = new Uint8Array(32).fill(7);
const ANTRAG = { kontoId: 'konto-1', ziel: ZIEL, vorher: LAUFEND };

describe('zielDigestAus', () => {
  it('nimmt einen vollständigen Digest an', () => {
    expect(zielDigestAus(ZIEL)).toBe(ZIEL);
  });

  it('nimmt Leerraum an den Rändern weg (beim Einfügen oft dabei)', () => {
    expect(zielDigestAus(`  ${ZIEL}\n`)).toBe(ZIEL);
  });

  it.each([
    ['ein Tag', 'latest'],
    ['eine Version', '1.5.0'],
    ['ein gekürzter Digest', 'sha256:e77b40'],
    ['63 Zeichen', `sha256:${'a'.repeat(63)}`],
    ['65 Zeichen', `sha256:${'a'.repeat(65)}`],
    ['Großbuchstaben', `sha256:${'A'.repeat(64)}`],
    ['ein anderes Verfahren', `sha512:${'a'.repeat(64)}`],
    ['ohne Präfix', 'a'.repeat(64)],
    ['ein Präfix in Großbuchstaben', `SHA256:${'a'.repeat(64)}`],
    ['ein Zeichen außerhalb von Hex', `sha256:${'g'.repeat(64)}`],
    ['ein Umbruch mittendrin', `sha256:${'a'.repeat(32)}\n${'a'.repeat(32)}`],
    ['ein Bild mit Digest', `ghcr.io/stefan39/cockpit@sha256:${'a'.repeat(64)}`],
    ['leer', ''],
  ])('weist %s ab', (_name, wert) => {
    expect(zielDigestAus(wert)).toBeUndefined();
  });

  it.each([undefined, null, 42, [ZIEL], { digest: ZIEL }])('weist %o ab: nur Text ist eine Eingabe', (wert) => {
    expect(zielDigestAus(wert)).toBeUndefined();
  });
});

describe('Bestätigung', () => {
  function ausgestellt(): { bis: string; token: string } {
    return bestaetigungAusstellen(SCHLUESSEL, ANTRAG, JETZT);
  }

  it('gilt für genau den Antrag, für den sie ausgestellt ist', () => {
    expect(bestaetigungPruefen(SCHLUESSEL, ausgestellt(), ANTRAG, JETZT)).toBe(true);
  });

  it('läuft nach zehn Minuten ab', () => {
    const eingabe = ausgestellt();
    const spaeter = (ms: number): Date => new Date(JETZT.getTime() + ms);

    expect(bestaetigungPruefen(SCHLUESSEL, eingabe, ANTRAG, spaeter(BESTAETIGUNG_GUELTIG_MS - 1))).toBe(true);
    expect(bestaetigungPruefen(SCHLUESSEL, eingabe, ANTRAG, spaeter(BESTAETIGUNG_GUELTIG_MS))).toBe(false);
    expect(BESTAETIGUNG_GUELTIG_MS).toBe(10 * 60_000);
  });

  it.each([
    ['ein anderes Konto', { ...ANTRAG, kontoId: 'konto-2' }],
    ['ein anderes Ziel', { ...ANTRAG, ziel: `sha256:${'e8'.repeat(32)}` }],
    ['ein anderer laufender Digest (inzwischen neu gestartet)', { ...ANTRAG, vorher: `sha256:${'9e'.repeat(32)}` }],
  ])('gilt nicht für %s', (_name, anderer) => {
    expect(bestaetigungPruefen(SCHLUESSEL, ausgestellt(), anderer, JETZT)).toBe(false);
  });

  it('gilt nicht mit einem anderen Schlüssel (etwa nach einem Neustart)', () => {
    expect(bestaetigungPruefen(new Uint8Array(32).fill(8), ausgestellt(), ANTRAG, JETZT)).toBe(false);
  });

  it('gilt nicht, wenn jemand den Ablauf verschiebt', () => {
    const { token } = ausgestellt();

    expect(bestaetigungPruefen(SCHLUESSEL, { token, bis: String(JETZT.getTime() + BESTAETIGUNG_GUELTIG_MS - 1) }, ANTRAG, JETZT)).toBe(false);
  });

  it('gilt nicht mit einem Ablauf, der weiter reicht als zehn Minuten — auch wenn er signiert wäre', () => {
    const bis = JETZT.getTime() + BESTAETIGUNG_GUELTIG_MS + 60_000;
    const weit = bestaetigungAusstellen(SCHLUESSEL, ANTRAG, new Date(bis - BESTAETIGUNG_GUELTIG_MS));

    expect(bestaetigungPruefen(SCHLUESSEL, weit, ANTRAG, JETZT)).toBe(false);
  });

  it.each<[string, (echt: { bis: string; token: string }) => { bis?: unknown; token?: unknown }]>([
    ['ohne Token', ({ bis }) => ({ bis })],
    ['mit leerem Token', ({ bis }) => ({ bis, token: '' })],
    ['mit verändertem Token', ({ bis, token }) => ({ bis, token: `${token.startsWith('A') ? 'B' : 'A'}${token.slice(1)}` })],
    ['mit gekürztem Token', ({ bis, token }) => ({ bis, token: token.slice(0, -1) })],
    ['mit Token als Liste', ({ bis, token }) => ({ bis, token: [token, token] })],
    ['ohne Ablauf', ({ token }) => ({ token })],
    ['mit Ablauf, der keine Zahl ist', ({ token }) => ({ bis: 'morgen', token })],
    ['mit Ablauf in wissenschaftlicher Schreibweise', ({ token }) => ({ bis: '1e20', token })],
  ])('gilt nicht %s', (_name, aendern) => {
    expect(bestaetigungPruefen(SCHLUESSEL, aendern(ausgestellt()), ANTRAG, JETZT)).toBe(false);
  });

  it('stellt je Antrag ein anderes Token aus', () => {
    const a = bestaetigungAusstellen(SCHLUESSEL, ANTRAG, JETZT).token;
    const b = bestaetigungAusstellen(SCHLUESSEL, { ...ANTRAG, ziel: `sha256:${'e8'.repeat(32)}` }, JETZT).token;

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
