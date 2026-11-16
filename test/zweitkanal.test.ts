/**
 * Die reinen Teile des E-Mail-Zweitkanals (COPI-60): wer wann eine Mail bekommt, und was darin steht — nie der Inhalt
 * der Nachricht.
 */
import { describe, expect, it } from 'vitest';
import { faelligeMails, ZWEITKANAL_DROSSEL_MS } from '../src/chat/zweitkanal.js';
import type { ZweitkanalKandidat } from '../src/chat/zweitkanal-speicher.js';
import { zweitkanalMailBauen } from '../src/mail/zweitkanal-mail.js';

const JETZT = new Date('2026-09-23T12:00:00.000Z');
const REGELN = { fristMs: 15 * 60 * 1000, drosselMs: ZWEITKANAL_DROSSEL_MS };

function vorMinuten(minuten: number): Date {
  return new Date(JETZT.getTime() - minuten * 60 * 1000);
}

function kandidat(nachrichtId: number, benutzerId: string, alterMinuten: number, letzteMailVorMinuten?: number): ZweitkanalKandidat {
  return {
    nachrichtId,
    benutzerId,
    erstelltAm: vorMinuten(alterMinuten),
    letzteMail: letzteMailVorMinuten === undefined ? undefined : vorMinuten(letzteMailVorMinuten),
  };
}

describe('faelligeMails', () => {
  it('meldet nichts ohne Kandidaten', () => {
    expect(faelligeMails([], JETZT, REGELN)).toEqual([]);
  });

  it.each([
    ['vor der Frist', 14.99, []],
    ['genau an der Frist', 15, [{ benutzerId: 'anna', nachrichtIds: [1] }]],
    ['nach der Frist', 60, [{ benutzerId: 'anna', nachrichtIds: [1] }]],
  ])('%s', (_fall, alter, erwartet) => {
    expect(faelligeMails([kandidat(1, 'anna', alter)], JETZT, REGELN)).toEqual(erwartet);
  });

  it('fasst die fälligen Nachrichten eines Kontos in einer Mail zusammen und lässt die noch nicht fälligen liegen', () => {
    const kandidaten = [kandidat(3, 'anna', 20), kandidat(1, 'anna', 40), kandidat(4, 'anna', 5), kandidat(2, 'bert', 16)];
    expect(faelligeMails(kandidaten, JETZT, REGELN)).toEqual([
      { benutzerId: 'anna', nachrichtIds: [1, 3] },
      { benutzerId: 'bert', nachrichtIds: [2] },
    ]);
  });

  it('drosselt auf eine Mail je Konto und Stunde — die übrigen Konten nicht', () => {
    const kandidaten = [kandidat(1, 'anna', 30, 59), kandidat(2, 'bert', 30, 60), kandidat(3, 'carl', 30, 120)];
    expect(faelligeMails(kandidaten, JETZT, REGELN)).toEqual([
      { benutzerId: 'bert', nachrichtIds: [2] },
      { benutzerId: 'carl', nachrichtIds: [3] },
    ]);
  });

  it('richtet sich nach dem übergebenen Zeitpunkt, nicht nach der Uhr', () => {
    const spaeter = new Date(JETZT.getTime() + 10 * 60 * 1000);
    expect(faelligeMails([kandidat(1, 'anna', 10)], JETZT, REGELN)).toEqual([]);
    expect(faelligeMails([kandidat(1, 'anna', 10)], spaeter, REGELN)).toEqual([{ benutzerId: 'anna', nachrichtIds: [1] }]);
  });
});

describe('zweitkanalMailBauen', () => {
  const URL = 'https://cockpit.example.org/chat';

  it('nennt Anzahl, Frist und den Link, in Text und HTML', () => {
    const mail = zweitkanalMailBauen({ url: URL, anzahl: 1, fristMinuten: 15 });
    expect(mail.betreff).toBe('Eine dringende Nachricht wartet im Cockpit');
    expect(mail.text).toContain('wartet eine dringende Nachricht auf Sie, seit mehr als 15 Minuten ungelesen');
    expect(mail.text).toContain(URL);
    expect(mail.html).toContain(`<a href="${URL}">${URL}</a>`);
    expect(mail.text).toContain('höchstens eine solche E-Mail je Stunde');
  });

  it('spricht bei mehreren Nachrichten von mehreren', () => {
    const mail = zweitkanalMailBauen({ url: URL, anzahl: 3, fristMinuten: 20 });
    expect(mail.betreff).toBe('Dringende Nachrichten warten im Cockpit');
    expect(mail.text).toContain('warten 3 dringende Nachrichten auf Sie, seit mehr als 20 Minuten ungelesen');
  });

  it('sagt, dass der Inhalt nicht in der Mail steht', () => {
    expect(zweitkanalMailBauen({ url: URL, anzahl: 1, fristMinuten: 15 }).text).toContain(
      'Aus Sicherheitsgründen steht der Inhalt nicht in dieser E-Mail',
    );
  });
});
