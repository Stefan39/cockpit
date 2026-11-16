/**
 * Kanäle und Nachrichten des Chats in der Datenbank (COPI-52, Migration 0024).
 *
 * Zwei Arten von Kanälen: je Benutzer ein Assistenten-Kanal (Dauerkanal mit dem Koordinator) und ein gemeinsamer
 * Team-Kanal der Instanz. Wer welchen Kanal sehen darf, entscheidet die Route (COPI-53); hier nimmt jede Abfrage den
 * Kanal als ersten Schlüssel, damit keine Nachricht aus einem anderen Kanal durchrutscht.
 *
 * **Nie löschen:** eine Nachricht wird nur als gelöscht markiert. Beim Lesen kommt ihr Inhalt dann nicht mehr mit
 * (`inhalt` ist `undefined`) — im Bestand bleibt er, als Nachweis.
 *
 * Die Regeln (Absender, Länge, wer dringend sein darf, eine Antwort je Frage, Unveränderlichkeit) stehen in der
 * Datenbank; hier stehen die Abfragen und die Umrechnung in Objekte.
 */
import type { Abfrager } from '../auth/protokoll.js';

/** `agent` (COPI-113): ein Kanal zwischen zwei Agenten; Menschen lesen dort nur mit. */
export const KANAL_ARTEN = ['assistent', 'team', 'agent'] as const;
export type KanalArt = (typeof KANAL_ARTEN)[number];

export const ABSENDER_ARTEN = ['mensch', 'agent', 'system'] as const;
export type AbsenderArt = (typeof ABSENDER_ARTEN)[number];

/** Höchstlänge eines Inhalts in Zeichen. Muss mit `nachricht_inhalt_laenge` (Migration 0024) übereinstimmen. */
export const INHALT_HOECHSTENS = 4000;

/** So viele Nachrichten höchstens je Seite des Verlaufs. */
export const SEITE_HOECHSTENS = 50;

export interface Kanal {
  readonly id: number;
  readonly art: KanalArt;
  /** Nur beim Assistenten-Kanal. */
  readonly besitzerId: string | undefined;
  /** Nur beim Kanal zweier Agenten (COPI-113): ihre Kennungen, sortiert. */
  readonly agenten?: readonly [string, string] | undefined;
}

export interface Nachricht {
  readonly id: number;
  readonly kanalId: number;
  readonly absenderArt: AbsenderArt;
  /** Nur bei `mensch`. */
  readonly absenderId: string | undefined;
  /** Welcher Agent geschrieben hat (COPI-113); nur bei `agent`, und nur, wenn er sich genannt hat. */
  readonly absenderAgent?: string | undefined;
  /** Name des Menschen, der geschrieben hat (auch eines als gelöscht markierten Kontos); beim Anlegen nicht gelesen. */
  readonly absenderName: string | undefined;
  /** Klartext, nie HTML. `undefined`, wenn die Nachricht als gelöscht markiert ist. */
  readonly inhalt: string | undefined;
  readonly dringend: boolean;
  readonly antwortAuf: number | undefined;
  readonly erstelltAm: Date;
  readonly geloeschtAm: Date | undefined;
  /** Wann der Webhook des Koordinators die Nachricht quittiert hat (COPI-69, Migration 0031); sonst `undefined`. */
  readonly zugestelltAm?: Date | undefined;
}

export interface NeueNachricht {
  readonly kanalId: number;
  readonly absenderArt: AbsenderArt;
  /** Pflicht bei `mensch`, sonst nicht erlaubt (die Datenbank prüft es). */
  readonly absenderId?: string;
  readonly inhalt: string;
  readonly dringend?: boolean;
  readonly antwortAuf?: number;
  /** Nur bei `agent` (COPI-113); im Kanal zweier Agenten Pflicht (die Datenbank prüft es). */
  readonly absenderAgent?: string;
}

interface KanalZeile {
  readonly id: number;
  readonly art: string;
  readonly besitzer_id: string | null;
  readonly agent_a?: string | null;
  readonly agent_b?: string | null;
}

interface Zeile {
  readonly id: number;
  readonly kanal_id: number;
  readonly absender_art: string;
  readonly absender_id: string | null;
  readonly absender_agent: string | null;
  readonly absender_name: string | null;
  readonly inhalt: string;
  readonly dringend: boolean;
  readonly antwort_auf: number | null;
  readonly erstellt_am: Date;
  readonly geloescht_am: Date | null;
  readonly zugestellt_am: Date | null;
}

const KANAL_SPALTEN = 'id::int AS id, art, besitzer_id, agent_a, agent_b';

const SPALTEN = `n.id::int AS id, n.kanal_id::int AS kanal_id, n.absender_art, n.absender_id, n.absender_agent, u.name AS absender_name,
                 n.inhalt, n.dringend, n.antwort_auf::int AS antwort_auf, n.erstellt_am, n.geloescht_am, n.zugestellt_am`;

/** Nachrichten samt Namen des Absenders. */
const AUS = 'cockpit.nachricht n LEFT JOIN cockpit."user" u ON u.id = n.absender_id';

function istAus<T extends string>(liste: readonly T[], wert: string): wert is T {
  return (liste as readonly string[]).includes(wert);
}

function kanalLesen(zeile: KanalZeile | undefined): Kanal {
  // Beide Kanäle legt die Datenbank bzw. `assistentKanal` an; fehlt einer, ist das ein Fehler, kein Zustand.
  if (zeile === undefined || !istAus(KANAL_ARTEN, zeile.art)) {
    throw new Error('Kanal fehlt oder hat eine unbekannte Art');
  }
  const agenten = zeile.agent_a && zeile.agent_b ? ([zeile.agent_a, zeile.agent_b] as const) : undefined;
  return { id: zeile.id, art: zeile.art, besitzerId: zeile.besitzer_id ?? undefined, ...(agenten ? { agenten } : {}) };
}

function zeileLesen(zeile: Zeile): Nachricht {
  if (!istAus(ABSENDER_ARTEN, zeile.absender_art)) {
    throw new Error('Unbekannte Absender-Art in der Datenbank');
  }
  const geloescht = zeile.geloescht_am !== null;
  return {
    id: zeile.id,
    kanalId: zeile.kanal_id,
    absenderArt: zeile.absender_art,
    absenderId: zeile.absender_id ?? undefined,
    ...(zeile.absender_agent === null ? {} : { absenderAgent: zeile.absender_agent }),
    absenderName: zeile.absender_name ?? undefined,
    inhalt: geloescht ? undefined : zeile.inhalt,
    dringend: zeile.dringend,
    antwortAuf: zeile.antwort_auf ?? undefined,
    erstelltAm: zeile.erstellt_am,
    geloeschtAm: zeile.geloescht_am ?? undefined,
    zugestelltAm: zeile.zugestellt_am ?? undefined,
  };
}

/** Der Assistenten-Kanal des Benutzers; beim ersten Mal wird er angelegt (auch bei gleichzeitigen Aufrufen genau einer). */
export async function assistentKanal(db: Abfrager, benutzerId: string): Promise<Kanal> {
  await db.query(
    `INSERT INTO cockpit.kanal (art, besitzer_id) VALUES ('assistent', $1)
     ON CONFLICT (besitzer_id) WHERE art = 'assistent' DO NOTHING`,
    [benutzerId],
  );
  const ergebnis = await db.query<KanalZeile>(
    `SELECT ${KANAL_SPALTEN} FROM cockpit.kanal WHERE art = 'assistent' AND besitzer_id = $1`,
    [benutzerId],
  );
  return kanalLesen(ergebnis.rows[0]);
}

/** Der gemeinsame Team-Kanal der Instanz (angelegt von Migration 0024). */
export async function teamKanal(db: Abfrager): Promise<Kanal> {
  const ergebnis = await db.query<KanalZeile>(`SELECT ${KANAL_SPALTEN} FROM cockpit.kanal WHERE art = 'team'`);
  return kanalLesen(ergebnis.rows[0]);
}

/**
 * Der Kanal zweier Agenten (COPI-113); beim ersten Mal wird er angelegt (auch bei gleichzeitigen Aufrufen genau einer).
 * Die Reihenfolge der Kennungen spielt keine Rolle: der Kanal speichert sie sortiert.
 */
export async function agentenKanal(db: Abfrager, eins: string, zwei: string): Promise<Kanal> {
  const [a, b] = eins < zwei ? [eins, zwei] : [zwei, eins];
  await db.query(
    `INSERT INTO cockpit.kanal (art, agent_a, agent_b) VALUES ('agent', $1, $2)
     ON CONFLICT (agent_a, agent_b) WHERE art = 'agent' DO NOTHING`,
    [a, b],
  );
  const ergebnis = await db.query<KanalZeile>(`SELECT ${KANAL_SPALTEN} FROM cockpit.kanal WHERE art = 'agent' AND agent_a = $1 AND agent_b = $2`, [a, b]);
  return kanalLesen(ergebnis.rows[0]);
}

/** Legt eine Nachricht an. Wirft, wenn die Datenbank sie ablehnt (leer, zu lang, zweite Antwort auf dieselbe Frage). */
export async function nachrichtAnlegen(db: Abfrager, neu: NeueNachricht): Promise<Nachricht> {
  const ergebnis = await db.query<Zeile>(
    `WITH n AS (
       INSERT INTO cockpit.nachricht (kanal_id, absender_art, absender_id, inhalt, dringend, antwort_auf, absender_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *
     )
     SELECT ${SPALTEN} FROM n LEFT JOIN cockpit."user" u ON u.id = n.absender_id`,
    [neu.kanalId, neu.absenderArt, neu.absenderId ?? null, neu.inhalt, neu.dringend ?? false, neu.antwortAuf ?? null, neu.absenderAgent ?? null],
  );
  const zeile = ergebnis.rows[0];
  if (zeile === undefined) {
    throw new Error('Nachricht wurde nicht angelegt');
  }
  return zeileLesen(zeile);
}

/** Eine Nachricht aus diesem Kanal, sonst `undefined` — auch wenn es sie in einem anderen Kanal gibt. */
export async function nachrichtLesen(db: Abfrager, kanalId: number, id: number): Promise<Nachricht | undefined> {
  const ergebnis = await db.query<Zeile>(`SELECT ${SPALTEN} FROM ${AUS} WHERE n.kanal_id = $1 AND n.id = $2`, [kanalId, id]);
  const zeile = ergebnis.rows[0];
  return zeile === undefined ? undefined : zeileLesen(zeile);
}

/**
 * Eine Seite des Verlaufs, **älteste zuerst**: die jüngsten `hoechstens` Nachrichten, oder mit `vor` die jüngsten vor
 * dieser ID (älter nachladen). Als gelöscht markierte Nachrichten stehen mit darin, ohne Inhalt.
 */
export async function verlaufLesen(
  db: Abfrager,
  kanalId: number,
  optionen: { readonly vor?: number; readonly hoechstens?: number } = {},
): Promise<Nachricht[]> {
  const hoechstens = Math.min(optionen.hoechstens ?? SEITE_HOECHSTENS, SEITE_HOECHSTENS);
  const ergebnis = await db.query<Zeile>(
    `SELECT * FROM (
       SELECT ${SPALTEN} FROM ${AUS}
        WHERE n.kanal_id = $1 AND ($2::bigint IS NULL OR n.id < $2)
        ORDER BY n.id DESC LIMIT $3
     ) seite ORDER BY id ASC`,
    [kanalId, optionen.vor ?? null, hoechstens],
  );
  return ergebnis.rows.map(zeileLesen);
}

/** Was nach dieser ID dazukam, älteste zuerst — für die Wiederverbindung per `Last-Event-ID` (COPI-56). */
export async function nachrichtenSeit(db: Abfrager, kanalId: number, nachId: number): Promise<Nachricht[]> {
  const ergebnis = await db.query<Zeile>(
    `SELECT ${SPALTEN} FROM ${AUS} WHERE n.kanal_id = $1 AND n.id > $2 ORDER BY n.id ASC LIMIT $3`,
    [kanalId, nachId, SEITE_HOECHSTENS],
  );
  return ergebnis.rows.map(zeileLesen);
}

export type MarkierenErgebnis = 'markiert' | 'unbekannt' | 'schon_geloescht';

/**
 * Markiert eine Nachricht als gelöscht; ihr Inhalt bleibt im Bestand. Wer das darf (etwa nur die eigenen), prüft die
 * Route. `von` ist die Konto-ID dessen, der markiert.
 */
export async function nachrichtAlsGeloeschtMarkieren(db: Abfrager, kanalId: number, id: number, von: string): Promise<MarkierenErgebnis> {
  const ergebnis = await db.query<{ markiert: boolean }>(
    `WITH markiert AS (
       UPDATE cockpit.nachricht SET geloescht_am = now(), geloescht_von = $3
        WHERE kanal_id = $1 AND id = $2 AND geloescht_am IS NULL
       RETURNING id
     )
     SELECT EXISTS (SELECT 1 FROM markiert) AS markiert
       FROM cockpit.nachricht n WHERE n.kanal_id = $1 AND n.id = $2`,
    [kanalId, id, von],
  );
  const zeile = ergebnis.rows[0];
  if (zeile === undefined) {
    return 'unbekannt';
  }
  return zeile.markiert ? 'markiert' : 'schon_geloescht';
}

/** Hält fest, dass der Webhook des Koordinators die Nachricht quittiert hat (COPI-69). Einmal gesetzt, bleibt der Zeitpunkt. */
export async function nachrichtAlsZugestelltMarkieren(db: Abfrager, id: number): Promise<void> {
  await db.query(`UPDATE cockpit.nachricht SET zugestellt_am = now() WHERE id = $1 AND zugestellt_am IS NULL`, [id]);
}

/** Gibt es im Kanal eine Antwort des Koordinators nach dieser ID? Für ältere Seiten, deren Antwort auf einer neueren steht. */
export async function agentAntwortNach(db: Abfrager, kanalId: number, nachId: number): Promise<boolean> {
  const ergebnis = await db.query<{ da: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM cockpit.nachricht WHERE kanal_id = $1 AND id > $2 AND absender_art = 'agent') AS da`,
    [kanalId, nachId],
  );
  return ergebnis.rows[0]?.da ?? false;
}

/** Der Lesestand eines Benutzers in einem Kanal (0, wenn er noch keinen hat) — vor dem Setzen lesen (Trenner „Neu", COPI-69). */
export async function lesestandLesen(db: Abfrager, benutzerId: string, kanalId: number): Promise<number> {
  const ergebnis = await db.query<{ bis_id: number }>(
    `SELECT bis_id::int AS bis_id FROM cockpit.nachricht_lesestand WHERE benutzer_id = $1 AND kanal_id = $2`,
    [benutzerId, kanalId],
  );
  return ergebnis.rows[0]?.bis_id ?? 0;
}

/**
 * Setzt den Lesestand in einem Kanal auf `bisId`. Er geht nur vorwärts: ein älterer Tab, der später meldet, setzt ihn
 * nicht zurück.
 */
export async function lesestandSetzen(db: Abfrager, benutzerId: string, kanalId: number, bisId: number): Promise<void> {
  await db.query(
    `INSERT INTO cockpit.nachricht_lesestand (benutzer_id, kanal_id, bis_id) VALUES ($1, $2, $3)
     ON CONFLICT (benutzer_id, kanal_id) DO UPDATE
        SET bis_id = GREATEST(cockpit.nachricht_lesestand.bis_id, EXCLUDED.bis_id),
            aktualisiert_am = now()`,
    [benutzerId, kanalId, bisId],
  );
}

/** Ungelesene Nachrichten in einem Kanal — ohne die eigenen und ohne als gelöscht markierte. */
export async function ungeleseneZaehlen(db: Abfrager, benutzerId: string, kanalId: number): Promise<number> {
  return (await kanalStand(db, benutzerId, kanalId)).ungelesen;
}

/** Welche Nachrichten ein Benutzer als ungelesen sieht: nicht die eigenen, keine markierten, nur nach seinem Lesestand. */
const UNGELESEN = `n.geloescht_am IS NULL AND n.absender_id IS DISTINCT FROM $1
   AND n.id > COALESCE((SELECT l.bis_id FROM cockpit.nachricht_lesestand l WHERE l.benutzer_id = $1 AND l.kanal_id = n.kanal_id), 0)`;

/**
 * Ungelesene Nachrichten über alle Kanäle des Benutzers — den eigenen Assistenten-Kanal und den Team-Kanal. Für das
 * Kennzeichen in der Navigation; legt keinen Kanal an.
 */
export async function ungeleseneGesamt(db: Abfrager, benutzerId: string): Promise<number> {
  const ergebnis = await db.query<{ anzahl: number }>(
    `SELECT count(*)::int AS anzahl FROM cockpit.nachricht n JOIN cockpit.kanal k ON k.id = n.kanal_id
      WHERE (k.art = 'team' OR (k.art = 'assistent' AND k.besitzer_id = $1)) AND ${UNGELESEN}`,
    [benutzerId],
  );
  return ergebnis.rows[0]?.anzahl ?? 0;
}

/** Eine ungelesene Nachricht für den Posteingang (COPI-112), mit der Art ihres Kanals (dorthin führt der Link). */
export interface UngeleseneNachricht {
  readonly nachricht: Nachricht;
  readonly kanalArt: KanalArt;
}

/**
 * Die jüngsten ungelesenen Nachrichten über alle Kanäle des Benutzers, neueste zuerst — dieselbe Regel wie
 * `ungeleseneGesamt`. Als gelöscht markierte zählen nie (ohne Inhalt gäbe es auch nichts anzureißen).
 */
export async function ungeleseneNachrichten(db: Abfrager, benutzerId: string, hoechstens: number): Promise<UngeleseneNachricht[]> {
  const ergebnis = await db.query<Zeile & { kanal_art: string }>(
    `SELECT ${SPALTEN}, k.art AS kanal_art FROM ${AUS} JOIN cockpit.kanal k ON k.id = n.kanal_id
      WHERE (k.art = 'team' OR (k.art = 'assistent' AND k.besitzer_id = $1)) AND ${UNGELESEN}
      ORDER BY n.id DESC LIMIT $2`,
    [benutzerId, hoechstens],
  );
  return ergebnis.rows.map((zeile) => {
    if (!istAus(KANAL_ARTEN, zeile.kanal_art)) {
      throw new Error('Kanal hat eine unbekannte Art');
    }
    return { nachricht: zeileLesen(zeile), kanalArt: zeile.kanal_art };
  });
}

/**
 * „Alle als gelesen" (COPI-112): setzt den Lesestand in jedem Kanal des Benutzers auf dessen jüngste Nachricht. Nur
 * vorwärts, wie `lesestandSetzen`.
 */
export async function alleNachrichtenGelesen(db: Abfrager, benutzerId: string): Promise<void> {
  await db.query(
    `INSERT INTO cockpit.nachricht_lesestand (benutzer_id, kanal_id, bis_id)
     SELECT $1, n.kanal_id, max(n.id) FROM cockpit.nachricht n JOIN cockpit.kanal k ON k.id = n.kanal_id
      WHERE k.art = 'team' OR (k.art = 'assistent' AND k.besitzer_id = $1)
      GROUP BY n.kanal_id
     ON CONFLICT (benutzer_id, kanal_id) DO UPDATE
        SET bis_id = GREATEST(cockpit.nachricht_lesestand.bis_id, EXCLUDED.bis_id),
            aktualisiert_am = now()`,
    [benutzerId],
  );
}

/** Ein Gespräch auf der Detailseite eines Agenten (COPI-113): der Kanal und seine jüngste Nachricht. */
export interface AgentGespraech {
  readonly kanal: Kanal;
  readonly letzte: Nachricht | undefined;
}

/**
 * Die Gespräche eines Agenten, jüngstes zuerst: jeder Kanal mit einem anderen Agenten, dazu der Team-Kanal und der
 * **eigene** Assistenten-Kanal des Betrachters, wenn der Agent dort geschrieben hat. Fremde Assistenten-Kanäle nie —
 * sie gehören einem anderen Konto, auch wenn derselbe Agent dort antwortet.
 */
export async function agentGespraeche(db: Abfrager, kennung: string, benutzerId: string): Promise<AgentGespraech[]> {
  const ergebnis = await db.query<KanalZeile>(
    `SELECT k.id::int AS id, k.art, k.besitzer_id, k.agent_a, k.agent_b
       FROM cockpit.kanal k
      WHERE (k.art = 'agent' AND $1 IN (k.agent_a, k.agent_b))
         OR ((k.art = 'team' OR (k.art = 'assistent' AND k.besitzer_id = $2))
             AND EXISTS (SELECT 1 FROM cockpit.nachricht n WHERE n.kanal_id = k.id AND n.absender_agent = $1))
      ORDER BY (SELECT max(n.id) FROM cockpit.nachricht n WHERE n.kanal_id = k.id) DESC NULLS LAST, k.id`,
    [kennung, benutzerId],
  );
  return Promise.all(
    ergebnis.rows.map(async (zeile) => ({ kanal: kanalLesen(zeile), letzte: (await verlaufLesen(db, zeile.id, { hoechstens: 1 }))[0] })),
  );
}

/** Ein Kanal in der Liste „Verlauf": die jüngste Nachricht als Vorschau und wie viel ungelesen ist. */
export interface KanalStand {
  readonly letzte: Nachricht | undefined;
  readonly ungelesen: number;
}

/** Stand eines Kanals für einen Benutzer. */
export async function kanalStand(db: Abfrager, benutzerId: string, kanalId: number): Promise<KanalStand> {
  const [letzte, ungelesen] = await Promise.all([
    verlaufLesen(db, kanalId, { hoechstens: 1 }),
    db.query<{ anzahl: number }>(`SELECT count(*)::int AS anzahl FROM cockpit.nachricht n WHERE n.kanal_id = $2 AND ${UNGELESEN}`, [
      benutzerId,
      kanalId,
    ]),
  ]);
  return { letzte: letzte[0], ungelesen: ungelesen.rows[0]?.anzahl ?? 0 };
}

export type AntwortErgebnis =
  | { readonly ok: true; readonly nachricht: Nachricht }
  /** Keine Frage eines Menschen im Assistenten-Kanal — auch keine Nachricht im Team-Kanal, das verrät nichts. */
  | { readonly ok: false; readonly grund: 'unbekannt' }
  | { readonly ok: false; readonly grund: 'schon_beantwortet' };

/** Postgres: eindeutiger Index verletzt. */
const EINDEUTIG_VERLETZT = '23505';

function istDoppelteAntwort(fehler: unknown): boolean {
  return (
    typeof fehler === 'object' &&
    fehler !== null &&
    'code' in fehler &&
    fehler.code === EINDEUTIG_VERLETZT &&
    'constraint' in fehler &&
    fehler.constraint === 'nachricht_eine_antwort_je_frage_idx'
  );
}

/**
 * Speichert die Antwort des Koordinators auf eine Frage (COPI-55). Die Frage muss von einem Menschen im
 * Assistenten-Kanal stammen; der Kanal der Antwort ist der der Frage, nie eine Angabe des Agenten. Je Frage gibt es
 * genau eine Antwort — eine wiederholte Zustellung desselben Agentenlaufs wird abgewiesen, nicht verdoppelt.
 */
export async function koordinatorAntwortSpeichern(
  db: Abfrager,
  frageId: number,
  inhalt: string,
  dringend: boolean,
  agent?: string,
): Promise<AntwortErgebnis> {
  const frage = await db.query<{ kanal_id: number }>(
    `SELECT n.kanal_id::int AS kanal_id FROM cockpit.nachricht n JOIN cockpit.kanal k ON k.id = n.kanal_id
      WHERE n.id = $1 AND n.absender_art = 'mensch' AND k.art = 'assistent'`,
    [frageId],
  );
  const kanalId = frage.rows[0]?.kanal_id;
  if (kanalId === undefined) {
    return { ok: false, grund: 'unbekannt' };
  }
  try {
    return {
      ok: true,
      nachricht: await nachrichtAnlegen(db, { kanalId, absenderArt: 'agent', inhalt, dringend, antwortAuf: frageId, ...(agent ? { absenderAgent: agent } : {}) }),
    };
  } catch (fehler) {
    if (istDoppelteAntwort(fehler)) {
      return { ok: false, grund: 'schon_beantwortet' };
    }
    throw fehler;
  }
}
