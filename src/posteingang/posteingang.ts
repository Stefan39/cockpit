/**
 * Der Posteingang im Kopf der Seiten (COPI-112) — reine Funktionen, der Zeitpunkt ist ein Parameter.
 *
 * **Vier Quellen, eine Liste** (die vierte, „Freigabe nötig", seit COPI-90: ein Antwortentwurf wartet auf eine Freigabe —
 * eine Aufgabe, die so lange zählt, bis sie erledigt ist, nicht bis sie gelesen ist).
 *
 * **Die ersten drei:** ungelesene Chat-Nachrichten (Lesestand des Chats, COPI-53), ungelesene Zeilen der
 * Module mit `posteingang:` (etwa die Mails des Moduls Kommunikation, „Postfächer") und Meldungen, die seit dem letzten
 * Besuch der Seite Meldungen auf Gelb oder Rot gewechselt sind. Die Liste zeigt die jüngsten Einträge aller Quellen
 * zusammen, die Zahlen zählen je Quelle alles Ungelesene.
 *
 * **Fremdtexte bleiben Text:** Anriss und Titel kommen aus Chat, Fach-View oder Befund. Sie werden hier nur gekürzt;
 * die Vorlage escaped sie und verlinkt nie etwas darin (JAC-577).
 */
import { zeitText } from '../chat/ansicht.js';
import type { Statuswoerter } from '../module/block.js';
import { modulStatusAnsicht, type ModulStatusAnsicht } from '../module/ansicht.js';
import { vorKurz } from '../status/zustand.js';
import type { PostfachZeile } from './posteingang-speicher.js';

export const POSTEINGANG_QUELLEN = ['freigabe', 'chat', 'postfach', 'meldung'] as const;
export type PosteingangQuelle = (typeof POSTEINGANG_QUELLEN)[number];

/** So viele Einträge zeigt die Liste höchstens; gezählt wird trotzdem alles. */
export const POSTEINGANG_HOECHSTENS = 20;

/** So viele Zeichen hat ein Anriss höchstens (zwei Zeilen im Panel). */
export const ANRISS_ZEICHEN = 140;

/** Ein ungelesener Eintrag, wie die Quellen ihn liefern. */
export interface PosteingangEintrag {
  readonly quelle: PosteingangQuelle;
  /** „Chat · Assistent", „Kommunikation", „Meldung · Rot". */
  readonly herkunft: string;
  readonly titel: string;
  readonly anriss: string;
  readonly zeit: Date;
  readonly href: string;
  /** Nur bei Meldungen: rot statt gelb (das Symbol zeigt es zusätzlich zum Wort). */
  readonly rot?: boolean;
  /** Nur bei Postfächern und Freigaben: das Modul (COPI-122, „Zu tun" trennt angeheftete Module heraus). */
  readonly kennung?: string;
}

/** Was eine Quelle beiträgt: ihre jüngsten Einträge und wie viele es insgesamt sind. */
export interface PosteingangTeil {
  readonly eintraege: readonly PosteingangEintrag[];
  readonly anzahl: number;
  /** Nur bei den Postfächern: die Anzahl je Modul-Kennung (für die Liste „Verlauf" der Chat-Seite). */
  readonly je?: Readonly<Record<string, number>>;
}

/** Ein Eintrag, wie das Panel ihn zeigt. */
export interface PosteingangEintragAnsicht {
  readonly quelle: PosteingangQuelle;
  readonly herkunft: string;
  readonly titel: string;
  readonly anriss: string;
  readonly zeit: string;
  readonly href: string;
  readonly rot: boolean;
  readonly kennung?: string;
}

/** Der Posteingang eines Kontos, fertig für Navigation und Panel. */
export interface PosteingangAnsicht {
  readonly gesamt: number;
  readonly zahlen: Readonly<Record<PosteingangQuelle, number>>;
  readonly eintraege: readonly PosteingangEintragAnsicht[];
  /** Ungelesenes je Postfach (Modul-Kennung). */
  readonly postfaecher: Readonly<Record<string, number>>;
}

export const POSTEINGANG_LEER: PosteingangAnsicht = { gesamt: 0, zahlen: { freigabe: 0, chat: 0, postfach: 0, meldung: 0 }, eintraege: [], postfaecher: {} };

/** Eine Zeile, Leerraum zusammengezogen, höchstens `zeichen` Zeichen (mit „…", wenn gekürzt). */
export function anrissKuerzen(text: string, zeichen = ANRISS_ZEICHEN): string {
  const zeile = text.replace(/\s+/g, ' ').trim();
  const teile = Array.from(zeile);
  return teile.length > zeichen ? `${teile.slice(0, zeichen - 1).join('').trimEnd()}…` : zeile;
}

/** Führt die Quellen zusammen: die jüngsten Einträge zuerst, höchstens `POSTEINGANG_HOECHSTENS`. */
export function posteingangAnsicht(teile: Partial<Record<PosteingangQuelle, PosteingangTeil>>, jetzt: Date): PosteingangAnsicht {
  const zahlen = {
    freigabe: teile.freigabe?.anzahl ?? 0,
    chat: teile.chat?.anzahl ?? 0,
    postfach: teile.postfach?.anzahl ?? 0,
    meldung: teile.meldung?.anzahl ?? 0,
  };
  // Offene Freigaben zuerst (eine Aufgabe wartet auf jemanden), danach alles nach Zeit.
  const eintraege = POSTEINGANG_QUELLEN.flatMap((quelle) => teile[quelle]?.eintraege ?? [])
    .sort((a, b) => Number(b.quelle === 'freigabe') - Number(a.quelle === 'freigabe') || b.zeit.getTime() - a.zeit.getTime())
    .slice(0, POSTEINGANG_HOECHSTENS)
    .map((eintrag) => ({
      quelle: eintrag.quelle,
      herkunft: eintrag.herkunft,
      titel: anrissKuerzen(eintrag.titel, 80),
      anriss: anrissKuerzen(eintrag.anriss),
      zeit: vorKurz(Math.max(0, Math.floor((jetzt.getTime() - eintrag.zeit.getTime()) / 1000))),
      href: eintrag.href,
      rot: eintrag.rot === true,
      ...(eintrag.kennung === undefined ? {} : { kennung: eintrag.kennung }),
    }));
  return { gesamt: zahlen.freigabe + zahlen.chat + zahlen.postfach + zahlen.meldung, zahlen, eintraege, postfaecher: teile.postfach?.je ?? {} };
}

/** „99+" ab hundert — wie die Zahl am Chat (COPI-53). */
export function zahlText(anzahl: number): string {
  return anzahl > 99 ? '99+' : String(anzahl);
}

/** Die Quelle `modul:<kennung>` im Lesestand (Migration 0036). */
export function modulQuelle(kennung: string): string {
  return `modul:${kennung}`;
}

/** Die Quelle der Meldungen im Lesestand (Migration 0036). */
export const QUELLE_MELDUNGEN = 'meldungen';

/** Die Postfach-Seite eines Moduls im Bereich Nachrichten. */
export function postfachPfad(kennung: string): string {
  return `/chat/postfach/${encodeURIComponent(kennung)}`;
}

/** Der Wert von `?von=`, mit dem eine Detailseite zurück ins Postfach führt (statt in die Modul-Liste). */
export const VON_NACHRICHTEN = 'nachrichten';

/** Die Detailseite einer Zeile, aufgerufen aus Posteingang oder Postfach. */
export function postfachDetailPfad(kennung: string, id: string): string {
  return `/module/${encodeURIComponent(kennung)}/${encodeURIComponent(id)}?von=${VON_NACHRICHTEN}`;
}

/**
 * Wohin ein Eintrag des Posteingangs führt: ins Postfach unter „Nachrichten", bei einem angehefteten Modul (COPI-121) auf
 * seine eigene Detailseite — es steht ja als eigener Eintrag in der Navigation, nicht unter „Nachrichten".
 */
export function posteingangZielPfad(kennung: string, id: string, angeheftet: boolean): string {
  return angeheftet ? `/module/${encodeURIComponent(kennung)}/${encodeURIComponent(id)}` : postfachDetailPfad(kennung, id);
}

/** Eine Zeile der Postfach-Seite. */
export interface PostfachZeileAnsicht {
  readonly id: string;
  readonly href: string;
  readonly titel: string;
  readonly anriss: string;
  readonly zeit: string;
  readonly status: ModulStatusAnsicht;
  readonly ungelesen: boolean;
}

/** Die Zeilen eines Postfachs, wie seine Seite sie zeigt (COPI-112). */
export function postfachAnsicht(kennung: string, zeilen: readonly PostfachZeile[], jetzt: Date, statuswoerter?: Statuswoerter): PostfachZeileAnsicht[] {
  return zeilen.map((zeile) => ({
    id: zeile.id,
    href: postfachDetailPfad(kennung, zeile.id),
    titel: zeile.titel.length > 0 ? zeile.titel : '—',
    anriss: anrissKuerzen(zeile.anriss),
    zeit: zeile.zeit === undefined ? '—' : zeitText(zeile.zeit, jetzt),
    status: modulStatusAnsicht(zeile.status, statuswoerter),
    ungelesen: zeile.ungelesen,
  }));
}
