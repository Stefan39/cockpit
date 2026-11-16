/**
 * Der Lesestand des Posteingangs in der Datenbank (COPI-112, Migration 0036) und das Lesen der Postfächer.
 *
 * **„Gelesen bis" je Konto und Quelle** (`posteingang_stand`): was davor liegt, gilt als gelesen. Fehlt der Stand, legt
 * das erste Lesen ihn mit dem aktuellen Zeitpunkt an — was dann schon da ist, zählt nicht als neu (sonst begänne jedes
 * Konto mit dem ganzen Bestand eines Postfachs als „ungelesen"). Er geht nur vorwärts.
 *
 * **Geöffnete Zeilen** (`modul_gelesen`): eine Zeile eines Postfachs ist gelesen, sobald ihre Detailseite geöffnet war.
 *
 * **Postfächer** lesen dieselbe View wie die Modulseite, mit derselben erneuten Katalogprüfung und derselben lesenden
 * Transaktion mit kurzem Timeout (`modulLesen`, `liste-detail.ts`). Bezeichner kommen nur aus dem geprüften Block und
 * immer über `escapeIdentifier`; Konto, Kennung und Zeitpunkt gehen als Parameter.
 */
import pg from 'pg';
import type { Abfrager } from '../auth/protokoll.js';
import type { ModulBlock, ModulPosteingang } from '../module/block.js';
import { modulLesen, type Meldung, type ModulLeseErgebnis } from '../module/liste-detail.js';
import { modulViewPruefen } from '../module/registry.js';
import { POSTEINGANG_HOECHSTENS } from './posteingang.js';

const { escapeIdentifier } = pg;

/** So viele Zeilen zeigt die Postfach-Seite höchstens — wie die Modulseite. */
export const POSTFACH_ZEILEN_HOECHSTENS = 200;

/** Der Stand „gelesen bis" einer Quelle; fehlt er, wird er mit `jetzt` angelegt (siehe Kopf). */
export async function standSichern(db: Abfrager, benutzerId: string, quelle: string, jetzt: Date): Promise<Date> {
  const ergebnis = await db.query<{ gelesen_bis: Date }>(
    `WITH neu AS (
       INSERT INTO cockpit.posteingang_stand (benutzer_id, quelle, gelesen_bis) VALUES ($1, $2, $3)
       ON CONFLICT (benutzer_id, quelle) DO NOTHING
       RETURNING gelesen_bis
     )
     SELECT gelesen_bis FROM neu
     UNION ALL
     SELECT gelesen_bis FROM cockpit.posteingang_stand WHERE benutzer_id = $1 AND quelle = $2
     LIMIT 1`,
    [benutzerId, quelle, jetzt],
  );
  return ergebnis.rows[0]?.gelesen_bis ?? jetzt;
}

/** Rückt den Stand einer Quelle auf `bis` vor — nie zurück. */
export async function standSetzen(db: Abfrager, benutzerId: string, quelle: string, bis: Date): Promise<void> {
  await db.query(
    `INSERT INTO cockpit.posteingang_stand (benutzer_id, quelle, gelesen_bis) VALUES ($1, $2, $3)
     ON CONFLICT (benutzer_id, quelle) DO UPDATE
        SET gelesen_bis = GREATEST(cockpit.posteingang_stand.gelesen_bis, EXCLUDED.gelesen_bis),
            aktualisiert_am = now()`,
    [benutzerId, quelle, bis],
  );
}

/** Hält fest, dass das Konto diese Zeile geöffnet hat. Einmal gelesen bleibt gelesen. */
export async function zeileGelesen(db: Abfrager, benutzerId: string, kennung: string, vorgangId: string): Promise<void> {
  await db.query(
    `INSERT INTO cockpit.modul_gelesen (benutzer_id, modul_kennung, vorgang_id) VALUES ($1, $2, $3)
     ON CONFLICT (benutzer_id, modul_kennung, vorgang_id) DO NOTHING`,
    [benutzerId, kennung, vorgangId],
  );
}

/** Eine Zeile eines Postfachs. */
export interface PostfachZeile {
  readonly id: string;
  readonly titel: string;
  readonly status: string;
  readonly anriss: string;
  readonly zeit: Date | undefined;
  readonly ungelesen: boolean;
}

/** Die ungelesenen Zeilen eines Postfachs: die jüngsten und wie viele insgesamt. */
export interface PostfachUngelesen {
  readonly zeilen: readonly PostfachZeile[];
  readonly anzahl: number;
}

interface RohZeile {
  readonly id: unknown;
  readonly titel: unknown;
  readonly status: unknown;
  readonly anriss: unknown;
  readonly zeit: Date | null;
  readonly ungelesen: boolean;
  readonly anzahl?: number;
}

function zeileLesen(zeile: RohZeile): PostfachZeile {
  return {
    id: String(zeile.id),
    titel: zeile.titel === null || zeile.titel === undefined ? '' : String(zeile.titel),
    status: zeile.status === null || zeile.status === undefined ? '' : String(zeile.status),
    anriss: zeile.anriss === null || zeile.anriss === undefined ? '' : String(zeile.anriss),
    zeit: zeile.zeit ?? undefined,
    ungelesen: zeile.ungelesen,
  };
}

/** Spalten und Bedingung „ungelesen" für eine View mit `posteingang:` ($1 Konto, $2 gelesen bis, $3 Kennung). */
function bausteine(block: ModulBlock, posteingang: ModulPosteingang) {
  const zeit = `v.${escapeIdentifier(posteingang.zeit)}`;
  return {
    view: `cockpit.${escapeIdentifier(block.view)}`,
    zeit,
    spalten: `v.id, v.titel, v.status, v.${escapeIdentifier(posteingang.anriss)} AS anriss, ${zeit} AS zeit`,
    ungelesen: `(${zeit} > $2 AND NOT EXISTS (
                   SELECT 1 FROM cockpit.modul_gelesen g
                    WHERE g.benutzer_id = $1 AND g.modul_kennung = $3 AND g.vorgang_id = v.id::text))`,
  };
}

/**
 * Die ungelesenen Zeilen eines Postfachs für den Posteingang: neuer als `gelesenBis` und nie geöffnet, die jüngsten
 * `POSTEINGANG_HOECHSTENS` samt Gesamtzahl.
 */
export function postfachUngelesenLesen(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  posteingang: ModulPosteingang,
  benutzerId: string,
  gelesenBis: Date,
  log?: Meldung,
): Promise<ModulLeseErgebnis<PostfachUngelesen>> {
  const b = bausteine(block, posteingang);
  return modulLesen(pool, kennung, () => modulViewPruefen(pool, block), log, 'Posteingang konnte nicht gelesen werden', async (client) => {
    const ergebnis = await client.query<RohZeile>(
      `SELECT ${b.spalten}, true AS ungelesen, count(*) OVER ()::int AS anzahl
         FROM ${b.view} v
        WHERE ${b.ungelesen}
        ORDER BY ${b.zeit} DESC
        LIMIT ${String(POSTEINGANG_HOECHSTENS)}`,
      [benutzerId, gelesenBis, kennung],
    );
    return { zeilen: ergebnis.rows.map(zeileLesen), anzahl: ergebnis.rows[0]?.anzahl ?? 0 };
  });
}

/** Alle Zeilen eines Postfachs für seine Seite, jüngste zuerst, jede mit „ungelesen". */
export function postfachLesen(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  posteingang: ModulPosteingang,
  benutzerId: string,
  gelesenBis: Date,
  log?: Meldung,
): Promise<ModulLeseErgebnis<readonly PostfachZeile[]>> {
  const b = bausteine(block, posteingang);
  return modulLesen(pool, kennung, () => modulViewPruefen(pool, block), log, 'Postfach konnte nicht gelesen werden', async (client) => {
    const ergebnis = await client.query<RohZeile>(
      `SELECT ${b.spalten}, COALESCE(${b.ungelesen}, false) AS ungelesen
         FROM ${b.view} v
        ORDER BY ${b.zeit} DESC NULLS LAST, v.titel
        LIMIT ${String(POSTFACH_ZEILEN_HOECHSTENS)}`,
      [benutzerId, gelesenBis, kennung],
    );
    return ergebnis.rows.map(zeileLesen);
  });
}

/** Die offenen Zeilen eines angehefteten Moduls (COPI-122) und wie viele es insgesamt sind. */
export interface OffeneZeilen {
  readonly zeilen: readonly PostfachZeile[];
  readonly offen: number;
}

/**
 * Die jüngsten offenen Zeilen (Status `rot` oder `gelb`) eines Moduls mit `posteingang:` für die Reihe „Zu tun" des
 * Dashboards (COPI-122), jede mit „ungelesen" wie im Postfach, dazu die Zahl aller offenen Zeilen.
 */
export function offeneZeilenLesen(
  pool: pg.Pool,
  kennung: string,
  block: ModulBlock,
  posteingang: ModulPosteingang,
  benutzerId: string,
  gelesenBis: Date,
  anzahl: number,
  log?: Meldung,
): Promise<ModulLeseErgebnis<OffeneZeilen>> {
  const b = bausteine(block, posteingang);
  return modulLesen(pool, kennung, () => modulViewPruefen(pool, block), log, 'Offene Zeilen konnten nicht gelesen werden', async (client) => {
    const ergebnis = await client.query<RohZeile>(
      `SELECT ${b.spalten}, COALESCE(${b.ungelesen}, false) AS ungelesen, count(*) OVER ()::int AS anzahl
         FROM ${b.view} v
        WHERE v.status IN ('rot', 'gelb')
        ORDER BY ${b.zeit} DESC NULLS LAST, v.titel
        LIMIT $4`,
      [benutzerId, gelesenBis, kennung, anzahl],
    );
    return { zeilen: ergebnis.rows.map(zeileLesen), offen: ergebnis.rows[0]?.anzahl ?? 0 };
  });
}
