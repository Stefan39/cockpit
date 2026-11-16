/**
 * Anmeldung mit Passkey im zweiten Schritt (COPI-27, Migration 0013).
 *
 * Nach dem Passwort gibt es den Anmeldevorgang (`anmeldevorgang.ts`) — ohne Sitzung.
 * Hier läuft der Passkey-Teil dieses Zwischenzustands, in zwei Schritten:
 *   1. `anmeldungOptionen` — Optionen für `navigator.credentials.get`, die Challenge
 *      steht in der Zeile des Vorgangs. Sie gehört zu genau diesem Vorgang.
 *   2. `anmeldungPruefen` — die Challenge wird **verbraucht** (auch bei einem
 *      Fehlschlag: eine Challenge gilt einmal), der Passkey muss zum Konto des Vorgangs
 *      gehören, die Bibliothek prüft Signatur, Herkunft, rpID und Benutzerprüfung, und
 *      der Signaturzähler muss steigen.
 *
 * Dieselbe Prüfung dient der frischen Bestätigung auf `/sicherheit` (COPI-94): dort mit Sitzung,
 * die Challenge in `passkey_vorgang` (Zweck `bestaetigung`, Migration 0042) statt im Anmeldevorgang.
 *
 * Diese Datei legt **keine Sitzung** an und protokolliert nichts. Sie sagt nur, ob der
 * Nachweis gilt und warum nicht; die Route entscheidet und antwortet immer gleich.
 *
 * Der Zähler wird nicht von der Bibliothek verglichen (ihr wird 0 mitgegeben), sondern hier,
 * in einer einzigen Anweisung: so ist der Vergleich atomar (zwei gleichzeitige Antworten mit
 * demselben Zähler bestehen nicht beide), und ein zurückgegangener Zähler ist ein eigener
 * Grund, den die Route als möglichen Klon festhält. Ein Gerät ohne Zähler (synchronisierte
 * Passkeys liefern immer 0) bleibt zulässig: 0 gespeichert, 0 geliefert.
 */
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import type pg from 'pg';
import { tokenHashen } from './einmal-token.js';
import {
  PASSKEY_VORGANG_GUELTIGKEIT_MS,
  passkeyAntwortLesen,
  passkeyVorgangSpeichern,
  passkeyVorgangVerbrauchen,
  type PasskeyKonfiguration,
} from './passkey.js';

/** Hat das Konto mindestens einen Passkey? Für die Frage, was die Codeseite anbietet. */
export async function passkeyVorhanden(pool: pg.Pool, benutzerId: string): Promise<boolean> {
  const ergebnis = await pool.query('SELECT 1 FROM cockpit.passkey WHERE benutzer_id = $1 LIMIT 1', [benutzerId]);
  return ergebnis.rowCount === 1;
}

/**
 * Optionen für das Gerät und die gespeicherte Challenge. `undefined`, wenn das Konto
 * keinen Passkey hat oder der Vorgang nicht mehr offen ist. Eine neue Anforderung ersetzt
 * die offene Challenge des Vorgangs.
 */
/** Optionen für `navigator.credentials.get` mit allen Passkeys des Kontos; `undefined` ohne Passkey. */
async function optionenErzeugen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  benutzerId: string,
): Promise<PublicKeyCredentialRequestOptionsJSON | undefined> {
  const passkeys = await pool.query<{ id: string; transports: string[] }>(
    'SELECT id, transports FROM cockpit.passkey WHERE benutzer_id = $1 ORDER BY angelegt_am, id',
    [benutzerId],
  );
  if (passkeys.rows.length === 0) {
    return undefined;
  }
  return generateAuthenticationOptions({
    rpID: konfiguration.rpId,
    allowCredentials: passkeys.rows.map((zeile) => ({
      id: zeile.id,
      transports: zeile.transports as AuthenticatorTransport[],
    })),
    // Der Passkey soll allein ein zweiter Faktor sein: PIN oder Biometrie am Gerät.
    userVerification: 'required',
    timeout: PASSKEY_VORGANG_GUELTIGKEIT_MS,
  });
}

export async function anmeldungOptionen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  vorgangToken: string,
  benutzerId: string,
  jetzt: Date,
): Promise<PublicKeyCredentialRequestOptionsJSON | undefined> {
  const optionen = await optionenErzeugen(pool, konfiguration, benutzerId);
  if (optionen === undefined) {
    return undefined;
  }
  const gespeichert = await pool.query(
    `UPDATE cockpit.anmeldevorgang
        SET passkey_challenge = $2, passkey_challenge_ablauf_am = $3
      WHERE kennung_hash = $1 AND verbraucht_am IS NULL`,
    [tokenHashen(vorgangToken), optionen.challenge, new Date(jetzt.getTime() + PASSKEY_VORGANG_GUELTIGKEIT_MS)],
  );
  return gespeichert.rowCount === 1 ? optionen : undefined;
}

/** Liest die Antwort des Geräts aus einem Formularfeld; nur die Form, geprüft wird später. */
export function anmeldungsAntwortLesen(text: string): AuthenticationResponseJSON | undefined {
  return passkeyAntwortLesen<AuthenticationResponseJSON>(text, [
    'clientDataJSON',
    'authenticatorData',
    'signature',
  ]);
}

export type AnmeldungGrund =
  /** Keine offene Challenge im Vorgang, oder ihre Frist ist um. */
  | 'kein_vorgang'
  /** Die Kennung gehört nicht zu einem Passkey dieses Kontos. */
  | 'unbekannter_passkey'
  /** Signatur, Herkunft, rpID, Challenge oder Benutzerprüfung stimmen nicht. */
  | 'nicht_geprueft'
  /** Der Zähler ist nicht gestiegen: möglicherweise ein kopierter Passkey. */
  | 'zaehler';

export type AnmeldungErgebnis =
  | { readonly ok: true }
  | { readonly ok: false; readonly grund: AnmeldungGrund };

const ABGELEHNT = (grund: AnmeldungGrund): AnmeldungErgebnis => ({ ok: false, grund });

async function challengeVerbrauchen(
  pool: pg.Pool,
  vorgangToken: string,
  jetzt: Date,
): Promise<string | undefined> {
  // Eine einzige Anweisung: gleichzeitige Antworten auf dieselbe Challenge kann höchstens
  // eine verbrauchen. Auch eine abgelaufene Challenge wird dabei entfernt.
  const ergebnis = await pool.query<{ challenge: string; gueltig: boolean }>(
    `WITH alt AS (
        SELECT id, passkey_challenge, passkey_challenge_ablauf_am
          FROM cockpit.anmeldevorgang
         WHERE kennung_hash = $1 AND verbraucht_am IS NULL AND passkey_challenge IS NOT NULL
           FOR UPDATE
     )
     UPDATE cockpit.anmeldevorgang v
        SET passkey_challenge = NULL, passkey_challenge_ablauf_am = NULL
       FROM alt
      WHERE v.id = alt.id
  RETURNING alt.passkey_challenge AS challenge, alt.passkey_challenge_ablauf_am > $2 AS gueltig`,
    [tokenHashen(vorgangToken), jetzt],
  );
  const zeile = ergebnis.rows[0];
  return zeile?.gueltig === true ? zeile.challenge : undefined;
}

/** Steigt der Zähler (oder bleibt er bei 0/0), wird er gespeichert; sonst ändert sich nichts. */
async function zaehlerFortschreiben(pool: pg.Pool, passkeyId: string, neu: number): Promise<boolean> {
  const ergebnis = await pool.query(
    `UPDATE cockpit.passkey
        SET zaehler = $2
      WHERE id = $1 AND (zaehler < $2 OR (zaehler = 0 AND $2 = 0))
  RETURNING id`,
    [passkeyId, neu],
  );
  return ergebnis.rowCount === 1;
}

/**
 * Prüft die Antwort des Geräts gegen die offene Challenge des Vorgangs. Nur bei `ok: true`
 * gilt der Passkey als vorgezeigt; der Zähler ist dann schon fortgeschrieben.
 */
export async function anmeldungPruefen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  vorgangToken: string,
  benutzerId: string,
  antwort: AuthenticationResponseJSON,
  jetzt: Date,
): Promise<AnmeldungErgebnis> {
  const challenge = await challengeVerbrauchen(pool, vorgangToken, jetzt);
  return challenge === undefined
    ? ABGELEHNT('kein_vorgang')
    : nachweisPruefen(pool, konfiguration, benutzerId, antwort, challenge);
}

/**
 * Bestätigung mit einem vorhandenen Passkey (COPI-94): dieselben Optionen wie bei der Anmeldung, die Challenge aber
 * in `passkey_vorgang` mit Zweck `bestaetigung` (Migration 0042) — es gibt hier eine Sitzung, keinen Anmeldevorgang.
 */
export async function bestaetigungOptionen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  benutzerId: string,
  jetzt: Date,
): Promise<PublicKeyCredentialRequestOptionsJSON | undefined> {
  const optionen = await optionenErzeugen(pool, konfiguration, benutzerId);
  if (optionen !== undefined) {
    await passkeyVorgangSpeichern(pool, benutzerId, 'bestaetigung', optionen.challenge, jetzt);
  }
  return optionen;
}

/** Prüft die Antwort gegen die offene Bestätigung des Kontos; dieselben Regeln wie bei der Anmeldung. */
export async function bestaetigungPruefen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  benutzerId: string,
  antwort: AuthenticationResponseJSON,
  jetzt: Date,
): Promise<AnmeldungErgebnis> {
  const challenge = await passkeyVorgangVerbrauchen(pool, benutzerId, 'bestaetigung', jetzt);
  return challenge === undefined
    ? ABGELEHNT('kein_vorgang')
    : nachweisPruefen(pool, konfiguration, benutzerId, antwort, challenge);
}

/**
 * Der Nachweis selbst: der Passkey muss zum Konto gehören, die Bibliothek prüft Signatur, Herkunft, rpID und
 * Benutzerprüfung, und der Zähler muss steigen. Nur bei `ok: true` ist der Zähler schon fortgeschrieben.
 */
async function nachweisPruefen(
  pool: pg.Pool,
  konfiguration: PasskeyKonfiguration,
  benutzerId: string,
  antwort: AuthenticationResponseJSON,
  challenge: string,
): Promise<AnmeldungErgebnis> {

  // Nur ein Passkey dieses Kontos: ein gültig signierter Passkey eines anderen Kontos
  // beweist nichts für den Konto dieses Vorgangs.
  const gespeichert = await pool.query<{ id: string; oeffentlicher_schluessel: Buffer; transports: string[] }>(
    'SELECT id, oeffentlicher_schluessel, transports FROM cockpit.passkey WHERE id = $1 AND benutzer_id = $2',
    [antwort.id, benutzerId],
  );
  const passkey = gespeichert.rows[0];
  if (passkey === undefined) {
    return ABGELEHNT('unbekannter_passkey');
  }

  let pruefung;
  try {
    pruefung = await verifyAuthenticationResponse({
      response: antwort,
      expectedChallenge: challenge,
      expectedOrigin: konfiguration.origin,
      expectedRPID: konfiguration.rpId,
      // Ohne PIN oder Biometrie am Gerät ist der Passkey kein zweiter Faktor.
      requireUserVerification: true,
      // 0: die Bibliothek vergleicht den Zähler nicht mit; das geschieht unten, atomar.
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(passkey.oeffentlicher_schluessel),
        counter: 0,
        transports: passkey.transports as AuthenticatorTransport[],
      },
    });
  } catch {
    return ABGELEHNT('nicht_geprueft');
  }
  if (!pruefung.verified) {
    return ABGELEHNT('nicht_geprueft');
  }

  if (!(await zaehlerFortschreiben(pool, passkey.id, pruefung.authenticationInfo.newCounter))) {
    return ABGELEHNT('zaehler');
  }
  return { ok: true };
}
