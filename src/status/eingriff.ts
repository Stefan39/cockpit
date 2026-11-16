/**
 * Der Lebenszyklus eines Eingriffs (COPI-41, ADR 13.1) — reine Funktionen, der Zeitpunkt ist ein Parameter.
 *
 * Die Kette ist `beantragt → freigegeben → laeuft → erledigt | fehlgeschlagen`, dazu `beantragt → zurueckgezogen`
 * (Migration 0015, 0018, 0020). Ihre Regeln stehen in der Datenbank; hier steht, was die Anwendung darüber hinaus
 * wissen muss:
 *
 *   * **Welche Übergänge der Admin-Agent auslösen darf** — genau drei: freigeben, starten, als gescheitert melden.
 *     `erledigt` setzt nur das Cockpit selbst, beim Start, wenn es sich mit Ziel-Digest und Ziel-Version meldet
 *     (`instanz-speicher.ts`). `zurueckgezogen` ist Sache des Betreuers (COPI-40), `beantragt` ein neuer Antrag.
 *   * **`haengt`** — eine Zeile, die länger als 15 Minuten in `laeuft` steht. Das wird nie gespeichert, sondern beim
 *     Lesen berechnet: das Cockpit hat keinen Scheduler. So wird die ausbleibende Meldung sichtbar, die häufigste
 *     stille Fehlfunktion (ADR 13.1).
 *   * **Die Form der Ziel-Version**, die der Agent mit der Freigabe nennt: SemVer ohne Build-Metadaten, wie das Tag des
 *     Release (Bedingung `eingriff_ziel_version_form`).
 */

/** Die Kette (`eingriff_status_bekannt`, Migration 0015, Rückzug seit 0018). */
export const EINGRIFF_STATUS = ['beantragt', 'freigegeben', 'laeuft', 'erledigt', 'fehlgeschlagen', 'zurueckgezogen'] as const;

export type EingriffStatus = (typeof EINGRIFF_STATUS)[number];

/** Noch nicht abgeschlossen. */
export const OFFENE_STATUS: readonly EingriffStatus[] = ['beantragt', 'freigegeben', 'laeuft'];

export function istEingriffStatus(wert: string): wert is EingriffStatus {
  return (EINGRIFF_STATUS as readonly string[]).includes(wert);
}

/**
 * Was der Admin-Agent setzen darf, und woher allein das geht. Das Ziel bestimmt die Herkunft: so braucht ein Wechsel
 * keine zweite Angabe, und ein doppelt geschickter scheitert, weil die Zeile nicht mehr dort steht.
 */
export const AGENTEN_UEBERGAENGE = {
  freigegeben: 'beantragt',
  laeuft: 'freigegeben',
  fehlgeschlagen: 'laeuft',
} as const satisfies Partial<Record<EingriffStatus, EingriffStatus>>;

export type AgentenZiel = keyof typeof AGENTEN_UEBERGAENGE;

/** Länger als so lange in `laeuft`, und die Zeile hängt (ADR 13.1). */
export const HAENGT_NACH_MS = 15 * 60_000;

/** Hängt der Eingriff? Nur eine laufende Zeile kann hängen; genau 15 Minuten sind noch nicht „länger als". */
export function haengt(status: EingriffStatus, laeuftSeit: Date | undefined, jetzt: Date): boolean {
  return status === 'laeuft' && laeuftSeit !== undefined && jetzt.getTime() - laeuftSeit.getTime() > HAENGT_NACH_MS;
}

/** Wer vor diesem Zeitpunkt zu laufen begann, hängt jetzt — dieselbe Regel, als Grenze für eine Abfrage. */
export function haengtGrenze(jetzt: Date): Date {
  return new Date(jetzt.getTime() - HAENGT_NACH_MS);
}

/** SemVer 2.0 ohne Build-Metadaten, höchstens 64 Zeichen (`eingriff_ziel_version_form`, Migration 0020). */
export const ZIEL_VERSION_FORM = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const ZIEL_VERSION_HOECHSTENS = 64;

/** Ein Commit in agent-blueprints, wie ihn ein Modul-Antrag nennt (`eingriff_art_passt`, Migration 0040). */
export const ZIEL_COMMIT_FORM = /^[0-9a-f]{7,40}$/;

/** So lang darf der Grund eines Fehlschlags sein (`eingriff_fehler_grund_passt`, 0040). */
export const FEHLER_GRUND_HOECHSTENS = 300;
