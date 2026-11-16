/**
 * Sperre für das Anlegen von Benutzern.
 *
 * Im Cockpit darf ein Konto **nur** über den Erststart-Bootstrap entstehen
 * (später zusätzlich über die E-Mail-Einladung des Betriebs-Admins,
 * Architektur-Vorschlag Abschnitt 13.2) — niemals über einen öffentlich
 * erreichbaren Selbstregistrierungs-Endpunkt.
 *
 * Abgesichert wird das zweifach:
 * 1. Der Pfad `<auth-basis>/sign-up*` wird in der zentralen Fastify-Weiche
 *    gar nicht erst durchgelassen (siehe `zwei-faktor-tor.ts`).
 * 2. Zusätzlich hier: ein `databaseHooks.user.create.before`-Haken bricht jede
 *    Benutzeranlage ab, die nicht aus `mitBenutzerAnlage()` heraus läuft.
 *
 * Der zweite Riegel nutzt `AsyncLocalStorage` statt eines Modul-Flags, damit
 * parallele Anfragen die Freigabe nicht voneinander „erben" können.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const anlageKontext = new AsyncLocalStorage<true>();

/** Führt `aufgabe` in einem Kontext aus, in dem eine Benutzeranlage erlaubt ist. */
export async function mitBenutzerAnlage<T>(aufgabe: () => Promise<T>): Promise<T> {
  return anlageKontext.run(true, aufgabe);
}

export function benutzerAnlageErlaubt(): boolean {
  return anlageKontext.getStore() === true;
}
