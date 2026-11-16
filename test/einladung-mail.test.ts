/**
 * Inhalt und Versand der Einladungsmail.
 *
 * Der Versand läuft über den `jsonTransport` von nodemailer — einen
 * Test-Transport, der die fertige Nachricht als JSON zurückgibt, statt sie
 * zu verschicken. Es geht also nie eine Mail hinaus, und geprüft wird
 * trotzdem der Weg durch `mailversandBauen`, den auch die Anwendung nimmt.
 */
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { einladungsMailBauen, htmlMaskieren } from '../src/mail/einladung-mail.js';
import {
  absenderOhneAnzeigename,
  mailversandBauen,
  smtpAusEnv,
} from '../src/mail/versand.js';
import type { CockpitEnv } from '../src/server/env.js';

const EMPFAENGER = 'neue.kollegin@example.org';
const URL_MIT_TOKEN = 'https://cockpit.example.org/einladung/AbCdEf-1234_token';

interface JsonNachricht {
  readonly from: { address: string; name: string };
  readonly to: { address: string; name: string }[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

async function versandtNachricht(absender: string): Promise<JsonNachricht> {
  const transporter = nodemailer.createTransport({ jsonTransport: true });
  const versand = mailversandBauen(transporter, absender);
  let erfasst: JsonNachricht | undefined;

  const echteSendMail = transporter.sendMail.bind(transporter);
  transporter.sendMail = (async (optionen: Parameters<typeof echteSendMail>[0]) => {
    const info = await echteSendMail(optionen);
    erfasst = JSON.parse(String(info.message)) as JsonNachricht;
    return info;
  }) as typeof transporter.sendMail;

  const inhalt = einladungsMailBauen({ einladungsUrl: URL_MIT_TOKEN, gueltigStunden: 3 });
  await versand.senden({
    an: EMPFAENGER,
    betreff: inhalt.betreff,
    text: inhalt.text,
    html: inhalt.html,
  });

  if (!erfasst) {
    throw new Error('Der Test-Transport hat keine Nachricht erfasst.');
  }
  return erfasst;
}

describe('Inhalt der Einladungsmail', () => {
  const inhalt = einladungsMailBauen({ einladungsUrl: URL_MIT_TOKEN, gueltigStunden: 3 });

  it('siezt und duzt nirgends', () => {
    expect(inhalt.text).toContain('Guten Tag');
    expect(inhalt.text).toContain('Bitte legen Sie Ihr Passwort');
    for (const teil of [inhalt.text, inhalt.html]) {
      expect(teil).not.toMatch(/\bdu\b/i);
      expect(teil).not.toMatch(/\bdein/i);
      expect(teil).not.toMatch(/\bdich\b/i);
    }
  });

  it('nennt den Empfängerwert nirgends im Text', () => {
    expect(inhalt.text).not.toContain(EMPFAENGER);
    expect(inhalt.html).not.toContain(EMPFAENGER);
    expect(inhalt.betreff).not.toContain(EMPFAENGER);
    expect(inhalt.text).not.toContain('@example.org');
  });

  it('nennt die Gültigkeitsdauer von 3 Stunden und die Einlöse-Adresse', () => {
    expect(inhalt.text).toContain('3 Stunden gültig');
    expect(inhalt.html).toContain('3 Stunden gültig');
    expect(inhalt.text).toContain(URL_MIT_TOKEN);
    expect(inhalt.html).toContain(`href="${URL_MIT_TOKEN}"`);
  });

  it('maskiert HTML-bedeutsame Zeichen in der Adresse', () => {
    const boshaft = einladungsMailBauen({
      einladungsUrl: 'https://x.example/"><script>alert(1)</script>',
      gueltigStunden: 3,
    });

    expect(boshaft.html).not.toContain('<script>');
    expect(htmlMaskieren('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('Versand über den Test-Transport', () => {
  it('verschickt Text- und HTML-Teil an die Zieladresse', async () => {
    const nachricht = await versandtNachricht('cockpit@example.org');

    expect(nachricht.to[0]?.address).toBe(EMPFAENGER);
    expect(nachricht.subject).toBe('Ihr Zugang zum Cockpit');
    expect(nachricht.text).toContain(URL_MIT_TOKEN);
    expect(nachricht.html).toContain('<p>');
  });

  it('setzt keinen Anzeigenamen beim Absender', async () => {
    const nachricht = await versandtNachricht('Cockpit der Box <cockpit@example.org>');

    expect(nachricht.from.address).toBe('cockpit@example.org');
    expect(nachricht.from.name).toBe('');
  });
});

describe('SMTP-Einstellungen aus der Umgebung', () => {
  const basis: CockpitEnv = {
    nodeEnv: 'test',
    port: 3000,
    host: '0.0.0.0',
    databaseUrl: undefined,
    cockpitDomain: undefined,
    authSecret: undefined,
    smtpHost: undefined,
    smtpPort: undefined,
    smtpUser: undefined,
    smtpPass: undefined,
    smtpFrom: undefined,
    imageVersion: undefined,
    imageCommit: undefined,
    imageDigest: undefined,
    instanzName: undefined,
    koordinatorUrl: undefined,
    koordinatorGeheimnis: undefined,
    koordinatorFristSekunden: undefined,
    chatTageslimit: undefined,
    chatMailNachMinuten: undefined,
    vapidOeffentlich: undefined,
    vapidPrivat: undefined,
    vapidKontakt: undefined,
    wartungsfenster: 'di 07-09',
    pipelineGeheimnis: undefined,
  };

  it('ergibt ohne SMTP_HOST oder SMTP_FROM keinen Versand', () => {
    expect(smtpAusEnv(basis)).toBeUndefined();
    expect(smtpAusEnv({ ...basis, smtpHost: 'mail.example.org' })).toBeUndefined();
    expect(smtpAusEnv({ ...basis, smtpFrom: 'cockpit@example.org' })).toBeUndefined();
  });

  it('nimmt Port 587, solange SMTP_PORT fehlt, und kürzt den Absender', () => {
    const einstellungen = smtpAusEnv({
      ...basis,
      smtpHost: 'mail.example.org',
      smtpFrom: 'Cockpit <cockpit@example.org>',
    });

    expect(einstellungen?.port).toBe(587);
    expect(einstellungen?.from).toBe('cockpit@example.org');
    expect(einstellungen?.user).toBeUndefined();
  });

  it('lässt eine Adresse ohne Anzeigename unverändert', () => {
    expect(absenderOhneAnzeigename('cockpit@example.org')).toBe('cockpit@example.org');
  });
});
