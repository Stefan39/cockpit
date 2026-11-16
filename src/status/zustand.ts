/**
 * Der Zustand einer Wache — eine reine Funktion (COPI-36, Architektur-Vorschlag 4).
 *
 * Das Cockpit prüft nichts selbst und hat keinen Scheduler. Es kennt zwei Zeitpunkte je Wache, den
 * letzten Lauf und den Takt, in dem sie melden soll, und rechnet daraus **beim Ansehen**, ob sie
 * ausgeblieben ist. Ein „alles grün" von vor drei Tagen ist keine Auskunft — und die ausbleibende
 * Meldung ist laut Admin-Vorgabe die häufigste stille Fehlfunktion.
 *
 * Die Regeln, jede mit einem Test:
 *
 *   * **Überfällig** ist eine Wache, wenn ihr letzter Lauf länger als `Takt + Toleranz` zurückliegt
 *     (genau an der Grenze noch nicht). Die Toleranz ist der halbe Takt, mindestens eine Minute: sie
 *     fängt Schwankungen und Verzögerungen des Zeitplans auf, ohne eine wöchentliche Wache nach einem
 *     Tag als tot zu melden.
 *   * Eine überfällige Wache ist **gelb**. Ein **gemeldetes Rot bleibt rot**: eine Störung wird durch
 *     Schweigen nicht besser.
 *   * Eine Wache, die **nie gemeldet** hat, ist gelb und „noch nie geprüft" — nie ein erfundenes
 *     „gerade eben".
 *   * **Springt die Uhr zurück** (der letzte Lauf liegt scheinbar in der Zukunft), ist das Alter null,
 *     nicht negativ: die Wache ist nicht überfällig und wird nicht als „in der Zukunft geprüft"
 *     beschrieben.
 *   * **Im Zweifel gelb:** ein unbrauchbarer Takt (null, negativ, keine Zahl) oder ein Lauf ohne
 *     bekannten Befund lässt eine Wache nie grün aussehen.
 *
 * Der Zeitpunkt ist ein Parameter (nie die Uhr des Rechners): dasselbe Argument liefert immer dasselbe
 * Ergebnis, und Grenzfälle lassen sich ohne Warten prüfen.
 */

/** Die Farben eines Befunds; muss mit der CHECK-Bedingung `befund_status_bekannt` (Migration 0015) übereinstimmen. */
export const BEFUND_STATUS = ['gruen', 'gelb', 'rot'] as const;

export type BefundStatus = (typeof BEFUND_STATUS)[number];

/** Ein Status aus der Datenbank. Sie lässt nur diese Werte zu (`befund_status_bekannt`); ein anderer wäre ein Fehler, keine Farbe. */
export function befundStatusAus(wert: string): BefundStatus {
  const gefunden = BEFUND_STATUS.find((farbe) => farbe === wert);
  if (gefunden === undefined) {
    throw new Error('Unbekannter Status in der Datenbank');
  }
  return gefunden;
}

/** Mindestens so viel Spielraum über den Takt hinaus, auch bei einer Wache mit sehr kurzem Takt. */
const TOLERANZ_MINDESTENS_SEKUNDEN = 60;

/** Die Toleranz zu einem Takt: der halbe Takt, mindestens eine Minute. */
export function toleranzSekunden(taktSekunden: number): number {
  return Math.max(TOLERANZ_MINDESTENS_SEKUNDEN, Math.ceil(taktSekunden / 2));
}

/** Was das Cockpit über eine Wache weiß: Takt, letzter Lauf und der Status ihres letzten Befunds. */
export interface WachenStand {
  readonly taktSekunden: number;
  /** `undefined`: die Wache hat noch nie gemeldet. */
  readonly letzterLauf: Date | undefined;
  readonly letzterStatus: BefundStatus | undefined;
}

export interface WachenZustand {
  /** Die Farbe, mit der die Wache jetzt angezeigt wird. */
  readonly farbe: BefundStatus;
  /** Ausgeblieben: nie gemeldet oder länger als Takt plus Toleranz her. */
  readonly ueberfaellig: boolean;
  readonly nieGemeldet: boolean;
  /** Ganze Sekunden seit dem letzten Lauf, nie negativ; `undefined`, wenn die Wache nie gemeldet hat. */
  readonly alterSekunden: number | undefined;
  /** Klartext für die Oberfläche, etwa „zuletzt geprüft vor 2 Stunden". */
  readonly zuletztGeprueft: string;
  /** Die kurze Form der Kacheln im Prototyp, etwa „vor 2 Std. geprüft" (COPI-43). */
  readonly geprueftKurz: string;
}

function einheit(anzahl: number, einzahl: string, mehrzahl: string): string {
  return `${String(anzahl)} ${anzahl === 1 ? einzahl : mehrzahl}`;
}

/** Eine Dauer ab einer Minute, abgerundet auf die größte volle Einheit, im Dativ: passt hinter „vor" und „in". */
function dauer(sekunden: number): string {
  if (sekunden < 3600) {
    return einheit(Math.floor(sekunden / 60), 'Minute', 'Minuten');
  }
  if (sekunden < 86_400) {
    return einheit(Math.floor(sekunden / 3600), 'Stunde', 'Stunden');
  }
  return einheit(Math.floor(sekunden / 86_400), 'Tag', 'Tagen');
}

/** „gerade eben", „vor 5 Minuten" …, gerundet auf die größte volle Einheit. Auch für das Alter des Inventars (COPI-38). */
export function vorText(alterSekunden: number): string {
  return alterSekunden < 60 ? 'gerade eben' : `vor ${dauer(alterSekunden)}`;
}

/** Dasselbe nach vorn (COPI-45): „in weniger als einer Minute", „in 5 Minuten", „in 2 Stunden", „in 3 Tagen". */
export function inText(restSekunden: number): string {
  return restSekunden < 60 ? 'in weniger als einer Minute' : `in ${dauer(restSekunden)}`;
}

/** Die kurze Form des Prototyps: „gerade eben", „vor 4 Min.", „vor 2 Std.", „vor 3 Tagen" (COPI-43). */
export function vorKurz(alterSekunden: number): string {
  if (alterSekunden < 60) {
    return 'gerade eben';
  }
  if (alterSekunden < 3600) {
    return `vor ${String(Math.floor(alterSekunden / 60))} Min.`;
  }
  if (alterSekunden < 86_400) {
    return `vor ${String(Math.floor(alterSekunden / 3600))} Std.`;
  }
  return `vor ${einheit(Math.floor(alterSekunden / 86_400), 'Tag', 'Tagen')}`;
}

function farbeBestimmen(ueberfaellig: boolean, letzterStatus: BefundStatus | undefined): BefundStatus {
  if (letzterStatus === 'rot') {
    return 'rot';
  }
  if (ueberfaellig) {
    return 'gelb';
  }
  // Ein Lauf ohne bekannten Befund ist keine Gesundmeldung.
  return letzterStatus ?? 'gelb';
}

export function wachenZustand(stand: WachenStand, jetzt: Date): WachenZustand {
  const lauf = stand.letzterLauf;
  if (lauf === undefined || Number.isNaN(lauf.getTime())) {
    return {
      farbe: farbeBestimmen(true, stand.letzterStatus),
      ueberfaellig: true,
      nieGemeldet: true,
      alterSekunden: undefined,
      zuletztGeprueft: 'noch nie geprüft',
      geprueftKurz: 'noch nie geprüft',
    };
  }

  const alterSekunden = Math.max(0, Math.floor((jetzt.getTime() - lauf.getTime()) / 1000));
  const taktBrauchbar = Number.isFinite(stand.taktSekunden) && stand.taktSekunden > 0;
  // Ohne brauchbaren Takt lässt sich nicht sagen, ob die Wache ausbleibt: im Zweifel gilt sie als überfällig.
  const ueberfaellig = !taktBrauchbar || alterSekunden > stand.taktSekunden + toleranzSekunden(stand.taktSekunden);

  return {
    farbe: farbeBestimmen(ueberfaellig, stand.letzterStatus),
    ueberfaellig,
    nieGemeldet: false,
    alterSekunden,
    zuletztGeprueft: `zuletzt geprüft ${vorText(alterSekunden)}`,
    geprueftKurz: `${vorKurz(alterSekunden)} geprüft`,
  };
}
