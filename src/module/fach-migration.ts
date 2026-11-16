/**
 * Die Mindestversion der Fachmigrationen eines Moduls (COPI-107, Empfehlung Alex zu COPI-106).
 *
 * Fachtabellen (z. B. `kommunikation.vorgang`) ändert der Einrichter von Hand, nach festen Regeln: nummerierte, nur
 * hinzufügende Migrationen, die sich in `<schema>._migration` selbst buchen (`docs/modul-vertrag.md`,
 * „Fachmigrationen"). Ein Block, der eine neuere Fachtabelle braucht, nennt sie im Feld `fach` — und `modul-einspielen`
 * nimmt ihn erst an, wenn die Buchführung mindestens diese Version zeigt. So läuft nie eine View auf einer Tabelle, der
 * die Spalten noch fehlen.
 *
 * Das Cockpit liest dafür nur (`SELECT` auf `<schema>._migration`, vom Einrichter vergeben) und schreibt nie in ein
 * Fachschema. Der Schemaname ist vom Block-Parser geprüft (`FACH_SCHEMA`) und wird zusätzlich als Bezeichner maskiert.
 */
import pg from 'pg';

export interface FachAnforderung {
  readonly schema: string;
  readonly mindestens: number;
}

export type FachPruefung = { readonly ok: true } | { readonly ok: false; readonly grund: string };

/** Eine Versionsnummer, wie sie im Dateinamen steht: `0002`. */
export function versionText(version: number): string {
  return String(version).padStart(4, '0');
}

/**
 * Prüft in der Transaktion von `modulEinspielen`, ob das Fachschema die verlangte Version erreicht hat. Ein Fehler beim
 * Lesen (fehlendes Recht) bricht die Transaktion ab; der Aufrufer rollt ohnehin zurück, wenn die Prüfung scheitert.
 */
export async function fachVersionPruefen(client: pg.ClientBase, fach: FachAnforderung): Promise<FachPruefung> {
  const tabelle = `${pg.escapeIdentifier(fach.schema)}._migration`;
  const vorhanden = await client.query<{ da: boolean }>('SELECT to_regclass($1) IS NOT NULL AS da', [tabelle]);
  if (vorhanden.rows[0]?.da !== true) {
    return {
      ok: false,
      grund: `Das Fachschema „${fach.schema}" hat keine Buchführung (${fach.schema}._migration fehlt). Zuerst die Fachmigrationen einspielen (fach-migrieren.sh).`,
    };
  }
  let erreicht: number;
  try {
    const gelesen = await client.query<{ version: number }>(`SELECT coalesce(max(version), 0)::int AS version FROM ${tabelle}`);
    erreicht = gelesen.rows[0]?.version ?? 0;
  } catch {
    return {
      ok: false,
      grund: `Das Cockpit darf ${fach.schema}._migration nicht lesen. Der Rolle des Cockpits fehlt SELECT darauf (Rechte-Skript des Moduls).`,
    };
  }
  if (erreicht < fach.mindestens) {
    return {
      ok: false,
      grund: `Fachmigration ${versionText(erreicht + 1)} fehlt: ${fach.schema} ist bis ${versionText(erreicht)} eingespielt, der Block verlangt ${versionText(fach.mindestens)}.`,
    };
  }
  return { ok: true };
}
