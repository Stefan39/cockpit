/**
 * `mailBauen` (COPI-154): Text- und HTML-Teil entstehen aus denselben Absätzen. Die Funktion ist sonst nur indirekt über
 * die einzelnen Mails getestet; hier direkt, ohne Datenbank.
 */
import { describe, expect, it } from 'vitest';
import { mailBauen } from '../src/mail/mail-bauen.js';

const SCHLUSS = 'Diese Nachricht wurde automatisch erzeugt.';

describe('mailBauen', () => {
  it('übernimmt den Betreff unverändert', () => {
    expect(mailBauen('Ihr <Betreff> & "mehr"', ['Hallo']).betreff).toBe('Ihr <Betreff> & "mehr"');
  });

  it('rahmt den Text mit Anrede und Schlusssatz und trennt Absätze durch eine Leerzeile', () => {
    const { text } = mailBauen('Betreff', ['Erster Absatz', 'Zweiter Absatz']);

    expect(text.startsWith('Guten Tag,')).toBe(true);
    expect(text.endsWith(SCHLUSS)).toBe(true);
    expect(text).toBe(['Guten Tag,', 'Erster Absatz', 'Zweiter Absatz', SCHLUSS].join('\n\n'));
  });

  it('setzt einen Link-Absatz im Text als nackte URL und im HTML als Verweis', () => {
    const url = 'https://cockpit.example.org/weiter?x=1';
    const { text, html } = mailBauen('Betreff', ['Bitte öffnen:', { link: url }]);

    expect(text).toContain(`Bitte öffnen:\n\n${url}\n\n${SCHLUSS}`);
    expect(html).toContain(`<p><a href="${url}">${url}</a></p>`);
  });

  it('maskiert HTML-Sonderzeichen in Text und Link, im Text bleiben sie unverändert', () => {
    const link = 'https://cockpit.example.org/?a=1&b="2"<x>';
    const { text, html } = mailBauen('Betreff', ['Preis <5 & "gut"', { link }]);

    expect(html).toContain('<p>Preis &lt;5 &amp; &quot;gut&quot;</p>');
    const maskiert = 'https://cockpit.example.org/?a=1&amp;b=&quot;2&quot;&lt;x&gt;';
    expect(html).toContain(`<p><a href="${maskiert}">${maskiert}</a></p>`);
    expect(html).not.toContain('<x>');
    expect(text).toContain('Preis <5 & "gut"');
    expect(text).toContain(link);
  });

  it('erzeugt ein HTML-Dokument mit lang="de" und allen Absätzen', () => {
    const { html } = mailBauen('Betreff', ['Eins']);

    expect(html.startsWith('<!doctype html>\n<html lang="de">\n<body>')).toBe(true);
    expect(html.endsWith('</body>\n</html>')).toBe(true);
    expect(html).toContain('<p>Guten Tag,</p>');
    expect(html).toContain('<p>Eins</p>');
    expect(html).toContain(`<p>${SCHLUSS}</p>`);
  });
});
