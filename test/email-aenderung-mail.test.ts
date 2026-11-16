/**
 * Die Mails der Adressänderung (COPI-47): Konventionen wie bei der Einladung — Siezen, Text und HTML gleich, kein
 * Empfängerwert; der Hinweis an die bisherige Adresse nennt weder die neue Adresse noch einen Link.
 */
import { describe, expect, it } from 'vitest';
import { adressBestaetigungMailBauen, adressHinweisMailBauen } from '../src/mail/email-aenderung-mail.js';

const URL = `https://fewotest.example.com/email-bestaetigen/${'A'.repeat(43)}`;

describe('adressBestaetigungMailBauen', () => {
  const mail = adressBestaetigungMailBauen({ url: URL, gueltigStunden: 24 });

  it('trägt den Link in Text und HTML, verlinkt, und nennt die Gültigkeit', () => {
    expect(mail.betreff).toBe('Bitte bestätigen Sie Ihre neue E-Mail-Adresse');
    expect(mail.text).toContain(URL);
    expect(mail.html).toContain(`<a href="${URL}">${URL}</a>`);
    expect(mail.text).toContain('24 Stunden gültig');
    expect(mail.text.startsWith('Guten Tag,')).toBe(true);
  });

  it('siezt und enthält keine Adresse außer dem Link', () => {
    expect(mail.text).not.toMatch(/\bdu\b|\bdein/i);
    expect(mail.text.replace(URL, '')).not.toContain('@');
  });

  it('maskiert den Link im HTML', () => {
    const boese = adressBestaetigungMailBauen({ url: 'https://x.example/"><script>', gueltigStunden: 24 });

    expect(boese.html).not.toContain('<script>');
    expect(boese.html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('adressHinweisMailBauen', () => {
  const mail = adressHinweisMailBauen();

  it('sagt, dass eine neue Adresse eingetragen wurde und erst mit Bestätigung gilt — ohne Adresse, ohne Link', () => {
    expect(mail.text).toContain('wurde eine neue E-Mail-Adresse eingetragen');
    expect(mail.text).not.toContain('@');
    expect(mail.text).not.toContain('http');
    expect(mail.html).not.toContain('<a ');
  });

  it('hat einen HTML-Teil mit denselben Absätzen', () => {
    for (const absatz of mail.text.split('\n\n')) {
      expect(mail.html).toContain(`<p>${absatz}</p>`);
    }
  });
});
