/**
 * Text- und HTML-Teil einer Mail aus denselben Absätzen (COPI-47, seit COPI-60 für mehrere Mails): so können sie nicht
 * auseinanderlaufen. Anrede und Schlusssatz sind fest; Konventionen wie in `einladung-mail.ts`.
 */
import { htmlMaskieren, type MailInhalt } from './einladung-mail.js';

/** Ein Absatz der Mail: Text, oder ein Link, der in HTML verlinkt wird. */
export type Absatz = string | { readonly link: string };

/** Baut Text- und HTML-Teil aus denselben Absätzen: so können sie nicht auseinanderlaufen. */
export function mailBauen(betreff: string, absaetze: readonly Absatz[]): MailInhalt {
  const alle: readonly Absatz[] = ['Guten Tag,', ...absaetze, 'Diese Nachricht wurde automatisch erzeugt.'];
  const text = alle.map((absatz) => (typeof absatz === 'string' ? absatz : absatz.link)).join('\n\n');
  const html = [
    '<!doctype html>',
    '<html lang="de">',
    '<body>',
    ...alle.map((absatz) => {
      if (typeof absatz === 'string') {
        return `<p>${htmlMaskieren(absatz)}</p>`;
      }
      const url = htmlMaskieren(absatz.link);
      return `<p><a href="${url}">${url}</a></p>`;
    }),
    '</body>',
    '</html>',
  ].join('\n');
  return { betreff, text, html };
}
