/**
 * Passkey (WebAuthn) als zweiter Faktor einrichten (COPI-26, Migration 0012).
 *
 * Gewählt ist `@simplewebauthn/server` direkt statt des Better-Auth-Plugins
 * (`@better-auth/passkey`): das Plugin zielt auf die Anmeldung **ohne** Passwort
 * und öffnet rohe Endpunkte unter `/api/auth`. Das Cockpit braucht einen zweiten
 * Faktor neben dem Passwort; die Registrierung läuft über eigene Routen im Prozess
 * (siehe `routes/passkey.ts`). Die Messung steht im Ticket COPI-26.
 *
 * Die Zeremonie, in drei Schritten:
 *   1. `registrierungBeginnen` — Optionen für das Gerät, die Challenge wird
 *      gespeichert (eine je Konto, fünf Minuten gültig).
 *   2. Das Gerät signiert die Challenge (im Browser, `assets/js/passkey.js`).
 *   3. `registrierungAbschliessen` — die Challenge wird **verbraucht** (auch bei
 *      einem Fehlschlag: eine Challenge gilt einmal), die Antwort geprüft, und erst
 *      dann entsteht der Passkey. Ab diesem Moment liefert
 *      `cockpit.zweiter_faktor_aktiv` (0012) wahr, und der Trigger setzt
 *      `aktiviert_am`.
 *
 * Strikt aus der festen Basis-URL (ADR 13.3): rpID ist die Domain, die erwartete
 * Herkunft die Basis-URL. Ein Domainwechsel macht bestehende Passkeys ungültig.
 * `userVerification: required`: der Passkey soll allein ein zweiter Faktor sein
 * (PIN oder Biometrie am Gerät); ein Gerät, das das nicht kann, nimmt TOTP.
 */
import { isIP } from 'node:net';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type pg from 'pg';
import { ersatzcodesErzeugen } from './ersatzcode.js';
import { passwortHashen } from './passwort.js';
import { protokollSchreiben } from './protokoll.js';

/** Fünf Minuten, so lange gilt eine offene Zeremonie. Das Gerät bekommt dieselbe Frist. */
export const PASSKEY_VORGANG_GUELTIGKEIT_MS = 5 * 60 * 1000;

/** Länge des Anzeigenamens, wie in der CHECK-Bedingung von 0012. */
const NAME_MAXIMUM = 60;
const STANDARDNAME = 'Passkey';

export interface PasskeyKonfiguration {
  /** Die Domain (ohne Port und Pfad) — an sie ist jeder Passkey gebunden. */
  readonly rpId: string;
  /** Der Name, den das Gerät in seinem Dialog anzeigt. */
  readonly rpName: string;
  /** Die erwartete Herkunft der Zeremonie: Schema, Host und Port der Basis-URL. */
  readonly origin: string;
}

function abgewiesen(grund: string): never {
  throw new Error(`Passkey: Die Basis-URL ist nicht brauchbar (${grund})`);
}

/**
 * rpID und Herkunft aus der festen Basis-URL. Weist ab, was ein Browser ohnehin
 * ablehnen würde — besser beim Start als beim ersten Passkey: eine IP-Adresse (die
 * rpID muss eine Domain sein) und `http` außerhalb von `localhost` (kein sicherer
 * Kontext, `navigator.credentials` fehlt).
 */
export function passkeyKonfiguration(basisUrl: string): PasskeyKonfiguration {
  let adresse: URL;
  try {
    adresse = new URL(basisUrl);
  } catch {
    return abgewiesen('keine URL');
  }
  if (adresse.protocol !== 'https:' && adresse.protocol !== 'http:') {
    return abgewiesen('weder http noch https');
  }
  const host = adresse.hostname;
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) {
    return abgewiesen('eine IP-Adresse statt einer Domain');
  }
  const lokal = host === 'localhost' || host.endsWith('.localhost');
  if (adresse.protocol === 'http:' && !lokal) {
    return abgewiesen('http ist außerhalb von localhost kein sicherer Kontext');
  }
  return { rpId: host, rpName: 'Cockpit', origin: adresse.origin };
}

export interface Kontoangaben {
  readonly id: string;
  readonly email: string;
}

/**
 * Optionen für `navigator.credentials.create` und die gespeicherte Challenge.
 * Eine neue Zeremonie ersetzt die offene des Kontos.
 */
export async function registrierungBeginnen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  konto: Kontoangaben,
  jetzt: Date,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const vorhandene = await pool.query<{ id: string; transports: string[] }>(
    'SELECT id, transports FROM cockpit.passkey WHERE benutzer_id = $1',
    [konto.id],
  );
  const optionen = await generateRegistrationOptions({
    rpName: konfiguration.rpName,
    rpID: konfiguration.rpId,
    userName: konto.email,
    // Die Kennung des Kontos am Gerät ist die Konto-ID, nie die Adresse.
    userID: new TextEncoder().encode(konto.id),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: vorhandene.rows.map((zeile) => ({
      id: zeile.id,
      transports: zeile.transports,
    })),
    timeout: PASSKEY_VORGANG_GUELTIGKEIT_MS,
  });
  await passkeyVorgangSpeichern(pool, konto.id, 'registrierung', optionen.challenge, jetzt);
  return optionen;
}

/**
 * Wofür eine offene Zeremonie gilt (Migration 0042): einen Passkey anlegen oder mit einem vorhandenen bestätigen
 * (COPI-94). Eine Challenge gilt nur für ihren Zweck.
 */
export type VorgangZweck = 'registrierung' | 'bestaetigung';

/** Speichert die Challenge der offenen Zeremonie; sie ersetzt eine offene des Kontos, gleich welchen Zwecks. */
export async function passkeyVorgangSpeichern(
  pool: pg.Pool,
  benutzerId: string,
  zweck: VorgangZweck,
  challenge: string,
  jetzt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO cockpit.passkey_vorgang (benutzer_id, challenge, ablauf_am, zweck)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (benutzer_id)
     DO UPDATE SET challenge = EXCLUDED.challenge, ablauf_am = EXCLUDED.ablauf_am, zweck = EXCLUDED.zweck`,
    [benutzerId, challenge, new Date(jetzt.getTime() + PASSKEY_VORGANG_GUELTIGKEIT_MS), zweck],
  );
}

/**
 * Liest die Antwort des Geräts aus einem Formularfeld. Nur die Form: ein Objekt mit
 * `id`, `rawId`, `type: public-key` und einer `response`, deren genannte Felder Texte
 * sind. Geprüft wird die Antwort erst später, von der Bibliothek.
 */
export function passkeyAntwortLesen<T>(text: string, antwortFelder: readonly string[]): T | undefined {
  let wert: unknown;
  try {
    wert = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof wert !== 'object' || wert === null) {
    return undefined;
  }
  const antwort = wert as Record<string, unknown>;
  const inhalt = antwort.response;
  if (
    typeof antwort.id !== 'string' ||
    typeof antwort.rawId !== 'string' ||
    antwort.type !== 'public-key' ||
    typeof inhalt !== 'object' ||
    inhalt === null ||
    antwortFelder.some((feld) => typeof (inhalt as Record<string, unknown>)[feld] !== 'string')
  ) {
    return undefined;
  }
  return wert as T;
}

export function registrierungsAntwortLesen(text: string): RegistrationResponseJSON | undefined {
  return passkeyAntwortLesen<RegistrationResponseJSON>(text, ['clientDataJSON', 'attestationObject']);
}

/** Name für die Anzeige: getrimmt, ohne Steuerzeichen, höchstens 60 Zeichen, sonst „Passkey“. */
export function passkeyNameBereinigen(eingabe: string): string {
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das, was raus soll.
  const bereinigt = eingabe.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAXIMUM).trim();
  return bereinigt.length > 0 ? bereinigt : STANDARDNAME;
}

export type RegistrierungGrund =
  /** Keine offene Zeremonie, oder ihre Frist ist um. */
  | 'kein_vorgang'
  /** Die Antwort hat die Prüfung nicht bestanden. */
  | 'nicht_geprueft'
  /** Das Konto hat schon einen aktiven zweiten Faktor (erste Einrichtung). */
  | 'schon_aktiv'
  /** Das Konto hat keinen aktiven zweiten Faktor (weiterer Passkey, COPI-94). */
  | 'nicht_aktiv';

export type RegistrierungErgebnis =
  | { readonly ok: true; readonly ersatzcodes: readonly string[] }
  | { readonly ok: false; readonly grund: RegistrierungGrund };

const FEHLGESCHLAGEN = (grund: RegistrierungGrund): RegistrierungErgebnis => ({ ok: false, grund });

/**
 * Verbraucht die offene Zeremonie des Kontos und liefert ihre Challenge, wenn sie noch gilt und zum Zweck passt.
 * Eine einzige Anweisung: gleichzeitige Antworten auf dieselbe Challenge kann höchstens eine verbrauchen. Auch eine
 * abgelaufene Zeile oder eine mit anderem Zweck wird dabei entfernt.
 */
export async function passkeyVorgangVerbrauchen(
  pool: pg.Pool,
  benutzerId: string,
  zweck: VorgangZweck,
  jetzt: Date,
): Promise<string | undefined> {
  const ergebnis = await pool.query<{ challenge: string; gueltig: boolean }>(
    `DELETE FROM cockpit.passkey_vorgang
      WHERE benutzer_id = $1
  RETURNING challenge, ablauf_am > $2 AND zweck = $3 AS gueltig`,
    [benutzerId, jetzt, zweck],
  );
  const zeile = ergebnis.rows[0];
  return zeile?.gueltig === true ? zeile.challenge : undefined;
}

/** Postgres-Code für „Wert verletzt eine Eindeutigkeitsbedingung". */
const EINDEUTIGKEIT_VERLETZT = '23505';

type Beglaubigt = NonNullable<Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo']>;

/** Verbraucht die Challenge und prüft die Antwort; liefert die beglaubigten Schlüsseldaten oder den Grund. */
async function antwortPruefen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  benutzerId: string,
  antwort: RegistrationResponseJSON,
  jetzt: Date,
): Promise<Beglaubigt | RegistrierungGrund> {
  const challenge = await passkeyVorgangVerbrauchen(pool, benutzerId, 'registrierung', jetzt);
  if (challenge === undefined) {
    return 'kein_vorgang';
  }
  let pruefung;
  try {
    pruefung = await verifyRegistrationResponse({
      response: antwort,
      expectedChallenge: challenge,
      expectedOrigin: konfiguration.origin,
      expectedRPID: konfiguration.rpId,
      // Ohne PIN oder Biometrie am Gerät ist der Passkey kein zweiter Faktor.
      requireUserVerification: true,
    });
  } catch {
    return 'nicht_geprueft';
  }
  const info = pruefung.registrationInfo;
  return pruefung.verified && info !== undefined ? info : 'nicht_geprueft';
}

/** Legt den Passkey in der laufenden Transaktion an. */
async function passkeyEinfuegen(client: pg.PoolClient, benutzerId: string, info: Beglaubigt, name: string): Promise<void> {
  await client.query(
    `INSERT INTO cockpit.passkey (id, benutzer_id, oeffentlicher_schluessel, zaehler, transports, name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      info.credential.id,
      benutzerId,
      Buffer.from(info.credential.publicKey),
      info.credential.counter,
      info.credential.transports ?? [],
      name,
    ],
  );
}

/**
 * Die Transaktion um das Anlegen: sperrt die Zeile des Kontos (serialisiert zwei Zeremonien), fragt in einer eigenen
 * Anweisung nach dem aktiven Faktor und lässt `arbeit` nur laufen, wenn er dem `erwartet`en Stand entspricht. Dieselbe
 * Kennung bei einem anderen Konto ist kein Passkey, den die Zeremonie hätte hervorbringen dürfen.
 */
async function anlegenInTransaktion<T>(
  pool: pg.Pool,
  benutzerId: string,
  faktorErwartet: boolean,
  arbeit: (client: pg.PoolClient) => Promise<T>,
): Promise<T | RegistrierungGrund> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM cockpit."user" WHERE id = $1 FOR UPDATE', [benutzerId]);
    const aktiv = await client.query<{ aktiv: boolean }>(
      'SELECT cockpit.zweiter_faktor_aktiv(u) AS aktiv FROM cockpit."user" u WHERE u.id = $1',
      [benutzerId],
    );
    if (aktiv.rows[0]?.aktiv !== faktorErwartet) {
      // Der Stand passt nicht — oder das Konto ist gerade verschwunden.
      await client.query('ROLLBACK');
      return faktorErwartet ? 'nicht_aktiv' : 'schon_aktiv';
    }
    const ergebnis = await arbeit(client);
    await client.query('COMMIT');
    return ergebnis;
  } catch (fehler) {
    await client.query('ROLLBACK');
    if ((fehler as { code?: string }).code === EINDEUTIGKEIT_VERLETZT) {
      return 'nicht_geprueft';
    }
    throw fehler;
  } finally {
    client.release();
  }
}

/**
 * Schließt die Zeremonie ab: verbraucht die Challenge, prüft die Antwort und legt
 * den Passkey an. Hat das Konto bis dahin gar keinen zweiten Faktor, entstehen in
 * **derselben Transaktion** die Ersatzcodes und der Protokolleintrag: alles gilt
 * oder nichts. Die Codes stehen nur im Rückgabewert, nie in der Datenbank.
 */
export async function registrierungAbschliessen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  benutzerId: string,
  antwort: RegistrationResponseJSON,
  name: string,
  jetzt: Date,
): Promise<RegistrierungErgebnis> {
  const info = await antwortPruefen(pool, konfiguration, benutzerId, antwort, jetzt);
  if (typeof info === 'string') {
    return FEHLGESCHLAGEN(info);
  }

  // Argon2id rechnet, bevor die Transaktion die Zeile des Kontos sperrt.
  const codes = ersatzcodesErzeugen();
  const hashes = await Promise.all(codes.map((code) => passwortHashen(code)));

  const ergebnis = await anlegenInTransaktion(pool, benutzerId, false, async (client) => {
    await passkeyEinfuegen(client, benutzerId, info, passkeyNameBereinigen(name));
    await client.query(
      'INSERT INTO cockpit.ersatzcode (benutzer_id, code_hash) SELECT $1, unnest($2::text[])',
      [benutzerId, hashes],
    );
    await protokollSchreiben(client, {
      art: 'zweiter_faktor_eingerichtet',
      akteur: benutzerId,
      einzelheiten: { faktor: 'passkey' },
    });
    return codes;
  });
  return typeof ergebnis === 'string' ? FEHLGESCHLAGEN(ergebnis) : { ok: true, ersatzcodes: ergebnis };
}

export type WeitererErgebnis =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly grund: RegistrierungGrund };

/**
 * Ein **weiterer** Passkey für ein Konto mit aktivem Faktor (COPI-94, `/sicherheit`). Die frische Bestätigung durch
 * einen vorhandenen Faktor prüft die Route, bevor sie hierher kommt. Keine neuen Ersatzcodes (die bisherigen gelten
 * weiter); der Protokolleintrag entsteht in derselben Transaktion.
 */
export async function weiterenPasskeyAbschliessen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  benutzerId: string,
  antwort: RegistrationResponseJSON,
  name: string,
  jetzt: Date,
): Promise<WeitererErgebnis> {
  const info = await antwortPruefen(pool, konfiguration, benutzerId, antwort, jetzt);
  if (typeof info === 'string') {
    return { ok: false, grund: info };
  }
  const anzeige = passkeyNameBereinigen(name);
  const ergebnis = await anlegenInTransaktion(pool, benutzerId, true, async (client) => {
    await passkeyEinfuegen(client, benutzerId, info, anzeige);
    await protokollSchreiben(client, {
      art: 'zweiter_faktor_hinzugefuegt',
      akteur: benutzerId,
      einzelheiten: { faktor: 'passkey' },
    });
    // Ein Objekt, kein Text: ein Gerätename darf nie mit einem Grund verwechselt werden.
    return { name: anzeige };
  });
  return typeof ergebnis === 'string' ? { ok: false, grund: ergebnis } : { ok: true, name: ergebnis.name };
}
