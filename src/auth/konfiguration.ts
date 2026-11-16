/**
 * Better-Auth-Grundintegration des Cockpits (Epic E2, COPI-10).
 *
 * Leitplanken aus dem Architektur-Vorschlag, die hier sichtbar werden:
 * - Ein Prozess, kein separater Auth-Dienst, kein Redis — Sitzungen liegen als
 *   Datenbank-Sitzungen in der vorhandenen PostgreSQL.
 * - Eigenes Schema `cockpit`, nicht `public`.
 * - Sitzungs-Cookie mit `__Host-`-Präfix (Abschnitt 13.3).
 * - Zweiter Faktor über das Better-Auth-Plugin: TOTP. Der Passkey (COPI-26)
 *   läuft bewusst nicht über Better Auth, sondern über `passkey.ts`.
 */
import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { PostgresDialect } from 'kysely';
import pg from 'pg';
import { passwortHashen, passwortPruefen } from './passwort.js';
import { appErsatzcodesPlugin } from './app-ersatzcodes.js';
import { sitzungAnlegenPlugin } from './sitzung-anlegen.js';
import { benutzerAnlageErlaubt } from './benutzer-anlage.js';
import { CLIENT_IP_KOPF } from './client-ip.js';
import type { CockpitEnv } from '../server/env.js';

/** Eigenes Schema statt `public` — siehe db/migrations/0002_auth.up.sql. */
export const DB_SCHEMA = 'cockpit';

/**
 * Cookie-Präfix. Better Auth bildet Cookie-Namen als `${praefix}.${name}`,
 * der Sitzungs-Cookie heißt damit `__Host-cockpit.session_token`.
 * `__Host-` verlangt `Secure`, `Path=/` und **kein** `Domain`-Attribut —
 * genau das setzen wir unten fest (Vorgriff auf die Domain-Festlegung,
 * Architektur-Vorschlag Abschnitt 13.3).
 *
 * Achtung beim Ändern: Better Auth stellt jedem Cookie-Namen zusätzlich
 * `__Secure-` voran, sobald `useSecureCookies` wahr ist — der Name hieße dann
 * `__Secure-__Host-cockpit.session_token` und trüge **gar kein** gültiges
 * Präfix mehr, weil `__Host-` nur am Namensanfang wirkt. Deshalb steht unten
 * `useSecureCookies: false` bei gleichzeitig fest gesetztem `secure: true`.
 * Das ist kein Verzicht auf sichere Cookies, sondern der einzige Weg zu einem
 * echten `__Host-`-Cookie. `test/cookie.test.ts` hält das fest.
 */
export const COOKIE_PRAEFIX = '__Host-cockpit';
export const SITZUNGS_COOKIE_NAME = `${COOKIE_PRAEFIX}.session_token`;

/** Montagepunkt der Better-Auth-Endpunkte. */
export const AUTH_BASIS_PFAD = '/api/auth';

/** Mindestlänge des Passworts — strenger als der Better-Auth-Default (8). */
export const MINDEST_PASSWORTLAENGE = 12;

/**
 * Die Datei mit dem Geheimnis der Entwicklung (COPI-32), in der Wurzel des Repos: von `src/auth`
 * und von `dist/auth` aus zwei Ordner nach oben. Sie steht in `.gitignore` und `.dockerignore`
 * und wird nur in der Entwicklung gelesen oder angelegt.
 */
export const DEV_GEHEIMNIS_DATEI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.cockpit-dev-secret',
);

/** So kurz darf ein Geheimnis nicht sein: Better Auth verlangt mindestens 32 Zeichen. */
const MINDESTLAENGE_GEHEIMNIS = 32;

export interface GeheimnisOptionen {
  /** Wo das Geheimnis der Entwicklung liegt. Standard: `DEV_GEHEIMNIS_DATEI`; Tests geben ihre eigene an. */
  readonly datei?: string;
  /** Bekommt einen Hinweis für den Log, wenn etwas Besonderes geschah (Datei angelegt, Ersatz je Prozess). */
  readonly hinweis?: (text: string) => void;
}

function zufallsgeheimnis(): string {
  return randomBytes(32).toString('base64url');
}

function dateifehlerCode(fehler: unknown): string | undefined {
  return typeof fehler === 'object' && fehler !== null && 'code' in fehler ? String((fehler as { code: unknown }).code) : undefined;
}

/** Das Geheimnis aus der Datei, `undefined` wenn es sie nicht gibt; eine unbrauchbare Datei bricht ab. */
function geheimnisAusDatei(datei: string): string | undefined {
  let inhalt: string;
  try {
    inhalt = readFileSync(datei, 'utf8');
  } catch (fehler) {
    if (dateifehlerCode(fehler) === 'ENOENT') {
      return undefined;
    }
    throw fehler;
  }
  const geheimnis = inhalt.trim();
  if (geheimnis.length < MINDESTLAENGE_GEHEIMNIS) {
    // Kein stilles Neuwürfeln: ein unbemerkt neues Geheimnis wäre genau der Fehler, den die Datei verhindern soll.
    throw new Error(
      `${datei} enthält kein gültiges Geheimnis (zu kurz, mindestens ${String(MINDESTLAENGE_GEHEIMNIS)} Zeichen). ` +
        'Die Datei löschen: der nächste Start legt eine neue an. Konten dieser Entwicklungs-Datenbank mit TOTP ' +
        'müssen dann über `entsperren` neu eingerichtet werden, denn ihr Schlüssel ist mit dem alten Geheimnis verschlüsselt.',
    );
  }
  return geheimnis;
}

/**
 * Legt die Datei **atomar** mit dem fertigen Inhalt an: erst eine Zwischendatei (0600), dann ein
 * harter Link auf den Zielnamen, der nur gelingt, wenn es das Ziel noch nicht gibt. Zwei
 * gleichzeitig startende Prozesse (`tsx watch`, zwei Terminals) sehen so nie eine halbe oder
 * zweimal angelegte Datei. `false`: die Datei gab es schon (ein anderer Prozess war schneller).
 */
export function geheimnisDateiAnlegen(datei: string, geheimnis: string): boolean {
  const zwischen = `${datei}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(zwischen, `${geheimnis}\n`, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(zwischen, datei);
    return true;
  } catch (fehler) {
    if (dateifehlerCode(fehler) === 'EEXIST') {
      return false;
    }
    throw fehler;
  } finally {
    rmSync(zwischen, { force: true });
  }
}

/**
 * Das Geheimnis, mit dem Better Auth signiert und verschlüsselt. Es hängt daran: die Signatur
 * der Sitzungs-Cookies und der TOTP-Schlüssel samt seinen Ersatzcodes (Better Auth speichert sie
 * verschlüsselt). Ändert es sich, sind Sitzungen ungültig, und ein TOTP-Konto lässt sich nicht
 * mehr anmelden. Passkeys und die eigenen Ersatzcodes der Passkey-Konten hängen **nicht** daran.
 *
 *   1. `BETTER_AUTH_SECRET` gewinnt immer.
 *   2. In Produktion ist es Pflicht; ohne startet das Cockpit nicht. Die Datei der Entwicklung
 *      wird dort nie gelesen oder angelegt.
 *   3. In Tests ein Zufallswert je Aufruf; die Tests setzen ihr Geheimnis selbst.
 *   4. In der Entwicklung liegt das Geheimnis in einer Datei (`DEV_GEHEIMNIS_DATEI`, nicht in
 *      Git, nicht im Image): beim ersten Start wird sie mit einem Zufallswert angelegt, danach
 *      gelesen. Vor COPI-32 wurde bei jedem Start neu gewürfelt, und jeder Neustart (bei
 *      `tsx watch` jede Dateiänderung) machte TOTP-Konten der Entwicklungs-Datenbank unbrauchbar.
 *      Ein fester Wert im Repo wäre dagegen einer, der versehentlich produktiv würde.
 *      Lässt sich die Datei nicht anlegen, gilt ein Zufallswert für diesen Prozess, mit Hinweis.
 */
export function geheimnisBesorgen(env: CockpitEnv, optionen: GeheimnisOptionen = {}): string {
  if (env.authSecret) {
    return env.authSecret;
  }
  if (env.nodeEnv === 'production') {
    throw new Error(
      'BETTER_AUTH_SECRET ist nicht gesetzt — ohne Signiergeheimnis startet das Cockpit nicht.',
    );
  }
  if (env.nodeEnv === 'test') {
    return zufallsgeheimnis();
  }

  const datei = optionen.datei ?? DEV_GEHEIMNIS_DATEI;
  const vorhanden = geheimnisAusDatei(datei);
  if (vorhanden !== undefined) {
    return vorhanden;
  }

  const neu = zufallsgeheimnis();
  try {
    if (geheimnisDateiAnlegen(datei, neu)) {
      optionen.hinweis?.(
        `BETTER_AUTH_SECRET ist nicht gesetzt: für die Entwicklung wurde ein Geheimnis in ${datei} angelegt und wird ` +
          'bei jedem Start wiederverwendet. So bleiben TOTP-Schlüssel und Sitzungen über Neustarts gültig. ' +
          'Die Datei gehört nicht in Git und nicht ins Image; wer BETTER_AUTH_SECRET setzt, braucht sie nicht.',
      );
      return neu;
    }
  } catch (fehler) {
    optionen.hinweis?.(
      `BETTER_AUTH_SECRET ist nicht gesetzt, und das Geheimnis der Entwicklung konnte nicht gespeichert werden ` +
        `(${dateifehlerCode(fehler) ?? 'unbekannter Fehler'} bei ${datei}): es gilt nur für diesen Prozess. Mit jedem ` +
        'Neustart werden Sitzungen und TOTP-Schlüssel ungültig. Abhilfe: BETTER_AUTH_SECRET setzen (Handbuch, „Auth-Geheimnis").',
    );
    return neu;
  }
  // Ein anderer Prozess war schneller: sein Geheimnis gilt, nicht unseres.
  return geheimnisAusDatei(datei) ?? neu;
}

export interface AuthOptionen {
  readonly databaseUrl: string;
  readonly basisUrl: string;
  readonly secret: string;
  /** Vorhandener Pool (Tests); sonst wird einer aus `databaseUrl` gebaut. */
  readonly pool?: pg.Pool;
  /**
   * Schaltet die Better-Auth-Ratenbegrenzung ein, die von sich aus nur in
   * Produktion aktiv ist (`enabled: isProduction`). Ausschließlich für den
   * Nachweis in `test/better-auth-ratenbegrenzung.test.ts`, dass sie die
   * direkten `auth.api.*`-Aufrufe der Anmeldeseite nicht erfasst — und damit
   * für die eigene Begrenzung in `ratenbegrenzung.ts`. In Produktion ist der
   * Wert wirkungslos, dort ist sie ohnehin an.
   */
  readonly ratenbegrenzungErzwingen?: boolean;
}

export type CockpitAuth = ReturnType<typeof erzeugeAuth>;

export function erzeugeAuth(optionen: AuthOptionen) {
  const pool =
    optionen.pool ?? new pg.Pool({ connectionString: optionen.databaseUrl });

  return betterAuth({
    appName: 'Cockpit',
    baseURL: optionen.basisUrl,
    basePath: AUTH_BASIS_PFAD,
    secret: optionen.secret,
    database: {
      dialect: new PostgresDialect({ pool }),
      type: 'postgres',
      schemaName: DB_SCHEMA,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MINDEST_PASSWORTLAENGE,
      // Argon2id statt des Better-Auth-Defaults scrypt — siehe passwort.ts.
      password: {
        hash: passwortHashen,
        verify: passwortPruefen,
      },
    },
    // Zweiter Riegel gegen Selbstregistrierung (siehe benutzer-anlage.ts).
    databaseHooks: {
      // Ein als gelöscht markiertes Konto bekommt keine Sitzung mehr (COPI-62). Anmelden kann es sich ohnehin nicht
      // (Adresse ersetzt, Passwort ohne Urbild, Faktoren entfernt); das hier ist der Riegel dahinter.
      session: {
        create: {
          before: async (sitzung) => {
            const konto = await pool.query('SELECT 1 FROM cockpit."user" WHERE id = $1 AND geloescht_am IS NULL', [sitzung.userId]);
            return (konto.rowCount ?? 0) > 0 ? { data: sitzung } : false;
          },
        },
      },
      user: {
        create: {
          before: (benutzer) => {
            if (!benutzerAnlageErlaubt()) {
              return Promise.resolve(false);
            }
            return Promise.resolve({ data: benutzer });
          },
        },
      },
    },
    advanced: {
      cookiePrefix: COOKIE_PRAEFIX,
      // Better Auth soll genau die Adresse sehen, die auch die eigene
      // Ratenbegrenzung benutzt. `x-cockpit-client-ip` wird prozessintern von
      // `registriereClientIp` gesetzt (rechter X-Forwarded-For-Eintrag, also
      // der vom Proxy angehängte) und überschreibt einen mitgeschickten Wert.
      // Ohne diese Angabe liest Better Auth `x-forwarded-for` selbst und
      // verwirft eine Kette mit mehreren Einträgen — dann fiele die
      // Ratenbegrenzung auf einen gemeinsamen Zähler je Pfad zurück, und
      // `session.ipAddress` bliebe leer.
      ipAddress: {
        ipAddressHeaders: [CLIENT_IP_KOPF],
      },
      // Verhindert das zusätzliche `__Secure-`-Präfix (siehe COOKIE_PRAEFIX).
      useSecureCookies: false,
      // `Secure` wird stattdessen hier fest gesetzt — ohne das verwirft der
      // Browser einen `__Host-`-Cookie. Auf localhost ist das unkritisch,
      // weil localhost als sicherer Kontext gilt. Kein `domain`-Attribut:
      // `__Host-` verlangt host-only.
      defaultCookieAttributes: {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
      },
    },
    ...(optionen.ratenbegrenzungErzwingen ? { rateLimit: { enabled: true } } : {}),
    plugins: [twoFactor({ issuer: 'Cockpit' }), sitzungAnlegenPlugin(), appErsatzcodesPlugin()],
  });
}
