/**
 * Die Hinweis-Mail nach einer Änderung an den zweiten Faktoren (COPI-94): gesiezt, mit Zeitpunkt in der Zeit des
 * Betriebs, ohne Link und ohne Code; der Gerätename wird im HTML-Teil maskiert.
 */
import { describe, expect, it } from 'vitest';
import { faktorMailBauen, type FaktorAenderung } from '../src/mail/faktor-mail.js';

const ZEITPUNKT = new Date('2026-10-03T12:34:00Z');

describe('faktorMailBauen', () => {
  it('meldet einen neuen Passkey mit Namen und Zeitpunkt (Europe/Berlin)', () => {
    const mail = faktorMailBauen({ art: 'passkey_hinzugefuegt', name: 'iPhone' }, ZEITPUNKT);

    expect(mail.betreff).toBe('Neuer Passkey für Ihren Cockpit-Zugang');
    expect(mail.text).toContain('wurde am 03.10.2026 um 14:34 Uhr ein neuer Passkey hinzugefügt („iPhone“).');
    expect(mail.text).toContain('Waren Sie das nicht, wenden Sie sich bitte sofort an Ihren Betriebs-Admin oder Ihren Betreuer.');
  });

  it.each<[FaktorAenderung, string]>([
    [{ art: 'passkey_entfernt', name: 'iMac' }, 'Passkey aus Ihrem Cockpit-Zugang entfernt'],
    [{ art: 'totp_hinzugefuegt' }, 'Authenticator-App für Ihren Cockpit-Zugang eingerichtet'],
    [{ art: 'totp_entfernt' }, 'Authenticator-App aus Ihrem Cockpit-Zugang entfernt'],
    [{ art: 'ersatzcodes_erneuert' }, 'Neue Ersatzcodes für Ihren Cockpit-Zugang'],
  ])('hat für %j den Betreff „%s“ und keinen Link', (aenderung, betreff) => {
    const mail = faktorMailBauen(aenderung, ZEITPUNKT);

    expect(mail.betreff).toBe(betreff);
    expect(mail.text).not.toMatch(/https?:/);
    expect(mail.html).not.toContain('<a ');
  });

  it('maskiert den Gerätenamen im HTML-Teil', () => {
    const mail = faktorMailBauen({ art: 'passkey_hinzugefuegt', name: '<b>Laptop</b>' }, ZEITPUNKT);

    expect(mail.html).toContain('&lt;b&gt;Laptop&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>Laptop');
  });
});
