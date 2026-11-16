/**
 * Schutz für die Dev-Werkzeuge unter `scripts/dev` (COPI-80): `./dev demo` und `./dev vorschau`
 * schreiben direkt in die Datenbank, und `demo-daten.ts` hebelt dafür kurz den Löschschutz aus
 * (`cockpit.nie_loeschen()`, Migration 0025). Das darf niemals gegen eine Kundeninstanz laufen.
 *
 * Reine Prüfung, ohne Datenbankverbindung und ohne Seiteneffekt:
 *
 *   * `NODE_ENV=production` bricht immer ab, unabhängig von `DATABASE_URL`.
 *   * Der Host aus `DATABASE_URL` muss `localhost`, `127.0.0.1` oder `::1` sein. Alles andere ist im
 *     Zweifel ein Abbruch — auch eine fehlende, leere oder nicht parsbare URL.
 *
 * `scripts/` liegt bewusst außerhalb von `src/` und geht nie ins Image (`tsconfig.build.json`
 * baut nur `src`, `.dockerignore` schließt `scripts` zusätzlich aus dem Build-Kontext aus).
 */

export interface LokalPruefungEingabe {
  readonly nodeEnv: string | undefined;
  readonly databaseUrl: string | undefined;
}

export type LokalPruefungErgebnis = { readonly ok: true } | { readonly ok: false; readonly grund: string };

/** `[::1]` ist die Schreibweise von `URL#hostname` für die IPv6-Loopback-Adresse (mit den Klammern). */
const ERLAUBTE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function lokalPruefen(eingabe: LokalPruefungEingabe): LokalPruefungErgebnis {
  if (eingabe.nodeEnv === 'production') {
    return {
      ok: false,
      grund: 'NODE_ENV=production — dieses Werkzeug läuft nie gegen eine Produktionsinstanz.',
    };
  }
  if (!eingabe.databaseUrl) {
    return { ok: false, grund: 'DATABASE_URL ist nicht gesetzt.' };
  }
  let host: string;
  try {
    host = new URL(eingabe.databaseUrl).hostname;
  } catch {
    return { ok: false, grund: 'DATABASE_URL ist keine gültige URL.' };
  }
  if (!ERLAUBTE_HOSTS.has(host)) {
    return {
      ok: false,
      grund:
        `DATABASE_URL zeigt auf „${host}", nicht auf localhost/127.0.0.1/::1 — ` +
        'dieses Werkzeug läuft nur gegen eine lokale Datenbank.',
    };
  }
  return { ok: true };
}

/** Wie `lokalPruefen`, wirft aber mit dem Grund als Meldung statt `{ ok: false }` zurückzugeben. */
export function sicherstellenLokal(eingabe: LokalPruefungEingabe): void {
  const ergebnis = lokalPruefen(eingabe);
  if (!ergebnis.ok) {
    throw new Error(ergebnis.grund);
  }
}

/**
 * Wie `sicherstellenLokal`, liefert aber gleich die geprüfte `DATABASE_URL` zurück — beide
 * Einstiegspunkte (`demo-daten.ts`, `vorschau.ts`) brauchen als Nächstes genau die, und
 * `sicherstellenLokal` hat schon geprüft, dass sie gesetzt ist (nur TypeScript weiß das über einen
 * Funktionsaufruf hinweg nicht, deshalb die Engführung hier statt an jeder Aufrufstelle erneut).
 */
export function sicherstellenLokaleDatenbankUrl(eingabe: LokalPruefungEingabe): string {
  sicherstellenLokal(eingabe);
  if (!eingabe.databaseUrl) {
    throw new Error('DATABASE_URL ist nicht gesetzt.');
  }
  return eingabe.databaseUrl;
}
