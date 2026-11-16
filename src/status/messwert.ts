/**
 * Der Hauptmesswert eines Befunds (COPI-83, Entscheidung Stefan 28.09.2026): **ein** Wert je Befund, etwa
 * „Plattenplatz 86 % von 100 %, Warnschwelle 85". Die Form prüfen drei Stellen unabhängig voneinander: die Route
 * (`intern/befund.ts`, zod), die Datenbank (`befund_messwert_form`, Migration 0029) und beim Lesen `messwertAus` —
 * ein Wert, der die Form nicht hat, gilt als „kein Messwert", nie als halber.
 *
 * Für den Kunden zählt ein Messwert nur über einen `kundensichtbar`en Befund — dieselbe Regel wie für den Klartext.
 */

export interface Messwert {
  /** Endliche Zahl. */
  readonly wert: number;
  /** 1–12 Zeichen, an den Rändern gekürzt: „%", „ms", „Tage", „von 5". */
  readonly einheit: string;
  /** Obergrenze (> 0), etwa 100 bei Prozent; ohne Angabe gibt es keinen Balken. */
  readonly max?: number | undefined;
  /** Schwelle, ab der die Wache gelb meldet — die Warnlinie der Kurve. */
  readonly warnung?: number | undefined;
}

/** Längste erlaubte Einheit, ungekürzt gezählt wie `char_length` in `befund_messwert_form` (Migration 0029). */
export const MESSWERT_EINHEIT_MAX = 12;

/** Erlaubte Schlüssel, wie `befund_messwert_form` (Migration 0029); jeder weitere macht den Wert ungültig. */
const MESSWERT_SCHLUESSEL: readonly string[] = ['wert', 'einheit', 'max', 'warnung'];

function endlich(wert: unknown): wert is number {
  return typeof wert === 'number' && Number.isFinite(wert);
}

/** Ein Messwert aus gelesenem jsonb; alles, was nicht genau die Form hat, ist `undefined` (siehe Kopf). */
export function messwertAus(json: unknown): Messwert | undefined {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return undefined;
  }
  if (Object.keys(json).some((schluessel) => !MESSWERT_SCHLUESSEL.includes(schluessel))) {
    return undefined;
  }
  const { wert, einheit, max, warnung } = json as Record<string, unknown>;
  if (!endlich(wert) || typeof einheit !== 'string' || einheit.trim() === '') {
    return undefined;
  }
  // Zeichen (Codepoints) zählen wie `char_length`, nicht UTF-16-Einheiten.
  if ([...einheit].length > MESSWERT_EINHEIT_MAX) {
    return undefined;
  }
  if ((max !== undefined && (!endlich(max) || max <= 0)) || (warnung !== undefined && !endlich(warnung))) {
    return undefined;
  }
  return { wert, einheit: einheit.trim(), ...(max === undefined ? {} : { max }), ...(warnung === undefined ? {} : { warnung }) };
}
