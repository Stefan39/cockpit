/**
 * Der Zustand der KI-Anbieter der Entwicklungspipeline (COPI-181, Welle 3 von JAC-744): lesen und von Hand auf `ok`
 * oder `disabled` setzen.
 *
 * **Nur Stefan setzt ihn** — über die Server-Kommandos `pipeline-anbieter` und `pipeline-anbieter-setzen`. `exhausted`
 * lässt sich nicht von Hand setzen: das meldet nur der Runner über `quota` (siehe `jobAbschliessen` in `queue.ts`).
 */
import type pg from 'pg';
import { ANBIETER, type Anbieter } from './queue.js';

export type AnbieterZustand = 'ok' | 'exhausted' | 'disabled';

/** Die Zustände, die sich von Hand setzen lassen. */
export type SetzbarerZustand = Exclude<AnbieterZustand, 'exhausted'>;

export interface AnbieterZeile {
  readonly provider: Anbieter;
  readonly state: AnbieterZustand;
  readonly until: Date | null;
  readonly updatedAt: Date;
}

export function istAnbieter(wert: unknown): wert is Anbieter {
  return typeof wert === 'string' && (ANBIETER as readonly string[]).includes(wert);
}

interface Zeile {
  provider: Anbieter;
  state: AnbieterZustand;
  until: Date | null;
  updated_at: Date;
}

/** Alle Einträge, nach Anbieter sortiert. Ein Anbieter ohne Zeile gilt als `ok`. */
export async function anbieterLesen(pool: pg.Pool): Promise<AnbieterZeile[]> {
  const { rows } = await pool.query<Zeile>(
    'SELECT provider, state, until, updated_at FROM cockpit.pipeline_provider_state ORDER BY provider',
  );
  return rows.map((zeile) => ({
    provider: zeile.provider,
    state: zeile.state,
    until: zeile.until,
    updatedAt: zeile.updated_at,
  }));
}

/** Setzt den Anbieter auf `ok` oder `disabled`, leert `until` und legt die Zeile an, falls sie fehlt. */
export async function anbieterSetzen(
  pool: pg.Pool,
  eingabe: { readonly provider: string; readonly state: SetzbarerZustand; readonly jetzt: Date },
): Promise<void> {
  if (!istAnbieter(eingabe.provider)) {
    throw new Error(`Unbekannter Anbieter. Erlaubt: ${ANBIETER.join(', ')}.`);
  }
  if (eingabe.state !== 'ok' && eingabe.state !== 'disabled') {
    throw new Error('Von Hand lässt sich nur ok oder disabled setzen.');
  }
  await pool.query(
    `INSERT INTO cockpit.pipeline_provider_state (provider, state, until, updated_at)
     VALUES ($1, $2, NULL, $3)
     ON CONFLICT (provider) DO UPDATE SET state = EXCLUDED.state, until = NULL, updated_at = EXCLUDED.updated_at`,
    [eingabe.provider, eingabe.state, eingabe.jetzt],
  );
}
