/**
 * Die beiden Mails der Adressänderung (COPI-47) — reine Funktionen ohne Transport, wie die Einladungsmail.
 *
 *   * **An die neue Adresse:** der Link, der sie bestätigt. Erst damit gilt sie.
 *   * **An die bisherige Adresse:** ein Hinweis, dass eine neue eingetragen wurde — **ohne** die neue Adresse und ohne
 *     Link. Wer die Änderung nicht erwartet hat, soll es erfahren und sich melden können; eine weitergeleitete Mail
 *     verrät nichts.
 *
 * Konventionen wie in `einladung-mail.ts`: Siezen, Text- und HTML-Teil mit gleichem Inhalt, kein Empfängerwert im
 * Text, kein Anzeigename beim Absender (`versand.ts`).
 */
import type { MailInhalt } from './einladung-mail.js';
import { mailBauen } from './mail-bauen.js';

export interface BestaetigungsMailDaten {
  /** Die vollständige Adresse der Bestätigungsseite samt Token. */
  readonly url: string;
  readonly gueltigStunden: number;
}

export function adressBestaetigungMailBauen(daten: BestaetigungsMailDaten): MailInhalt {
  return mailBauen('Bitte bestätigen Sie Ihre neue E-Mail-Adresse', [
    'für Ihren Zugang zum Cockpit der KI-Automatisierungs-Box soll künftig diese E-Mail-Adresse gelten. Bitte bestätigen Sie das über die folgende Adresse:',
    { link: daten.url },
    `Die Adresse ist ${String(daten.gueltigStunden)} Stunden gültig und lässt sich nur einmal verwenden. Erst mit der Bestätigung gilt die neue E-Mail-Adresse; bis dahin melden Sie sich wie bisher an.`,
    'Haben Sie das nicht erwartet, können Sie diese Nachricht ignorieren. Ohne Bestätigung ändert sich nichts.',
  ]);
}

export function adressHinweisMailBauen(): MailInhalt {
  return mailBauen('Änderung Ihrer E-Mail-Adresse im Cockpit', [
    'für Ihren Zugang zum Cockpit der KI-Automatisierungs-Box wurde eine neue E-Mail-Adresse eingetragen. Sie gilt erst, wenn sie über einen Link bestätigt ist, der an die neue Adresse ging. Bis dahin bleibt alles, wie es ist.',
    'Haben Sie diese Änderung nicht erwartet, wenden Sie sich bitte an Ihren Betriebs-Admin oder Ihren Betreuer.',
  ]);
}
