/**
 * Inhalt der Einladungsmail (Architektur-Vorschlag Abschnitt 7 Punkt 3).
 *
 * Bewusst eine reine Funktion ohne Transport: der Text ist damit ohne
 * Mailversand prüfbar, und die Konventionen stehen an einer Stelle.
 *
 * Konventionen, die hier eingehalten sind:
 * - **Siezen.** Keine Du-Ansprache, kein Vorname.
 * - **Text- und HTML-Teil**, inhaltlich gleich.
 * - **Kein Empfängerwert im Text.** Die Zieladresse taucht in der Nachricht
 *   nicht auf — sie steht im Umschlag und sonst nirgends. Eine
 *   weitergeleitete Mail gibt damit nicht preis, für wen der Zugang gedacht
 *   ist.
 * - Kein Anzeigename beim Absender — das setzt `versand.ts` durch.
 */

export interface EinladungsMailDaten {
  /** Vollständige Einlöse-Adresse inklusive Token. */
  readonly einladungsUrl: string;
  /** Gültigkeitsdauer in Stunden, wie sie im Text genannt wird. */
  readonly gueltigStunden: number;
}

export interface MailInhalt {
  readonly betreff: string;
  readonly text: string;
  readonly html: string;
}

/**
 * Maskiert die fünf in HTML bedeutsamen Zeichen. Die Einlöse-Adresse besteht
 * zwar aus Basis-URL und base64url-Token und enthält keines davon — maskiert
 * wird trotzdem, damit eine später konfigurierbare Basis-URL das HTML nicht
 * aufbrechen kann.
 */
export function htmlMaskieren(wert: string): string {
  return wert
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function einladungsMailBauen(daten: EinladungsMailDaten): MailInhalt {
  const stunden = String(daten.gueltigStunden);
  const url = daten.einladungsUrl;
  const maskierteUrl = htmlMaskieren(url);

  const text = [
    'Guten Tag,',
    '',
    'für Sie wurde ein Zugang zum Cockpit der KI-Automatisierungs-Box',
    'eingerichtet. Bitte legen Sie Ihr Passwort über die folgende Adresse',
    'selbst fest:',
    '',
    url,
    '',
    `Die Adresse ist ${stunden} Stunden gültig und lässt sich nur einmal`,
    'verwenden. Ist sie abgelaufen, bitten Sie bitte um eine neue Einladung.',
    '',
    'Im Anschluss richten Sie einen zweiten Faktor ein; ohne ihn bleibt der',
    'Zugang gesperrt.',
    '',
    'Haben Sie diese Einladung nicht erwartet, können Sie diese Nachricht',
    'ignorieren. Ohne die Adresse oben entsteht kein Zugang.',
    '',
    'Diese Nachricht wurde automatisch erzeugt.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="de">',
    '<body>',
    '<p>Guten Tag,</p>',
    '<p>für Sie wurde ein Zugang zum Cockpit der KI-Automatisierungs-Box',
    'eingerichtet. Bitte legen Sie Ihr Passwort über die folgende Adresse',
    'selbst fest:</p>',
    `<p><a href="${maskierteUrl}">${maskierteUrl}</a></p>`,
    `<p>Die Adresse ist ${stunden} Stunden gültig und lässt sich nur einmal`,
    'verwenden. Ist sie abgelaufen, bitten Sie bitte um eine neue Einladung.</p>',
    '<p>Im Anschluss richten Sie einen zweiten Faktor ein; ohne ihn bleibt der',
    'Zugang gesperrt.</p>',
    '<p>Haben Sie diese Einladung nicht erwartet, können Sie diese Nachricht',
    'ignorieren. Ohne die Adresse oben entsteht kein Zugang.</p>',
    '<p>Diese Nachricht wurde automatisch erzeugt.</p>',
    '</body>',
    '</html>',
  ].join('\n');

  return { betreff: 'Ihr Zugang zum Cockpit', text, html };
}
