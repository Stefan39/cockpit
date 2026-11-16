import { wartungsfensterAus, type Wartungsfenster } from '../status/wartungsfenster.js';

/**
 * Liest und validiert die Umgebungsvariablen, mit denen jede Kundeninstanz
 * das Cockpit parametriert (siehe Architektur-Vorschlag Abschnitt 3/13.3).
 * Bewusst keine Bibliothek dafür — wenige, klar benannte Variablen.
 */

export interface CockpitEnv {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string | undefined;
  readonly cockpitDomain: string | undefined;
  /**
   * Signiergeheimnis für Better Auth (Sitzungs-Cookies, Verifikationswerte).
   * In Produktion Pflicht — ohne gesetzten Wert startet das Cockpit nicht,
   * damit niemand versehentlich mit einem Wegwerf-Geheimnis produktiv geht.
   */
  readonly authSecret: string | undefined;
  /**
   * Zugang zum vorhandenen mailcow-SMTP (Architektur-Vorschlag Abschnitt 7).
   * Ohne `SMTP_HOST` und `SMTP_FROM` verschickt das Cockpit keine Mail und
   * bietet die Einladung gar nicht erst an — siehe `src/mail/versand.ts`.
   */
  readonly smtpHost: string | undefined;
  readonly smtpPort: number | undefined;
  readonly smtpUser: string | undefined;
  readonly smtpPass: string | undefined;
  readonly smtpFrom: string | undefined;
  /**
   * Selbstmeldung beim Start (COPI-39, `src/status/instanz.ts`): Version und Commit backt der Build ins Image
   * (Build-Argumente), den Digest setzt die Compose-Datei der Instanz — ein Image kann seinen eigenen Digest
   * nicht enthalten.
   */
  readonly imageVersion: string | undefined;
  readonly imageCommit: string | undefined;
  readonly imageDigest: string | undefined;
  /**
   * Name der Instanz, wie ihn der Prototyp unter der Wortmarke und über dem Seitentitel zeigt (etwa „MUSTERBETRIEB", COPI-43).
   * `COCKPIT_INSTANZ_NAME`, gesetzt beim Server-Setup; ohne Angabe zeigt die Seite keinen.
   */
  readonly instanzName: string | undefined;
  /**
   * Der Webhook des Koordinator-Agenten in n8n (COPI-54, `src/chat/koordinator.ts`): Adresse, gemeinsames Geheimnis für
   * die Signatur und die Frist, nach der eine ausbleibende Antwort sichtbar wird (Sekunden). Ohne Adresse und Geheimnis
   * gibt es keinen Assistenten; nur eines von beiden ist ein Fehler beim Start.
   */
  readonly koordinatorUrl: string | undefined;
  readonly koordinatorGeheimnis: string | undefined;
  readonly koordinatorFristSekunden: number | undefined;
  /**
   * Die Repo-Wache in n8n (COPI-139, `src/freigaben/repowache.ts`): Adresse und Bearer-Token der Freigabe-Inbox. Ohne
   * beide ist das Modul ausgeblendet. Der Token bleibt im Server und erreicht nie den Browser.
   */
  readonly repowacheUrl?: string | undefined;
  readonly repowacheToken?: string | undefined;
  /** Nachrichten an den Assistenten je Konto und Tag (COPI-57, `COCKPIT_CHAT_TAGESLIMIT`); ohne Angabe 50. */
  readonly chatTageslimit: number | undefined;
  /** E-Mail-Zweitkanal (COPI-60): nach wie vielen Minuten eine dringende, ungelesene Nachricht per E-Mail geht. */
  readonly chatMailNachMinuten: number | undefined;
  /**
   * Web Push (COPI-59): das VAPID-Paar aus `vapid-erzeugen` und optional der Kontakt für die Push-Dienste
   * (`mailto:` oder `https:`). Beide Schlüssel oder keiner; ohne sie gibt es auf der Instanz keinen Push.
   */
  readonly vapidOeffentlich: string | undefined;
  readonly vapidPrivat: string | undefined;
  readonly vapidKontakt: string | undefined;
  /** Wann das Cockpit automatisch ein Image-Update beantragt (COPI-235, `COCKPIT_WARTUNGSFENSTER`); ohne Angabe Dienstag 07–09. */
  readonly wartungsfenster: Wartungsfenster;
  /** Das gemeinsame Geheimnis des Pipeline-Runners (COPI-145); ohne Wert ist jede Anfrage an `/pipeline` 401. */
  readonly pipelineGeheimnis: string | undefined;
}

/** Längster Instanzname: eine Beschriftung, kein Text. */
const INSTANZ_NAME_HOECHSTENS = 40;

/** Der Instanzname, an den Rändern gekürzt; leer heißt keiner, zu lang wird gekürzt. */
export function instanzNameAus(roh: string | undefined): string | undefined {
  const name = (roh ?? '').trim().slice(0, INSTANZ_NAME_HOECHSTENS).trim();
  return name === '' ? undefined : name;
}

function readNodeEnv(): CockpitEnv['nodeEnv'] {
  const value = process.env.NODE_ENV;
  if (value === 'production' || value === 'test') {
    return value;
  }
  return 'development';
}

/** Positive Ganzzahl aus einer Umgebungsvariablen; leer bleibt leer. */
function readPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Ungültiger ${name}-Wert: "${raw}"`);
  }
  return parsed;
}

export function loadEnv(): CockpitEnv {
  return {
    nodeEnv: readNodeEnv(),
    port: readPositiveInt('PORT') ?? 3000,
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL,
    cockpitDomain: process.env.COCKPIT_DOMAIN,
    authSecret: process.env.BETTER_AUTH_SECRET,
    smtpHost: process.env.SMTP_HOST,
    smtpPort: readPositiveInt('SMTP_PORT'),
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    smtpFrom: process.env.SMTP_FROM,
    imageVersion: process.env.COCKPIT_VERSION,
    imageCommit: process.env.COCKPIT_COMMIT,
    imageDigest: process.env.COCKPIT_IMAGE_DIGEST,
    instanzName: instanzNameAus(process.env.COCKPIT_INSTANZ_NAME),
    koordinatorUrl: process.env.COCKPIT_KOORDINATOR_URL,
    koordinatorGeheimnis: process.env.COCKPIT_KOORDINATOR_SECRET,
    koordinatorFristSekunden: readPositiveInt('COCKPIT_KOORDINATOR_FRIST'),
    repowacheUrl: process.env.REPOWACHE_URL,
    repowacheToken: process.env.REPOWACHE_TOKEN,
    chatTageslimit: readPositiveInt('COCKPIT_CHAT_TAGESLIMIT'),
    chatMailNachMinuten: readPositiveInt('COCKPIT_CHAT_MAIL_NACH_MINUTEN'),
    vapidOeffentlich: process.env.COCKPIT_VAPID_PUBLIC_KEY,
    vapidPrivat: process.env.COCKPIT_VAPID_PRIVATE_KEY,
    vapidKontakt: process.env.COCKPIT_VAPID_KONTAKT,
    wartungsfenster: wartungsfensterAus(process.env.COCKPIT_WARTUNGSFENSTER),
    pipelineGeheimnis: process.env.COCKPIT_PIPELINE_SECRET,
  };
}

/**
 * Öffentliche Basis-URL des Cockpits. Mit gesetzter Domain immer `https` —
 * das Cockpit steht in jeder Kundeninstanz hinter Caddy mit TLS (Architektur-
 * Vorschlag Abschnitt 13.3). Ohne Domain (lokale Entwicklung) `http` auf
 * localhost; Browser behandeln localhost als sicheren Kontext, daher
 * funktionieren auch dort `Secure`- und `__Host-`-Cookies.
 */
export function basisUrl(env: Pick<CockpitEnv, 'cockpitDomain' | 'port'>): string {
  if (env.cockpitDomain) {
    return `https://${env.cockpitDomain}`;
  }
  return `http://localhost:${String(env.port)}`;
}
