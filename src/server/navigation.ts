/**
 * Die Navigation der angemeldeten Seiten (COPI-38, neu gefasst mit COPI-43 nach dem Prototyp). Eine reine Funktion,
 * damit die Regel an einer Stelle steht und ohne Server testbar ist.
 *
 *   * **Fünf Haupteinträge** wie im Prototyp, am Desktop in der Sidebar, mobil in der Tab-Leiste: Übersicht, Chat,
 *     Module, Meldungen, Mehr. **Module** (E5, COPI-78) ist ein Link, sobald für die Rolle mindestens ein aktives
 *     Modul sichtbar ist — sonst bleibt der Eintrag ausgegraut und ohne Ziel (`folgt`), wie bisher: die Tab-Leiste
 *     behält so immer dieselben fünf Plätze, ein Konto ohne Modul verliert keinen Eintrag und gewinnt keinen, sobald
 *     ihm eines zugewiesen wird. Ebenso der Chat für ein Konto ohne Recht `chat_nutzen`.
 *   * Der Chat trägt die Zahl der ungelesenen Nachrichten (COPI-53), wenn es welche gibt. Seit COPI-112 heißt er
 *     „Nachrichten" und zählt die ungelesenen Zeilen der Postfächer (Module mit `posteingang:`) mit; sein Ziel bleibt
 *     `/chat`, dort stehen die Postfächer in der Liste „Verlauf".
 *   * **Posteingang** (COPI-112): das Badge im Kopf mit allem Ungelesenen (`posteingang`), aus dem Zugang.
 *   * **Mehr** sammelt Benutzer, Agenten, Zeitplan, Einstellungen und Einladen — in der Reihenfolge der ADR
 *     (Abschnitt 5), Einladen zuletzt. Auf diesen Seiten ist „Mehr" markiert, wie im Prototyp bei den Einstellungen.
 *   * **Angeheftete Module** (COPI-121, Block-Feld `navigation: haupt`): je ein Eintrag direkt unter „Nachrichten", mit
 *     der Zahl der ungelesenen Zeilen seines Postfachs — „Nachrichten" zählt diese Zeilen dann nicht mehr mit. Mobil nimmt
 *     das erste angeheftete Modul den Platz von „Meldungen" ein (die Tab-Leiste behält fünf Plätze); „Meldungen" steht
 *     dann nur am Desktop in der Leiste und mobil unter „Mehr". Weitere angeheftete Module stehen nur in der Sidebar.
 *   * **Am Desktop kein „Mehr"** (COPI-108, Entscheidung Stefan, bewusste Abweichung vom Prototyp): Dort ist Platz, die
 *     Sidebar zeigt dieselben Einträge (`mehr`) direkt als Gruppe „Verwaltung". „Mehr" trägt deshalb `nurMobil`.
 *
 * **Ein Link ist keine Zugriffsregel.** Wer ein Ziel nicht sieht, kommt trotzdem nicht hin, weil die Route selbst
 * prüft (Tor, Rechte). Die Navigation zeigt nur, was diese Prüfung ohnehin durchlässt, und nutzt dafür dieselbe
 * Regel (`hatRecht` bzw. für Module `modulZugriffErlaubt`), nicht eine zweite. Ein Konto sieht so nie einen Link,
 * der bei ihm auf eine `404` führt.
 */
import { hatRecht, type AngeheftetesModul, type ErweiterungEintrag, type Zugang } from '../auth/berechtigung.js';
import type { PosteingangAnsicht } from '../posteingang/posteingang.js';

export type NavSeite =
  | 'uebersicht'
  | 'chat'
  | 'module'
  | 'meldungen'
  | 'mehr'
  | 'benutzer'
  | 'agenten'
  | 'zeitplan'
  | 'einstellungen'
  | 'einladung'
  // Die Freigabe-Inbox (COPI-139).
  | 'freigaben'
  // Anmeldung & Sicherheit (COPI-94): eine Unterseite der Einstellungen, markiert deshalb deren Eintrag.
  | 'sicherheit'
  // Die Seite einer Erweiterung (COPI-193): welche, sagt die Kennung, die `navigation()` als dritte Angabe bekommt.
  | 'erweiterung';

/** Die Symbole, die `views/partials/symbol.eta` kennt. */
export type Symbol = 'haus' | 'chat' | 'module' | 'glocke' | 'mehr' | 'personen' | 'agenten' | 'uhr' | 'zahnrad' | 'person' | 'posteingang' | 'mail' | 'koffer' | 'haken';

export interface HauptEintrag {
  readonly text: string;
  readonly symbol: Symbol;
  /** `undefined`: das Ziel gibt es noch nicht (`folgt`). */
  readonly href: string | undefined;
  readonly aktuell: boolean;
  readonly folgt: boolean;
  /** Ungelesenes (nur bei „Nachrichten": Chat und Postfächer); `undefined` ohne. */
  readonly ungelesen: number | undefined;
  /** Nur in der mobilen Tab-Leiste (COPI-108): „Mehr"; am Desktop stehen seine Einträge als Gruppe in der Sidebar. */
  readonly nurMobil: boolean;
  /** Nur in der Sidebar (COPI-121): „Meldungen" neben einem angehefteten Modul, weitere angeheftete Module. */
  readonly nurDesktop: boolean;
  /** Hinweispunkt „Update verfügbar" (COPI-140): mobil an „Mehr", weil „Einstellungen" darunter liegt. */
  readonly punkt: boolean;
  /** Wofür die Zahl steht, wenn nicht für „ungelesen" (COPI-139: „offen"). */
  readonly zahlWort?: string;
}

export interface MehrEintrag {
  readonly text: string;
  readonly symbol: Symbol;
  readonly href: string;
  readonly aktuell: boolean;
  /** Hinweispunkt „Update verfügbar" (COPI-140), nur an „Einstellungen". */
  readonly punkt: boolean;
  /** Nur auf der Seite „Mehr", nicht in der Gruppe „Verwaltung" der Sidebar (COPI-121: „Meldungen"). */
  readonly nurMobil: boolean;
  /** Die Zahl an der Zeile (COPI-139: offene Freigaben), mit `zahlWort` als Beschriftung für Screenreader. */
  readonly zahl?: number;
  readonly zahlWort?: string;
}

export interface Navigation {
  readonly eintraege: readonly HauptEintrag[];
  readonly mehr: readonly MehrEintrag[];
  /** Der Pfad der Seite: dorthin kehrt der Dark-Mode-Schalter zurück. */
  readonly pfad: string;
  /** Ein Abmelden gibt es nur mit Sitzung: sonst gäbe es nichts, wovon man sich abmeldet. */
  readonly abmelden: boolean;
  /** Der Hinweis „Update verfügbar" (COPI-84) mit dem Text der Wache; `undefined` ohne (auch für jede Kundenrolle). */
  readonly updateHinweis: { readonly text: string } | undefined;
  /** Der Posteingang im Kopf (COPI-112); `undefined` ohne Sitzung samt zweitem Faktor. */
  readonly posteingang: PosteingangAnsicht | undefined;
}

/** Was die Navigation von einem Zugang wissen muss. */
export interface NavRechte {
  readonly angemeldet: boolean;
  readonly einladen: boolean;
  /** Recht `benutzer_sehen` (COPI-45). */
  readonly benutzerSehen: boolean;
  /** Recht `chat_nutzen` (COPI-53). */
  readonly chat: boolean;
  /** Ungelesene Nachrichten im Chat. */
  readonly chatUngelesen: number;
  /** Mindestens ein aktives Modul ist für die Rolle sichtbar (COPI-78). Ohne Angabe: keins. */
  readonly module?: boolean;
  /** Text der Versions-Wache bei gelbem Befund (COPI-84); nur für Konten mit `technik_sehen` gesetzt. */
  readonly updateVerfuegbar?: { readonly text: string };
  /** Eine Karte bietet „Update installieren" an (COPI-140); nur für Konten mit `technik_sehen` gesetzt. */
  readonly updateInstallierbar?: boolean;
  /** Der Posteingang (COPI-112); ohne Angabe kein Badge. */
  readonly posteingang?: PosteingangAnsicht;
  /** Die angehefteten Module (COPI-121), die der Zugang sieht; ohne Angabe keins. */
  readonly angeheftet?: readonly AngeheftetesModul[];
  /** Die Freigabe-Inbox (COPI-139): gesetzt nur mit dem Recht und bei konfiguriertem Modul; `offen` ohne Zahl bei Störung. */
  readonly freigaben?: { readonly offen: number | undefined };
  /** Die Einträge der Erweiterungen (COPI-193), die der Zugang sehen darf; ohne Angabe keiner. */
  readonly erweiterungen?: readonly ErweiterungEintrag[];
}

type HauptId = 'uebersicht' | 'chat' | 'module' | 'meldungen' | 'mehr';

interface Haupt {
  readonly id: HauptId;
  readonly text: string;
  readonly symbol: Symbol;
  readonly href?: string;
}

/** Die Reihenfolge des Prototyps. Chat und Module haben ein Ziel, sind aber nur mit dem passenden Recht ein Link. */
const HAUPT: readonly Haupt[] = [
  { id: 'uebersicht', text: 'Übersicht', symbol: 'haus', href: '/' },
  { id: 'chat', text: 'Nachrichten', symbol: 'chat', href: '/chat' },
  { id: 'module', text: 'Module', symbol: 'module', href: '/module' },
  { id: 'meldungen', text: 'Meldungen', symbol: 'glocke', href: '/meldungen' },
  { id: 'mehr', text: 'Mehr', symbol: 'mehr', href: '/mehr' },
];

interface Unter {
  readonly seite: NavSeite;
  readonly text: string;
  readonly symbol: Symbol;
  readonly href: string;
  /** Ohne Angabe für jeden; sonst nur mit diesem Recht. */
  readonly recht?: 'einladen' | 'benutzerSehen';
}

/** „Meldungen" unter „Mehr", nur wenn ein angeheftetes Modul ihren Platz in der Tab-Leiste einnimmt (COPI-121). */
const MELDUNGEN_MEHR: Unter = { seite: 'meldungen', text: 'Meldungen', symbol: 'glocke', href: '/meldungen' };

/** „Freigaben" unter „Mehr" (COPI-139), nur mobil: am Desktop steht der Eintrag in der Sidebar. */
const FREIGABEN_MEHR: Unter = { seite: 'freigaben', text: 'Freigaben', symbol: 'haken', href: '/freigaben' };

const MEHR: readonly Unter[] = [
  { seite: 'benutzer', text: 'Benutzer', symbol: 'personen', href: '/benutzer', recht: 'benutzerSehen' },
  { seite: 'agenten', text: 'Agenten', symbol: 'agenten', href: '/agenten' },
  { seite: 'zeitplan', text: 'Zeitplan', symbol: 'uhr', href: '/zeitplan' },
  { seite: 'einstellungen', text: 'Einstellungen', symbol: 'zahnrad', href: '/einstellungen' },
  { seite: 'einladung', text: 'Einladen', symbol: 'person', href: '/einladung', recht: 'einladen' },
];

const PFAD: Readonly<Record<NavSeite, string>> = {
  uebersicht: '/',
  chat: '/chat',
  module: '/module',
  meldungen: '/meldungen',
  mehr: '/mehr',
  benutzer: '/benutzer',
  agenten: '/agenten',
  zeitplan: '/zeitplan',
  einstellungen: '/einstellungen',
  einladung: '/einladung',
  freigaben: '/freigaben',
  sicherheit: '/sicherheit',
  // Nur der Platzhalter: den Pfad einer Erweiterungsseite kennt `navigation()` aus deren Eintrag.
  erweiterung: '/',
};

/** Unterseiten, die den Eintrag ihrer Elternseite unter „Mehr" markieren. */
const ELTERN: Partial<Record<NavSeite, NavSeite>> = { sicherheit: 'einstellungen' };

/** Welcher Haupteintrag auf einer Seite markiert ist: die Unterseiten von „Mehr" markieren „Mehr". */
function hauptZu(seite: NavSeite): HauptId {
  return seite === 'uebersicht' || seite === 'chat' || seite === 'module' || seite === 'meldungen' ? seite : 'mehr';
}

/** Ob dieser Haupteintrag trotz eines hinterlegten Ziels ausgegraut bleibt (kein Recht bzw. kein sichtbares Modul). */
function versteckt(ziel: Haupt, rechte: NavRechte): boolean {
  if (ziel.id === 'chat') {
    return !rechte.chat;
  }
  if (ziel.id === 'module') {
    return rechte.module !== true;
  }
  return false;
}

/**
 * Die Navigation einer Seite. `modul` ist die Kennung der Modulseite, auf der man ist (`aktuell === 'module'`): ist das
 * Modul angeheftet, ist sein Eintrag markiert statt „Module". Auf einer Erweiterungsseite (`aktuell === 'erweiterung'`) ist `modul`
 * die Kennung der Erweiterung (COPI-193).
 */
export function navigation(aktuell: NavSeite, rechte: NavRechte, modul?: string): Navigation {
  const erweiterungen = rechte.erweiterungen ?? [];
  const angeheftet = rechte.angeheftet ?? [];
  const angeheftetAktuell = aktuell === 'module' && angeheftet.some((eintrag) => eintrag.kennung === modul);
  const markiert = hauptZu(aktuell);
  const mitAngehefteten = angeheftet.length > 0;
  const haupt: HauptEintrag[] = HAUPT.map((ziel) => {
    const href = versteckt(ziel, rechte) ? undefined : ziel.href;
    const meldungenVerdraengt = mitAngehefteten && ziel.id === 'meldungen';
    return {
      text: ziel.text,
      symbol: ziel.symbol,
      href,
      aktuell: href !== undefined && (ziel.id === markiert ? !(ziel.id === 'module' && angeheftetAktuell) : ziel.id === 'mehr' && meldungenMitMehr(aktuell, mitAngehefteten)),
      folgt: href === undefined,
      ungelesen: ziel.id === 'chat' && rechte.chat ? nachrichtenUngelesen(rechte) : undefined,
      nurMobil: ziel.id === 'mehr',
      nurDesktop: meldungenVerdraengt,
      punkt: ziel.id === 'mehr' && rechte.updateInstallierbar === true,
    };
  });
  const angeheftetEintraege = angeheftet.map((eintrag, stelle) => {
    const ungelesen = rechte.posteingang?.postfaecher[eintrag.kennung] ?? 0;
    return {
      text: eintrag.menuename,
      symbol: 'koffer' as const,
      href: `/module/${encodeURIComponent(eintrag.kennung)}`,
      aktuell: angeheftetAktuell && eintrag.kennung === modul,
      folgt: false,
      ungelesen: ungelesen > 0 ? ungelesen : undefined,
      nurMobil: false,
      nurDesktop: stelle > 0,
      punkt: false,
    };
  });
  // Erweiterungen (COPI-193): am Desktop direkt hinter „Übersicht", mobil unter „Mehr" — die Tab-Leiste behält ihre fünf Plätze.
  const erweiterungAktuell = (eintrag: ErweiterungEintrag): boolean => aktuell === 'erweiterung' && eintrag.kennung === modul;
  const erweiterungEintraege = erweiterungen.map((eintrag) => ({
    text: eintrag.text,
    symbol: 'agenten' as const,
    href: eintrag.href,
    aktuell: erweiterungAktuell(eintrag),
    folgt: false,
    ungelesen: undefined,
    nurMobil: false,
    nurDesktop: true,
    punkt: false,
  }));
  const erweiterungMehr = erweiterungen.map((eintrag) => ({
    text: eintrag.text,
    symbol: 'agenten' as const,
    href: eintrag.href,
    aktuell: erweiterungAktuell(eintrag),
    punkt: false,
    nurMobil: true,
  }));
  // Freigaben (COPI-139): am Desktop direkt hinter „Nachrichten" mit der Zahl der offenen, mobil unter „Mehr".
  const freigabenEintraege = rechte.freigaben === undefined ? [] : [{
    text: 'Freigaben',
    symbol: 'haken' as const,
    href: '/freigaben',
    aktuell: aktuell === 'freigaben',
    folgt: false,
    ungelesen: rechte.freigaben.offen !== undefined && rechte.freigaben.offen > 0 ? rechte.freigaben.offen : undefined,
    zahlWort: 'offen',
    nurMobil: false,
    nurDesktop: true,
    punkt: false,
  }];
  const freigabenOffen = rechte.freigaben?.offen !== undefined && rechte.freigaben.offen > 0 ? rechte.freigaben.offen : undefined;
  const freigabenMehr = rechte.freigaben === undefined ? [] : [FREIGABEN_MEHR];
  const unter = [...(mitAngehefteten ? [MELDUNGEN_MEHR] : []), ...freigabenMehr, ...MEHR];
  return {
    eintraege: [...haupt.slice(0, 1), ...erweiterungEintraege, ...haupt.slice(1, 2), ...freigabenEintraege, ...angeheftetEintraege, ...haupt.slice(2)],
    mehr: [...erweiterungMehr, ...unter
      .filter((ziel) => ziel.recht === undefined || rechte[ziel.recht])
      .map((ziel) => ({
        text: ziel.text,
        symbol: ziel.symbol,
        href: ziel.href,
        aktuell: ziel.seite === (ELTERN[aktuell] ?? aktuell),
        nurMobil: ziel === MELDUNGEN_MEHR || ziel === FREIGABEN_MEHR,
        punkt: ziel.seite === 'einstellungen' && rechte.updateInstallierbar === true,
        ...(ziel === FREIGABEN_MEHR && freigabenOffen !== undefined ? { zahl: freigabenOffen, zahlWort: 'offen' } : {}),
      }))],
    pfad: aktuell === 'erweiterung' ? (erweiterungen.find(erweiterungAktuell)?.href ?? PFAD[aktuell]) : PFAD[aktuell],
    abmelden: rechte.angemeldet,
    updateHinweis: rechte.updateVerfuegbar,
    posteingang: rechte.posteingang,
  };
}

/** Auf „Meldungen" ist mobil „Mehr" mit markiert, wenn Meldungen dort liegt (COPI-121). */
function meldungenMitMehr(aktuell: NavSeite, mitAngehefteten: boolean): boolean {
  return mitAngehefteten && aktuell === 'meldungen';
}

/**
 * Die Zahl an „Nachrichten": ungelesene Chats und Zeilen der Postfächer (COPI-112); `undefined` bei null. Mit Posteingang
 * zählt er beides, ohne bleibt es bei der Zahl des Chats (COPI-53).
 */
function nachrichtenUngelesen(rechte: NavRechte): number | undefined {
  const posteingang = rechte.posteingang;
  if (posteingang === undefined) {
    return rechte.chatUngelesen > 0 ? rechte.chatUngelesen : undefined;
  }
  // Angeheftete Module zählen an ihrem eigenen Eintrag (COPI-121), nicht noch einmal hier.
  const angeheftet = (rechte.angeheftet ?? []).reduce((summe, eintrag) => summe + (posteingang.postfaecher[eintrag.kennung] ?? 0), 0);
  const anzahl = posteingang.zahlen.chat + posteingang.zahlen.postfach - angeheftet;
  return anzahl > 0 ? anzahl : undefined;
}

/**
 * Die Navigation für den Zugang einer Anfrage. Ohne Zugang (keine Anmeldung eingerichtet, Tests und
 * Entwicklung ohne Datenbank) gibt es weder Rechte noch ein Abmelden.
 */
export function navigationFuerZugang(aktuell: NavSeite, zugang: Zugang | undefined, modul?: string): Navigation {
  return navigation(aktuell, {
    angemeldet: zugang?.angemeldet === true,
    einladen: zugang !== undefined && hatRecht(zugang, 'einladen'),
    benutzerSehen: zugang !== undefined && hatRecht(zugang, 'benutzer_sehen'),
    chat: zugang !== undefined && hatRecht(zugang, 'chat_nutzen'),
    chatUngelesen: zugang?.chatUngelesen ?? 0,
    module: zugang?.moduleSichtbar === true,
    // Zusätzlich zum Laden (nur mit `technik_sehen`) hier noch einmal am Recht festgemacht: ein Hinweis erreicht nie eine Kundenrolle.
    ...(zugang?.updateVerfuegbar !== undefined && hatRecht(zugang, 'technik_sehen') ? { updateVerfuegbar: zugang.updateVerfuegbar } : {}),
    ...(zugang?.updateInstallierbar === true && hatRecht(zugang, 'technik_sehen') ? { updateInstallierbar: true } : {}),
    ...(zugang?.posteingang !== undefined ? { posteingang: zugang.posteingang } : {}),
    ...(zugang?.moduleAngeheftet !== undefined ? { angeheftet: zugang.moduleAngeheftet } : {}),
    ...(zugang?.freigaben !== undefined && hatRecht(zugang, 'technik_sehen') ? { freigaben: zugang.freigaben } : {}),
    ...(zugang?.erweiterungen !== undefined ? { erweiterungen: zugang.erweiterungen } : {}),
  }, modul);
}
