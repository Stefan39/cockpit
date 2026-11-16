/**
 * Wer an wem was bearbeiten darf (COPI-46) — reine Funktionen, die eine Stelle, an der die Regel steht. Seite,
 * Bestätigung und Ausführung fragen alle hier.
 *
 * **Die Grundregel: man bearbeitet nur Konten mit niedrigerer Rolle als der eigenen.** Der Betreuer also Betriebs-Admins
 * und Mitarbeiter, der Betriebs-Admin nur Mitarbeiter. Daraus folgt ohne eigene Sonderfälle:
 *
 *   * **Den Betreuer bearbeitet niemand** in der Oberfläche — es gibt keine höhere Rolle. Seine Übergabe bleibt beim
 *     Server-Kommando (ADR 13.1).
 *   * **Das eigene Konto** hat dieselbe Rolle, nicht eine niedrigere: niemand sperrt sich selbst aus oder stuft sich
 *     herab. (Es wird zusätzlich über die Kennung ausgeschlossen — falls je zwei Konten derselben Rolle einander
 *     bearbeiten dürften, bliebe das eigene trotzdem zu.)
 *   * Eine **unbekannte Rolle** — beim Handelnden wie beim Ziel — hat keinen Rang: nichts ist erlaubt.
 *
 * Die Aktionen (Stefans Entscheidung vom 22.09.2026):
 *
 *   * `name` — den Anzeigenamen ändern (angemeldet wird mit der E-Mail, nicht mit dem Namen);
 *   * `email` — eine neue E-Mail-Adresse beantragen; sie gilt erst, wenn ihr Postfach den Link bestätigt (COPI-47);
 *   * `rolle` — zwischen Betriebs-Admin und Mitarbeiter wechseln; nur mit `rollen_aendern` (Betreuer), und nur in eine
 *     Rolle, die ebenfalls niedriger ist als die eigene. `betreuer` ist nie ein Ziel;
 *   * `entfernen` — das Konto löschen; das Protokoll bleibt;
 *   * `zuruecksetzen` — der zweite Faktor, wie das Entsperren aus COPI-28: Faktoren, Passwort und Sitzungen entwertet,
 *     ein Link zur persönlichen Übergabe.
 *
 * **Frische Anmeldung:** jede dieser Aktionen verlangt eine Sitzung, die höchstens 15 Minuten alt ist. Wer eine fremde
 * Sitzung übernommen hat, hat sie meist nicht gerade erst mit Passwort und zweitem Faktor geöffnet.
 */
import { hatRecht, istRolle, istVergebbareRolle, type Rolle, type VergebbareRolle, type Zugang } from './berechtigung.js';

export const BEARBEITEN_AKTIONEN = ['name', 'email', 'rolle', 'entfernen', 'zuruecksetzen'] as const;

export type BearbeitenAktion = (typeof BEARBEITEN_AKTIONEN)[number];

export function istBearbeitenAktion(wert: unknown): wert is BearbeitenAktion {
  return typeof wert === 'string' && (BEARBEITEN_AKTIONEN as readonly string[]).includes(wert);
}

/** Wie weit eine Rolle reicht. Nur wer höher steht, bearbeitet. */
const RANG: Readonly<Record<Rolle, number>> = {
  betreuer: 3,
  betriebs_admin: 2,
  betrieb_mitarbeiter: 1,
};

function rang(rolle: unknown): number | undefined {
  return istRolle(rolle) ? RANG[rolle] : undefined;
}

/** Das Konto, das bearbeitet werden soll: Kennung und Rolle, wie sie gerade in der Datenbank stehen. */
export interface BearbeitenZiel {
  readonly id: string;
  readonly rolle: string;
}

/** Steht der Handelnde über dem Ziel, und ist es nicht er selbst? */
function darueber(akteur: Zugang, ziel: BearbeitenZiel): boolean {
  const eigener = rang(akteur.rolle);
  const fremder = rang(ziel.rolle);
  return (
    akteur.benutzerId !== undefined &&
    ziel.id !== akteur.benutzerId &&
    eigener !== undefined &&
    fremder !== undefined &&
    fremder < eigener
  );
}

/** Was dieser Zugang an diesem Konto tun darf, in fester Reihenfolge; leer, wenn nichts. Ohne Blick auf die Uhr. */
export function erlaubteAktionen(akteur: Zugang, ziel: BearbeitenZiel): readonly BearbeitenAktion[] {
  if (!hatRecht(akteur, 'benutzer_bearbeiten') || !darueber(akteur, ziel)) {
    return [];
  }
  return BEARBEITEN_AKTIONEN.filter((aktion) => aktion !== 'rolle' || hatRecht(akteur, 'rollen_aendern'));
}

/** Die Rollen, die dieser Zugang diesem Konto geben darf: niedriger als die eigene, vergebbar, nicht die bisherige. */
export function vergebbareRollenFuer(akteur: Zugang, ziel: BearbeitenZiel): readonly VergebbareRolle[] {
  const eigener = rang(akteur.rolle);
  if (!erlaubteAktionen(akteur, ziel).includes('rolle') || eigener === undefined) {
    return [];
  }
  return (['betriebs_admin', 'betrieb_mitarbeiter'] as const).filter(
    (rolle) => istVergebbareRolle(rolle) && RANG[rolle] < eigener && rolle !== ziel.rolle,
  );
}

/** So lange gilt eine Anmeldung als frisch. */
export const FRISCH_MS = 15 * 60_000;

/** Ist die Sitzung höchstens 15 Minuten alt? Ohne Zeitpunkt nie; eine Sitzung aus der Zukunft auch nicht. */
export function frischAngemeldet(akteur: Zugang, jetzt: Date): boolean {
  const seit = akteur.angemeldetSeit;
  if (seit === undefined) {
    return false;
  }
  const alter = jetzt.getTime() - seit.getTime();
  return alter >= 0 && alter <= FRISCH_MS;
}
