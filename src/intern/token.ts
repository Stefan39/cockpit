/**
 * Das Token der Agenten-API (COPI-35) — reine Funktionen ohne Datenbank und ohne Fastify.
 *
 * Aufbau: `cpk_` (Cockpit-Schlüssel) und 32 Byte Zufall, base64url-kodiert, zusammen 47 Zeichen. Das
 * Präfix hat zwei Aufgaben. Es macht ein durchgesickertes Token erkennbar (Secret-Scanner, ein Blick
 * in einen Log), und es lässt die Anwendung Unsinn abweisen, **bevor** sie die Datenbank fragt: nur
 * ein wohlgeformter Wert löst überhaupt eine Abfrage aus.
 *
 * Erzeugung, Hash und Vergleich sind dieselben wie bei Erststart- und Einladungs-Token
 * (`einmal-token.ts`): 32 Byte aus `crypto.randomBytes`, gespeichert wird nur der SHA-256-Hash. Anders
 * als jene ist ein Zugangs-Token nicht einmalig einlösbar, sondern gilt bis zum Widerruf.
 */
import { randomBytes } from 'node:crypto';
import { TOKEN_LAENGE_BYTES, tokenHashen } from '../auth/einmal-token.js';

export const API_TOKEN_PRAEFIX = 'cpk_';

/**
 * Die Rechte eines Zugangs. Muss mit der CHECK-Bedingung `api_token_scopes_bekannt` (Migrationen 0016, 0026, 0030, 0032, 0034, 0051)
 * übereinstimmen; ein neues Recht kommt mit dem Ticket, das es braucht, samt Migration.
 *
 * Schreibweise mit Unterstrich statt Doppelpunkt: die Rechte stehen im Protokoll, und dort passt nur
 * eine Kennung (Buchstaben, Ziffern, `_`, `-`).
 */
export const API_SCOPES = ['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen', 'verbrauch_schreiben', 'verbrauch_lesen', 'pipeline_verwalten'] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function istApiScope(wert: string): wert is ApiScope {
  return (API_SCOPES as readonly string[]).includes(wert);
}

/** Der Name eines Zugangs: wie eine Kennung im Protokoll (höchstens 40 Zeichen), siehe Migration 0016. */
export const API_TOKEN_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** 32 Byte in base64url sind 43 Zeichen. */
const TOKEN_FORM = /^cpk_[A-Za-z0-9_-]{43}$/;

/** Länger als jedes gültige `Authorization` (7 + 47 Zeichen) — schützt die Auswertung vor Riesenwerten. */
const KOPF_HOECHSTLAENGE = 200;

export interface ApiToken {
  /** Klartext-Token — nur für die einmalige Ausgabe auf der Konsole. */
  readonly token: string;
  /** SHA-256-Hex des Tokens — nur dieser Wert wird gespeichert. */
  readonly hash: string;
}

export function apiTokenErzeugen(): ApiToken {
  const token = `${API_TOKEN_PRAEFIX}${randomBytes(TOKEN_LAENGE_BYTES).toString('base64url')}`;
  return { token, hash: tokenHashen(token) };
}

/**
 * Das Token aus der `Authorization`-Kopfzeile, oder `undefined`, wenn sie fehlt oder das Token nicht
 * wohlgeformt ist. Das Schema `Bearer` gilt ohne Rücksicht auf die Schreibweise (RFC 7235), sonst ist
 * die Form streng: genau ein Leerzeichen, kein Leerraum davor oder danach, genau ein Token.
 *
 * Das Token kommt **nur** aus dieser Kopfzeile, nie aus der Adresse: eine Adresse steht in Logs und
 * Verläufen.
 */
export function tokenAusKopf(kopf: string | undefined): string | undefined {
  if (kopf === undefined || kopf.length > KOPF_HOECHSTLAENGE) {
    return undefined;
  }
  const treffer = /^bearer (\S+)$/i.exec(kopf);
  const token = treffer?.[1];
  return token !== undefined && TOKEN_FORM.test(token) ? token : undefined;
}
