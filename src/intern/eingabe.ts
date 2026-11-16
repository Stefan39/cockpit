/**
 * Was die Eingabe-Prüfung der Agenten-API gemeinsam hat (COPI-36, COPI-38): die Form einer Kennung und die
 * Antwort auf eine ungültige Eingabe.
 *
 * Die Antwort nennt **nur Namen von Feldern, nie Werte** — ein Agent bekommt seine Eingabe nicht zurück, und
 * ein Fehler im Agenten legt so nichts in einer Antwort ab, die ein Zwischenspeicher oder ein Log aufbewahrt.
 */
import type { FastifyReply } from 'fastify';
import type * as z from 'zod';
import { antworten } from './antwort.js';

/** Wie Kennungen in der Datenbank (`wache_kennung_form`, `agent_kennung_form`, Migration 0015). */
export const KENNUNG = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/** Der Name eines Feldes, wie er in die Antwort darf: unsere eigenen Namen, oder ein harmloser fremder. */
const FELDNAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Der Pfad eines Fehlers als Name, etwa `agenten.2.zeitplan.0.name`. **Nach `grenzen` endet er:** was dahinter
 * steht, ist ein Schlüssel, den der Agent gewählt hat („Betrag je Rechnung"), also Inhalt und kein Feldname.
 */
function pfadName(pfad: readonly PropertyKey[]): string {
  const teile: string[] = [];
  for (const teil of pfad) {
    teile.push(String(teil));
    if (teil === 'grenzen') {
      break;
    }
  }
  return teile.join('.');
}

/**
 * Die Namen der fehlerhaften Felder, sortiert und ohne Wiederholung — nie ein Wert. Ein unbekanntes Feld
 * nennt sich mit seinem Namen, solange der harmlos aussieht; ein Fehler am ganzen Rumpf heißt `(rumpf)`.
 */
export function fehlerhafteFelder(fehler: z.ZodError): string[] {
  const felder = new Set<string>();
  for (const problem of fehler.issues) {
    const pfad = pfadName(problem.path);
    if (problem.code === 'unrecognized_keys') {
      for (const name of problem.keys) {
        const harmlos = FELDNAME.test(name) ? name : '(unbekanntes Feld)';
        felder.add(pfad === '' ? harmlos : `${pfad}.${harmlos}`);
      }
    } else {
      felder.add(pfad === '' ? '(rumpf)' : pfad);
    }
  }
  return [...felder].sort();
}

/**
 * Prüft eine Abfrage (`?…`, COPI-57 und COPI-85) gegen `schema`. Ungültig: die `400` mit den Feldnamen ist schon
 * gesendet, und es kommt `undefined` zurück — die Route gibt dann nur noch `reply` zurück.
 */
export function abfrageLesen<T>(schema: z.ZodType<T>, abfrage: unknown, reply: FastifyReply): T | undefined {
  const geprueft = schema.safeParse(abfrage);
  if (!geprueft.success) {
    void antworten(reply, 400, 'ungueltige_anfrage', {}, { felder: fehlerhafteFelder(geprueft.error) });
    return undefined;
  }
  return geprueft.data;
}
