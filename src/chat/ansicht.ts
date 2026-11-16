/**
 * Was die Chat-Seite aus den Nachrichten macht (COPI-53), als reine Funktionen: Absender in Betriebssprache, Uhrzeit,
 * KI-Kennzeichnung, Vorschau — und die Prüfung einer Eingabe, bevor sie in die Datenbank geht.
 *
 * Der Inhalt bleibt Klartext. Er wird im Template escaped und nie verlinkt (ADR 10, Regel wie JAC-577): kein Markdown,
 * kein HTML, keine automatische Erkennung von Adressen.
 */
import { INHALT_HOECHSTENS, type Nachricht } from './nachricht-speicher.js';

export interface NachrichtAnsicht {
  readonly id: number;
  /** Vom angemeldeten Benutzer selbst: rechts, in der Akzentfarbe. */
  readonly eigen: boolean;
  readonly absender: string;
  /** Von einer KI erzeugt (Art. 50 KI-VO): sichtbar gekennzeichnet. */
  readonly ki: boolean;
  readonly zeit: string;
  readonly zeitIso: string;
  /** `undefined`, wenn die Nachricht als gelöscht markiert ist. */
  readonly inhalt: string | undefined;
  readonly dringend: boolean;
  /** Häkchen an der eigenen Nachricht im Assistenten-Kanal (COPI-69); sonst `undefined`. */
  readonly status: NachrichtStatus | undefined;
}

/** Was eine eigene Nachricht im Assistenten-Kanal erreicht hat: ✓ gesendet, ✓✓ angenommen, ✓✓ (Akzent) beantwortet. */
export type NachrichtStatus = 'gesendet' | 'angenommen' | 'beantwortet';

const ZEITZONE = 'Europe/Berlin';

const UHRZEIT = new Intl.DateTimeFormat('de-DE', { timeZone: ZEITZONE, hour: '2-digit', minute: '2-digit' });
const TAG = new Intl.DateTimeFormat('de-DE', { timeZone: ZEITZONE, day: '2-digit', month: '2-digit', year: 'numeric' });

/** „10:15" am selben Tag, sonst „22.09.2026, 10:15" — immer in der Zeit des Betriebs. */
export function zeitText(zeitpunkt: Date, jetzt: Date): string {
  const tag = TAG.format(zeitpunkt);
  const uhrzeit = UHRZEIT.format(zeitpunkt);
  return tag === TAG.format(jetzt) ? uhrzeit : `${tag}, ${uhrzeit}`;
}

/** „22.09.2026" — nur das Datum, in der Zeit des Betriebs (Modul-Version, COPI-84). */
export function datumText(zeitpunkt: Date): string {
  return TAG.format(zeitpunkt);
}

/**
 * „heute, 10:02" — der aktuelle Zeitpunkt selbst, als „Stand: …" (Dashboard der Übersicht, COPI-81; Kacheln der
 * Modulseite, COPI-82). `zeitText(jetzt, jetzt)` liefert nie „heute" (der Tagesvergleich ist dann immer gleich,
 * also nur die Uhrzeit) — deshalb hier ausgeschrieben, an einer Stelle statt an jeder Aufrufstelle einzeln.
 */
export function standText(jetzt: Date): string {
  return `heute, ${zeitText(jetzt, jetzt)}`;
}

/** Wer geschrieben hat, wie die Blase es zeigt — auch für den Posteingang (COPI-112). */
export function absenderText(nachricht: Nachricht, eigen: boolean): string {
  switch (nachricht.absenderArt) {
    case 'agent':
      return 'Koordinator';
    case 'system':
      return 'Cockpit';
    case 'mensch':
      return eigen ? 'Du' : (nachricht.absenderName ?? 'Unbekannt');
  }
}

/**
 * Der Stand einer eigenen Nachricht (COPI-69): „beantwortet", wenn danach (höhere ID) eine Antwort des Koordinators
 * im Kanal steht — die Meldungen des Cockpits (`system`) zählen nicht —, sonst „angenommen", wenn der Webhook quittiert
 * hat, sonst „gesendet". Als gelöscht markierte Nachrichten tragen kein Häkchen mehr.
 */
export function nachrichtStatus(nachricht: Nachricht, antwortDanach: boolean): NachrichtStatus | undefined {
  if (nachricht.geloeschtAm !== undefined) {
    return undefined;
  }
  if (antwortDanach) {
    return 'beantwortet';
  }
  return nachricht.zugestelltAm === undefined ? 'gesendet' : 'angenommen';
}

/**
 * Der Stand aller eigenen Nachrichten einer Seite des Verlaufs (älteste zuerst), nach ID. `antwortNachSeite`: es gibt
 * nach der Seite noch eine Antwort des Koordinators (bei älteren Seiten, deren Antwort auf einer neueren steht).
 */
export function eigeneStaende(verlauf: readonly Nachricht[], benutzerId: string, antwortNachSeite = false): Map<number, NachrichtStatus> {
  const staende = new Map<number, NachrichtStatus>();
  let antwortDanach = antwortNachSeite;
  for (const nachricht of [...verlauf].reverse()) {
    if (nachricht.absenderArt === 'agent') {
      antwortDanach = true;
    } else if (nachricht.absenderArt === 'mensch' && nachricht.absenderId === benutzerId) {
      const stand = nachrichtStatus(nachricht, antwortDanach);
      if (stand !== undefined) {
        staende.set(nachricht.id, stand);
      }
    }
  }
  return staende;
}

/**
 * Vor welcher Nachricht der Trenner „Neu" steht (COPI-69): die erste, die nicht von einem selbst stammt, nicht als
 * gelöscht markiert ist und nach dem alten Lesestand kam. Auf einer Seite, die nicht bis zum Lesestand zurückreicht
 * (ältere Nachrichten davor), kann eine ungelesene weiter vorn stehen — dann kein Trenner.
 */
export function neuTrennerVor(verlauf: readonly Nachricht[], benutzerId: string, lesestand: number, aeltereVorhanden: boolean): number | undefined {
  const erste = verlauf[0];
  if (erste === undefined || (aeltereVorhanden && erste.id > lesestand)) {
    return undefined;
  }
  return verlauf.find((n) => n.id > lesestand && n.geloeschtAm === undefined && n.absenderId !== benutzerId)?.id;
}

export function nachrichtAnsicht(nachricht: Nachricht, benutzerId: string, jetzt: Date, status?: NachrichtStatus): NachrichtAnsicht {
  const eigen = nachricht.absenderArt === 'mensch' && nachricht.absenderId === benutzerId;
  return {
    id: nachricht.id,
    eigen,
    absender: absenderText(nachricht, eigen),
    ki: nachricht.absenderArt === 'agent',
    zeit: zeitText(nachricht.erstelltAm, jetzt),
    zeitIso: nachricht.erstelltAm.toISOString(),
    inhalt: nachricht.inhalt,
    dringend: nachricht.dringend,
    status: eigen ? status : undefined,
  };
}

/** So viele Zeichen zeigt die Vorschau in der Liste „Verlauf". */
const VORSCHAU_ZEICHEN = 60;

/** Eine Zeile Vorschau der jüngsten Nachricht; ohne Nachricht `undefined`. */
export function vorschau(nachricht: Nachricht | undefined): string | undefined {
  if (nachricht === undefined) {
    return undefined;
  }
  if (nachricht.inhalt === undefined) {
    return 'Nachricht gelöscht';
  }
  const zeile = nachricht.inhalt.replace(/\s+/g, ' ').trim();
  const zeichen = Array.from(zeile);
  return zeichen.length > VORSCHAU_ZEICHEN ? `${zeichen.slice(0, VORSCHAU_ZEICHEN - 1).join('')}…` : zeile;
}

export type EingabePruefung = { readonly ok: true; readonly inhalt: string } | { readonly ok: false; readonly fehler: string };

/**
 * Prüft eine Eingabe aus dem Formular. Gezählt wird in Zeichen (Code-Points), wie `char_length` in der Datenbank —
 * nicht in UTF-16-Einheiten, sonst zählte ein Emoji doppelt. Zeilenumbrüche werden vereinheitlicht, sonst nichts.
 */
export function eingabePruefen(roh: unknown): EingabePruefung {
  const inhalt = typeof roh === 'string' ? roh.replace(/\r\n?/g, '\n') : '';
  if (!/\S/.test(inhalt)) {
    return { ok: false, fehler: 'Bitte eine Nachricht eingeben.' };
  }
  if (Array.from(inhalt).length > INHALT_HOECHSTENS) {
    return { ok: false, fehler: `Die Nachricht ist zu lang: höchstens ${String(INHALT_HOECHSTENS)} Zeichen.` };
  }
  return { ok: true, inhalt };
}
