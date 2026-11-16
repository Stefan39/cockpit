/**
 * Die zweiten Faktoren eines Kontos verwalten (COPI-94): lesen, einen entfernen, die Ersatzcodes neu erzeugen.
 *
 * Diese Datei prüft **keine** frische Bestätigung — das tut die Route (`routes/sicherheit.ts`), bevor sie hier etwas
 * ändert. Sie hält die Regeln, die unabhängig vom Weg gelten:
 *
 *   * **Nie den letzten Faktor.** Faktoren sind die Passkeys und eine geprüfte Authenticator-App
 *     (`cockpit.totp_aktiv`). Ersatzcodes zählen nicht: sie ersetzen einen Faktor nur im Notfall. Gezählt und
 *     entfernt wird in **einer** Transaktion, nach einer Sperre auf die Zeile des Kontos — zwei gleichzeitige
 *     Anfragen, die je einen von zwei Faktoren entfernen, lassen so immer einen übrig.
 *   * **Nie physisch löschen** gilt hier wie seit COPI-62: Passkey und App werden gelöscht, der Trigger aus 0025
 *     archiviert sie dabei ohne Geheimnis in `zugangsmittel_archiv`. Wer entfernt hat, steht im Protokoll, in
 *     derselben Transaktion. Ersatzcodes werden nicht gelöscht, sondern entwertet (`entwertet_am`, Migration 0042).
 *   * **Ersatzcodes gibt es danach nur noch in einer Tabelle.** „Neu erzeugen" schreibt zehn eigene Codes und
 *     entwertet alle bisherigen — die eigenen und die der Authenticator-App (`app-ersatzcodes.ts`). Die von Better
 *     Auth werden **zuerst** entwertet: scheitert danach die Transaktion, hat das Konto weniger gültige Codes, nie mehr.
 */
import type pg from 'pg';
import type { CockpitAuth } from './konfiguration.js';
import { ERSATZCODE_ANZAHL, ersatzcodesErzeugen } from './ersatzcode.js';
import { passwortHashen } from './passwort.js';
import { eigeneEreignisseLesen, protokollSchreiben, type ProtokollArt } from './protokoll.js';

export interface PasskeyEintrag {
  readonly id: string;
  readonly name: string;
  readonly angelegtAm: Date;
}

export interface Faktoren {
  readonly passkeys: readonly PasskeyEintrag[];
  readonly totp: boolean;
  /** Offene Ersatzcodes beider Tabellen: eigene (weder verbraucht noch entwertet) und die der Authenticator-App. */
  readonly ersatzcodes: number;
  /** Davon die eigenen: sie bleiben, wenn die App entfernt wird (deren Codes fallen mit ihr weg). */
  readonly eigeneErsatzcodes: number;
}

export { ERSATZCODE_ANZAHL };

/** Wie viele Ersatzcodes der Authenticator-App offen sind; ohne geprüfte App keine. */
async function appErsatzcodesZaehlen(auth: CockpitAuth, benutzerId: string): Promise<number> {
  try {
    const { backupCodes } = await auth.api.viewBackupCodes({ body: { userId: benutzerId } });
    return backupCodes.length;
  } catch {
    // Keine Zeile in `twoFactor` (oder nicht lesbar): dann gibt es dort auch keinen gültigen Code.
    return 0;
  }
}

export async function faktorenLesen(pool: pg.Pool, auth: CockpitAuth, benutzerId: string): Promise<Faktoren> {
  const passkeys = await pool.query<{ id: string; name: string; angelegt_am: Date }>(
    'SELECT id, name, angelegt_am FROM cockpit.passkey WHERE benutzer_id = $1 ORDER BY angelegt_am, id',
    [benutzerId],
  );
  const stand = await pool.query<{ totp: boolean; eigene: number }>(
    `SELECT cockpit.totp_aktiv(u) AS totp,
            (SELECT count(*)::int FROM cockpit.ersatzcode e
              WHERE e.benutzer_id = u.id AND e.verbraucht_am IS NULL AND e.entwertet_am IS NULL) AS eigene
       FROM cockpit."user" u WHERE u.id = $1`,
    [benutzerId],
  );
  const totp = stand.rows[0]?.totp === true;
  const app = totp ? await appErsatzcodesZaehlen(auth, benutzerId) : 0;
  const eigene = stand.rows[0]?.eigene ?? 0;
  return {
    passkeys: passkeys.rows.map((zeile) => ({ id: zeile.id, name: zeile.name, angelegtAm: zeile.angelegt_am })),
    totp,
    ersatzcodes: eigene + app,
    eigeneErsatzcodes: eigene,
  };
}

export type ZuEntfernen = { readonly art: 'passkey'; readonly id: string } | { readonly art: 'totp' };

export type EntfernenErgebnis =
  /** Entfernt; beim Passkey mit seinem Namen (für die Hinweis-Mail). */
  | { readonly ok: true; readonly name?: string }
  /** Es ist der letzte Faktor des Kontos: nichts geändert. */
  | { readonly ok: false; readonly grund: 'letzter' }
  /** Diesen Faktor hat das Konto nicht (fremder oder schon entfernter Passkey, keine App). */
  | { readonly ok: false; readonly grund: 'unbekannt' };

type Client = pg.PoolClient;

/** Sperrt die Zeile des Kontos und zählt seine Faktoren. `undefined`, wenn es das Konto nicht gibt. */
async function faktorenSperrenUndZaehlen(
  client: Client,
  benutzerId: string,
): Promise<{ readonly anzahl: number; readonly totp: boolean } | undefined> {
  // Erst sperren, dann zählen — in **zwei** Anweisungen. In einer zählte die Unterabfrage mit dem Stand vom Beginn
  // der Anweisung: wer auf die Sperre gewartet hat, sähe den eben entfernten Faktor noch (gemessen im Test mit zwei
  // gleichzeitigen Anfragen). Die zweite Anweisung bekommt unter READ COMMITTED einen neuen Stand.
  await client.query('SELECT 1 FROM cockpit."user" WHERE id = $1 FOR UPDATE', [benutzerId]);
  const ergebnis = await client.query<{ passkeys: number; totp: boolean }>(
    `SELECT (SELECT count(*)::int FROM cockpit.passkey p WHERE p.benutzer_id = u.id) AS passkeys,
            cockpit.totp_aktiv(u) AS totp
       FROM cockpit."user" u WHERE u.id = $1`,
    [benutzerId],
  );
  const zeile = ergebnis.rows[0];
  return zeile === undefined ? undefined : { anzahl: zeile.passkeys + (zeile.totp ? 1 : 0), totp: zeile.totp };
}

async function inTransaktion<T>(pool: pg.Pool, arbeit: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ergebnis = await arbeit(client);
    await client.query('COMMIT');
    return ergebnis;
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

/** Ein Rückgabewert, nach dem die Transaktion ohne Änderung endet (ein `ROLLBACK` wäre gleichwertig). */
const UNVERAENDERT = (grund: 'letzter' | 'unbekannt'): EntfernenErgebnis => ({ ok: false, grund });

export async function faktorEntfernen(pool: pg.Pool, benutzerId: string, ziel: ZuEntfernen): Promise<EntfernenErgebnis> {
  return inTransaktion(pool, async (client) => {
    const stand = await faktorenSperrenUndZaehlen(client, benutzerId);
    if (stand === undefined) {
      return UNVERAENDERT('unbekannt');
    }
    let name: string | undefined;
    if (ziel.art === 'passkey') {
      const vorhanden = await client.query<{ name: string }>(
        'SELECT name FROM cockpit.passkey WHERE id = $1 AND benutzer_id = $2',
        [ziel.id, benutzerId],
      );
      if (vorhanden.rows[0] === undefined) {
        return UNVERAENDERT('unbekannt');
      }
      name = vorhanden.rows[0].name;
    } else if (!stand.totp) {
      return UNVERAENDERT('unbekannt');
    }
    if (stand.anzahl <= 1) {
      return UNVERAENDERT('letzter');
    }
    if (ziel.art === 'passkey') {
      await client.query('DELETE FROM cockpit.passkey WHERE id = $1 AND benutzer_id = $2', [ziel.id, benutzerId]);
    } else {
      // Wie `cockpit.zweite_faktoren_entfernen` (0014), nur für die App (0042): Zeile weg (der Trigger archiviert sie
      // samt ihrer Ersatzcodes ohne Geheimnis), Schalter aus. `totp_aktiv` ist danach falsch.
      await client.query('SELECT cockpit.totp_entfernen($1)', [benutzerId]);
    }
    await protokollSchreiben(client, {
      art: 'zweiter_faktor_entfernt',
      akteur: benutzerId,
      einzelheiten: { faktor: ziel.art },
    });
    return name === undefined ? { ok: true } : { ok: true, name };
  });
}

/**
 * Zehn neue Ersatzcodes; alle bisherigen gelten danach nicht mehr. Die Codes stehen nur im Rückgabewert (einmal
 * anzeigen), in der Datenbank nur ihr Hash.
 */
export async function ersatzcodesErneuern(pool: pg.Pool, auth: CockpitAuth, benutzerId: string): Promise<string[]> {
  // Zuerst die der Authenticator-App: siehe Kopfkommentar.
  await auth.api.appErsatzcodesEntwerten({ body: { benutzerId } });
  // Argon2id rechnet, bevor die Transaktion die Zeile des Kontos sperrt.
  const codes = ersatzcodesErzeugen();
  const hashes = await Promise.all(codes.map((code) => passwortHashen(code)));
  await inTransaktion(pool, async (client) => {
    await client.query('SELECT 1 FROM cockpit."user" WHERE id = $1 FOR UPDATE', [benutzerId]);
    await client.query(
      `UPDATE cockpit.ersatzcode SET entwertet_am = now()
        WHERE benutzer_id = $1 AND verbraucht_am IS NULL AND entwertet_am IS NULL`,
      [benutzerId],
    );
    await client.query('INSERT INTO cockpit.ersatzcode (benutzer_id, code_hash) SELECT $1, unnest($2::text[])', [
      benutzerId,
      hashes,
    ]);
    await protokollSchreiben(client, { art: 'ersatzcodes_erneuert', akteur: benutzerId });
  });
  return codes;
}

/** Was „Letzte Änderungen" auf `/sicherheit` zeigt: nur Ereignisse am eigenen Zugang, die man selbst ausgelöst hat. */
export const VERLAUF_ARTEN = [
  'zweiter_faktor_eingerichtet',
  'zweiter_faktor_hinzugefuegt',
  'zweiter_faktor_entfernt',
  'ersatzcodes_erneuert',
  'ersatzcode_verwendet',
] as const satisfies readonly ProtokollArt[];

export interface VerlaufEintrag {
  readonly zeitpunkt: Date;
  readonly art: (typeof VERLAUF_ARTEN)[number];
  /** `passkey` oder `totp`, wo das Ereignis es nennt. */
  readonly faktor: string | undefined;
}

/** Die jüngsten Änderungen am eigenen zweiten Faktor, neueste zuerst (gelesen über `protokoll.ts`). */
export async function verlaufLesen(pool: pg.Pool, benutzerId: string, anzahl = 5): Promise<VerlaufEintrag[]> {
  const eintraege = await eigeneEreignisseLesen(pool, benutzerId, VERLAUF_ARTEN, anzahl);
  return eintraege.map((eintrag) => ({
    zeitpunkt: eintrag.zeitpunkt,
    art: eintrag.art as VerlaufEintrag['art'],
    faktor: typeof eintrag.einzelheiten.faktor === 'string' ? eintrag.einzelheiten.faktor : undefined,
  }));
}
