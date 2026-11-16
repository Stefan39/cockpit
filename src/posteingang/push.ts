/**
 * Push bei neuen Einträgen im Posteingang (COPI-116, Entscheidungen Stefan 02.10.2026: Takt eine Minute, keine
 * Ruhezeiten, alle Quellen des Badges).
 *
 * Bis COPI-116 kam ein Push nur bei einer Antwort des Assistenten oder einer dringenden Nachricht (COPI-59,
 * `chat/push.ts`). Den Posteingang (COPI-112) berechnet das Cockpit beim Lesen aus Views und Tabellen; ein Ereignis, an
 * dem ein Push hängen könnte, gibt es nicht. Deshalb ein **Takt im Prozess** (kein Scheduler-Dienst, kein Redis): je
 * Konto mit aktivem Push-Abo den Posteingang lesen — mit denselben Abfragen und denselben Rechten wie der Badge — und mit
 * dem zuletzt gemeldeten Stand (`cockpit.posteingang_push`, Migration 0041) vergleichen.
 *
 *   * **Neu** ist ein Eintrag, dessen Kennzeichen noch nicht gesehen wurde, oder die Gesamtzahl ist gestiegen (ein
 *     Eintrag jenseits der jüngsten 20, etwa eine Mail mit altem Datum). Höchstens **ein** Push je Konto und Takt.
 *   * **Der erste Lauf** für ein Konto meldet nichts: nach einem Neustart oder einem neuen Abo kommt kein Push für Altes.
 *   * **Inhalt:** nie Absender, Betreff oder Text — nur, dass etwas da ist (wie bei COPI-59), und die Zahl für das
 *     App-Symbol. Ziel ist der Posteingang; die Adresse steht im Service Worker fest (`ziel` wählt nur aus einer Liste).
 *   * Nach einem **Sofort-Push** (Antwort, dringend) hält `posteingangStandFesthalten` den Stand fest, damit der Takt
 *     dieselbe Nachricht nicht eine Minute später noch einmal meldet.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { hatRecht, zugangsZustandLesen, type Zugang } from '../auth/berechtigung.js';
import type { Abfrager } from '../auth/protokoll.js';
import { aktiveModule, type AktivesModul } from '../module/modul-speicher.js';
import { anAbosZustellen, type PushKonfiguration, type PushLog, type Versender } from '../chat/push.js';
import { posteingangTeileLesen } from './lesen.js';
import { POSTEINGANG_QUELLEN, type PosteingangEintrag, type PosteingangQuelle, type PosteingangTeil } from './posteingang.js';

/** So oft läuft der Takt (Entscheidung Stefan): höchstens ein Push je Konto und Minute. */
export const POSTEINGANG_PUSH_TAKT_MS = 60_000;

/** So viele Kennzeichen merkt sich der Stand (`posteingang_push_gesehen_liste`, 0041). */
export const GESEHEN_HOECHSTENS = 200;

export type PosteingangTeile = Partial<Record<PosteingangQuelle, PosteingangTeil>>;

/** Was zuletzt gemeldet wurde. */
export interface PushStand {
  readonly gesamt: number;
  readonly gesehen: readonly string[];
}

/** Das Kennzeichen eines Eintrags: gekürzter SHA-256, kein Inhalt im Klartext. */
export function eintragKennzeichen(eintrag: PosteingangEintrag): string {
  return createHash('sha256')
    .update([eintrag.quelle, eintrag.href, eintrag.titel, eintrag.zeit.toISOString()].join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export interface PushAuswertung {
  /** Die Zahl des Badges jetzt. */
  readonly gesamt: number;
  /** Der neue Stand, der gespeichert wird. */
  readonly stand: PushStand;
  /** `undefined`: nichts zu melden. */
  readonly push: { readonly text: string; readonly neu: number } | undefined;
}

/** Ein Satz je Quelle, wenn genau ein Eintrag neu ist — ohne Inhalt. */
const EINZELN: Readonly<Record<PosteingangQuelle, string>> = {
  freigabe: 'Freigabe nötig: eine Antwort wartet auf dich.',
  chat: 'Neue Nachricht im Chat.',
  postfach: 'Neuer Eintrag im Posteingang.',
  meldung: 'Neue Meldung: ein Dienst braucht Aufmerksamkeit.',
};

/** Der Text des Push: eine Freigabe geht vor, mehrere werden zusammengefasst. */
export function pushText(neue: readonly PosteingangEintrag[], anzahl: number): string {
  const [einziger] = neue;
  if (anzahl === 1 && einziger !== undefined && neue.length === 1) {
    return EINZELN[einziger.quelle];
  }
  if (neue.some((eintrag) => eintrag.quelle === 'freigabe')) {
    return `Freigabe nötig – insgesamt ${String(anzahl)} neue Einträge im Posteingang.`;
  }
  return anzahl === 1 ? 'Neuer Eintrag im Posteingang.' : `${String(anzahl)} neue Einträge im Posteingang.`;
}

/**
 * Vergleicht den Posteingang mit dem zuletzt gemeldeten Stand. Ohne Stand (erster Lauf) wird nur festgehalten. Rein,
 * ohne Datenbank.
 */
export function pushAuswerten(teile: PosteingangTeile, vorher: PushStand | undefined): PushAuswertung {
  const eintraege = POSTEINGANG_QUELLEN.flatMap((quelle) => teile[quelle]?.eintraege ?? []);
  const gesamt = POSTEINGANG_QUELLEN.reduce((summe, quelle) => summe + (teile[quelle]?.anzahl ?? 0), 0);
  const kennzeichen = eintraege.map(eintragKennzeichen);
  const gesehen = [...new Set([...kennzeichen, ...(vorher?.gesehen ?? [])])].slice(0, GESEHEN_HOECHSTENS);
  const stand = { gesamt, gesehen };
  if (vorher === undefined) {
    return { gesamt, stand, push: undefined };
  }
  const bekannt = new Set(vorher.gesehen);
  const neue = eintraege.filter((_eintrag, index) => !bekannt.has(kennzeichen[index] ?? ''));
  const anzahl = Math.max(neue.length, gesamt - vorher.gesamt);
  return { gesamt, stand, push: anzahl > 0 ? { text: pushText(neue, anzahl), neu: anzahl } : undefined };
}

async function standLesen(db: Abfrager, benutzerId: string): Promise<PushStand | undefined> {
  const ergebnis = await db.query<{ gesamt: number; gesehen: unknown }>(
    'SELECT gesamt, gesehen FROM cockpit.posteingang_push WHERE benutzer_id = $1',
    [benutzerId],
  );
  const zeile = ergebnis.rows[0];
  if (zeile === undefined) {
    return undefined;
  }
  const gesehen = Array.isArray(zeile.gesehen) ? zeile.gesehen.filter((wert): wert is string => typeof wert === 'string') : [];
  return { gesamt: zeile.gesamt, gesehen };
}

async function standSchreiben(db: Abfrager, benutzerId: string, stand: PushStand, gemeldet: Date | undefined): Promise<void> {
  await db.query(
    `INSERT INTO cockpit.posteingang_push (benutzer_id, gesamt, gesehen, gemeldet_am)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (benutzer_id) DO UPDATE
        SET gesamt = EXCLUDED.gesamt, gesehen = EXCLUDED.gesehen,
            gemeldet_am = coalesce(EXCLUDED.gemeldet_am, posteingang_push.gemeldet_am), aktualisiert_am = now()`,
    [benutzerId, stand.gesamt, JSON.stringify(stand.gesehen), gemeldet ?? null],
  );
}

/** Der Zugang eines Kontos ohne Anfrage: Rolle und zweiter Faktor frisch aus der Datenbank, wie beim Lesen einer Seite. */
async function kontoZugang(pool: pg.Pool, benutzerId: string): Promise<Zugang> {
  const zustand = await zugangsZustandLesen(pool, benutzerId);
  return { angemeldet: true, rolle: zustand.rolle, zweiterFaktorAktiv: zustand.zweiterFaktorAktiv, benutzerId };
}

/** Der Rumpf: nur Hinweis, Zahl und ein Ziel aus der Liste des Service Workers. */
export function posteingangPushRumpf(text: string, gesamt: number): string {
  return JSON.stringify({ titel: 'Cockpit', text, ziel: 'posteingang', anzahl: gesamt });
}

export interface PushAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly konfiguration: PushKonfiguration;
  readonly versender: Versender;
  readonly log: PushLog;
}

/**
 * Ein Konto: Posteingang lesen, auswerten, Stand schreiben, bei Neuem pushen. `melden: false` hält nur fest (nach einem
 * Sofort-Push). Liefert, ob ein Push hinausging. Wer Push nicht nutzen darf (Recht `chat_nutzen`, wie die Push-Routen)
 * oder keinen zweiten Faktor hat, wird übersprungen.
 */
async function kontoPruefen(
  abhaengigkeiten: PushAbhaengigkeiten,
  benutzerId: string,
  jetzt: Date,
  melden: boolean,
  module: readonly AktivesModul[] | undefined,
): Promise<boolean> {
  const { pool } = abhaengigkeiten;
  const zugang = await kontoZugang(pool, benutzerId);
  if (!hatRecht(zugang, 'chat_nutzen')) {
    return false;
  }
  const teile = await posteingangTeileLesen(pool, zugang, jetzt, abhaengigkeiten.log, module);
  if (teile === undefined) {
    return false;
  }
  const auswertung = pushAuswerten(teile, await standLesen(pool, benutzerId));
  const push = melden ? auswertung.push : undefined;
  await standSchreiben(pool, benutzerId, auswertung.stand, push === undefined ? undefined : jetzt);
  if (push === undefined) {
    return false;
  }
  const rumpf = posteingangPushRumpf(push.text, auswertung.gesamt);
  return (await anAbosZustellen(abhaengigkeiten, benutzerId, rumpf, 'normal')) > 0;
}

/** Ein Lauf des Takts über alle Konten mit aktivem Abo. Wirft nie; ein Konto für sich. Liefert die Zahl der Pushes. */
export async function posteingangPushLauf(abhaengigkeiten: PushAbhaengigkeiten, jetzt: Date): Promise<number> {
  const { pool, log } = abhaengigkeiten;
  const konten = await pool.query<{ benutzer_id: string }>(
    `SELECT DISTINCT a.benutzer_id
       FROM cockpit.push_abo a JOIN cockpit."user" u ON u.id = a.benutzer_id
      WHERE a.abgemeldet_am IS NULL AND u.geloescht_am IS NULL`,
  );
  if (konten.rows.length === 0) {
    return 0;
  }
  const module = await aktiveModule(pool);
  let gesendet = 0;
  for (const { benutzer_id: benutzerId } of konten.rows) {
    try {
      if (await kontoPruefen(abhaengigkeiten, benutzerId, jetzt, true, module)) {
        gesendet++;
      }
    } catch (fehler) {
      log.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Posteingang-Push: Konto übersprungen');
    }
  }
  return gesendet;
}

/** Nach einem Sofort-Push: den Stand festhalten, ohne zu melden (siehe Kopf). Wirft nie. */
export async function posteingangStandFesthalten(abhaengigkeiten: PushAbhaengigkeiten, benutzerId: string, jetzt: Date): Promise<void> {
  try {
    await kontoPruefen(abhaengigkeiten, benutzerId, jetzt, false, undefined);
  } catch (fehler) {
    abhaengigkeiten.log.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Posteingang-Push: Stand nicht festgehalten');
  }
}

/**
 * Startet den Takt (nur mit VAPID, `server/app.ts`). Ein Lauf, der länger dauert als der Takt, lässt den nächsten aus,
 * statt sich zu überlappen. Der Zeitgeber hält den Prozess nicht am Leben. Liefert die Funktion zum Anhalten.
 */
export function posteingangPushStarten(abhaengigkeiten: PushAbhaengigkeiten, jetzt: () => Date, taktMs = POSTEINGANG_PUSH_TAKT_MS): () => void {
  let laeuft = false;
  const zeitgeber = setInterval(() => {
    if (laeuft) {
      return;
    }
    laeuft = true;
    posteingangPushLauf(abhaengigkeiten, jetzt())
      .catch((fehler: unknown) => {
        abhaengigkeiten.log.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Posteingang-Push: Lauf gescheitert');
      })
      .finally(() => {
        laeuft = false;
      });
  }, taktMs);
  zeitgeber.unref();
  return () => {
    clearInterval(zeitgeber);
  };
}
