/**
 * Mailversand über den vorhandenen mailcow-SMTP-Zugang (Architektur-Vorschlag
 * Abschnitt 2 und 7). Kein eigener Mail-Dienst, kein Queue-Dienst — ein
 * `nodemailer`-Transport, parametriert über Umgebungsvariablen.
 *
 * Konventionen aus Abschnitt 7 Punkt 3, die hier durchgesetzt werden:
 * - **Kein Anzeigename beim Absender.** `SMTP_FROM` wird auf die nackte
 *   Adresse reduziert; ein konfigurierter Anzeigename wird verworfen statt
 *   übernommen.
 * - Jede Nachricht hat einen Text- **und** einen HTML-Teil; beides ist im
 *   `Nachricht`-Typ Pflicht, ein Nur-HTML-Versand ist gar nicht formulierbar.
 *
 * Nicht protokolliert werden Empfänger und Inhalt: eine Einladungsmail trägt
 * ein gültiges Token, das nirgends in einen Log geraten darf.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { CockpitEnv } from '../server/env.js';

export interface Nachricht {
  readonly an: string;
  readonly betreff: string;
  readonly text: string;
  readonly html: string;
}

export interface Mailversand {
  senden(nachricht: Nachricht): Promise<void>;
}

export interface SmtpEinstellungen {
  readonly host: string;
  readonly port: number;
  readonly user: string | undefined;
  readonly pass: string | undefined;
  readonly from: string;
}

/**
 * Reduziert `Cockpit <cockpit@example.org>` auf `cockpit@example.org`.
 * Absenderadressen ohne Anzeigenamen bleiben unverändert.
 */
export function absenderOhneAnzeigename(from: string): string {
  const inSpitzklammern = /<([^>]+)>/.exec(from);
  return (inSpitzklammern?.[1] ?? from).trim();
}

/**
 * SMTP-Einstellungen aus der Umgebung. `SMTP_HOST` und `SMTP_FROM` sind die
 * beiden Pflichtwerte; fehlt einer, gibt es keinen Versand (und damit keine
 * Einladungsroute) statt eines halb konfigurierten Transports.
 */
export function smtpAusEnv(env: CockpitEnv): SmtpEinstellungen | undefined {
  if (!env.smtpHost || !env.smtpFrom) {
    return undefined;
  }
  return {
    host: env.smtpHost,
    port: env.smtpPort ?? 587,
    user: env.smtpUser,
    pass: env.smtpPass,
    from: absenderOhneAnzeigename(env.smtpFrom),
  };
}

/**
 * Baut den SMTP-Transport. Port 465 spricht TLS von Anfang an, 587/25
 * verhandeln über STARTTLS — `requireTLS` erzwingt dabei die Aufwertung,
 * damit die Zugangsdaten nie über eine offene Verbindung gehen.
 */
export function smtpTransportBauen(einstellungen: SmtpEinstellungen): Transporter {
  const sicher = einstellungen.port === 465;
  return nodemailer.createTransport({
    host: einstellungen.host,
    port: einstellungen.port,
    secure: sicher,
    requireTLS: !sicher,
    ...(einstellungen.user && einstellungen.pass
      ? { auth: { user: einstellungen.user, pass: einstellungen.pass } }
      : {}),
  });
}

/**
 * Verbindet einen Transport mit der festen Absenderadresse. Der Transport
 * wird hereingereicht, damit Tests denselben Weg mit dem
 * `jsonTransport`-Transport von nodemailer prüfen können, ohne dass dieser
 * Testpfad in der Anwendung selbst existiert.
 */
export function mailversandBauen(
  transporter: Transporter,
  absender: string,
): Mailversand {
  const from = absenderOhneAnzeigename(absender);
  return {
    async senden(nachricht: Nachricht): Promise<void> {
      await transporter.sendMail({
        from,
        to: nachricht.an,
        subject: nachricht.betreff,
        text: nachricht.text,
        html: nachricht.html,
      });
    },
  };
}

export function mailversandAusEnv(env: CockpitEnv): Mailversand | undefined {
  const einstellungen = smtpAusEnv(env);
  if (!einstellungen) {
    return undefined;
  }
  return mailversandBauen(smtpTransportBauen(einstellungen), einstellungen.from);
}
