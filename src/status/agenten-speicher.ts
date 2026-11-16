/**
 * Das Inventar der Agenten in der Datenbank (COPI-38): Rolle, Version, Grenzen und Zeitplan, wie der
 * Admin-Agent sie meldet. Das Cockpit liest nie die YAML des Agenten-Repos und fragt GHCR nie selbst
 * (Architektur-Vorschlag 4, 13.1): es zeigt, was ihm gemeldet wurde.
 *
 * **Die Meldung ersetzt das Inventar als Ganzes** (`PUT`): angelegt oder geändert wird, was in der Liste
 * steht; wer fehlt, fällt heraus. So verschwindet ein abgeschaffter Agent, ohne dass jemand ihn eigens
 * löschen müsste. Alles geschieht in **einer** Transaktion — scheitert ein Eintrag, bleibt der alte Stand
 * ganz stehen. Zwei gleichzeitige Meldungen laufen nacheinander (Tabellensperre) und ergeben nie eine
 * Mischung aus beiden Listen; Leser werden davon nicht aufgehalten.
 *
 * Texte werden verbatim gespeichert. Maskieren ist Sache der Ausgabe.
 */
import type pg from 'pg';

/** Ein Wert in `grenzen`: was ein Agent darf, als Text, Zahl oder Ja/Nein. */
export type GrenzWert = string | number | boolean;

/** Ein Takt aus dem Zeitplan eines Agenten. Beides ist Freitext: das Cockpit rechnet und liest nichts daraus (ADR 4). */
export interface ZeitplanEintrag {
  readonly name: string;
  readonly wann: string;
}

/** Ein Agent, wie der Admin-Agent ihn meldet. */
export interface AgentInventar {
  readonly kennung: string;
  readonly rolle: string;
  readonly version: string;
  readonly grenzen: Readonly<Record<string, GrenzWert>>;
  readonly zeitplan: readonly ZeitplanEintrag[];
}

/** Ein Agent, wie die Datenbank ihn hält: dazu der Zeitpunkt der letzten Meldung. */
export interface AgentZeile extends AgentInventar {
  readonly aktualisiertAm: Date;
}

export interface InventarErgebnis {
  /** Wie viele Agenten das Inventar jetzt hat. */
  readonly agenten: number;
  /** Wie viele Agenten mit dieser Meldung herausgefallen sind. */
  readonly entfernt: number;
}

/**
 * Ersetzt das Inventar durch `agenten`. Der Zeitpunkt kommt vom Aufrufer (vom Server, nie vom Agenten) und
 * gilt für jede Zeile: er sagt, wann das Inventar zuletzt gemeldet wurde, auch wenn sich nichts geändert hat.
 */
export async function inventarErsetzen(
  pool: pg.Pool,
  agenten: readonly AgentInventar[],
  jetzt: Date,
): Promise<InventarErgebnis> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Schreiber nacheinander; SELECT bleibt frei. Ohne die Sperre könnten zwei Meldungen ihre Listen mischen:
    // jede markiert als entfernt, was die andere nicht kennt, und legt an, was die andere nicht sieht.
    await client.query('LOCK TABLE cockpit.agent IN SHARE ROW EXCLUSIVE MODE');
    if (agenten.length > 0) {
      await client.query(
        `INSERT INTO cockpit.agent (kennung, rolle, version, grenzen, zeitplan, aktualisiert_am)
         SELECT a.kennung, a.rolle, a.version, a.grenzen, a.zeitplan, $2::timestamptz
           FROM jsonb_to_recordset($1::jsonb) AS a(kennung text, rolle text, version text, grenzen jsonb, zeitplan jsonb)
         ON CONFLICT (kennung) DO UPDATE
            SET rolle = EXCLUDED.rolle,
                version = EXCLUDED.version,
                grenzen = EXCLUDED.grenzen,
                zeitplan = EXCLUDED.zeitplan,
                aktualisiert_am = EXCLUDED.aktualisiert_am,
                entfernt_am = NULL`,
        [JSON.stringify(agenten), jetzt],
      );
    }
    // Nie löschen (COPI-62): wer nicht mehr gemeldet wird, gilt als entfernt und bleibt im Bestand.
    const entfernt = await client.query(
      'UPDATE cockpit.agent SET entfernt_am = $2 WHERE kennung <> ALL($1::text[]) AND entfernt_am IS NULL',
      [agenten.map((agent) => agent.kennung), jetzt],
    );
    await client.query('COMMIT');
    return { agenten: agenten.length, entfernt: entfernt.rowCount ?? 0 };
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

interface AgentSpalten {
  readonly kennung: string;
  readonly rolle: string;
  readonly version: string;
  readonly grenzen: Record<string, GrenzWert>;
  readonly zeitplan: ZeitplanEintrag[];
  readonly aktualisiert_am: Date;
}

/** Das ganze Inventar, nach Rolle, dann nach Kennung: die Reihenfolge ist nie zufällig. */
export async function agentenLesen(pool: pg.Pool): Promise<AgentZeile[]> {
  const ergebnis = await pool.query<AgentSpalten>(
    `SELECT kennung, rolle, version, grenzen, zeitplan, aktualisiert_am
       FROM cockpit.agent
      WHERE entfernt_am IS NULL
      ORDER BY rolle COLLATE "C", kennung COLLATE "C"`,
  );
  return ergebnis.rows.map(agentAus);
}

function agentAus(zeile: AgentSpalten): AgentZeile {
  return {
    kennung: zeile.kennung,
    rolle: zeile.rolle,
    version: zeile.version,
    grenzen: zeile.grenzen,
    zeitplan: zeile.zeitplan,
    aktualisiertAm: zeile.aktualisiert_am,
  };
}

/** Ein Agent samt Zeitpunkt, seit dem er nicht mehr gemeldet wird (COPI-113: die Detailseite zeigt auch Entfernte). */
export interface AgentMitStand extends AgentZeile {
  readonly entferntAm: Date | undefined;
}

/** Alle Agenten, auch entfernte (nie löschen, COPI-62) — die Detailseite sucht darin ihren Schlüssel (COPI-113). */
export async function agentenMitEntferntenLesen(pool: pg.Pool): Promise<AgentMitStand[]> {
  const ergebnis = await pool.query<AgentSpalten & { entfernt_am: Date | null }>(
    `SELECT kennung, rolle, version, grenzen, zeitplan, aktualisiert_am, entfernt_am FROM cockpit.agent ORDER BY kennung COLLATE "C"`,
  );
  return ergebnis.rows.map((zeile) => ({ ...agentAus(zeile), entferntAm: zeile.entfernt_am ?? undefined }));
}
