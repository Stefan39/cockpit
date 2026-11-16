/**
 * Der E-Mail-Zweitkanal (COPI-60, ADR 6): eine dringende Nachricht, die der Besitzer des Assistenten-Kanals nach der
 * Frist (Standard 15 Minuten, `COCKPIT_CHAT_MAIL_NACH_MINUTEN`) noch nicht gelesen hat, meldet das Cockpit per E-Mail —
 * Pflicht, nicht Fallback: auch wer Push hat, bekommt sie.
 *
 *   * **Auswahl** ist eine reine Funktion (`faelligeMails`): Kandidaten und Zeitpunkt rein, Empfänger raus.
 *   * **Drosselung:** höchstens eine Mail je Konto und Stunde; eine Mail meldet alle fälligen Nachrichten des Kontos.
 *   * **Genau einmal je Nachricht:** Vermerk (`cockpit.chat_mail`) und Versand in derselben Transaktion. Scheitert der
 *     Versand, gibt es keinen Vermerk, und der nächste Lauf versucht es wieder. Stürzt der Prozess zwischen Versand und
 *     Commit ab, geht die Mail ein zweites Mal — lieber doppelt als gar nicht.
 *   * **Kein Inhalt** in der Mail (`zweitkanal-mail.ts`), keine Adresse im Log.
 *
 * Der Lauf prüft nichts am Server, nur die eigenen Tabellen; `src/server/index.ts` startet ihn im Takt.
 */
import type pg from 'pg';
import { protokollSchreiben } from '../auth/protokoll.js';
import type { Mailversand } from '../mail/versand.js';
import { zweitkanalMailBauen } from '../mail/zweitkanal-mail.js';
import { chatMailVermerken, zweitkanalKandidaten, type ZweitkanalKandidat } from './zweitkanal-speicher.js';

export const ZWEITKANAL_FRIST_MINUTEN_STANDARD = 15;
/** Höchstens eine Mail je Konto in diesem Abstand. */
export const ZWEITKANAL_DROSSEL_MS = 60 * 60 * 1000;
/** Wie oft der Lauf nachsieht. */
export const ZWEITKANAL_TAKT_MS = 60 * 1000;

export interface ZweitkanalRegeln {
  readonly fristMs: number;
  readonly drosselMs: number;
}

export interface FaelligeMail {
  readonly benutzerId: string;
  /** Aufsteigend. */
  readonly nachrichtIds: readonly number[];
}

/**
 * Wer jetzt eine Mail bekommt, und für welche Nachrichten: je Konto die Nachrichten, die seit mindestens der Frist
 * vorliegen — sofern die letzte Mail an das Konto nicht jünger ist als die Drosselung. Die Kandidaten sind schon
 * dringend, ungelesen und noch nicht gemeldet (`zweitkanalKandidaten`).
 */
export function faelligeMails(kandidaten: readonly ZweitkanalKandidat[], jetzt: Date, regeln: ZweitkanalRegeln): FaelligeMail[] {
  const jeKonto = new Map<string, number[]>();
  for (const kandidat of kandidaten) {
    const faellig = jetzt.getTime() - kandidat.erstelltAm.getTime() >= regeln.fristMs;
    const gedrosselt = kandidat.letzteMail !== undefined && jetzt.getTime() - kandidat.letzteMail.getTime() < regeln.drosselMs;
    if (faellig && !gedrosselt) {
      jeKonto.set(kandidat.benutzerId, [...(jeKonto.get(kandidat.benutzerId) ?? []), kandidat.nachrichtId]);
    }
  }
  return [...jeKonto].map(([benutzerId, ids]) => ({ benutzerId, nachrichtIds: ids.toSorted((a, b) => a - b) }));
}

/** Was der Lauf zum Melden braucht — Fastifys `app.log` passt. */
export interface ZweitkanalLog {
  warn(objekt: { benutzer: string; grund: string }, nachricht: string): void;
}

export interface ZweitkanalLauf {
  readonly pool: pg.Pool;
  readonly versand: Mailversand;
  /** `<basis>/chat` wird verlinkt. */
  readonly basisUrl: string;
  readonly fristMinuten: number;
  readonly log: ZweitkanalLog;
}

export interface ZweitkanalErgebnis {
  readonly gesendet: number;
  readonly fehlgeschlagen: number;
}

/**
 * Ein Lauf: auswählen, dann je Konto in einer eigenen Transaktion vermerken, protokollieren und senden. Ein Fehler bei
 * einem Konto hält die übrigen nicht auf; er kommt ins Log, ohne Adresse und ohne Inhalt.
 */
export async function zweitkanalLaufen(lauf: ZweitkanalLauf, jetzt: Date): Promise<ZweitkanalErgebnis> {
  const regeln = { fristMs: lauf.fristMinuten * 60 * 1000, drosselMs: ZWEITKANAL_DROSSEL_MS };
  const faellig = faelligeMails(await zweitkanalKandidaten(lauf.pool, jetzt), jetzt, regeln);
  let gesendet = 0;
  let fehlgeschlagen = 0;
  for (const mail of faellig) {
    try {
      if (await mailSenden(lauf, mail, jetzt)) {
        gesendet++;
      }
    } catch (fehler) {
      fehlgeschlagen++;
      const grund = fehler instanceof Error ? fehler.name : 'unbekannt';
      lauf.log.warn({ benutzer: mail.benutzerId, grund }, 'Zweitkanal: Mail nicht gesendet, der nächste Lauf versucht es wieder');
    }
  }
  return { gesendet, fehlgeschlagen };
}

/** Vermerk, Protokoll und Versand für ein Konto — alles oder nichts. `false`, wenn nichts (mehr) zu senden war. */
async function mailSenden(lauf: ZweitkanalLauf, mail: FaelligeMail, jetzt: Date): Promise<boolean> {
  const client = await lauf.pool.connect();
  try {
    await client.query('BEGIN');
    const vermerkt = await chatMailVermerken(client, mail, jetzt);
    if (vermerkt.email === undefined || vermerkt.anzahl === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await protokollSchreiben(client, {
      art: 'chat_mail_gesendet',
      akteur: 'system',
      ziel: mail.benutzerId,
      einzelheiten: { anzahl: vermerkt.anzahl },
    });
    const inhalt = zweitkanalMailBauen({ url: `${lauf.basisUrl}/chat`, anzahl: vermerkt.anzahl, fristMinuten: lauf.fristMinuten });
    await lauf.versand.senden({ an: vermerkt.email, ...inhalt });
    await client.query('COMMIT');
    return true;
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}
