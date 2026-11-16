/**
 * Server-Sent Events für den Chat (COPI-56, ADR 2: „Server-Sent Events, nicht WebSocket — Einbahn reicht, läuft durch
 * Caddy, übersteht Mobilfunk-Reconnects"). Hier stehen die reinen Teile: das Format eines Ereignisses, der Heartbeat,
 * woher ein Stream weiterzählt, und die Obergrenze gleichzeitiger Streams je Konto.
 */

/** Alle so viele Millisekunden ein Kommentar, damit Caddy und Mobilfunk die ruhige Leitung nicht schließen. */
export const PULS_MS = 25_000;

/** So lange wartet der Browser nach einem Abbruch, bis er neu verbindet (`retry`). */
export const WIEDERVERBINDEN_MS = 5_000;

/** Gleichzeitige Streams je Konto — genug für mehrere Tabs und Geräte, nicht genug, um den Prozess zu fluten. */
export const STROEME_JE_KONTO = 5;

/** Der Heartbeat: ein Kommentar, den der Browser verwirft. */
export const PULS = ': puls\n\n';

export interface Ereignis {
  readonly id?: number;
  readonly art?: string;
  readonly daten?: string;
  readonly retry?: number;
}

/**
 * Ein Ereignis im Format von `text/event-stream`. Mehrzeilige Daten werden auf mehrere `data:`-Zeilen verteilt (der
 * Browser fügt sie mit `\n` wieder zusammen); ein `\r` fällt weg, sonst begänne dort eine neue Zeile des Protokolls.
 */
export function ereignisText(ereignis: Ereignis): string {
  const zeilen: string[] = [];
  if (ereignis.retry !== undefined) {
    zeilen.push(`retry: ${String(ereignis.retry)}`);
  }
  if (ereignis.id !== undefined) {
    zeilen.push(`id: ${String(ereignis.id)}`);
  }
  if (ereignis.art !== undefined) {
    zeilen.push(`event: ${ereignis.art}`);
  }
  if (ereignis.daten !== undefined) {
    for (const zeile of ereignis.daten.replace(/\r/g, '').split('\n')) {
      zeilen.push(`data: ${zeile}`);
    }
  }
  return `${zeilen.join('\n')}\n\n`;
}

/** Eine Nachrichten-ID aus Kopfzeile oder Adresse: eine positive ganze Zahl, sicher darstellbar. */
const NACHRICHT_ID = /^[1-9][0-9]{0,14}$/;

/**
 * Ab welcher Nachricht der Stream weiterzählt. `Last-Event-ID` (der Browser schickt es beim Wiederverbinden) geht vor
 * `?seit=` (die Seite, die den Stream öffnet, kennt ihre jüngste Nachricht). Ohne gültige Angabe: nichts nachliefern,
 * nur Neues.
 */
export function seitAus(letzteId: unknown, seit: unknown): number | undefined {
  for (const wert of [letzteId, seit]) {
    if (typeof wert === 'string' && NACHRICHT_ID.test(wert)) {
      return Number(wert);
    }
  }
  return undefined;
}

/** Zählt die offenen Streams je Konto. */
export class StromZaehler {
  private readonly offen = new Map<string, number>();

  constructor(private readonly hoechstens: number = STROEME_JE_KONTO) {}

  /** Belegt einen Platz; `false`, wenn das Konto schon so viele hat. */
  belegen(konto: string): boolean {
    const anzahl = this.offen.get(konto) ?? 0;
    if (anzahl >= this.hoechstens) {
      return false;
    }
    this.offen.set(konto, anzahl + 1);
    return true;
  }

  freigeben(konto: string): void {
    const anzahl = (this.offen.get(konto) ?? 0) - 1;
    if (anzahl > 0) {
      this.offen.set(konto, anzahl);
    } else {
      this.offen.delete(konto);
    }
  }

  anzahl(konto: string): number {
    return this.offen.get(konto) ?? 0;
  }
}
