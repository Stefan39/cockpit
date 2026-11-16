/**
 * Das Einspielen eines Moduls in die Registry `cockpit.modul` (COPI-77, Migration 0028) und das Lesen
 * der aktiven Module.
 *
 * `modulEinspielen` ist der ganze Ablauf aus dem Ticket, **in einer Transaktion**: parsen → Schema
 * prüfen (`block.ts`) → Katalog prüfen (`registry.ts`) → nächste Version ermitteln → neue Zeile einfügen
 * → bisher aktive Zeile derselben Kennung deaktivieren → neue Zeile aktivieren. Scheitert irgendetwas,
 * bleibt die bisher aktive Version aktiv (Rollback) — das Cockpit prüft und aktualisiert nichts selbst,
 * aber ein Einspielen, das auf halbem Weg abbricht, darf ein Modul erst recht nicht unbrauchbar
 * hinterlassen.
 *
 * Parsen und Schema-Prüfung brauchen keine Datenbank und laufen deshalb, bevor überhaupt eine Verbindung
 * aufgemacht wird; das Ergebnis ist dasselbe, als stünden sie in der Transaktion, nur ohne unnötig lange
 * eine Verbindung zu halten.
 *
 * **Prüfsumme und `block_roh`.** Beide stammen vom getrimmten Rohtext (führende/nachfolgende
 * Leerzeichen und ein Zeilenumbruch von der Standardeingabe sollen keine neue Version erzeugen, wenn
 * sich am Inhalt nichts geändert hat). Ist die Prüfsumme identisch mit der aktiven Version derselben
 * Kennung, entsteht keine neue Zeile — Meldung „unverändert", auch ohne Katalogprüfung: ein unverändert
 * gemeldeter Block ändert nichts an dem, was schon geprüft und aktiv ist.
 *
 * `eingespielt_von`: die Kennung des Aufrufers, wie bei jedem anderen Server-Kommando (`akteur`,
 * `src/cli/befehle.ts`) — `konsole`, solange es nur das Server-Kommando gibt.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { protokollSchreiben, type Abfrager } from '../auth/protokoll.js';
import { BETREUER_ZUGRIFF_STANDARD, istBetreuerZugriff, JUENGSTER_ZUGRIFF, type BetreuerZugriff } from './betreuer-zugriff.js';
import { kundenrolleFehlt, modulBlockAusText, modulBlockPruefen, type ModulBlock } from './block.js';
import { fachVersionPruefen } from './fach-migration.js';
import { katalogPruefen } from './registry.js';

export function pruefsummeBerechnen(rohtext: string): string {
  return createHash('sha256').update(rohtext, 'utf8').digest('hex');
}

export interface ModulEinspielenEingabe {
  /** Der rohe YAML-Text, direkt oder unter `cockpit:` (siehe `block.ts`). */
  readonly rohtext: string;
  readonly herkunft?: string | undefined;
  readonly akteur: string;
}

export type ModulEinspielenErgebnis =
  | {
      readonly ok: true;
      readonly status: 'neu' | 'unveraendert';
      readonly kennung: string;
      readonly version: number;
      readonly pruefsumme: string;
      /** Der Modul-Antrag (COPI-106), den diese Version als erledigt belegt; sonst keiner. */
      readonly erledigt?: number | undefined;
    }
  | { readonly ok: false; readonly grund: string };

export async function modulEinspielen(pool: pg.Pool, eingabe: ModulEinspielenEingabe): Promise<ModulEinspielenErgebnis> {
  const rohtext = eingabe.rohtext.trim();
  if (rohtext === '') {
    return { ok: false, grund: 'Der Modul-Block ist leer.' };
  }
  const geparst = modulBlockAusText(rohtext);
  if (!geparst.ok) {
    return { ok: false, grund: geparst.grund };
  }
  const block = geparst.block;
  const ohneKunde = kundenrolleFehlt(block);
  if (ohneKunde !== undefined) {
    return { ok: false, grund: ohneKunde };
  }
  const pruefsumme = pruefsummeBerechnen(rohtext);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialisiert gleichzeitige Läufe für dieselbe Kennung; die Sperre gilt nur für diese Transaktion
    // (Muster wie beim Migrations-Lock, `src/datenbank/migrationen.ts`, nur transaktionslokal statt
    // sitzungslokal, da hier kein eigener Client über die Funktion hinaus lebt).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cockpit.modul:${block.kennung}`]);

    const bisherAktiv = await client.query<{ version: number; pruefsumme: string; herkunft: string | null }>(
      `SELECT version::int AS version, pruefsumme, herkunft FROM cockpit.modul WHERE kennung = $1 AND aktiv = true`,
      [block.kennung],
    );
    const aktiv = bisherAktiv.rows[0];
    // Gleicher Block aus einem neuen Commit ist eine neue Version (COPI-106): die View kann sich geändert haben, also
    // läuft die Katalogprüfung erneut, und die Registry nennt die neue Herkunft, an der ein Modul-Update erledigt ist.
    const herkunftNeu = eingabe.herkunft !== undefined && eingabe.herkunft !== aktiv?.herkunft;
    if (aktiv?.pruefsumme === pruefsumme && !herkunftNeu) {
      await client.query('COMMIT');
      return { ok: true, status: 'unveraendert', kennung: block.kennung, version: aktiv.version, pruefsumme };
    }

    // Erst die Fachtabelle, dann die View (COPI-107): eine View über Spalten, die es noch nicht gibt, fiele sonst erst
    // in der Katalogprüfung auf — mit einer Meldung, die nicht sagt, welche Fachmigration fehlt.
    if (block.fach !== undefined) {
      const fach = await fachVersionPruefen(client, block.fach);
      if (!fach.ok) {
        await client.query('ROLLBACK');
        return { ok: false, grund: fach.grund };
      }
    }

    const katalog = await katalogPruefen(client, block);
    if (!katalog.ok) {
      await client.query('ROLLBACK');
      return { ok: false, grund: katalog.grund };
    }

    const naechsteVersion = await client.query<{ naechste: number }>(
      `SELECT coalesce(max(version), 0)::int + 1 AS naechste FROM cockpit.modul WHERE kennung = $1`,
      [block.kennung],
    );
    const version = naechsteVersion.rows[0]?.naechste ?? 1;

    const eingefuegt = await client.query<{ id: number }>(
      `INSERT INTO cockpit.modul (kennung, version, block, block_roh, pruefsumme, herkunft, eingespielt_von)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       RETURNING id::int AS id`,
      [block.kennung, version, JSON.stringify(block), rohtext, pruefsumme, eingabe.herkunft ?? null, eingabe.akteur],
    );
    const id = eingefuegt.rows[0]?.id;
    if (id === undefined) {
      throw new Error('Modul konnte nicht angelegt werden');
    }

    await client.query(
      `UPDATE cockpit.modul SET aktiv = false, aktiv_seit = NULL WHERE kennung = $1 AND aktiv = true`,
      [block.kennung],
    );
    await client.query(`UPDATE cockpit.modul SET aktiv = true, aktiv_seit = now() WHERE id = $1`, [id]);
    const erledigt = await modulUpdateBelegen(client, block.kennung);

    await client.query('COMMIT');
    return { ok: true, status: 'neu', kennung: block.kennung, version, pruefsumme, erledigt };
  } catch (fehler) {
    await client.query('ROLLBACK');
    return { ok: false, grund: fehler instanceof Error ? fehler.message : 'unbekannt' };
  } finally {
    client.release();
  }
}

/**
 * Setzt den laufenden Modul-Antrag auf `erledigt`, wenn die eben aktivierte Version aus seinem Ziel-Commit stammt
 * (COPI-106) — mit `update_erledigt`, Akteur `system`, wie beim Image (`instanz-speicher.ts`). Dieselbe Regel prüft der
 * Trigger `eingriff_modul` (0040): ein Agent kann sich nicht selbst Erfolg bescheinigen.
 */
async function modulUpdateBelegen(client: pg.PoolClient, kennung: string): Promise<number | undefined> {
  const ergebnis = await client.query<{ id: number }>(
    `UPDATE cockpit.eingriff e SET status = 'erledigt'
       FROM cockpit.modul m
      WHERE e.art = 'modul' AND e.status = 'laeuft' AND e.modul_kennung = $1
        AND m.kennung = $1 AND m.aktiv
        AND cockpit.commit_passt(cockpit.herkunft_commit(m.herkunft), e.ziel_commit)
      RETURNING e.id::int AS id`,
    [kennung],
  );
  const [belegt] = ergebnis.rows;
  if (belegt === undefined) {
    return undefined;
  }
  await protokollSchreiben(client, { art: 'update_erledigt', akteur: 'system', einzelheiten: { eingriff_id: belegt.id } });
  return belegt.id;
}

export interface AktivesModul {
  readonly kennung: string;
  readonly version: number;
  readonly block: ModulBlock;
  readonly eingespieltAm: Date;
  /** Was der Kunde dem Betreuer an diesem Modul freigegeben hat (COPI-134); bei `art: betrieb` ohne Bedeutung. */
  readonly betreuerZugriff: BetreuerZugriff;
}

/**
 * Alle aktiven Module, sortiert nach Kennung, mit geprüftem Block. Wird pro Anfrage gelesen, nie
 * zwischengespeichert — die Registry lebt in der Datenbank, damit ein Modul-Update ohne Neustart wirkt
 * (ADR); ein Cache widerspräche genau dem.
 */
export async function aktiveModule(db: Abfrager): Promise<AktivesModul[]> {
  const ergebnis = await db.query<{ kennung: string; version: number; block: unknown; eingespielt_am: Date; betreuer_zugriff: string | null }>(
    `SELECT m.kennung, m.version::int AS version, m.block, m.eingespielt_am, z.stufe AS betreuer_zugriff
       FROM cockpit.modul m
       LEFT JOIN (${JUENGSTER_ZUGRIFF}) z ON z.modul_kennung = m.kennung
      WHERE m.aktiv = true
      ORDER BY m.kennung`,
  );
  return ergebnis.rows.map((zeile) => {
    // Beim Einspielen schon geprüft (`modulEinspielen`): eine hier scheiternde Prüfung hieße, dass die
    // Zeile an der Registry vorbei geschrieben wurde.
    const geprueft = modulBlockPruefen(zeile.block);
    if (!geprueft.ok) {
      throw new Error(`Aktives Modul ${zeile.kennung} hat einen ungültigen Block: ${geprueft.grund}`);
    }
    return {
      kennung: zeile.kennung,
      version: zeile.version,
      block: geprueft.block,
      eingespieltAm: zeile.eingespielt_am,
      betreuerZugriff: istBetreuerZugriff(zeile.betreuer_zugriff) ? zeile.betreuer_zugriff : BETREUER_ZUGRIFF_STANDARD,
    };
  });
}
