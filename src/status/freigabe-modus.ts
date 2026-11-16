/**
 * Der Freigabemodus für Updates (COPI-141, Stefan 13.10.2026, `docs/adr/0002-freigabe-direkt.md`).
 *
 * Getrennt für das Cockpit-Image und für die Module (nicht je Modul):
 *
 *   * `rueckfrage` — Standard und bisheriger Ablauf: der Antrag steht auf `beantragt`, Stefan gibt ihn außerhalb des
 *     Cockpits frei (Slack-Rückfrage des Admin-Agenten).
 *   * `direkt` — die signierte Bestätigung des Betreuers im Cockpit ist die Freigabe: der Antrag steht sofort auf
 *     `freigegeben`, der Agent spielt ihn ohne Rückfrage ein. Bis er startet, lässt er sich zurückziehen.
 *   * `automatisch` (COPI-142, `docs/adr/0003-update-automatisch.md`) — wie `direkt`, dazu stellt das Cockpit den Antrag
 *     selbst, sobald die Versions-Wache ein Update meldet (`update-planer.ts`).
 *
 * Ausgeführt wird in beiden Fällen nur vom Admin-Agenten — das Cockpit bekommt dafür nichts dazu. Der Modus wird beim
 * Antrag in dessen Zeile festgeschrieben (`eingriff.freigabe_modus`); ein späterer Wechsel ändert keinen laufenden
 * Antrag. Jede Änderung ist eine neue Zeile (Migration 0050, nur anhängen) und ein Protokolleintrag in derselben
 * Transaktion, wie beim Betreuer-Zugriff (COPI-134).
 */
import type pg from 'pg';
import { protokollSchreiben, type Abfrager } from '../auth/protokoll.js';
import { inTransaktion } from '../datenbank/transaktion.js';

export const FREIGABE_MODI = ['rueckfrage', 'direkt', 'automatisch'] as const;

/** Die Einstellung eines Bereichs. */
export type FreigabeModus = (typeof FREIGABE_MODI)[number];

/**
 * Wie ein einzelner Antrag freigegeben wird (`eingriff.freigabe_modus`). Ein automatischer Antrag ist für den Agenten
 * ein direkter (`eingriff.automatisch` sagt, dass ihn das Cockpit gestellt hat, Migration 0052).
 */
export const ANTRAG_MODI = ['rueckfrage', 'direkt'] as const;

export type AntragModus = (typeof ANTRAG_MODI)[number];

/** Ohne Zeile gilt die Rückfrage. */
export const FREIGABE_STANDARD: FreigabeModus = 'rueckfrage';

export const FREIGABE_BEREICHE = ['cockpit', 'module'] as const;

export type FreigabeBereich = (typeof FREIGABE_BEREICHE)[number];

/** So heißen die Modi in der Oberfläche. */
export const FREIGABE_TEXT: Readonly<Record<FreigabeModus, string>> = {
  rueckfrage: 'Rückfrage in Slack',
  direkt: 'Direkt installieren',
  automatisch: 'Automatisch installieren',
};

export const FREIGABE_BEREICH_TEXT: Readonly<Record<FreigabeBereich, string>> = {
  cockpit: 'Cockpit',
  module: 'Module',
};

export function istFreigabeModus(wert: unknown): wert is FreigabeModus {
  return typeof wert === 'string' && (FREIGABE_MODI as readonly string[]).includes(wert);
}

export function istAntragModus(wert: unknown): wert is AntragModus {
  return typeof wert === 'string' && (ANTRAG_MODI as readonly string[]).includes(wert);
}

/**
 * Der Modus eines Antrags bei dieser Einstellung: `direkt` bei `direkt` und `automatisch`, aber nur mit `direktMoeglich`
 * (ein Ziel der Versions-Wache, beim Image mit Version) — sonst die Rückfrage.
 */
export function antragModus(eingestellt: FreigabeModus, direktMoeglich: boolean): AntragModus {
  return eingestellt !== 'rueckfrage' && direktMoeglich ? 'direkt' : 'rueckfrage';
}

export function istFreigabeBereich(wert: unknown): wert is FreigabeBereich {
  return typeof wert === 'string' && (FREIGABE_BEREICHE as readonly string[]).includes(wert);
}

/** Der Bereich eines Antrags: das Image gehört zum Cockpit, jedes Modul zu den Modulen. */
export function freigabeBereich(art: 'cockpit-image' | 'modul'): FreigabeBereich {
  return art === 'modul' ? 'module' : 'cockpit';
}

/** Der geltende Modus eines Bereichs, mit wem und wann er gesetzt wurde. */
export interface FreigabeStand {
  readonly modus: FreigabeModus;
  /** Name des Kontos; ohne Zeile (Standard) oder bei einem entfernten Konto keiner. */
  readonly von: string | undefined;
  readonly am: Date | undefined;
}

/** Je Bereich der jüngste Stand; ohne Zeile der Standard. */
export async function freigabeModiLesen(db: Abfrager): Promise<Readonly<Record<FreigabeBereich, FreigabeStand>>> {
  const ergebnis = await db.query<{ bereich: string; modus: string; von: string | null; gesetzt_am: Date }>(
    `SELECT DISTINCT ON (f.bereich) f.bereich, f.modus, u.name AS von, f.gesetzt_am
       FROM cockpit.update_freigabemodus f
       LEFT JOIN cockpit."user" u ON u.id = f.gesetzt_von
      ORDER BY f.bereich, f.id DESC`,
  );
  const stand = (bereich: FreigabeBereich): FreigabeStand => {
    const zeile = ergebnis.rows.find((z) => z.bereich === bereich);
    return zeile === undefined || !istFreigabeModus(zeile.modus)
      ? { modus: FREIGABE_STANDARD, von: undefined, am: undefined }
      : { modus: zeile.modus, von: zeile.von ?? undefined, am: zeile.gesetzt_am };
  };
  return { cockpit: stand('cockpit'), module: stand('module') };
}

/** Der geltende Modus eines Bereichs — im Antrag mit dem Client seiner Transaktion gelesen. */
export async function freigabeModusLesen(db: Abfrager, bereich: FreigabeBereich): Promise<FreigabeModus> {
  const ergebnis = await db.query<{ modus: string }>(
    `SELECT modus FROM cockpit.update_freigabemodus WHERE bereich = $1 ORDER BY id DESC LIMIT 1`,
    [bereich],
  );
  const modus = ergebnis.rows[0]?.modus;
  return istFreigabeModus(modus) ? modus : FREIGABE_STANDARD;
}

/** Sperrt den Modus eines Bereichs bis zum Ende der Transaktion: Umschalten und Antrag laufen nacheinander. */
export async function freigabeModusSperren(client: pg.PoolClient, bereich: FreigabeBereich): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cockpit.update_freigabemodus:${bereich}`]);
}

/**
 * Setzt den Modus eines Bereichs. Derselbe Modus noch einmal ergibt keine neue Zeile (`unveraendert`). Zeile und
 * Protokoll (`update_freigabemodus_geaendert`, alt → neu) in einer Transaktion.
 */
export async function freigabeModusSetzen(
  pool: pg.Pool,
  eingabe: { readonly bereich: FreigabeBereich; readonly modus: FreigabeModus; readonly konto: string },
): Promise<'gesetzt' | 'unveraendert'> {
  const ergebnis = await inTransaktion(pool, async (client) => {
    await freigabeModusSperren(client, eingabe.bereich);
    const bisher = await freigabeModusLesen(client, eingabe.bereich);
    if (bisher === eingabe.modus) {
      return 'unveraendert' as const;
    }
    const eingefuegt = await client.query<{ id: string }>(
      `INSERT INTO cockpit.update_freigabemodus (bereich, modus, gesetzt_von) VALUES ($1, $2, $3) RETURNING id::text`,
      [eingabe.bereich, eingabe.modus, eingabe.konto],
    );
    await protokollSchreiben(client, {
      art: 'update_freigabemodus_geaendert',
      akteur: eingabe.konto,
      einzelheiten: { update_freigabemodus_id: Number(eingefuegt.rows[0]?.id), von: bisher, an: eingabe.modus },
    });
    return 'gesetzt' as const;
  });
  // `inTransaktion` liefert `undefined` nur, wenn die Arbeit es tut — hier nie.
  if (ergebnis === undefined) {
    throw new Error('Freigabemodus: nicht gespeichert');
  }
  return ergebnis;
}
