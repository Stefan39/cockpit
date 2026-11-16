/**
 * Die Abfragen des Abschnitts „Versionen" (COPI-39): was die Kundensicht und was die Betreuersicht bekommt.
 *
 * Wie bei der Übersicht (COPI-37) liegt die Trennung **in der Abfrage**: die Kundensicht liest nur den Status des
 * jüngsten Antrags, keinen Digest, keine Version und keinen Befund der Versions-Wache. Ein Fehler in der Vorlage
 * kann nichts zeigen, was nie geladen wurde.
 */
import type pg from 'pg';
import { juengsteModulEingriffeLesen, juengsterEingriffLesen, type EingriffDaten } from './eingriff-speicher.js';
import { freigabeModiLesen, type FreigabeBereich } from './freigabe-modus.js';
import { instanzLesen } from './instanz-speicher.js';
import type { Wartungsfenster } from './wartungsfenster.js';
import { automatikSperre } from './update-antrag-speicher.js';
import {
  ANTRAG_STATUS,
  modulVersionsWache,
  VERSIONS_WACHE,
  type AntragDaten,
  type AntragStatus,
  type AutomatikStand,
  type BetreuerVersionenDaten,
  type KundenVersionenDaten,
  type ModulAntragDaten,
  type ModulVersionDaten,
  type UpdateZiel,
  type WachenDaten,
  UPDATE_ARTEN,
} from './versionen.js';
import { BEFUND_STATUS, type BefundStatus } from './zustand.js';

/** Die Datenbank lässt nur bekannte Werte zu; ein anderer wäre ein Fehler, kein Zustand. */
function bekannt<T extends string>(werte: readonly T[], wert: string): T {
  const gefunden = werte.find((kandidat) => kandidat === wert);
  if (gefunden === undefined) {
    throw new Error('Unbekannter Status in der Datenbank');
  }
  return gefunden;
}

/** Der jüngste Antrag für das Cockpit-Image: zuletzt angelegt (`id`), nicht spätester Zeitpunkt. */
const JUENGSTER_ANTRAG = `FROM cockpit.eingriff WHERE art = 'cockpit-image' ORDER BY id DESC LIMIT 1`;

export async function kundenVersionenLesen(pool: pg.Pool): Promise<KundenVersionenDaten> {
  const ergebnis = await pool.query<{ status: string }>(`SELECT status ${JUENGSTER_ANTRAG}`);
  const zeile = ergebnis.rows[0];
  return { antragStatus: zeile === undefined ? undefined : bekannt<AntragStatus>(ANTRAG_STATUS, zeile.status) };
}

interface WachenSpalten {
  readonly kennung: string;
  readonly takt_sekunden: number;
  readonly letzter_lauf: Date | null;
  readonly status: string | null;
  readonly text_intern: string | null;
  readonly update_ziel: unknown;
}

/**
 * Das Update-Ziel eines Befunds (COPI-140). Die Form prüft schon die Datenbank (`befund_update_ziel_form`, 0049); hier
 * wird sie nur noch in Typen übersetzt. Ein unlesbares `seit` macht das Ziel nicht ungültig, nur sein Datum unbekannt.
 */
export function updateZielAus(wert: unknown): UpdateZiel | undefined {
  if (typeof wert !== 'object' || wert === null) {
    return undefined;
  }
  const feld = (name: string): unknown => (wert as Record<string, unknown>)[name];
  const art = feld('art');
  const ziel = feld('ziel');
  const seit = feld('seit');
  if (typeof art !== 'string' || typeof ziel !== 'string' || typeof seit !== 'string') {
    return undefined;
  }
  const version = feld('version');
  const hinweis = feld('hinweis');
  return {
    art: bekannt(UPDATE_ARTEN, art),
    ziel,
    version: typeof version === 'string' ? version : undefined,
    hinweis: typeof hinweis === 'string' ? hinweis : undefined,
    seit: Number.isNaN(Date.parse(seit)) ? undefined : new Date(seit),
  };
}

/** Die Versions-Wachen mit diesen Kennungen und ihr jüngster Befund. */
async function wachenLesen(pool: pg.Pool, kennungen: readonly string[]): Promise<Map<string, WachenDaten>> {
  const ergebnis = await pool.query<WachenSpalten>(
    `SELECT w.kennung, w.takt_sekunden, w.letzter_lauf, b.status, b.text_intern, b.update_ziel
       FROM cockpit.wache w
       LEFT JOIN LATERAL (
              SELECT status, text_intern, update_ziel FROM cockpit.befund
               WHERE wache = w.kennung
               ORDER BY id DESC
               LIMIT 1
            ) b ON true
      WHERE w.kennung = ANY($1::text[])`,
    [kennungen],
  );
  return new Map(
    ergebnis.rows.map((zeile) => [
      zeile.kennung,
      {
        taktSekunden: zeile.takt_sekunden,
        letzterLauf: zeile.letzter_lauf ?? undefined,
        letzter:
          zeile.status === null || zeile.text_intern === null
            ? undefined
            : {
                status: bekannt<BefundStatus>(BEFUND_STATUS, zeile.status),
                text: zeile.text_intern,
                update: updateZielAus(zeile.update_ziel),
              },
      },
    ]),
  );
}

/** Ein Image-Antrag hat immer beide Digests (`eingriff_art_passt`, 0040). */
function imageAntrag(eingriff: EingriffDaten | undefined): AntragDaten | undefined {
  if (eingriff === undefined) {
    return undefined;
  }
  const { zielDigest, digestVorher } = eingriff;
  if (zielDigest === undefined || digestVorher === undefined) {
    throw new Error('Image-Antrag ohne Digest in der Datenbank');
  }
  return { ...eingriff, zielDigest, digestVorher };
}

/** Ein Modul-Antrag hat immer Ziel-Commit und Herkunft davor (`eingriff_art_passt`, 0040). */
function modulAntrag(eingriff: EingriffDaten | undefined): ModulAntragDaten | undefined {
  if (eingriff === undefined) {
    return undefined;
  }
  const { zielCommit, herkunftVorher } = eingriff;
  if (zielCommit === undefined || herkunftVorher === undefined) {
    throw new Error('Modul-Antrag ohne Ziel-Commit in der Datenbank');
  }
  return { ...eingriff, zielCommit, herkunftVorher };
}

interface ModulZeile {
  readonly kennung: string;
  readonly version: number;
  readonly menuename: unknown;
  readonly herkunft: string | null;
  readonly aktiv_seit: Date;
}

/** Die aktiven Module mit Versions-Wache und jüngstem Antrag (COPI-106). */
async function moduleLesen(pool: pg.Pool): Promise<ModulVersionDaten[]> {
  const [module, antraege] = await Promise.all([
    pool.query<ModulZeile>(
      `SELECT kennung, version::int AS version, block->'menuename' AS menuename, herkunft, aktiv_seit
         FROM cockpit.modul WHERE aktiv ORDER BY kennung`,
    ),
    juengsteModulEingriffeLesen(pool),
  ]);
  const wachen = await wachenLesen(pool, module.rows.map((zeile) => modulVersionsWache(zeile.kennung)));
  return module.rows.map((zeile) => ({
    kennung: zeile.kennung,
    menuename: typeof zeile.menuename === 'string' ? zeile.menuename : zeile.kennung,
    version: zeile.version,
    aktivSeit: zeile.aktiv_seit,
    herkunft: zeile.herkunft ?? undefined,
    antrag: modulAntrag(antraege.get(zeile.kennung)),
    wache: wachen.get(modulVersionsWache(zeile.kennung)),
  }));
}

/**
 * Was die Automatik mit dem gemeldeten Update täte (COPI-142): nur, wenn der Bereich auf `automatisch` steht und die Wache
 * ein Ziel meldet. Dieselbe Sperre, die der Planer beim Antrag prüft (`automatikSperre`).
 */
async function automatikStand(
  pool: pg.Pool,
  automatisch: ReadonlySet<FreigabeBereich>,
  wofuer: { readonly bereich: FreigabeBereich; readonly modul: string | undefined; readonly wache: WachenDaten | undefined },
  jetzt: Date,
  fenster: Wartungsfenster,
): Promise<AutomatikStand | undefined> {
  const ziel = wofuer.wache?.letzter?.update?.ziel;
  if (!automatisch.has(wofuer.bereich) || ziel === undefined) {
    return undefined;
  }
  const tageslimit = wofuer.bereich !== 'cockpit' || fenster !== 'jederzeit';
  return (await automatikSperre(pool, { modul: wofuer.modul, ziel }, jetzt, tageslimit)) ?? 'bereit';
}

export async function betreuerVersionenLesen(pool: pg.Pool, jetzt: Date = new Date(), fenster: Wartungsfenster = 'di 07-09'): Promise<BetreuerVersionenDaten> {
  const [instanz, antrag, wachen, module, modi] = await Promise.all([
    instanzLesen(pool),
    juengsterEingriffLesen(pool, 'cockpit-image'),
    wachenLesen(pool, [VERSIONS_WACHE]),
    moduleLesen(pool),
    freigabeModiLesen(pool),
  ]);
  const automatisch = new Set((['cockpit', 'module'] as const).filter((bereich) => modi[bereich].modus === 'automatisch'));
  const wache = wachen.get(VERSIONS_WACHE);
  return {
    instanz,
    antrag: imageAntrag(antrag),
    wache,
    module: await Promise.all(
      module.map(async (modul) => ({
        ...modul,
        automatik: await automatikStand(pool, automatisch, { bereich: 'module', modul: modul.kennung, wache: modul.wache }, jetzt, fenster),
      })),
    ),
    automatik: await automatikStand(pool, automatisch, { bereich: 'cockpit', modul: undefined, wache }, jetzt, fenster),
  };
}

/**
 * Das Ziel, das die Wache gerade meldet (COPI-140): das `update` ihres jüngsten Befunds, wenn er gelb ist und die Art
 * passt — sonst keins. Der Knopf „Update installieren" schickt kein Ziel mit; der Server liest es hier, beim Anzeigen
 * der Bestätigung und noch einmal beim Bestätigen.
 */
export async function gemeldetesZielLesen(pool: pg.Pool, wache: string, art: UpdateZiel['art']): Promise<UpdateZiel | undefined> {
  const ergebnis = await pool.query<{ status: string; update_ziel: unknown }>(
    `SELECT status, update_ziel FROM cockpit.befund WHERE wache = $1 ORDER BY id DESC LIMIT 1`,
    [wache],
  );
  const zeile = ergebnis.rows[0];
  const update = zeile?.status === 'gelb' ? updateZielAus(zeile.update_ziel) : undefined;
  return update?.art === art ? update : undefined;
}
