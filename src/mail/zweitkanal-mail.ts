/**
 * Die Mail des Zweitkanals (COPI-60): eine dringende Nachricht im Chat ist seit der Frist ungelesen. Reine Funktion ohne
 * Transport, wie die übrigen Mails.
 *
 * **Kein Inhalt der Nachricht**, auch kein Betreff aus ihr: die Mail liegt außerhalb des geschützten Logins und wird
 * womöglich weitergeleitet. Sie sagt nur, dass etwas wartet, wie viel, und wo man es liest.
 */
import type { MailInhalt } from './einladung-mail.js';
import { mailBauen } from './mail-bauen.js';

export interface ZweitkanalMailDaten {
  /** Die Adresse des Assistenten-Kanals, `<basis>/chat`. */
  readonly url: string;
  /** Wie viele dringende Nachrichten die Mail meldet (mindestens 1). */
  readonly anzahl: number;
  /** Nach wie vielen Minuten ohne Lesen die Mail geht, wie im Text genannt. */
  readonly fristMinuten: number;
}

export function zweitkanalMailBauen(daten: ZweitkanalMailDaten): MailInhalt {
  const eine = daten.anzahl === 1;
  return mailBauen(eine ? 'Eine dringende Nachricht wartet im Cockpit' : 'Dringende Nachrichten warten im Cockpit', [
    `im Cockpit der KI-Automatisierungs-Box ${eine ? 'wartet eine dringende Nachricht' : `warten ${String(daten.anzahl)} dringende Nachrichten`} auf Sie, seit mehr als ${String(daten.fristMinuten)} Minuten ungelesen.`,
    'Aus Sicherheitsgründen steht der Inhalt nicht in dieser E-Mail. Sie lesen ihn nach der Anmeldung im Chat:',
    { link: daten.url },
    'Sie erhalten höchstens eine solche E-Mail je Stunde. Eine Nachricht, die Sie im Chat gelesen haben, meldet das Cockpit nicht mehr.',
  ]);
}
