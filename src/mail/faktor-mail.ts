/**
 * Die Hinweis-Mail nach jeder Änderung an den zweiten Faktoren (COPI-94) — eine reine Funktion ohne Transport.
 *
 * Wer einen Passkey oder die Authenticator-App hinzufügt oder entfernt oder neue Ersatzcodes erzeugt, bekommt eine
 * Mail an die eigene Adresse. Wer die Änderung nicht selbst gemacht hat, soll es erfahren und sich melden können: das
 * ist der Sinn, nicht die Bestätigung. Deshalb ohne Link und ohne Code; der Gerätename steht drin (es ist die eigene
 * Adresse, und erst er macht die Mail verständlich). Konventionen wie in `einladung-mail.ts`: Siezen, Text- und
 * HTML-Teil aus denselben Absätzen.
 */
import { datumText, zeitText } from '../chat/ansicht.js';
import type { MailInhalt } from './einladung-mail.js';
import { mailBauen } from './mail-bauen.js';

export type FaktorAenderung =
  | { readonly art: 'passkey_hinzugefuegt'; readonly name: string }
  | { readonly art: 'passkey_entfernt'; readonly name: string }
  | { readonly art: 'totp_hinzugefuegt' }
  | { readonly art: 'totp_entfernt' }
  | { readonly art: 'ersatzcodes_erneuert' };

function was(aenderung: FaktorAenderung): { readonly betreff: string; readonly satz: string } {
  switch (aenderung.art) {
    case 'passkey_hinzugefuegt':
      return { betreff: 'Neuer Passkey für Ihren Cockpit-Zugang', satz: `ein neuer Passkey hinzugefügt („${aenderung.name}“). Mit ihm lässt sich der zweite Faktor bei der Anmeldung bestätigen.` };
    case 'passkey_entfernt':
      return { betreff: 'Passkey aus Ihrem Cockpit-Zugang entfernt', satz: `der Passkey „${aenderung.name}“ entfernt. Mit ihm ist keine Anmeldung mehr möglich.` };
    case 'totp_hinzugefuegt':
      return { betreff: 'Authenticator-App für Ihren Cockpit-Zugang eingerichtet', satz: 'eine Authenticator-App als zweiter Faktor eingerichtet.' };
    case 'totp_entfernt':
      return { betreff: 'Authenticator-App aus Ihrem Cockpit-Zugang entfernt', satz: 'die Authenticator-App als zweiter Faktor entfernt. Ihre Codes gelten nicht mehr.' };
    case 'ersatzcodes_erneuert':
      return { betreff: 'Neue Ersatzcodes für Ihren Cockpit-Zugang', satz: 'neue Ersatzcodes erzeugt. Alle bisherigen Ersatzcodes gelten nicht mehr.' };
  }
}

export function faktorMailBauen(aenderung: FaktorAenderung, zeitpunkt: Date): MailInhalt {
  const { betreff, satz } = was(aenderung);
  // `zeitText` mit sich selbst als „jetzt" liefert nur die Uhrzeit (der Tag steht davor ausgeschrieben).
  return mailBauen(betreff, [
    `für Ihren Zugang zum Cockpit der KI-Automatisierungs-Box wurde am ${datumText(zeitpunkt)} um ${zeitText(zeitpunkt, zeitpunkt)} Uhr ${satz}`,
    'Waren Sie das nicht, wenden Sie sich bitte sofort an Ihren Betriebs-Admin oder Ihren Betreuer.',
  ]);
}
