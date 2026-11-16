/**
 * Der Abschnitt „Versionen" der Einstellungen (COPI-39, ADR 13.1, Prototyp „Einstellungen") — reine Funktionen,
 * der Zeitpunkt ist ein Parameter.
 *
 * **Zwei Sichten mit getrennten Eingaben**, wie die Übersicht (COPI-37):
 *
 *   * **Betreuer** (Recht `technik_sehen`): je Bereich laufende Version und laufender Digest (Selbstmeldung aus
 *     `cockpit.instanz`), Soll-Digest (das Ziel eines offenen Antrags in `cockpit.eingriff`), verfügbare Version
 *     (der Text der Versions-Wache, **unverändert** — das Cockpit wertet ihn nicht aus und fragt GHCR nie selbst)
 *     und der Stand dieser Wache.
 *   * **Betriebs-Admin und Mitarbeiter:** ein Klartextsatz je Bereich. Ihre Eingabe kennt nur den Status des
 *     jüngsten Antrags — ein Digest oder eine Versionsnummer kann in dieser Sicht nicht vorkommen.
 *
 * Ein **Bereich** ist eine Komponente, die sich aktualisieren lässt: heute das Cockpit-Image, mit E5 die Module.
 * Je Bereich meldet eine eigene Wache; die des Cockpits heißt `version-cockpit`.
 *
 * **Der letzte Antrag (COPI-41):** der Betreuer sieht Stand, Ziel, Ziel-Version, den Weg zurück (`digest_vorher`, ADR
 * 13.1: „der Rückweg ist ein Befehl, keine Recherche") und wann jede Stufe erreicht wurde — auch nach `erledigt` und
 * `fehlgeschlagen`, denn dann braucht er ihn. Ein Antrag, der länger als 15 Minuten läuft, **hängt**: das geht jeder
 * anderen Marke vor, die Kundensicht bleibt bei „Update angefragt.".
 *
 * **Das gemeldete Update-Ziel (COPI-140):** meldet die Versions-Wache mit ihrem gelben Befund ein Ziel (`update`, Agenten-
 * API), zeigt die Karte „Update verfügbar: <Version bzw. Kurz-Commit> · <Hinweis> · seit <Datum>" und den Knopf
 * „Update installieren" — nur, wenn sich gerade ein Antrag stellen ließe. Läuft schon einer, zeigt sie dessen Stand.
 * Ein Ziel, das schon läuft (die Wache ist noch nicht wieder gelaufen), gilt nicht als Update.
 *
 * **Nur unter `module/` (COPI-140, Anlass COPI-143):** Ein Modul lässt sich nur per Antrag aktualisieren, wenn seine
 * Herkunft `agent-blueprints@<commit>:module/<kennung>.cockpit.yaml` lautet — nur so kann der Admin-Agent es mit
 * `einspielen` einspielen. Sonst bietet die Karte keinen Antrag an, sondern verweist auf die Server-Konsole.
 *
 * **Freigabemodus (COPI-141):** Ein direkt freigegebener Antrag (`freigabe_modus = direkt`) lässt sich zurückziehen, bis
 * der Agent ihn startet; der letzte Antrag zeigt, wie er freigegeben wurde.
 */
import { datumText } from '../chat/ansicht.js';
import { EINGRIFF_STATUS, haengt, OFFENE_STATUS, type EingriffStatus } from './eingriff.js';
import type { AntragModus } from './freigabe-modus.js';
import type { BefundStatus } from './zustand.js';
import { vorText, wachenZustand } from './zustand.js';

/** Die Wache, deren Befund sagt, ob es ein neueres Cockpit-Image gibt. */
export const VERSIONS_WACHE = 'version-cockpit';

/** Die Kette eines Antrags: die des Eingriffs (`eingriff.ts`). */
export const ANTRAG_STATUS = EINGRIFF_STATUS;

export type AntragStatus = EingriffStatus;

/** Was die Kundensicht wissen darf: nur, wo der jüngste Antrag steht. */
export interface KundenVersionenDaten {
  readonly antragStatus: AntragStatus | undefined;
}

/** Ein Bereich der Kundensicht: genau diese Felder. */
export interface KundenBereich {
  readonly name: string;
  readonly satz: string;
}

export interface KundenVersionen {
  readonly bereiche: readonly KundenBereich[];
}

/** Die Arten eines gemeldeten Update-Ziels (COPI-140): wie die Arten eines Antrags, ohne `-image`. */
export const UPDATE_ARTEN = ['cockpit', 'modul'] as const;

export type UpdateArt = (typeof UPDATE_ARTEN)[number];

/** Das Update-Ziel, das die Versions-Wache mit ihrem jüngsten Befund meldet (COPI-140, Migration 0049). */
export interface UpdateZiel {
  readonly art: UpdateArt;
  /** Beim Cockpit der Digest, beim Modul der volle Commit. */
  readonly ziel: string;
  /** Nur beim Cockpit, etwa `0.24.0`. */
  readonly version: string | undefined;
  readonly hinweis: string | undefined;
  /** Seit wann es das Ziel gibt; `undefined`, wenn der gespeicherte Text kein Zeitpunkt ist. */
  readonly seit: Date | undefined;
}

/** Die Versions-Wache eines Bereichs und ihr jüngster Befund. */
export interface WachenDaten {
  readonly taktSekunden: number;
  readonly letzterLauf: Date | undefined;
  readonly letzter: { readonly status: BefundStatus; readonly text: string; readonly update?: UpdateZiel | undefined } | undefined;
}

/**
 * Was der Planer im Modus `automatisch` mit dem gemeldeten Update täte (COPI-142): `bereit` — er stellt den Antrag (beim
 * Cockpit im nächsten Wartungsfenster); `heute` — heute gab es schon einen automatischen Antrag; `ziel` — für dieses Ziel
 * ist ein Antrag gescheitert oder ein automatischer zurückgezogen worden, die Automatik versucht es nicht mehr.
 */
export type AutomatikStand = 'bereit' | 'heute' | 'ziel';

/** Ein Modul-Antrag, wie ihn die Betreuersicht liest (COPI-106). */
export interface ModulAntragDaten {
  readonly id: number;
  readonly status: AntragStatus;
  readonly zielCommit: string;
  /** Die Herkunft der Version beim Antrag: der Weg zurück. */
  readonly herkunftVorher: string;
  readonly fehlerGrund: string | undefined;
  /** Wie freigegeben wird (COPI-141); ohne Angabe die Rückfrage, wie bei jedem Antrag davor. */
  readonly freigabeModus?: AntragModus | undefined;
  /** Vom Cockpit selbst gestellt (COPI-142). */
  readonly automatisch?: boolean | undefined;
  readonly beantragtAm: Date;
  readonly freigegebenAm: Date | undefined;
  readonly laeuftSeit: Date | undefined;
  readonly abgeschlossenAm: Date | undefined;
}

/** Ein aktives Modul mit seiner Versions-Wache `version-modul-<kennung>` und seinem jüngsten Antrag (COPI-106). */
export interface ModulVersionDaten {
  readonly kennung: string;
  readonly menuename: string;
  readonly version: number;
  readonly aktivSeit: Date;
  /** Frei; nur in der Form `agent-blueprints@<commit>:<pfad>` lässt sich ein Update beantragen. */
  readonly herkunft: string | undefined;
  readonly antrag: ModulAntragDaten | undefined;
  readonly wache: WachenDaten | undefined;
  /** Nur im Modus `automatisch` und mit gemeldetem Update (COPI-142). */
  readonly automatik?: AutomatikStand | undefined;
}

export interface BetreuerVersionenDaten {
  /** Die aktiven Module (COPI-106); ohne Angabe keine. */
  readonly module?: readonly ModulVersionDaten[] | undefined;
  readonly instanz: { readonly version: string; readonly digest: string | undefined; readonly gestartetAm: Date } | undefined;
  /** Der jüngste Antrag für das Cockpit-Image. */
  readonly antrag: AntragDaten | undefined;
  /** Die Versions-Wache und ihr jüngster Befund. */
  readonly wache: WachenDaten | undefined;
  /** Nur im Modus `automatisch` und mit gemeldetem Update (COPI-142). */
  readonly automatik?: AutomatikStand | undefined;
}

/** Ein Antrag, wie ihn die Betreuersicht liest (COPI-41). */
export interface AntragDaten {
  readonly id: number;
  readonly status: AntragStatus;
  readonly zielDigest: string;
  /** Genau ab der Freigabe gesetzt. */
  readonly zielVersion: string | undefined;
  /** Der Weg zurück. */
  readonly digestVorher: string;
  /** Wie freigegeben wird (COPI-141); ohne Angabe die Rückfrage, wie bei jedem Antrag davor. */
  readonly freigabeModus?: AntragModus | undefined;
  /** Vom Cockpit selbst gestellt (COPI-142). */
  readonly automatisch?: boolean | undefined;
  readonly beantragtAm: Date;
  readonly freigegebenAm: Date | undefined;
  readonly laeuftSeit: Date | undefined;
  readonly abgeschlossenAm: Date | undefined;
}

export interface Marke {
  readonly text: string;
  readonly farbe: 'gruen' | 'gelb' | 'rot' | 'info';
}

/**
 * Was sich im Bereich beantragen lässt (COPI-40). Höchstens ein offener Antrag zur Zeit (Migration 0018):
 *
 *   * `beantragen` — kein offener Antrag, der laufende Digest ist bekannt;
 *   * `ohne-digest` — kein offener Antrag, aber auch kein laufender Digest: ohne ihn gäbe es keinen Weg zurück
 *     (`digest_vorher`), also keinen Antrag;
 *   * `zurueckziehen` — ein Antrag wartet auf die Freigabe und lässt sich noch zurücknehmen;
 *   * `unterwegs` — ein Antrag ist freigegeben oder läuft: darüber ist entschieden, hier gibt es nichts zu tun.
 */
export type AntragAktion =
  | { readonly art: 'beantragen' }
  | { readonly art: 'ohne-digest' }
  | { readonly art: 'zurueckziehen'; readonly id: number; readonly satz: string }
  | { readonly art: 'unterwegs'; readonly satz: string };

/** Eine erreichte Stufe des Antrags, mit „vor …". */
export interface AntragsStufe {
  readonly name: string;
  readonly wann: string;
}

/** Der letzte Antrag in der Betreuersicht (COPI-41). */
export interface LetzterAntrag {
  readonly nummer: number;
  /** Der Stand in Betriebssprache: „wartet auf Freigabe", „läuft", „hängt", … */
  readonly stand: string;
  readonly haengt: boolean;
  /** Wie er freigegeben wird: „Rückfrage in Slack", „direkt im Cockpit" (COPI-141) oder „automatisch" (COPI-142). */
  readonly freigabe: string;
  readonly zielDigest: string;
  readonly zielVersion: string | undefined;
  /** Der Weg zurück, vollständig. */
  readonly digestVorher: string;
  /** Nur die erreichten Stufen, in ihrer Reihenfolge. */
  readonly stufen: readonly AntragsStufe[];
}

/** Ein verfügbares Update mit Knopf (COPI-140): die Zeile der Karte und das Ziel, das der Knopf beantragt. */
export interface VerfuegbaresUpdate {
  /** „Update verfügbar: 0.24.0 · Hinweis · seit 12.10.2026". */
  readonly zeile: string;
  readonly ziel: string;
  /** Was die Automatik damit tut (COPI-142); nur im Modus `automatisch`. */
  readonly automatik?: string | undefined;
}

export interface BetreuerBereich {
  readonly name: string;
  readonly marke: Marke | undefined;
  /** `undefined`, solange sich das Cockpit nicht gemeldet hat. */
  readonly version: string | undefined;
  readonly digest: string | undefined;
  readonly gestartet: string | undefined;
  /** Das Ziel eines offenen Antrags; ohne ihn keins. */
  readonly sollDigest: string | undefined;
  /** Der Text der Versions-Wache, unverändert. */
  readonly verfuegbar: string | undefined;
  readonly wache: { readonly text: string; readonly ueberfaellig: boolean };
  readonly antrag: AntragAktion;
  /** Das gemeldete Ziel mit Knopf — nur, wenn sich gerade ein Antrag stellen lässt (COPI-140). */
  readonly update: VerfuegbaresUpdate | undefined;
  /** Der jüngste Antrag, gleich in welchem Stand; ohne Antrag keiner. */
  readonly letzterAntrag: LetzterAntrag | undefined;
}

/**
 * Was sich bei einem Modul beantragen lässt: wie beim Cockpit, nur fehlt statt des Digests die Herkunft. `nur-konsole`:
 * die Herkunft liegt nicht unter `module/<kennung>.cockpit.yaml` — dann geht ein Update nur per Server-Konsole (COPI-140).
 */
export type ModulAntragAktion =
  | { readonly art: 'beantragen' }
  | { readonly art: 'ohne-herkunft' }
  | { readonly art: 'nur-konsole' }
  | { readonly art: 'zurueckziehen'; readonly id: number; readonly satz: string }
  | { readonly art: 'unterwegs'; readonly satz: string };

/** Der letzte Modul-Antrag in der Betreuersicht. */
export interface ModulLetzterAntrag {
  readonly nummer: number;
  readonly stand: string;
  readonly haengt: boolean;
  readonly freigabe: string;
  readonly zielCommit: string;
  readonly herkunftVorher: string;
  readonly grund: string | undefined;
  readonly stufen: readonly AntragsStufe[];
}

/** Ein Modul im Abschnitt „Versionen" (COPI-106). */
export interface ModulBereich {
  readonly kennung: string;
  readonly name: string;
  readonly marke: Marke | undefined;
  /** „4 · aktiv seit vor 2 Tagen". */
  readonly version: string;
  readonly herkunft: string | undefined;
  /** Das Ziel eines offenen Antrags. */
  readonly sollCommit: string | undefined;
  readonly verfuegbar: string | undefined;
  readonly wache: { readonly text: string; readonly ueberfaellig: boolean };
  readonly antrag: ModulAntragAktion;
  /** Das gemeldete Ziel mit Knopf — nur, wenn sich gerade ein Antrag stellen lässt (COPI-140). */
  readonly update: VerfuegbaresUpdate | undefined;
  readonly letzterAntrag: ModulLetzterAntrag | undefined;
}

export interface BetreuerVersionen {
  readonly bereiche: readonly BetreuerBereich[];
  /** Je aktives Modul ein Bereich (COPI-106), nach Kennung. */
  readonly module: readonly ModulBereich[];
}

/** Die Versions-Wache eines Moduls. */
export function modulVersionsWache(kennung: string): string {
  return `version-modul-${kennung}`;
}

/** Herkunft eines Moduls aus agent-blueprints, wie Migration 0040 sie liest (`cockpit.herkunft_commit`). */
const HERKUNFT_FORM = /^agent-blueprints@([0-9a-f]{7,40}):.+$/;

/** Der Commit einer Herkunft `agent-blueprints@<commit>:<pfad>`, sonst `undefined`. */
export function herkunftCommit(herkunft: string | undefined): string | undefined {
  return herkunft === undefined ? undefined : HERKUNFT_FORM.exec(herkunft)?.[1];
}

/**
 * Ob sich das Modul per Antrag aktualisieren lässt: seine Herkunft liegt unter `module/<kennung>.cockpit.yaml`. Nur diesen
 * Pfad kennt `einspielen` in agent-blueprints (COPI-127); der Admin-Agent weist jeden anderen ab (COPI-140, COPI-143).
 */
export function herkunftUnterModule(herkunft: string | undefined, kennung: string): boolean {
  return herkunft !== undefined && herkunftCommit(herkunft) !== undefined && herkunft.endsWith(`:module/${kennung}.cockpit.yaml`);
}

/** Derselbe Commit, wenn einer ein Präfix des anderen ist (`cockpit.commit_passt`, 0040). */
export function commitPasst(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && (a.startsWith(b) || b.startsWith(a));
}

function offen(status: AntragStatus | undefined): boolean {
  return status !== undefined && OFFENE_STATUS.includes(status);
}

function antragHaengt(antrag: AntragDaten | undefined, jetzt: Date): boolean {
  return antrag !== undefined && haengt(antrag.status, antrag.laeuftSeit, jetzt);
}

/** Die Sätze aus ADR 13.1. */
function kundenSatz(status: AntragStatus | undefined): string {
  if (offen(status)) {
    return 'Update angefragt.';
  }
  if (status === 'fehlgeschlagen') {
    return 'Update fehlgeschlagen, Betreuer ist informiert.';
  }
  return 'Aktuell.';
}

export function kundenVersionen(daten: KundenVersionenDaten): KundenVersionen {
  return { bereiche: [{ name: 'Cockpit', satz: kundenSatz(daten.antragStatus) }] };
}

const WACHEN_MARKE: Readonly<Record<BefundStatus, Marke>> = {
  gruen: { text: 'Aktuell', farbe: 'gruen' },
  gelb: { text: 'Update verfügbar', farbe: 'gelb' },
  rot: { text: 'Prüfung gestört', farbe: 'rot' },
};

/**
 * Ein Antrag geht der Wache vor: was hängt, angefragt ist oder gescheitert, ist wichtiger als „es gibt etwas Neues".
 * Hängen geht allem vor — die ausbleibende Meldung ist die häufigste stille Fehlfunktion (ADR 13.1).
 */
function marke(antrag: Pick<AntragDaten, 'status' | 'laeuftSeit'> | undefined, wache: WachenDaten | undefined, jetzt: Date): Marke | undefined {
  if (antrag !== undefined && haengt(antrag.status, antrag.laeuftSeit, jetzt)) {
    return { text: 'Update hängt', farbe: 'rot' };
  }
  if (offen(antrag?.status)) {
    return { text: 'Update angefragt', farbe: 'info' };
  }
  if (antrag?.status === 'fehlgeschlagen') {
    return { text: 'Update fehlgeschlagen', farbe: 'rot' };
  }
  const letzter = wache?.letzter;
  return letzter === undefined ? undefined : WACHEN_MARKE[letzter.status];
}

/** Direkt freigegeben und noch nicht gestartet: der Betreuer kann den Antrag noch zurückziehen (COPI-141). */
function direktFreigegeben(antrag: { readonly status: AntragStatus; readonly freigabeModus?: AntragModus | undefined }): boolean {
  return antrag.status === 'freigegeben' && antrag.freigabeModus === 'direkt';
}

const DIREKT_SATZ = 'ist direkt freigegeben: der Admin-Agent spielt das Update ohne Rückfrage ein. Bis er beginnt, lässt er sich zurückziehen.';

function antragAktion(daten: BetreuerVersionenDaten, jetzt: Date): AntragAktion {
  const antrag = daten.antrag;
  if (antrag !== undefined && antragHaengt(antrag, jetzt)) {
    return {
      art: 'unterwegs',
      satz: `Antrag Nr. ${String(antrag.id)} hängt: er läuft seit über 15 Minuten, ohne dass sich das neue Cockpit gemeldet hat.`,
    };
  }
  if (antrag?.status === 'beantragt') {
    return { art: 'zurueckziehen', id: antrag.id, satz: `Antrag Nr. ${String(antrag.id)} wartet auf die Freigabe.` };
  }
  if (antrag !== undefined && direktFreigegeben(antrag)) {
    return { art: 'zurueckziehen', id: antrag.id, satz: `Antrag Nr. ${String(antrag.id)} ${DIREKT_SATZ}` };
  }
  if (antrag?.status === 'freigegeben') {
    return { art: 'unterwegs', satz: `Antrag Nr. ${String(antrag.id)} ist freigegeben: der Admin-Agent spielt das Update ein.` };
  }
  if (antrag?.status === 'laeuft') {
    return { art: 'unterwegs', satz: `Antrag Nr. ${String(antrag.id)} läuft: das Update wird gerade eingespielt.` };
  }
  return daten.instanz?.digest === undefined ? { art: 'ohne-digest' } : { art: 'beantragen' };
}

/**
 * Die Zeile und das Ziel eines gemeldeten Updates (COPI-140) — nur, wenn die Karte gerade „beantragen" anbietet und das
 * Ziel nicht schon läuft (`laeuft`). Beim Cockpit steht die Version vorn, beim Modul der Kurz-Commit.
 */
/** Der Satz zur Automatik unter „Update verfügbar" (COPI-142); beim Cockpit mit dem Wartungsfenster. */
function automatikSatz(stand: AutomatikStand | undefined, art: 'cockpit' | 'modul'): string | undefined {
  switch (stand) {
    case 'bereit':
      return art === 'cockpit' ? 'Wird automatisch installiert, im nächsten Wartungsfenster (dienstags 7–9 Uhr).' : 'Wird automatisch installiert.';
    case 'heute':
      return 'Wird automatisch installiert, frühestens morgen: heute gab es schon einen automatischen Antrag.';
    case 'ziel':
      return 'Automatik für dieses Ziel gesperrt: ein Update darauf ist gescheitert oder wurde zurückgezogen. Installieren nur noch von Hand.';
    default:
      return undefined;
  }
}

function verfuegbaresUpdate(
  update: UpdateZiel | undefined,
  aktion: { readonly art: string },
  laeuft: (ziel: string) => boolean,
  automatik: string | undefined,
): VerfuegbaresUpdate | undefined {
  if (update === undefined || aktion.art !== 'beantragen' || laeuft(update.ziel)) {
    return undefined;
  }
  const stand = update.version ?? update.ziel.slice(0, 7);
  const teile = [stand, ...(update.hinweis === undefined ? [] : [update.hinweis]), ...(update.seit === undefined ? [] : [`seit ${datumText(update.seit)}`])];
  return { zeile: `Update verfügbar: ${teile.join(' · ')}`, ziel: update.ziel, ...(automatik === undefined ? {} : { automatik }) };
}

function wachenStand(wache: BetreuerVersionenDaten['wache'], jetzt: Date): BetreuerBereich['wache'] {
  if (wache === undefined) {
    return { text: 'noch nicht gemeldet', ueberfaellig: false };
  }
  const zustand = wachenZustand({ taktSekunden: wache.taktSekunden, letzterLauf: wache.letzterLauf, letzterStatus: wache.letzter?.status }, jetzt);
  return { text: zustand.zuletztGeprueft, ueberfaellig: zustand.ueberfaellig };
}

/** Der Stand in Betriebssprache. */
const STAND: Readonly<Record<AntragStatus, string>> = {
  beantragt: 'wartet auf Freigabe',
  freigegeben: 'freigegeben',
  laeuft: 'läuft',
  erledigt: 'erledigt',
  fehlgeschlagen: 'fehlgeschlagen',
  zurueckgezogen: 'zurückgezogen',
};

/** Wie der Abschluss heißt, je nachdem, wie der Antrag endete. */
const ABSCHLUSS: Readonly<Partial<Record<AntragStatus, string>>> = {
  erledigt: 'Erledigt',
  fehlgeschlagen: 'Fehlgeschlagen',
  zurueckgezogen: 'Zurückgezogen',
};

/** „vor …" — springt die Uhr zurück, liegt der Zeitpunkt scheinbar in der Zukunft: Alter null, nie ein negatives. */
function vor(zeitpunkt: Date, jetzt: Date): string {
  return vorText(Math.max(0, Math.floor((jetzt.getTime() - zeitpunkt.getTime()) / 1000)));
}

type Stufen = Pick<AntragDaten, 'id' | 'status' | 'freigabeModus' | 'automatisch' | 'beantragtAm' | 'freigegebenAm' | 'laeuftSeit' | 'abgeschlossenAm'>;

/** Nummer, Stand, Freigabeweg und erreichte Stufen eines Antrags, gleich welcher Art. */
function antragStand(antrag: Stufen, jetzt: Date): Pick<LetzterAntrag, 'nummer' | 'stand' | 'haengt' | 'freigabe' | 'stufen'> {
  const haengend = haengt(antrag.status, antrag.laeuftSeit, jetzt);
  const stufen: [string | undefined, Date | undefined][] = [
    ['Beantragt', antrag.beantragtAm],
    ['Freigegeben', antrag.freigegebenAm],
    ['Gestartet', antrag.laeuftSeit],
    [ABSCHLUSS[antrag.status], antrag.abgeschlossenAm],
  ];
  return {
    nummer: antrag.id,
    stand: haengend ? 'hängt' : STAND[antrag.status],
    haengt: haengend,
    freigabe: antrag.automatisch === true ? 'automatisch, ohne Klick' : antrag.freigabeModus === 'direkt' ? 'direkt im Cockpit' : 'Rückfrage in Slack',
    stufen: stufen.flatMap(([name, wann]) => (name === undefined || wann === undefined ? [] : [{ name, wann: vor(wann, jetzt) }])),
  };
}

function letzterAntrag(antrag: AntragDaten | undefined, jetzt: Date): LetzterAntrag | undefined {
  return antrag === undefined
    ? undefined
    : { ...antragStand(antrag, jetzt), zielDigest: antrag.zielDigest, zielVersion: antrag.zielVersion, digestVorher: antrag.digestVorher };
}

/** Wie beim Cockpit, mit den Sätzen des Moduls: es gibt keinen Neustart, erledigt meldet die Registry. */
function modulAntragAktion(daten: ModulVersionDaten, jetzt: Date): ModulAntragAktion {
  const antrag = daten.antrag;
  const nummer = antrag === undefined ? '' : `Antrag Nr. ${String(antrag.id)}`;
  if (antrag !== undefined && haengt(antrag.status, antrag.laeuftSeit, jetzt)) {
    return { art: 'unterwegs', satz: `${nummer} hängt: er läuft seit über 15 Minuten, ohne dass die Registry die neue Version meldet.` };
  }
  if (antrag?.status === 'beantragt') {
    return { art: 'zurueckziehen', id: antrag.id, satz: `${nummer} wartet auf die Freigabe. Bis dahin lässt er sich zurückziehen.` };
  }
  if (antrag !== undefined && direktFreigegeben(antrag)) {
    return { art: 'zurueckziehen', id: antrag.id, satz: `${nummer} ${DIREKT_SATZ}` };
  }
  if (antrag?.status === 'freigegeben' || antrag?.status === 'laeuft') {
    return {
      art: 'unterwegs',
      satz: `${nummer} ist freigegeben: der Admin-Agent spielt View und Block ein. Erledigt ist er, sobald die Registry die neue Herkunft meldet.`,
    };
  }
  if (herkunftCommit(daten.herkunft) === undefined) {
    return { art: 'ohne-herkunft' };
  }
  return herkunftUnterModule(daten.herkunft, daten.kennung) ? { art: 'beantragen' } : { art: 'nur-konsole' };
}

function modulBereich(daten: ModulVersionDaten, jetzt: Date): ModulBereich {
  const antrag = daten.antrag;
  const aktion = modulAntragAktion(daten, jetzt);
  const laeuft = herkunftCommit(daten.herkunft);
  return {
    kennung: daten.kennung,
    name: `Modul · ${daten.menuename}`,
    marke: marke(antrag, daten.wache, jetzt),
    version: `${String(daten.version)} · aktiv seit ${vor(daten.aktivSeit, jetzt)}`,
    herkunft: daten.herkunft,
    sollCommit: offen(antrag?.status) ? antrag?.zielCommit : undefined,
    verfuegbar: daten.wache?.letzter?.text,
    wache: wachenStand(daten.wache, jetzt),
    antrag: aktion,
    update: verfuegbaresUpdate(daten.wache?.letzter?.update, aktion, (ziel) => commitPasst(ziel, laeuft), automatikSatz(daten.automatik, 'modul')),
    letzterAntrag:
      antrag === undefined
        ? undefined
        : { ...antragStand(antrag, jetzt), zielCommit: antrag.zielCommit, herkunftVorher: antrag.herkunftVorher, grund: antrag.fehlerGrund },
  };
}

export function betreuerVersionen(daten: BetreuerVersionenDaten, jetzt: Date): BetreuerVersionen {
  const instanz = daten.instanz;
  const gestartet = instanz === undefined ? undefined : vor(instanz.gestartetAm, jetzt);
  const aktion = antragAktion(daten, jetzt);
  return {
    bereiche: [
      {
        name: 'Cockpit',
        marke: marke(daten.antrag, daten.wache, jetzt),
        version: instanz?.version,
        digest: instanz?.digest,
        gestartet,
        sollDigest: offen(daten.antrag?.status) ? daten.antrag?.zielDigest : undefined,
        verfuegbar: daten.wache?.letzter?.text,
        wache: wachenStand(daten.wache, jetzt),
        antrag: aktion,
        update: verfuegbaresUpdate(daten.wache?.letzter?.update, aktion, (ziel) => ziel === instanz?.digest, automatikSatz(daten.automatik, 'cockpit')),
        letzterAntrag: letzterAntrag(daten.antrag, jetzt),
      },
    ],
    module: (daten.module ?? []).map((modul) => modulBereich(modul, jetzt)),
  };
}
