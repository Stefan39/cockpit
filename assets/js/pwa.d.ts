/**
 * Typen für `pwa.js`, damit die Tests das Browser-Skript typgeprüft einbinden. Das Skript selbst ist reines JavaScript
 * ohne Build-Schritt und wird unverändert ausgeliefert.
 */
export type PushZugang = 'home_bildschirm' | 'nicht_unterstuetzt' | 'abgelehnt' | 'erlaubt' | 'moeglich';

export interface PushUmgebung {
  readonly ios: boolean;
  readonly standalone: boolean;
  readonly serviceWorker: boolean;
  readonly pushManager: boolean;
  readonly notification: boolean;
  readonly erlaubnis: 'default' | 'granted' | 'denied' | undefined;
}

export function istIos(userAgent: string, plattform: string, beruehrungspunkte: number): boolean;
export function pushZugang(umgebung: PushUmgebung): PushZugang;
export function schluesselBytes(schluessel: string): Uint8Array;

/** Was `neuLadenFaellig` braucht (COPI-105). */
export interface NeuLadenLage {
  readonly jetzt: number;
  readonly geladenUm: number;
  readonly taktSekunden: number;
  readonly sichtbar: boolean;
  readonly online: boolean;
  readonly beschaeftigt: boolean;
}

/** Das Stück Dokument, das `formularBeschaeftigt` liest. */
export interface FormularDokument {
  readonly activeElement: { readonly tagName: string; readonly isContentEditable?: boolean } | null;
  querySelectorAll(auswahl: string): Iterable<{
    readonly type: string;
    readonly value: string;
    readonly defaultValue?: string;
    readonly checked: boolean;
    readonly defaultChecked: boolean;
    readonly options?: Iterable<{ readonly selected: boolean; readonly defaultSelected: boolean }>;
  }>;
}

export function neuLadenFaellig(lage: NeuLadenLage): boolean;
export function formularBeschaeftigt(dokument: FormularDokument): boolean;
/** Die Zahl für das App-Symbol aus `data-posteingang-gesamt` (COPI-116). */
export function symbolZahl(wert: unknown): number | undefined;
/** Ob ein aufklappbarer Bereich offen ist (COPI-122): `auf`/`zu` aus dem Speicher, sonst der Stand des Servers. */
export function bereichOffen(gemerkt: string | null, standard: boolean): boolean;
