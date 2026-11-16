/**
 * Was das Server-Kommando auf stdout ausgibt (COPI-24). Eigene Datei, damit die
 * Blöcke ohne Datenbank testbar sind und die Befehle nur noch aufrufen.
 *
 * Der Link mit dem Token steht in jedem Block **genau einmal** und nirgends sonst:
 * wer die Ausgabe mitschneidet, hat das Token — das ist der Zweck, und deshalb
 * bleibt es aus Logs und von stderr fern.
 */
import { ROLLEN_NAMEN, type VergebbareRolle } from '../auth/berechtigung.js';
import type { ApiScope } from '../intern/token.js';

const RAHMEN = '='.repeat(72);

export interface EinladungAusgabe {
  readonly email: string;
  readonly rolle: VergebbareRolle;
  /** Der vollständige Einlöse-Link mit dem Klartext-Token. */
  readonly url: string;
  readonly gueltigStunden: number;
}

export function einladungBlockBauen(einladung: EinladungAusgabe): string {
  return [
    '',
    RAHMEN,
    '  COCKPIT — EINLADUNG (ohne Mail)',
    '',
    `  Zugang für ${einladung.email}, Rolle „${ROLLEN_NAMEN[einladung.rolle]}". Einmalig einlösbar unter:`,
    '',
    `    ${einladung.url}`,
    '',
    `  Gültig ${String(einladung.gueltigStunden)} Stunden. Ersetzt eine frühere offene Einladung an dieselbe Adresse.`,
    '  Persönlich übergeben: der Link steht nirgends sonst.',
    RAHMEN,
    '',
  ].join('\n');
}

export interface EntsperrungAusgabe {
  readonly email: string;
  /** Der vollständige Einlöse-Link mit dem Klartext-Token. */
  readonly url: string;
  readonly gueltigStunden: number;
}

/**
 * Die Ausgabe von `entsperren` (COPI-28). Der Link steht genau einmal darin. Der Text sagt,
 * was geschehen ist — die Person am Server soll es der Person am anderen Ende richtig
 * ausrichten können —, und was nicht: der Link ersetzt kein Gespräch.
 */
export function entsperrungBlockBauen(entsperrung: EntsperrungAusgabe): string {
  return [
    '',
    RAHMEN,
    '  COCKPIT — ZUGANG WIEDERHERSTELLEN',
    '',
    `  Konto: ${entsperrung.email}`,
    '  Alle zweiten Faktoren sind entfernt, alle Sitzungen beendet, das bisherige Passwort ist ungültig.',
    '  Neues Passwort und neuer zweiter Faktor über diesen Link, einmalig einlösbar:',
    '',
    `    ${entsperrung.url}`,
    '',
    `  Gültig ${String(entsperrung.gueltigStunden)} Stunden. Ersetzt einen früheren offenen Link für dieses Konto.`,
    '  Persönlich übergeben: der Link steht nirgends sonst. Den neuen zweiten Faktor sofort einrichten,',
    '  sonst zählt wieder, wer das neue Passwort kennt — im Zweifel erneut entsperren.',
    RAHMEN,
    '',
  ].join('\n');
}

export interface ApiTokenAusgabe {
  readonly id: number;
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  /** Das Klartext-Token. */
  readonly token: string;
}

/**
 * Die Ausgabe von `api-token-erzeugen` (COPI-35). Das Token steht genau einmal darin — der Hinweis
 * zur Verwendung nennt es nicht noch einmal, sondern zeigt `<token>` als Platzhalter.
 */
export function apiTokenBlockBauen(zugang: ApiTokenAusgabe): string {
  return [
    '',
    RAHMEN,
    '  COCKPIT — ZUGANG DER AGENTEN-API',
    '',
    `  Nummer:  ${String(zugang.id)}`,
    `  Name:    ${zugang.name}`,
    `  Rechte:  ${zugang.scopes.join(', ')}`,
    '',
    '  Token (nur jetzt sichtbar):',
    '',
    `    ${zugang.token}`,
    '',
    '  Der Agent sendet es in jeder Anfrage an /intern/… als Kopfzeile:',
    '    Authorization: Bearer <token>',
    '  Ob Adresse, Token und Rechte stimmen, zeigt GET /intern/ping.',
    '',
    '  Persönlich übergeben: das Token steht nirgends sonst und lässt sich nicht wiederherstellen.',
    `  Verloren oder durchgesickert: api-token-widerrufen --id ${String(zugang.id)}, dann einen neuen Zugang anlegen.`,
    RAHMEN,
    '',
  ].join('\n');
}

export interface ModulEinspielenAusgabe {
  readonly status: 'neu' | 'unveraendert';
  readonly kennung: string;
  readonly version: number;
  readonly pruefsumme: string;
  /** Der Modul-Antrag, den diese Version als erledigt belegt (COPI-106). */
  readonly erledigt?: number | undefined;
}

/** Die Ausgabe von `modul-einspielen` (COPI-77): Kennung, Version und Prüfsumme, nie der Block selbst. */
export function modulEinspielenBlockBauen(ergebnis: ModulEinspielenAusgabe): string {
  const neu = ergebnis.status === 'neu';
  return [
    '',
    RAHMEN,
    `  COCKPIT — MODUL ${neu ? 'EINGESPIELT' : 'UNVERÄNDERT'}`,
    '',
    `  Kennung:    ${ergebnis.kennung}`,
    `  Version:    ${String(ergebnis.version)}`,
    `  Prüfsumme:  ${ergebnis.pruefsumme}`,
    '',
    neu
      ? '  Diese Version ist ab sofort aktiv.'
      : '  Gleicher Block wie die aktive Version: keine neue Version angelegt.',
    ...(ergebnis.erledigt === undefined ? [] : [`  Modul-Antrag Nr. ${String(ergebnis.erledigt)} ist damit erledigt.`]),
    RAHMEN,
    '',
  ].join('\n');
}
