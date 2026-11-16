/**
 * Gemeinsame Prüfungen für die Formulare, über die Konten entstehen
 * (Erststart und Einladung).
 *
 * Absichtlich genügsam: die verbindliche Prüfung macht Better Auth. Hier geht
 * es nur darum, offensichtliche Tippfehler abzufangen, **bevor** ein
 * einmaliges Token verbraucht wird. Gemeinsam statt je Route kopiert, damit
 * die Passwortregel an genau einer Stelle steht.
 */
import { MINDEST_PASSWORTLAENGE } from '../../auth/konfiguration.js';

export const NAME_MINDESTLAENGE = 2;
export const NAME_HOECHSTLAENGE = 100;

/** Formularwerte kommen als `unknown` an — alles andere als ein String zählt als leer. */
export function text(wert: unknown): string {
  return typeof wert === 'string' ? wert.trim() : '';
}

export function emailPlausibel(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Meldung zum Passwortpaar, oder `undefined`, wenn beides in Ordnung ist. */
export function passwortFehler(
  passwort: string,
  wiederholung: string,
): string | undefined {
  if (passwort.length < MINDEST_PASSWORTLAENGE) {
    return `Das Passwort muss mindestens ${String(MINDEST_PASSWORTLAENGE)} Zeichen lang sein.`;
  }
  if (passwort !== wiederholung) {
    return 'Die beiden Passwörter stimmen nicht überein.';
  }
  return undefined;
}

export function namePruefen(name: string): string | undefined {
  if (name.length < NAME_MINDESTLAENGE || name.length > NAME_HOECHSTLAENGE) {
    return `Bitte einen Namen mit ${String(NAME_MINDESTLAENGE)} bis ${String(NAME_HOECHSTLAENGE)} Zeichen angeben.`;
  }
  return undefined;
}
