/** Mailversand (COPI-11) — SMTP-Transport und Inhalt der Einladungsmail. */
export {
  absenderOhneAnzeigename,
  mailversandAusEnv,
  mailversandBauen,
  smtpAusEnv,
  smtpTransportBauen,
} from './versand.js';
export type { Mailversand, Nachricht, SmtpEinstellungen } from './versand.js';
export { einladungsMailBauen, htmlMaskieren } from './einladung-mail.js';
export type { EinladungsMailDaten, MailInhalt } from './einladung-mail.js';
