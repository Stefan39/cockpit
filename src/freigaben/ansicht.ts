/**
 * Die Ansicht der Freigabe-Inbox (COPI-139): aus den Einträgen der Repo-Wache werden Zeilen und die Detailseite.
 *
 * **Kanalneutral:** Was zur Quelle gehört (Titel der Zeile, Beschriftung des Links), liefert ein Adapter je Quelltyp
 * (`QUELLEN`). `github` ist der erste; Social, Blog und Mail kommen als weitere Einträge der Tabelle, ohne dass Liste,
 * Detail oder Templates sich ändern.
 *
 * **Fremde Texte** (Titel, Original, Entwürfe) bleiben Text. Die Templates escapen sie, nichts wird verlinkt. Die
 * Quelladresse ist ein Link nur als Text und, wenn sie `http(s)` ist, zusätzlich ein ausdrücklich zu öffnender Link.
 */
import { vorKurz } from '../status/zustand.js';
import type { Eintrag, RepoKennzahl } from './repowache.js';

/** Was ein Quelltyp beisteuert. */
export interface QuellenAdapter {
  /** Der Name des Typs in der Oberfläche, etwa „GitHub". */
  readonly name: string;
  /** Die Quelle als Kurztext: bei GitHub `repo#42`. */
  readonly bezeichnung: (eintrag: Eintrag) => string;
}

function githubBezeichnung(eintrag: Eintrag): string {
  const repo = eintrag.repo ?? 'unbekanntes Repo';
  return eintrag.nummer === undefined ? repo : `${repo}#${String(eintrag.nummer)}`;
}

/** Die Adapter nach Quelltyp. */
export const QUELLEN: Readonly<Record<string, QuellenAdapter>> = {
  github: { name: 'GitHub', bezeichnung: githubBezeichnung },
};

const UNBEKANNT: QuellenAdapter = { name: 'Quelle', bezeichnung: (eintrag) => eintrag.titel ?? eintrag.id };

/** Der Agent, der die Einträge liefert; bis weitere folgen (weitere Agenten) der einzige. */
export const AGENT_REPOWACHE = 'Repo-Wache';

const STATUS_WORT = { offen: 'offen', info: 'Info' } as const;

/** Nur `http(s)`-Adressen werden zum Link; alles andere (etwa `javascript:`) bleibt Text. */
export function sichereAdresse(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    const adresse = new URL(url);
    return adresse.protocol === 'https:' || adresse.protocol === 'http:' ? adresse.href : undefined;
  } catch {
    return undefined;
  }
}

export interface Zeile {
  readonly id: string;
  readonly href: string;
  readonly quelleTyp: string;
  readonly quelle: string;
  readonly titel: string | undefined;
  readonly einordnung: string;
  readonly alter: string;
  readonly agent: string;
  readonly status: string;
  readonly offen: boolean;
  /** Die Adresse der Quelle als Text, so wie sie geliefert wurde. */
  readonly adresseText: string | undefined;
  /** Dieselbe Adresse als Link, nur wenn sie `http(s)` ist. */
  readonly adresseLink: string | undefined;
}

export interface Detail extends Zeile {
  /** Deutsch zuerst: die Übersetzung, ohne sie der Originaltext. */
  readonly deutsch: string;
  readonly deutschIstOriginal: boolean;
  readonly original: string;
  readonly entwurf: string | undefined;
  readonly entwurfDe: string | undefined;
}

export const detailPfad = (id: string): string => `/freigaben/${encodeURIComponent(id)}`;

export function zeileBauen(eintrag: Eintrag, jetzt: Date): Zeile {
  const adapter = QUELLEN[eintrag.quelle] ?? UNBEKANNT;
  return {
    id: eintrag.id,
    href: detailPfad(eintrag.id),
    quelleTyp: adapter.name,
    quelle: adapter.bezeichnung(eintrag),
    titel: eintrag.titel,
    einordnung: eintrag.einordnung ?? 'ohne Einordnung',
    alter: eintrag.ereignisAm === undefined ? 'Alter unbekannt' : vorKurz(Math.max(0, Math.floor((jetzt.getTime() - eintrag.ereignisAm.getTime()) / 1000))),
    agent: AGENT_REPOWACHE,
    status: STATUS_WORT[eintrag.status],
    offen: eintrag.status === 'offen',
    adresseText: eintrag.url,
    adresseLink: sichereAdresse(eintrag.url),
  };
}

export function detailBauen(eintrag: Eintrag, jetzt: Date): Detail {
  const deutsch = eintrag.uebersetzungDe;
  return {
    ...zeileBauen(eintrag, jetzt),
    deutsch: deutsch ?? eintrag.originalText,
    deutschIstOriginal: deutsch === undefined,
    original: eintrag.originalText,
    entwurf: eintrag.entwurf,
    entwurfDe: eintrag.entwurfDe,
  };
}

/** Die Zahl für die Navigation: Einträge mit Status `offen` (`info` zählt nicht). */
export function offeneZaehlen(eintraege: readonly Eintrag[]): number {
  return eintraege.filter((eintrag) => eintrag.status === 'offen').length;
}

const NOCH_NICHT = '–';

const ZAHL = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const STUNDEN = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Ganze Zahl nach deutscher Schreibweise (Tausenderpunkt); ohne Wert ein Strich. */
export const zahlText = (wert: number | undefined): string => (wert === undefined ? NOCH_NICHT : ZAHL.format(wert));

/** Stunden mit einer Nachkommastelle und Komma; ohne Wert ein Strich. */
export const stundenText = (wert: number | undefined): string => (wert === undefined ? NOCH_NICHT : STUNDEN.format(wert));

export interface KennzahlZeile {
  readonly repo: string;
  readonly beitraege: string;
  readonly beantwortet: string;
  readonly unbeantwortet: string;
  readonly median: string;
  readonly maximum: string;
  readonly stars: string;
  readonly forks: string;
  readonly stand: string;
}

export function kennzahlZeileBauen(kennzahl: RepoKennzahl): KennzahlZeile {
  return {
    repo: kennzahl.repo,
    beitraege: zahlText(kennzahl.beitraege),
    beantwortet: zahlText(kennzahl.beantwortet),
    unbeantwortet: zahlText(kennzahl.unbeantwortet),
    median: stundenText(kennzahl.medianStunden),
    maximum: stundenText(kennzahl.maxStunden),
    stars: zahlText(kennzahl.stars),
    forks: zahlText(kennzahl.forks),
    stand: kennzahl.stand === undefined ? NOCH_NICHT : kennzahl.stand.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' }),
  };
}
