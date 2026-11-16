/**
 * Der Update-Antrag in der Datenbank (COPI-40): stellen und zurückziehen, jeweils mit Protokolleintrag in derselben
 * Transaktion — beides gilt oder keins.
 *
 * Die Regeln der Kette stehen in der Datenbank (Migration 0015 und 0018), nicht hier: der Antrag beginnt als
 * `beantragt`, Ziel und Rückweg sind danach unveränderlich, zurückziehen geht nur aus `beantragt`, und es gibt
 * höchstens einen offenen Antrag je Art und Modul (`eingriff_ein_offener_antrag`, seit 0040 je Modul). Diese Datei
 * übersetzt nur, was die Datenbank sagt: scheitert der Antrag an dieser Regel, ist das ein Ergebnis („es gibt schon einen"), kein Fehler.
 *
 * Das Cockpit schreibt hier nur Anträge. Freigabe und Ausführung (`freigegeben`, `laeuft`, …) gehören dem
 * Admin-Agenten nach Stefans Freigabe außerhalb des Cockpits (ADR 13.1, COPI-41) — außer im Freigabemodus `direkt`
 * (COPI-141, `docs/adr/0002-freigabe-direkt.md`): dann ist die Bestätigung des Betreuers die Freigabe, und der Antrag
 * steht in derselben Transaktion auf `freigegeben`. Ausgeführt wird auch dann nur vom Agenten. Im Modus `automatisch`
 * (COPI-142) stellt der Planer (`update-planer.ts`) den Antrag über denselben Weg, mit `automatisch` und ohne Klick.
 */
import type pg from 'pg';
import { protokollSchreiben, type Abfrager } from '../auth/protokoll.js';
import { inTransaktion } from '../datenbank/transaktion.js';
import { antragModus, freigabeModusLesen, freigabeModusSperren, type AntragModus, type FreigabeBereich } from './freigabe-modus.js';

/** Die Zeit des Betriebs: Kalendertag des Tageslimits und Wartungsfenster des automatischen Updates (COPI-142). */
export const BETRIEBS_ZEITZONE = 'Europe/Berlin';

/** Postgres-Code für „Wert verletzt eine Eindeutigkeitsbedingung". */
const EINDEUTIGKEIT_VERLETZT = '23505';

/** Die Regel „höchstens ein offener Antrag" (Migration 0018). */
const EIN_OFFENER_ANTRAG = 'eingriff_ein_offener_antrag';

function istOffenerAntrag(fehler: unknown): boolean {
  return (
    typeof fehler === 'object' &&
    fehler !== null &&
    (fehler as { code?: unknown }).code === EINDEUTIGKEIT_VERLETZT &&
    (fehler as { constraint?: unknown }).constraint === EIN_OFFENER_ANTRAG
  );
}

/**
 * Wie der Antrag freigegeben wird (COPI-141). `erwartet` ist der Modus, den die Bestätigungsseite angekündigt hat;
 * gilt inzwischen ein anderer, entsteht nichts (`modus`), und die Seite kommt mit dem geltenden zurück. `direkt` gilt nur
 * mit `direktMoeglich` — beim Notweg (getipptes Ziel) bleibt es bei der Rückfrage.
 */
export interface AntragFreigabe {
  readonly erwartet: AntragModus;
  readonly direktMoeglich: boolean;
}

/**
 * Ein Antrag, den das Cockpit selbst stellt (COPI-142). Er entsteht nur, wenn der Bereich auf `automatisch` steht, und
 * nur, wenn `zulassen` in der Transaktion des Antrags `true` liefert (Schleifenschutz, unter der Sperre des Bereichs).
 */
export interface AutomatischerAntrag {
  readonly zulassen: (client: pg.PoolClient) => Promise<boolean>;
}

export interface UpdateAntrag {
  readonly zielDigest: string;
  /** Der laufende Digest: der Weg zurück (ADR 13.1). */
  readonly digestVorher: string;
  /** Konto-ID des Betreuers. */
  readonly kontoId: string;
  /** Die Version des Ziels, wie die Versions-Wache sie meldet; ohne sie keine direkte Freigabe (Erfolgsbeleg, 0020). */
  readonly zielVersion?: string | undefined;
  readonly freigabe: AntragFreigabe;
  readonly automatisch?: AutomatischerAntrag;
}

export type AntragErgebnis =
  | { readonly ok: true; readonly id: number; readonly modus: AntragModus }
  /** Es gibt schon einen offenen Antrag: es steht nichts in der Datenbank. */
  | { readonly ok: false; readonly grund: 'offen' }
  /** Es gilt ein anderer Modus als angekündigt: es steht nichts in der Datenbank. */
  | { readonly ok: false; readonly grund: 'modus'; readonly modus: AntragModus }
  /** Ein automatischer Antrag, den der Schleifenschutz nicht zulässt: es steht nichts in der Datenbank. */
  | { readonly ok: false; readonly grund: 'gesperrt' };

/**
 * Stellt den Antrag: eine Zeile `beantragt` und der Eintrag `update_beantragt` mit ihrer Nummer; im Modus `direkt`
 * gleich danach `freigegeben` mit der Ziel-Version und dem Eintrag `update_freigegeben` (`weg: direkt`).
 */
export async function updateBeantragen(pool: pg.Pool, antrag: UpdateAntrag): Promise<AntragErgebnis> {
  return antragAnlegen(pool, {
    bereich: 'cockpit',
    sql: `INSERT INTO cockpit.eingriff (art, ziel_digest, digest_vorher, beantragt_von, freigabe_modus, automatisch)
          VALUES ('cockpit-image', $1, $2, $3, $4, $5)
          RETURNING id::int AS id`,
    werte: [antrag.zielDigest, antrag.digestVorher, antrag.kontoId],
    kontoId: antrag.kontoId,
    freigabe: { ...antrag.freigabe, direktMoeglich: antrag.freigabe.direktMoeglich && antrag.zielVersion !== undefined },
    zielVersion: antrag.zielVersion ?? null,
    automatisch: antrag.automatisch,
  });
}

export interface ModulUpdateAntrag {
  readonly modul: string;
  /** Der Commit in agent-blueprints, wie eingegeben (7–40 Hex). */
  readonly zielCommit: string;
  /** Die Herkunft der aktiven Version: der Weg zurück. */
  readonly herkunftVorher: string;
  readonly kontoId: string;
  readonly freigabe: AntragFreigabe;
  readonly automatisch?: AutomatischerAntrag;
}

/** Stellt einen Modul-Antrag (COPI-106), wie `updateBeantragen`; höchstens einer je Modul ist offen. */
export async function modulUpdateBeantragen(pool: pg.Pool, antrag: ModulUpdateAntrag): Promise<AntragErgebnis> {
  return antragAnlegen(pool, {
    bereich: 'module',
    sql: `INSERT INTO cockpit.eingriff (art, modul_kennung, ziel_commit, herkunft_vorher, beantragt_von, freigabe_modus, automatisch)
          VALUES ('modul', $1, $2, $3, $4, $5, $6)
          RETURNING id::int AS id`,
    werte: [antrag.modul, antrag.zielCommit, antrag.herkunftVorher, antrag.kontoId],
    kontoId: antrag.kontoId,
    freigabe: antrag.freigabe,
    zielVersion: null,
    automatisch: antrag.automatisch,
  });
}

interface Anlage {
  readonly bereich: FreigabeBereich;
  /** Das INSERT; Modus und `automatisch` sind seine letzten Werte. */
  readonly sql: string;
  readonly werte: readonly unknown[];
  readonly kontoId: string;
  readonly freigabe: AntragFreigabe;
  readonly zielVersion: string | null;
  readonly automatisch: AutomatischerAntrag | undefined;
}

async function antragAnlegen(pool: pg.Pool, anlage: Anlage): Promise<AntragErgebnis> {
  const { bereich, kontoId, freigabe, automatisch } = anlage;
  // Im Protokoll: wie der Antrag entstand (Klick oder Planer) und wie er freigegeben wurde.
  const weg = automatisch === undefined ? 'direkt' : 'automatisch';
  try {
    const ergebnis = await inTransaktion<AntragErgebnis>(pool, async (client) => {
      // Gesperrt wie beim Umschalten: der Modus, der hier gilt, gilt auch beim Schreiben.
      await freigabeModusSperren(client, bereich);
      const eingestellt = await freigabeModusLesen(client, bereich);
      const modus = antragModus(eingestellt, freigabe.direktMoeglich);
      if (modus !== freigabe.erwartet || (automatisch !== undefined && eingestellt !== 'automatisch')) {
        return { ok: false, grund: 'modus', modus };
      }
      if (automatisch !== undefined && !(await automatisch.zulassen(client))) {
        return { ok: false, grund: 'gesperrt' };
      }
      const zeile = await client.query<{ id: number }>(anlage.sql, [...anlage.werte, modus, automatisch !== undefined]);
      const id = zeile.rows[0]?.id;
      if (id === undefined) {
        return undefined;
      }
      await protokollSchreiben(client, {
        art: 'update_beantragt',
        akteur: kontoId,
        einzelheiten: automatisch === undefined ? { eingriff_id: id } : { eingriff_id: id, weg },
      });
      if (modus === 'direkt') {
        await client.query(`UPDATE cockpit.eingriff SET status = 'freigegeben', ziel_version = $2 WHERE id = $1`, [id, anlage.zielVersion]);
        await protokollSchreiben(client, { art: 'update_freigegeben', akteur: kontoId, einzelheiten: { eingriff_id: id, weg } });
      }
      return { ok: true, id, modus };
    });
    // Ein Ergebnis `modus` nimmt die Transaktion nicht zurück, schrieb aber auch nichts.
    if (ergebnis === undefined) {
      throw new Error('Antrag ohne Nummer');
    }
    return ergebnis;
  } catch (fehler) {
    if (istOffenerAntrag(fehler)) {
      return { ok: false, grund: 'offen' };
    }
    throw fehler;
  }
}

/**
 * Zieht einen Antrag zurück, der noch auf die Freigabe wartet — Image oder Modul, die Nummer genügt —, mit dem Eintrag
 * `update_zurueckgezogen`; ebenso einen direkt freigegebenen, den der Agent noch nicht gestartet hat (COPI-141).
 * `undefined`, wenn es keinen solchen Antrag mit dieser Nummer gibt (schon freigegeben, gestartet, abgeschlossen oder
 * unbekannt) — dann ändert sich nichts. Sonst das Modul des Antrags (beim Image keins), damit die
 * Rückmeldung an seiner Karte steht.
 */
export async function updateZurueckziehen(
  pool: pg.Pool,
  id: number,
  kontoId: string,
): Promise<{ readonly modul: string | undefined } | undefined> {
  return inTransaktion(pool, async (client) => {
    const zeile = await client.query<{ modul_kennung: string | null }>(
      `UPDATE cockpit.eingriff SET status = 'zurueckgezogen'
        WHERE id = $1 AND (status = 'beantragt' OR (status = 'freigegeben' AND freigabe_modus = 'direkt'))
        RETURNING modul_kennung`,
      [id],
    );
    const getroffen = zeile.rows[0];
    if (getroffen === undefined) {
      return undefined;
    }
    await protokollSchreiben(client, { art: 'update_zurueckgezogen', akteur: kontoId, einzelheiten: { eingriff_id: id } });
    return { modul: getroffen.modul_kennung ?? undefined };
  });
}

/** Gibt es einen offenen Antrag für das Cockpit-Image — oder, mit Kennung, für dieses Modul? */
export async function offenerAntragVorhanden(pool: pg.Pool, modul?: string): Promise<boolean> {
  const ergebnis = await pool.query(
    `SELECT 1 FROM cockpit.eingriff
      WHERE art = $1 AND coalesce(modul_kennung, '') = $2 AND status IN ('beantragt', 'freigegeben', 'laeuft') LIMIT 1`,
    [modul === undefined ? 'cockpit-image' : 'modul', modul ?? ''],
  );
  return (ergebnis.rowCount ?? 0) > 0;
}

/** Was ein Modul-Antrag vom aktiven Modul braucht: Name, Version und die Herkunft (der Weg zurück). */
export interface ModulStand {
  readonly kennung: string;
  readonly menuename: string;
  readonly version: number;
  readonly herkunft: string | undefined;
}

/** Das aktive Modul mit dieser Kennung, oder `undefined`. */
export async function modulStandLesen(pool: pg.Pool, kennung: string): Promise<ModulStand | undefined> {
  const ergebnis = await pool.query<{ version: number; menuename: unknown; herkunft: string | null }>(
    `SELECT version::int AS version, block->'menuename' AS menuename, herkunft FROM cockpit.modul WHERE kennung = $1 AND aktiv`,
    [kennung],
  );
  const zeile = ergebnis.rows[0];
  return zeile === undefined
    ? undefined
    : {
        kennung,
        menuename: typeof zeile.menuename === 'string' ? zeile.menuename : kennung,
        version: zeile.version,
        herkunft: zeile.herkunft ?? undefined,
      };
}

/** Wofür ein automatischer Antrag gälte: das Image oder ein Modul, und das Ziel (Digest bzw. Commit). */
export interface AutomatikZiel {
  readonly modul: string | undefined;
  readonly ziel: string;
}

/** Warum kein automatischer Antrag entsteht: heute gab es schon einen, oder das Ziel ist gesperrt. */
export type AutomatikSperre = 'heute' | 'ziel';

/**
 * Der Schleifenschutz. `heute`: ein automatischer Antrag für dieses Image bzw. Modul an diesem Kalendertag (Europe/Berlin).
 * `ziel`: für dieses Ziel ist schon ein Antrag fehlgeschlagen oder ein automatischer zurückgezogen worden.
 * Ohne `tageslimit` (Wartungsfenster `jederzeit`, COPI-235) entfällt die Tagesgrenze, der Schutz je Ziel bleibt.
 */
export async function automatikSperre(db: Abfrager, ziel: AutomatikZiel, jetzt: Date, tageslimit = true): Promise<AutomatikSperre | undefined> {
  const ergebnis = await db.query<{ heute: boolean | null; ziel: boolean | null }>(
    `SELECT bool_or(automatisch AND (beantragt_am AT TIME ZONE $4)::date = ($3::timestamptz AT TIME ZONE $4)::date) AS heute,
            bool_or(
              (ziel_digest = $2 OR cockpit.commit_passt(ziel_commit, $2))
              AND (status = 'fehlgeschlagen' OR (automatisch AND status = 'zurueckgezogen'))
            ) AS ziel
       FROM cockpit.eingriff
      WHERE art = $1 AND coalesce(modul_kennung, '') = $5`,
    [ziel.modul === undefined ? 'cockpit-image' : 'modul', ziel.ziel, jetzt, BETRIEBS_ZEITZONE, ziel.modul ?? ''],
  );
  const zeile = ergebnis.rows[0];
  if (zeile?.ziel === true) {
    return 'ziel';
  }
  return tageslimit && zeile?.heute === true ? 'heute' : undefined;
}
