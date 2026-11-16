/**
 * Die Detailseite eines Agenten (COPI-113, freigegebener Entwurf) — reine Funktionen, der Zeitpunkt ist ein Parameter.
 *
 * **Fünf Bereiche:** Steckbrief, Chats, Mails, Protokoll, Verbrauch. Was ein Bereich zeigt, hängt an denselben Rechten
 * wie die übrigen Seiten:
 *
 *   * **Kennung und Version** nur mit `technik_sehen` (wie die Seite Agenten, COPI-38).
 *   * **Gespräche zwischen Agenten** nur mit `technik_sehen`: sie sind Rohtext, nicht vom Koordinator übersetzt (ADR 10).
 *     Jeder sieht dort nur den eigenen Assistenten-Kanal und den Team-Kanal, wenn der Agent darin geschrieben hat.
 *   * **Verbrauch** nur mit `technik_sehen`, wie das Modul KI-Verbrauch (nur Betreuer).
 *   * **Mails** aus den Modulen mit `agent: <kennung>`, die das Konto ohnehin sehen darf (`modulZugriffErlaubt`).
 *   * **Protokoll** ohne Container-Logs (ADR: kein Docker-Socket, kein SSH): Mails, Übernahmen, Nachrichten zwischen
 *     Agenten (nur mit `technik_sehen`), Befunde seiner Wachen — in der Sicht der Seite Meldungen — und die Ereignisse,
 *     die der Agent selbst meldet (COPI-114; Kundensicht nur kundensichtbare im Klartext, ohne Titel des Agenten).
 */
import { createHash } from 'node:crypto';
import { anzahlText, diagrammAus, euroText, type Diagramm } from '../module/kennzahlen-ansicht.js';
import { berlinerTag } from '../chat/tageslimit.js';
import { zeitText } from '../chat/ansicht.js';
import type { BefundStatus } from '../status/zustand.js';
import { vorKurz } from '../status/zustand.js';
import type { AgentUebernahme, AgentenNachricht, VerbrauchTagModell } from './detail-speicher.js';
import type { AgentEreignis, EreignisStufe } from './ereignis-speicher.js';

export const BEREICHE = ['steckbrief', 'chats', 'mails', 'protokoll', 'verbrauch'] as const;
export type Bereich = (typeof BEREICHE)[number];

const BEREICH_TEXT: Readonly<Record<Bereich, string>> = {
  steckbrief: 'Steckbrief',
  chats: 'Chats',
  mails: 'Mails',
  protokoll: 'Protokoll',
  verbrauch: 'Verbrauch',
};

/** Ein unbekannter oder nicht erlaubter Bereich ist der Steckbrief — nie eine Fehlerseite. */
export function bereichAus(wert: unknown, technik: boolean): Bereich {
  const bereich = (BEREICHE as readonly unknown[]).includes(wert) ? (wert as Bereich) : 'steckbrief';
  return bereich === 'verbrauch' && !technik ? 'steckbrief' : bereich;
}

/**
 * Der Schlüssel eines Agenten in der Adresse: die ersten 16 Hex-Zeichen von SHA-256 der Kennung. Die Kundensicht zeigt
 * die Kennung an keiner Stelle (COPI-38) — auch nicht in einem Link. Stabil, solange die Kennung bleibt; kein Geheimnis.
 */
export function agentSchluessel(kennung: string): string {
  return createHash('sha256').update(kennung).digest('hex').slice(0, 16);
}

/** Ein Schlüssel aus der Adresse hat genau diese Form. */
export const AGENT_SCHLUESSEL = /^[0-9a-f]{16}$/;

export function agentPfad(kennung: string, bereich: Bereich = 'steckbrief'): string {
  const basis = `/agenten/${agentSchluessel(kennung)}`;
  return bereich === 'steckbrief' ? basis : `${basis}?bereich=${bereich}`;
}

export interface BereichReiter {
  readonly text: string;
  readonly href: string;
  readonly aktuell: boolean;
  readonly zahl: number | undefined;
}

/** Die Reiter dieser Sicht; „Verbrauch" nur mit `technik_sehen`. */
export function reiter(kennung: string, aktuell: Bereich, technik: boolean, zahlen: Partial<Record<Bereich, number>>): BereichReiter[] {
  return BEREICHE.filter((bereich) => bereich !== 'verbrauch' || technik).map((bereich) => {
    const zahl = zahlen[bereich];
    return { text: BEREICH_TEXT[bereich], href: agentPfad(kennung, bereich), aktuell: bereich === aktuell, zahl: zahl !== undefined && zahl > 0 ? zahl : undefined };
  });
}

/** Der Anfangsbuchstabe für das Symbol des Agenten: aus der Rolle, sonst aus der Kennung. */
export function initiale(rolle: string, kennung: string): string {
  return (Array.from(rolle.trim())[0] ?? Array.from(kennung)[0] ?? '?').toLocaleUpperCase('de-DE');
}

// ---------- Verbrauch ----------

export interface VerbrauchModell {
  readonly modell: string;
  readonly eur: string;
  readonly anteil: number;
}

export interface VerbrauchAnsicht {
  readonly monat: string;
  readonly monatName: string;
  readonly einsaetze: string;
  readonly mitSubagent: number;
  readonly tokens: string;
  readonly cacheAnteil: number;
  readonly ohnePreis: boolean;
  /** Kosten je Tag der letzten 30 Tage — dasselbe Diagramm wie die Kennzahlen-Seite (COPI-98), Inline-SVG ohne `style`. */
  readonly diagramm: Diagramm;
  readonly modelle: readonly VerbrauchModell[];
  readonly leer: boolean;
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** Der erste Tag, den die Seite für den Verbrauch braucht: der frühere von Monatsanfang und vor 29 Tagen. */
export function verbrauchAb(jetzt: Date): string {
  const heute = berlinerTag(jetzt);
  const monatsanfang = `${heute.slice(0, 8)}01`;
  const vor29 = berlinerTag(new Date(jetzt.getTime() - 29 * 86_400_000));
  return vor29 < monatsanfang ? vor29 : monatsanfang;
}

/** Die letzten 30 Tage (Berlin), ältester zuerst. */
function letzteTage(jetzt: Date): string[] {
  return Array.from({ length: 30 }, (_, i) => berlinerTag(new Date(jetzt.getTime() - (29 - i) * 86_400_000)));
}

export function verbrauchAnsicht(zeilen: readonly VerbrauchTagModell[], jetzt: Date): VerbrauchAnsicht {
  const heute = berlinerTag(jetzt);
  const monat = zeilen.filter((zeile) => zeile.tag.slice(0, 7) === heute.slice(0, 7));
  const summe = (liste: readonly VerbrauchTagModell[]): number => liste.reduce((s, zeile) => s + (zeile.eur ?? 0), 0);
  const tokens = monat.reduce((s, zeile) => s + zeile.tokens, 0);
  const cache = monat.reduce((s, zeile) => s + zeile.tokensCacheLesen, 0);
  const tage = letzteTage(jetzt);
  const jeTag = tage.map((tag) => ({ tag, summen: { eur: summe(zeilen.filter((zeile) => zeile.tag === tag)) } }));
  const monatEur = summe(monat);
  const jeModell = new Map<string, number>();
  for (const zeile of monat) {
    jeModell.set(zeile.modell, (jeModell.get(zeile.modell) ?? 0) + (zeile.eur ?? 0));
  }
  return {
    monat: euroText(monatEur),
    monatName: MONATE[Number(heute.slice(5, 7)) - 1] ?? '',
    einsaetze: anzahlText(monat.reduce((s, zeile) => s + zeile.einsaetze, 0)),
    mitSubagent: monat.reduce((s, zeile) => s + zeile.mitSubagent, 0),
    tokens: anzahlText(tokens),
    cacheAnteil: tokens > 0 ? Math.round((cache / tokens) * 100) : 0,
    ohnePreis: monat.some((zeile) => zeile.eur === undefined),
    diagramm: diagrammAus(jeTag, { von: tage[0] ?? heute, bis: heute }, { name: 'eur', label: 'Kosten', format: 'euro' }),
    modelle: [...jeModell.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([modell, eur]) => ({ modell, eur: euroText(eur), anteil: monatEur > 0 ? Math.round((eur / monatEur) * 100) : 0 })),
    leer: zeilen.length === 0,
  };
}

// ---------- Protokoll ----------

export const PROTOKOLL_ARTEN = ['mail', 'uebernahme', 'agent', 'befund', 'ereignis'] as const;
export type ProtokollArt = (typeof PROTOKOLL_ARTEN)[number];

const ART_TEXT: Readonly<Record<ProtokollArt, string>> = { mail: 'Mails', uebernahme: 'Übernahmen', agent: 'Agent ↔ Agent', befund: 'Befunde', ereignis: 'Ereignisse' };

export function protokollArtAus(wert: unknown): ProtokollArt | undefined {
  return (PROTOKOLL_ARTEN as readonly unknown[]).includes(wert) ? (wert as ProtokollArt) : undefined;
}

/** Ein Ereignis, wie die Quellen es liefern. */
export interface ProtokollEreignis {
  readonly art: ProtokollArt;
  readonly titel: string;
  readonly text: string;
  readonly am: Date;
  /** `rot`/`gelb`/`gruen` bei Befunden, sonst die Art. */
  readonly ton: 'akzent' | 'warnung' | BefundStatus;
  readonly typ: string;
  readonly href?: string;
  /** Nur bei gemeldeten Ereignissen (COPI-114). */
  readonly stufe?: EreignisStufe;
}

export interface ProtokollZeile {
  readonly art: ProtokollArt;
  readonly symbol: 'mail' | 'schloss' | 'pfeile' | 'warnung' | 'ok' | 'blitz';
  readonly ton: string;
  readonly titel: string;
  readonly text: string;
  readonly zeit: string;
  readonly typ: string;
  readonly href: string | undefined;
}

const SYMBOL: Readonly<Record<ProtokollArt, ProtokollZeile['symbol']>> = { mail: 'mail', uebernahme: 'schloss', agent: 'pfeile', befund: 'warnung', ereignis: 'blitz' };

/** Die Ereignisse, neueste zuerst; mit `art` nur diese, mit `stufe` (nur bei „ereignis") nur diese Stufe. */
export function protokollAnsicht(ereignisse: readonly ProtokollEreignis[], jetzt: Date, art?: ProtokollArt, hoechstens = 50, stufe?: EreignisStufe): ProtokollZeile[] {
  return ereignisse
    .filter((ereignis) => art === undefined || ereignis.art === art)
    .filter((ereignis) => stufe === undefined || art !== 'ereignis' || ereignis.stufe === stufe)
    .sort((a, b) => b.am.getTime() - a.am.getTime())
    .slice(0, hoechstens)
    .map((ereignis) => ({
      art: ereignis.art,
      symbol: ereignis.art === 'befund' && ereignis.ton === 'gruen' ? 'ok' : SYMBOL[ereignis.art],
      ton: ereignis.ton,
      titel: ereignis.titel,
      text: ereignis.text,
      zeit: zeitText(ereignis.am, jetzt),
      typ: ereignis.typ,
      href: ereignis.href,
    }));
}

export interface ProtokollChip {
  readonly text: string;
  readonly href: string;
  readonly aktuell: boolean;
}

/** Die Filter des Protokolls (Links, ohne Skript); „Agent ↔ Agent" nur, wo es solche Einträge geben darf. */
export function protokollChips(kennung: string, aktuell: ProtokollArt | undefined, technik: boolean): ProtokollChip[] {
  const basis = agentPfad(kennung, 'protokoll');
  return [
    { text: 'Alle', href: basis, aktuell: aktuell === undefined },
    ...PROTOKOLL_ARTEN.filter((art) => art !== 'agent' || technik).map((art) => ({ text: ART_TEXT[art], href: `${basis}&art=${art}`, aktuell: art === aktuell })),
  ];
}

const STUFE_TEXT: Readonly<Record<EreignisStufe, string>> = { fehler: 'Fehler', warnung: 'Warnung', info: 'Info' };

/** Ein gemeldetes Ereignis (COPI-114) im Protokoll: Farbe nach Stufe, ohne Titel des Agenten ein neutraler je Stufe. */
export function agentEreignisZeile(ereignis: AgentEreignis): ProtokollEreignis {
  return {
    art: 'ereignis',
    titel: ereignis.titel ?? (ereignis.stufe === 'fehler' ? 'Fehler gemeldet' : ereignis.stufe === 'warnung' ? 'Warnung gemeldet' : 'Ereignis gemeldet'),
    text: ereignis.text,
    am: ereignis.zeitpunkt,
    ton: ereignis.stufe === 'fehler' ? 'rot' : ereignis.stufe === 'warnung' ? 'gelb' : 'akzent',
    typ: `Ereignis · ${STUFE_TEXT[ereignis.stufe]}`,
    stufe: ereignis.stufe,
  };
}

/** Die Stufe aus `?stufe=` (nur zusammen mit dem Filter „Ereignisse"). */
export function stufeAus(wert: unknown): EreignisStufe | undefined {
  return wert === 'fehler' || wert === 'warnung' || wert === 'info' ? wert : undefined;
}

/** Die Stufen-Chips unter „Ereignisse". */
export function stufenChips(kennung: string, aktuell: EreignisStufe | undefined): ProtokollChip[] {
  const basis = `${agentPfad(kennung, 'protokoll')}&art=ereignis`;
  return [
    { text: 'alle Stufen', href: basis, aktuell: aktuell === undefined },
    { text: 'nur Fehler', href: `${basis}&stufe=fehler`, aktuell: aktuell === 'fehler' },
    { text: 'Warnungen', href: `${basis}&stufe=warnung`, aktuell: aktuell === 'warnung' },
  ];
}

/** Eine Übernahme als Ereignis(se): übernommen und, wenn schon, zurückgegeben. */
export function uebernahmeEreignisse(uebernahme: AgentUebernahme, modulName: string, titel: string | undefined, href: string): ProtokollEreignis[] {
  const vorgang = titel ?? uebernahme.vorgangId;
  const ereignisse: ProtokollEreignis[] = [
    { art: 'uebernahme', titel: 'Vorgang übernommen', text: `${uebernahme.von} hat „${vorgang}" übernommen. Der Agent antwortet dort nicht mehr.`, am: uebernahme.am, ton: 'warnung', typ: modulName, href },
  ];
  if (uebernahme.zurueckAm !== undefined) {
    ereignisse.push({ art: 'uebernahme', titel: 'Vorgang zurückgegeben', text: `„${vorgang}" ist wieder beim Agenten.`, am: uebernahme.zurueckAm, ton: 'akzent', typ: modulName, href });
  }
  return ereignisse;
}

/** Eine Nachricht zwischen Agenten als Ereignis, aus Sicht dieses Agenten. */
export function agentenEreignis(nachricht: AgentenNachricht, kennung: string, href: string): ProtokollEreignis {
  const gesendet = nachricht.von === kennung;
  return {
    art: 'agent',
    titel: gesendet ? `Nachricht an ${nachricht.an}` : `Nachricht von ${nachricht.von}`,
    text: nachricht.inhalt ?? 'Nachricht gelöscht',
    am: nachricht.am,
    ton: 'akzent',
    typ: 'Agent ↔ Agent',
    href,
  };
}

/** „aktiv · zuletzt vor 4 Min." bzw. „entfernt seit …" für den Kopf. */
export function standText(aktualisiertAm: Date, entferntAm: Date | undefined, jetzt: Date): { readonly text: string; readonly aktiv: boolean } {
  if (entferntAm !== undefined) {
    return { text: `Nicht mehr gemeldet seit ${zeitText(entferntAm, jetzt)}`, aktiv: false };
  }
  return { text: `Im Inventar · gemeldet ${vorKurz(Math.max(0, Math.floor((jetzt.getTime() - aktualisiertAm.getTime()) / 1000)))}`, aktiv: true };
}
