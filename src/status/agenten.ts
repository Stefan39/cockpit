/**
 * Die Seiten „Agenten" und „Zeitplan" aus dem Inventar (COPI-38) — reine Funktionen, der Zeitpunkt ist ein
 * Parameter.
 *
 * **Sichtbarkeit je Rolle.** Jedes angemeldete Konto sieht Rolle, Grenzen und Zeitplan der Agenten; **Kennung
 * und Version sieht nur der Betreuer**. Wie bei der Übersicht (COPI-37) liegt der Unterschied in der Form
 * der Daten und nicht in einer Bedingung: die Karte der Kundensicht hat kein Feld für Kennung und Version,
 * sie kann sie also nicht zeigen, auch nicht durch einen Fehler in der Vorlage.
 *
 * Das Inventar kennt keine Sichtbarkeit je Agent (anders als ein Befund mit `kundensichtbar`). Deshalb gilt
 * für das, was der Admin-Agent meldet: `rolle`, `grenzen` und `zeitplan` sind **Klartext für den Kunden**
 * (Vertrag in der README, „Inventar melden"). Das Cockpit übersetzt nichts.
 *
 * Nichts wird berechnet: der Zeitplan ist Freitext des Agenten (kein Cron, kein „nächster Lauf"), denn das
 * Cockpit prüft und plant nichts selbst (ADR 4).
 */
import type { AgentZeile, GrenzWert, ZeitplanEintrag } from './agenten-speicher.js';
import { vorText } from './zustand.js';
import { agentPfad } from '../agenten/detail.js';

export type AgentenSicht = 'kunde' | 'betreuer';

/** Eine Zeile „Grenze": was der Agent darf, in Betriebssprache. */
export interface GrenzZeile {
  readonly name: string;
  readonly wert: string;
}

/** Eine Agentenkarte der Kundensicht: genau diese Felder, keins für Kennung oder Version. */
export interface KundenAgentKarte {
  readonly rolle: string;
  readonly grenzen: readonly GrenzZeile[];
  /** Die Detailseite (COPI-113), über den Schlüssel des Agenten — nie über die Kennung. */
  readonly href: string;
}

/** Eine Agentenkarte der Betreuersicht: dazu Kennung und Version. */
export interface BetreuerAgentKarte extends KundenAgentKarte {
  readonly kennung: string;
  readonly version: string;
}

export interface AgentenAnsicht<K> {
  /** „gemeldet vor 5 Minuten"; `undefined`, solange es kein Inventar gibt: dann behauptet die Seite nichts. */
  readonly stand: string | undefined;
  readonly karten: readonly K[];
}

/** Die Takte eines Agenten, unter seiner Rolle. */
export interface ZeitplanGruppe {
  readonly agent: string;
  readonly takte: readonly ZeitplanEintrag[];
}

export interface ZeitplanAnsicht {
  readonly stand: string | undefined;
  /** Nur Agenten mit mindestens einem Takt. */
  readonly gruppen: readonly ZeitplanGruppe[];
}

/** Deutsche Schreibweise: Ja/Nein für einen Schalter, Zahlen mit Tausenderpunkt und Komma, Text unverändert. */
function grenzWert(wert: GrenzWert): string {
  if (typeof wert === 'boolean') {
    return wert ? 'Ja' : 'Nein';
  }
  if (typeof wert === 'number') {
    return wert.toLocaleString('de-DE', { maximumFractionDigits: 20 });
  }
  return wert;
}

function grenzen(werte: Readonly<Record<string, GrenzWert>>): GrenzZeile[] {
  return Object.entries(werte)
    .map(([name, wert]) => ({ name, wert: grenzWert(wert) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Nach Rolle (deutsche Sortierung), zuletzt nach Kennung: die Reihenfolge ist nie zufällig. */
function sortiert(zeilen: readonly AgentZeile[]): AgentZeile[] {
  return [...zeilen].sort(
    (a, b) => a.rolle.localeCompare(b.rolle, 'de') || (a.kennung < b.kennung ? -1 : a.kennung > b.kennung ? 1 : 0),
  );
}

/** Wann das Inventar zuletzt gemeldet wurde: die jüngste Meldung; ohne Inventar keine Angabe. */
function stand(zeilen: readonly AgentZeile[], jetzt: Date): string | undefined {
  if (zeilen.length === 0) {
    return undefined;
  }
  const juengste = Math.max(...zeilen.map((zeile) => zeile.aktualisiertAm.getTime()));
  // Springt die Uhr zurück, liegt die Meldung scheinbar in der Zukunft: Alter null, nie ein negatives.
  const alterSekunden = Math.max(0, Math.floor((jetzt.getTime() - juengste) / 1000));
  return `gemeldet ${vorText(alterSekunden)}`;
}

export function agentenAnsicht(zeilen: readonly AgentZeile[], sicht: 'kunde', jetzt: Date): AgentenAnsicht<KundenAgentKarte>;
export function agentenAnsicht(zeilen: readonly AgentZeile[], sicht: 'betreuer', jetzt: Date): AgentenAnsicht<BetreuerAgentKarte>;
export function agentenAnsicht(
  zeilen: readonly AgentZeile[],
  sicht: AgentenSicht,
  jetzt: Date,
): AgentenAnsicht<KundenAgentKarte | BetreuerAgentKarte>;
export function agentenAnsicht(
  zeilen: readonly AgentZeile[],
  sicht: AgentenSicht,
  jetzt: Date,
): AgentenAnsicht<KundenAgentKarte | BetreuerAgentKarte> {
  const karten = sortiert(zeilen).map((zeile): KundenAgentKarte | BetreuerAgentKarte => {
    const kunde: KundenAgentKarte = { rolle: zeile.rolle, grenzen: grenzen(zeile.grenzen), href: agentPfad(zeile.kennung) };
    return sicht === 'betreuer' ? { ...kunde, kennung: zeile.kennung, version: zeile.version } : kunde;
  });
  return { stand: stand(zeilen, jetzt), karten };
}

export function zeitplanAnsicht(zeilen: readonly AgentZeile[], jetzt: Date): ZeitplanAnsicht {
  const gruppen = sortiert(zeilen)
    .filter((zeile) => zeile.zeitplan.length > 0)
    .map((zeile): ZeitplanGruppe => ({ agent: zeile.rolle, takte: zeile.zeitplan.map(({ name, wann }) => ({ name, wann })) }));
  return { stand: stand(zeilen, jetzt), gruppen };
}
