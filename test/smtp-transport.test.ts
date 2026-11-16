/**
 * Der SMTP-Transport geht nie ohne TLS (COPI-67). `docs/installation.md` sagt deshalb, dass ein interner Relay ohne
 * Server-TLS kein gültiger `COCKPIT_SMTP_HOST` ist. Ändert sich das hier, stimmt die Anleitung nicht mehr.
 */
import { describe, expect, it } from 'vitest';
import { smtpTransportBauen } from '../src/mail/versand.js';

function optionen(port: number) {
  return smtpTransportBauen({ host: 'mail.example.test', port, user: undefined, pass: undefined, from: 'cockpit@example.test' }).options;
}

describe('smtpTransportBauen', () => {
  it('spricht auf 465 TLS von Anfang an', () => {
    expect(optionen(465)).toMatchObject({ secure: true, requireTLS: false });
  });

  it.each([25, 587, 2525])('verlangt auf Port %i STARTTLS, auch ohne Zugangsdaten', (port) => {
    expect(optionen(port)).toMatchObject({ secure: false, requireTLS: true });
  });
});
