/**
 * Betreuerwechsel (COPI-22).
 *
 * Es gibt höchstens einen Betreuer (partieller Unique-Index in Migration 0008),
 * und ein aktivierter Betreuer bleibt bestehen: die Datenbank lässt ihn weder
 * löschen noch herabstufen (Trigger `user_betreuer_bleibt_bestehen`). Wechseln
 * kann die Rolle nur hier — wenn jemand anderes die Betreuung übernimmt.
 *
 * Ausgelöst wird die Übergabe **nicht in der Oberfläche**: `betreuer` ist dort
 * nicht vergebbar, sonst könnte sich der Betriebs-Admin selbst befördern
 * (Architektur-Vorschlag 13.1). Sie ist für ein Server-Kommando gedacht (COPI-24);
 * die Vertrauensgrenze ist der Serverzugang.
 *
 * Alles geschieht in **einer** Transaktion. Der bisherige Betreuer wird zuerst
 * herabgestuft und dann das Zielkonto befördert — der Index prüft sofort, und in
 * dieser Reihenfolge sind zu keinem Zeitpunkt zwei Betreuer sichtbar. Der
 * Datenbank sagt die Transaktion, dass die Änderung gewollt ist, mit der
 * transaktionslokalen Einstellung `cockpit.betreuer_aenderung`.
 */
import type pg from 'pg';
import {
  istVergebbareRolle,
  ROLLE_BETREUER,
  ROLLE_DEFAULT,
  type VergebbareRolle,
} from './berechtigung.js';
import { protokollSchreiben } from './protokoll.js';

/**
 * Feste Nummer der Advisory-Lock, die Übergaben nacheinander ablaufen lässt.
 * Ohne sie sähe ein zweiter, gleichzeitiger Aufruf nach dem Warten auf die Zeile
 * (Isolationsstufe READ COMMITTED) den neuen Betreuer nicht und scheiterte an der
 * Unique-Verletzung, statt sauber hinter dem ersten zu laufen.
 */
const UEBERGABE_SPERRE = 6220220001;

export type UebergabeGrund =
  | 'ziel-unbekannt'
  | 'ziel-ist-betreuer'
  | 'ziel-nicht-aktiv'
  | 'rolle-ungueltig';

/** Die Übergabe wurde abgelehnt; an den Konten hat sich nichts geändert. */
export class BetreuerUebergabeFehler extends Error {
  readonly grund: UebergabeGrund;

  constructor(grund: UebergabeGrund, meldung: string) {
    super(meldung);
    this.name = 'BetreuerUebergabeFehler';
    this.grund = grund;
  }
}

export interface UebergabeAuftrag {
  /** Konto-ID des neuen Betreuers. */
  readonly an: string;
  /** Rolle, die der bisherige Betreuer behält. Default `betrieb_mitarbeiter` (kleinstes Recht). */
  readonly bisherigerWirdRolle?: VergebbareRolle;
  /** Wer die Übergabe auslöst, fürs Protokoll. Default `konsole`: sie ist für ein Server-Kommando gedacht. */
  readonly akteur?: string;
}

export interface UebergabeErgebnis {
  /** Konto-ID des bisherigen Betreuers; `undefined`, wenn es keinen gab. */
  readonly von: string | undefined;
  readonly an: string;
}

/**
 * Macht das Zielkonto zum Betreuer und stuft den bisherigen herab.
 *
 * Das Zielkonto muss existieren, darf nicht schon Betreuer sein und muss einen
 * aktiven zweiten Faktor haben (aktiviert): ein Konto mit vollständigen Rechten
 * ohne zweiten Faktor wäre ein Rückschritt. Ohne bisherigen Betreuer ernennt die
 * Funktion das Zielkonto (Wiederherstellung, etwa nach einem abgebrochenen
 * Erststart).
 *
 * „Zweiter Faktor aktiv" kommt wie überall aus `cockpit.zweiter_faktor_aktiv`
 * (COPI-25): ein Passkey zählt damit mit, sobald die Funktion ihn kennt.
 */
export async function betreuerUebergeben(
  pool: pg.Pool,
  auftrag: UebergabeAuftrag,
): Promise<UebergabeErgebnis> {
  const rolleDesBisherigen = auftrag.bisherigerWirdRolle ?? ROLLE_DEFAULT;
  if (!istVergebbareRolle(rolleDesBisherigen)) {
    throw new BetreuerUebergabeFehler(
      'rolle-ungueltig',
      'Der bisherige Betreuer kann nur Betriebs-Admin oder Mitarbeiter werden.',
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [UEBERGABE_SPERRE]);
    await client.query("SELECT set_config('cockpit.betreuer_aenderung', 'ja', true)");

    const bisheriger = await client.query<{ id: string }>(
      `SELECT id FROM cockpit."user" WHERE rolle = $1 FOR UPDATE`,
      [ROLLE_BETREUER],
    );
    const von = bisheriger.rows[0]?.id;

    const ziel = await client.query<{ rolle: string; aktiv: boolean }>(
      `SELECT u.rolle, (cockpit.zweiter_faktor_aktiv(u) AND u.aktiviert_am IS NOT NULL) AS aktiv
         FROM cockpit."user" u WHERE u.id = $1 AND u.geloescht_am IS NULL FOR UPDATE`,
      [auftrag.an],
    );
    const zielzeile = ziel.rows[0];
    if (!zielzeile) {
      throw new BetreuerUebergabeFehler('ziel-unbekannt', 'Das Zielkonto gibt es nicht.');
    }
    if (zielzeile.rolle === ROLLE_BETREUER) {
      throw new BetreuerUebergabeFehler('ziel-ist-betreuer', 'Das Zielkonto ist schon der Betreuer.');
    }
    if (!zielzeile.aktiv) {
      throw new BetreuerUebergabeFehler(
        'ziel-nicht-aktiv',
        'Das Zielkonto braucht einen aktiven zweiten Faktor, bevor es Betreuer werden kann.',
      );
    }

    // Erst herabstufen, dann befördern: der Index prüft sofort.
    if (von !== undefined) {
      await client.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [
        von,
        rolleDesBisherigen,
      ]);
    }
    await client.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [
      auftrag.an,
      ROLLE_BETREUER,
    ]);
    // Der Eintrag gehört zur Transaktion (COPI-23): keine Übergabe ohne Eintrag.
    await protokollSchreiben(client, {
      art: 'betreuer_uebergeben',
      akteur: auftrag.akteur ?? 'konsole',
      ziel: auftrag.an,
      einzelheiten:
        von === undefined
          ? { an: auftrag.an }
          : { von, an: auftrag.an, bisherige_rolle: rolleDesBisherigen },
    });
    await client.query('COMMIT');
    return { von, an: auftrag.an };
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}
