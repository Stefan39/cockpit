/**
 * Der Update-Planer (COPI-142, Stefan 13.10.2026, `docs/adr/0003-update-automatisch.md`): steht ein Bereich auf
 * `automatisch`, stellt das Cockpit den Antrag selbst, sobald die Versions-Wache ein Update meldet, und gibt ihn wie im
 * Modus `direkt` sofort frei. **Es führt nichts aus.** Der Antrag ist dieselbe Zeile wie nach einem Klick (dazu
 * `automatisch`), ausgeführt wird er nur vom Admin-Agenten, mit dem Rückweg bei einem Fehlschlag.
 *
 * Ein Lauf je Minute (`server/index.ts`, Muster des Zweitkanals). Je Bereich:
 *
 *   * **Cockpit-Image:** nur im Wartungsfenster Dienstag 07:00–09:00 (Europe/Berlin, wie im Vertrag mit dem Agenten; je
 *     Instanz `COCKPIT_WARTUNGSFENSTER=jederzeit`, dann ohne Fenster und ohne Tagesgrenze, COPI-235), nur
 *     mit Ziel-Version (der Erfolgsbeleg, 0020) und bekanntem laufendem Digest (der Weg zurück), nie auf den laufenden.
 *   * **Module:** jederzeit, je aktivem Modul mit Herkunft unter `module/<kennung>.cockpit.yaml`, nie auf den Commit,
 *     der schon eingespielt ist.
 *
 * **Schleifenschutz** (`automatikSperre` im Antragsspeicher), in der Transaktion des Antrags und unter der Sperre des Bereichs geprüft:
 * höchstens ein automatischer Antrag je Cockpit bzw. Modul und Kalendertag; kein neuer für ein Ziel, das schon einmal
 * `fehlgeschlagen` ist oder dessen automatischer Antrag zurückgezogen wurde — bis die Wache ein anderes Ziel meldet. Ein
 * hängender Antrag ist offen und verhindert jeden neuen ohnehin (`eingriff_ein_offener_antrag`); meldet der Agent ihn
 * `fehlgeschlagen`, greift die Sperre. Gemeldet wird ein Fehlschlag weiter vom Agenten (Wache rot, Slack), nicht hier.
 * Solange ein Antrag offen ist, versucht der Planer gar nichts (sonst stünde jede Minute ein Versuch im Log); die Regel der
 * Datenbank hält trotzdem, falls zwischen Prüfung und Antrag einer entsteht.
 *
 * **Antragsteller** ist das Konto, das den Bereich auf `automatisch` gestellt hat. Ist es entfernt oder kein Betreuer
 * mehr, entsteht nichts: die Automatik hängt an einer Entscheidung, die jemand verantwortet.
 */
import type pg from 'pg';
import type { Abfrager } from '../auth/protokoll.js';
import { istModulKennung } from '../module/block.js';
import type { FreigabeBereich } from './freigabe-modus.js';
import { instanzLesen } from './instanz-speicher.js';
import type { Wartungsfenster } from './wartungsfenster.js';
import { zielCommitAus, zielDigestAus } from './update-antrag.js';
import {
  automatikSperre,
  BETRIEBS_ZEITZONE,
  modulUpdateBeantragen,
  offenerAntragVorhanden,
  updateBeantragen,
  type AntragErgebnis,
  type AutomatikZiel,
  type AutomatischerAntrag,
} from './update-antrag-speicher.js';
import { gemeldetesZielLesen } from './versionen-speicher.js';
import { commitPasst, herkunftCommit, herkunftUnterModule, modulVersionsWache, VERSIONS_WACHE } from './versionen.js';

/** Ein Lauf je Minute: das Wartungsfenster ist zwei Stunden lang, ein Modul-Update soll nicht lange warten. */
export const PLANER_TAKT_MS = 60_000;

const WOCHENTAG_UND_STUNDE = new Intl.DateTimeFormat('en-US', { timeZone: BETRIEBS_ZEITZONE, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });

/** Das Wartungsfenster des Cockpit-Images: Dienstag 07:00 bis vor 09:00, in der Zeit des Betriebs. */
export function imWartungsfenster(jetzt: Date): boolean {
  const teile = WOCHENTAG_UND_STUNDE.formatToParts(jetzt);
  const tag = teile.find((teil) => teil.type === 'weekday')?.value;
  const stunde = Number(teile.find((teil) => teil.type === 'hour')?.value);
  return tag === 'Tue' && stunde >= 7 && stunde < 9;
}

/**
 * Das Konto, in dessen Namen der Planer beantragt: wer den Bereich zuletzt umgestellt hat — nur wenn er jetzt auf
 * `automatisch` steht und das Konto ein aktiver Betreuer ist.
 */
export async function automatikKontoLesen(db: Abfrager, bereich: FreigabeBereich): Promise<string | undefined> {
  const ergebnis = await db.query<{ modus: string; konto: string | null }>(
    `SELECT f.modus, u.id AS konto
       FROM cockpit.update_freigabemodus f
       LEFT JOIN cockpit."user" u ON u.id = f.gesetzt_von AND u.geloescht_am IS NULL AND u.rolle = 'betreuer'
      WHERE f.bereich = $1
      ORDER BY f.id DESC
      LIMIT 1`,
    [bereich],
  );
  const zeile = ergebnis.rows[0];
  return zeile?.modus === 'automatisch' ? (zeile.konto ?? undefined) : undefined;
}

/** Ein Versuch des Planers: wofür, und was die Datenbank dazu sagte (oder der Fehler, der ihn abbrach). */
export interface PlanerVersuch {
  readonly modul: string | undefined;
  readonly ziel: string;
  readonly ergebnis: AntragErgebnis | { readonly ok: false; readonly grund: 'fehler'; readonly meldung: string };
}

/** Der Schleifenschutz als Bedingung des Antrags. */
function automatik(ziel: AutomatikZiel, jetzt: Date, tageslimit = true): AutomatischerAntrag {
  return { zulassen: async (client) => (await automatikSperre(client, ziel, jetzt, tageslimit)) === undefined };
}

const DIREKT = { erwartet: 'direkt', direktMoeglich: true } as const;

async function versuchen(ziel: AutomatikZiel, stellen: () => Promise<AntragErgebnis>): Promise<PlanerVersuch> {
  try {
    return { ...ziel, ergebnis: await stellen() };
  } catch (fehler) {
    return { ...ziel, ergebnis: { ok: false, grund: 'fehler', meldung: fehler instanceof Error ? fehler.message : 'unbekannt' } };
  }
}

async function cockpitPlanen(pool: pg.Pool, jetzt: Date, fenster: Wartungsfenster): Promise<PlanerVersuch | undefined> {
  const konto = await automatikKontoLesen(pool, 'cockpit');
  const jederzeit = fenster === 'jederzeit';
  if (konto === undefined || !(jederzeit || imWartungsfenster(jetzt))) {
    return undefined;
  }
  const gemeldet = await gemeldetesZielLesen(pool, VERSIONS_WACHE, 'cockpit');
  const ziel = zielDigestAus(gemeldet?.ziel);
  const laufend = (await instanzLesen(pool))?.digest;
  if (ziel === undefined || gemeldet?.version === undefined || laufend === undefined || ziel === laufend || (await offenerAntragVorhanden(pool))) {
    return undefined;
  }
  const wofuer = { modul: undefined, ziel };
  return versuchen(wofuer, () =>
    updateBeantragen(pool, {
      zielDigest: ziel,
      digestVorher: laufend,
      kontoId: konto,
      zielVersion: gemeldet.version,
      freigabe: DIREKT,
      automatisch: automatik(wofuer, jetzt, !jederzeit),
    }),
  );
}

async function modulePlanen(pool: pg.Pool, jetzt: Date): Promise<PlanerVersuch[]> {
  const konto = await automatikKontoLesen(pool, 'module');
  if (konto === undefined) {
    return [];
  }
  const module = await pool.query<{ kennung: string; herkunft: string | null }>(
    'SELECT kennung, herkunft FROM cockpit.modul WHERE aktiv ORDER BY kennung',
  );
  const versuche: PlanerVersuch[] = [];
  for (const { kennung, herkunft } of module.rows) {
    if (!istModulKennung(kennung) || herkunft === null || !herkunftUnterModule(herkunft, kennung)) {
      continue;
    }
    const ziel = zielCommitAus((await gemeldetesZielLesen(pool, modulVersionsWache(kennung), 'modul'))?.ziel);
    if (ziel === undefined || commitPasst(ziel, herkunftCommit(herkunft)) || (await offenerAntragVorhanden(pool, kennung))) {
      continue;
    }
    const wofuer = { modul: kennung, ziel };
    versuche.push(
      await versuchen(wofuer, () =>
        modulUpdateBeantragen(pool, {
          modul: kennung,
          zielCommit: ziel,
          herkunftVorher: herkunft,
          kontoId: konto,
          freigabe: DIREKT,
          automatisch: automatik(wofuer, jetzt),
        }),
      ),
    );
  }
  return versuche;
}

/**
 * Ein Lauf: je Bereich höchstens ein Antrag je Image bzw. Modul. Mehrfach hintereinander aufgerufen entsteht nichts
 * doppelt (offener Antrag, Tageslimit). Ein Fehler bei einem Ziel hält die übrigen nicht auf.
 */
export async function updatePlanerLaufen(pool: pg.Pool, jetzt: Date, fenster: Wartungsfenster = 'di 07-09'): Promise<readonly PlanerVersuch[]> {
  const cockpit = await cockpitPlanen(pool, jetzt, fenster);
  const module = await modulePlanen(pool, jetzt);
  return cockpit === undefined ? module : [cockpit, ...module];
}
