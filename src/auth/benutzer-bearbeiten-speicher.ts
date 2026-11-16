/**
 * Konten bearbeiten in der Datenbank (COPI-46): Name ändern, Rolle ändern, entfernen, zweiten Faktor zurücksetzen.
 *
 * **Die Rechte werden hier ein zweites Mal geprüft, an der gesperrten Zeile.** Seite und Bestätigung fragen
 * `erlaubteAktionen` schon vorher; zwischen Bestätigung und Ausführung kann sich die Rolle des Ziels aber geändert haben
 * (ein anderer Betreuer-Tab, eine Übergabe per Konsole). Deshalb läuft die Prüfung in der Transaktion, nachdem die Zeile
 * mit `FOR UPDATE` gesperrt ist, und die Änderung gilt nur, wenn sie dann noch erlaubt ist.
 *
 * Jede Änderung schreibt ihren Protokolleintrag **in derselben Transaktion** — beides gilt oder keins. Akteur ist das
 * handelnde Konto, Ziel das bearbeitete; Namen stehen nie im Protokoll (sie sind keine Kennung und keine Nachweis-Angabe).
 *
 * Die Datenbank sichert zusätzlich: der Betreuer lässt sich weder löschen noch herabstufen (0008), und es gibt höchstens
 * einen (partieller Unique-Index) — selbst ein Fehler in `erlaubteAktionen` machte niemanden zum Betreuer.
 */
import type pg from 'pg';
import type { VergebbareRolle } from './berechtigung.js';
import type { BearbeitenZiel } from './benutzer-bearbeiten.js';
import {
  EntsperrenKontoUnbekannt,
  EntsperrenNichtErlaubt,
  kontoEntsperren,
  type Entsperrung,
} from './entsperrung.js';
import { kontoAlsGeloeschtMarkieren, unbrauchbarerPasswortHash } from './konto-loeschen.js';
import { protokollSchreiben } from './protokoll.js';

export type BearbeitenErgebnis<T> =
  | { readonly ok: true; readonly wert: T }
  /** Es gibt kein Konto mit dieser Kennung. */
  | { readonly ok: false; readonly grund: 'unbekannt' }
  /** Das Konto gibt es, aber diese Änderung ist (jetzt) nicht erlaubt. */
  | { readonly ok: false; readonly grund: 'verboten' };

/** Wer handelt und was er am Ziel darf — geprüft an der gesperrten Zeile. */
export interface Handelnder {
  /** Konto-ID des Handelnden: der Akteur im Protokoll. */
  readonly id: string;
  readonly erlaubt: (ziel: BearbeitenZiel) => boolean;
}

/**
 * Sperrt das Konto, prüft, ob die Änderung jetzt noch erlaubt ist, und führt `arbeit` aus — alles in einer Transaktion.
 * Scheitert die Prüfung oder wirft `arbeit`, bleibt alles, wie es war. Auch für die Adressänderung (COPI-47).
 */
export async function amKonto<T>(
  pool: pg.Pool,
  zielId: string,
  handelnder: Handelnder,
  arbeit: (client: pg.PoolClient, ziel: BearbeitenZiel) => Promise<T>,
): Promise<BearbeitenErgebnis<T>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Ein als gelöscht markiertes Konto gibt es hier nicht mehr (COPI-62): es lässt sich nicht mehr bearbeiten.
    const gesperrt = await client.query<{ rolle: string }>(
      'SELECT rolle FROM cockpit."user" WHERE id = $1 AND geloescht_am IS NULL FOR UPDATE',
      [zielId],
    );
    const zeile = gesperrt.rows[0];
    if (zeile === undefined) {
      await client.query('ROLLBACK');
      return { ok: false, grund: 'unbekannt' };
    }
    const ziel: BearbeitenZiel = { id: zielId, rolle: zeile.rolle };
    if (!handelnder.erlaubt(ziel)) {
      await client.query('ROLLBACK');
      return { ok: false, grund: 'verboten' };
    }
    const wert = await arbeit(client, ziel);
    await client.query('COMMIT');
    return { ok: true, wert };
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

/** Setzt den Anzeigenamen. Angemeldet wird mit der E-Mail, der Name ist nur, wie das Konto heißt. */
export async function nameAendern(
  pool: pg.Pool,
  zielId: string,
  name: string,
  handelnder: Handelnder,
): Promise<BearbeitenErgebnis<undefined>> {
  return amKonto(pool, zielId, handelnder, async (client) => {
    await client.query('UPDATE cockpit."user" SET name = $2, "updatedAt" = now() WHERE id = $1', [zielId, name]);
    await protokollSchreiben(client, { art: 'name_geaendert', akteur: handelnder.id, ziel: zielId });
    return undefined;
  });
}

/** Wechselt die Rolle; das Protokoll hält fest, von welcher zu welcher. */
export async function rolleAendern(
  pool: pg.Pool,
  zielId: string,
  rolle: VergebbareRolle,
  handelnder: Handelnder,
): Promise<BearbeitenErgebnis<undefined>> {
  return amKonto(pool, zielId, handelnder, async (client, ziel) => {
    await client.query('UPDATE cockpit."user" SET rolle = $2, "updatedAt" = now() WHERE id = $1', [zielId, rolle]);
    await protokollSchreiben(client, {
      art: 'rolle_geaendert',
      akteur: handelnder.id,
      ziel: zielId,
      einzelheiten: { von: ziel.rolle, an: rolle },
    });
    return undefined;
  });
}

/**
 * Entfernt das Konto — **nie physisch, nur als gelöscht markiert** (COPI-62): Zugang entwertet (Faktoren archiviert,
 * Sitzungen beendet, Passwort ohne Urbild), Adresse durch einen Platzhalter ersetzt und wieder frei. Alles, was auf das
 * Konto verweist, bleibt im Bestand; Einladungen, die es verschickt hat, bleiben gültig.
 */
export async function kontoEntfernen(pool: pg.Pool, zielId: string, handelnder: Handelnder): Promise<BearbeitenErgebnis<undefined>> {
  // Argon2id rechnet, bevor die Transaktion die Zeile sperrt.
  const passwortHash = await unbrauchbarerPasswortHash();
  return amKonto(pool, zielId, handelnder, async (client, ziel) => {
    await protokollSchreiben(client, {
      art: 'konto_entfernt',
      akteur: handelnder.id,
      ziel: zielId,
      einzelheiten: { rolle: ziel.rolle },
    });
    await kontoAlsGeloeschtMarkieren(client, zielId, handelnder.id, passwortHash);
    return undefined;
  });
}

/**
 * Setzt den zweiten Faktor zurück: das Entsperren aus COPI-28, ausgelöst aus der Oberfläche. Faktoren, Passwort und
 * Sitzungen sind danach entwertet; zurück kommt der Link, der genau einmal gezeigt und persönlich übergeben wird.
 */
export async function faktorZuruecksetzen(
  pool: pg.Pool,
  zielId: string,
  handelnder: Handelnder,
  jetzt: Date,
): Promise<BearbeitenErgebnis<Entsperrung>> {
  try {
    const wert = await kontoEntsperren(pool, zielId, jetzt, { akteur: handelnder.id, weg: 'oberflaeche', erlaubt: handelnder.erlaubt });
    return { ok: true, wert };
  } catch (fehler) {
    if (fehler instanceof EntsperrenKontoUnbekannt) {
      return { ok: false, grund: 'unbekannt' };
    }
    if (fehler instanceof EntsperrenNichtErlaubt) {
      return { ok: false, grund: 'verboten' };
    }
    throw fehler;
  }
}
