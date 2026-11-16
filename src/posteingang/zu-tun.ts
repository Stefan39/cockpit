/**
 * Die Reihe „Zu tun" des Dashboards (COPI-122) — reine Funktionen, der Zeitpunkt ist ein Parameter.
 *
 * **Vier Arten Spalten, in dieser Reihenfolge.** Je angeheftetem Modul mit `posteingang:` (COPI-121, etwa die Akquise)
 * seine offenen Zeilen (Status rot oder gelb), jüngste zuerst, ungelesene als „neu" markiert; dann „Nachrichten" mit den
 * ungelesenen Chats und Postfächern **ohne** die angehefteten Module (die haben ihre eigene Spalte, wie in der
 * Navigation); dann „Freigaben" mit den wartenden Entwürfen; zuletzt „PR-Freigaben" (COPI-183) mit den PRs der Dev-Pipeline, die auf Stefans Freigabe warten.
 * Die Spalte gibt es nur, wenn der Aufrufer die Liste übergibt (nur mit `technik_sehen`, also dem Betreuer) und sie nicht
 * leer ist; den Link baut `zuTunAnsicht` selbst, `pr_url` aus dem Runner-Ereignis wird nie übernommen. Jede Spalte zeigt höchstens `ZU_TUN_HOECHSTENS` Einträge,
 * die Zahl im Kopf zählt alles.
 *
 * **Nur, was es für den Zugang gibt.** „Nachrichten" nur mit Chat oder einem Postfach, „Freigaben" nur, wenn ein
 * sichtbares Modul den Eingriff `antwort_freigeben` oder offene Zeilen als Aufgaben trägt (`entscheidung.aufgabe`) — der
 * Aufrufer entscheidet das mit denselben Regeln wie Navigation und Posteingang.
 * Ohne Posteingang (keine Sitzung samt zweitem Faktor) gibt es keine Reihe.
 *
 * Fremdtexte (Titel, Anriss) bleiben Text: die Vorlage escaped sie und verlinkt nie etwas darin (JAC-577).
 */
import type { Statuswoerter } from '../module/block.js';
import { modulStatusAnsicht, type ModulStatusAnsicht } from '../module/ansicht.js';
import { REPO_FORM } from '../pipeline/repo-config.js';
import type { OffeneFreigabe } from '../pipeline/freigaben.js';
import { vonUebersicht } from '../module/rueckweg.js';
import type { Symbol } from '../server/navigation.js';
import { vorKurz } from '../status/zustand.js';
import { anrissKuerzen, type PosteingangAnsicht } from './posteingang.js';
import type { PostfachZeile } from './posteingang-speicher.js';

/** So viele Einträge zeigt eine Spalte höchstens. */
export const ZU_TUN_HOECHSTENS = 4;

/** Ein angeheftetes Modul mit seinen offenen Zeilen (die jüngsten, höchstens `ZU_TUN_HOECHSTENS`). */
export interface ZuTunModul {
  readonly kennung: string;
  readonly menuename: string;
  readonly statuswoerter?: Statuswoerter | undefined;
  /** Alle offenen Zeilen, nicht nur die gelesenen. */
  readonly offen: number;
  readonly zeilen: readonly PostfachZeile[];
}

export interface ZuTunZeile {
  readonly titel: string;
  readonly meta: string;
  readonly zeit: string;
  readonly href: string;
  readonly neu: boolean;
  readonly status?: ModulStatusAnsicht;
}

export interface ZuTunSpalte {
  readonly art: 'modul' | 'nachrichten' | 'freigaben' | 'pipeline';
  readonly titel: string;
  readonly symbol: Symbol;
  /** „3 neu" bzw. „2"; `undefined` bei null. */
  readonly zahl: string | undefined;
  readonly zeilen: readonly ZuTunZeile[];
  /** Der Satz, wenn es nichts gibt. */
  readonly leer: string;
  readonly fuss: { readonly text: string; readonly href: string } | undefined;
}

export interface ZuTunEingabe {
  readonly posteingang: PosteingangAnsicht | undefined;
  readonly module: readonly ZuTunModul[];
  /** Der Zugang hat Chat oder ein Postfach (ohne die angehefteten Module). */
  readonly nachrichten: boolean;
  /** Ein sichtbares Modul trägt den Eingriff `antwort_freigeben` oder `entscheidung.aufgabe` (COPI-124). */
  readonly freigaben: boolean;
  /** Offene PR-Freigaben der Dev-Pipeline (COPI-183); `undefined`: der Zugang darf sie nicht sehen. */
  readonly pipelineFreigaben?: readonly OffeneFreigabe[] | undefined;
  readonly jetzt: Date;
}

/** Der Link zum PR; nur aus geprüftem `repo` und `pr`, nie aus `prUrl` (Fremdwert, JAC-577). */
function pipelineHref(freigabe: OffeneFreigabe): string {
  if (!REPO_FORM.test(freigabe.repo)) {
    return '/';
  }
  const pr = freigabe.pr;
  return typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0
    ? `https://github.com/${freigabe.repo}/pull/${String(pr)}`
    : `https://github.com/${freigabe.repo}/pulls`;
}

function pipelineSpalte(freigaben: readonly OffeneFreigabe[], jetzt: Date): ZuTunSpalte {
  return {
    art: 'pipeline',
    titel: 'PR-Freigaben',
    symbol: 'haken',
    zahl: String(freigaben.length),
    zeilen: freigaben.slice(0, ZU_TUN_HOECHSTENS).map((freigabe) => {
      const runden = freigabe.runden === null ? 'Review-Runden unbekannt' : `${String(freigabe.runden)} Review-Runden`;
      return {
        titel: anrissKuerzen(freigabe.titel === null ? freigabe.ticketKey : `${freigabe.ticketKey} · ${freigabe.titel}`, 80),
        meta: `${freigabe.repo} · PR #${String(freigabe.pr)} · ${runden}`,
        zeit: vorKurz(Math.max(0, Math.floor((jetzt.getTime() - freigabe.angefragtAm.getTime()) / 1000))),
        href: pipelineHref(freigabe),
        neu: false,
      };
    }),
    leer: '',
    fuss: undefined,
  };
}

function modulSpalte(modul: ZuTunModul, ungelesen: number, jetzt: Date): ZuTunSpalte {
  const modulPfad = `/module/${encodeURIComponent(modul.kennung)}`;
  return {
    art: 'modul',
    titel: modul.menuename,
    symbol: 'koffer',
    zahl: ungelesen > 0 ? `${String(ungelesen)} neu` : undefined,
    zeilen: modul.zeilen.slice(0, ZU_TUN_HOECHSTENS).map((zeile) => ({
      titel: zeile.titel.length > 0 ? anrissKuerzen(zeile.titel, 80) : '—',
      meta: anrissKuerzen(zeile.anriss, 80),
      zeit: zeile.zeit === undefined ? '' : vorKurz(Math.max(0, Math.floor((jetzt.getTime() - zeile.zeit.getTime()) / 1000))),
      href: vonUebersicht(`${modulPfad}/${encodeURIComponent(zeile.id)}`),
      neu: zeile.ungelesen,
      status: modulStatusAnsicht(zeile.status, modul.statuswoerter),
    })),
    leer: 'Nichts offen.',
    fuss: { text: modul.offen > 0 ? `Alle ${String(modul.offen)} offenen` : 'Zum Modul', href: vonUebersicht(modulPfad) },
  };
}

export function zuTunAnsicht(eingabe: ZuTunEingabe): ZuTunSpalte[] {
  const { posteingang, module, jetzt } = eingabe;
  if (posteingang === undefined) {
    return [];
  }
  const angeheftet = new Set(module.map((modul) => modul.kennung));
  const spalten = module.map((modul) => modulSpalte(modul, posteingang.postfaecher[modul.kennung] ?? 0, jetzt));
  if (eingabe.nachrichten) {
    const ausAngehefteten = module.reduce((summe, modul) => summe + (posteingang.postfaecher[modul.kennung] ?? 0), 0);
    const anzahl = posteingang.zahlen.chat + posteingang.zahlen.postfach - ausAngehefteten;
    const eintraege = posteingang.eintraege.filter(
      (eintrag) => (eintrag.quelle === 'chat' || eintrag.quelle === 'postfach') && (eintrag.kennung === undefined || !angeheftet.has(eintrag.kennung)),
    );
    spalten.push({
      art: 'nachrichten',
      titel: 'Nachrichten',
      symbol: 'chat',
      zahl: anzahl > 0 ? `${String(anzahl)} neu` : undefined,
      zeilen: eintraege.slice(0, ZU_TUN_HOECHSTENS).map((eintrag) => ({ titel: eintrag.titel, meta: eintrag.herkunft, zeit: eintrag.zeit, href: eintrag.href, neu: true })),
      leer: 'Keine ungelesenen Nachrichten.',
      fuss: { text: 'Zu den Nachrichten', href: '/chat' },
    });
  }
  if (eingabe.freigaben) {
    const anzahl = posteingang.zahlen.freigabe;
    spalten.push({
      art: 'freigaben',
      titel: 'Freigaben',
      symbol: 'haken',
      zahl: anzahl > 0 ? String(anzahl) : undefined,
      zeilen: posteingang.eintraege
        .filter((eintrag) => eintrag.quelle === 'freigabe')
        .slice(0, ZU_TUN_HOECHSTENS)
        .map((eintrag) => ({ titel: eintrag.titel, meta: eintrag.herkunft, zeit: eintrag.zeit, href: eintrag.href, neu: false })),
      leer: 'Nichts wartet auf deine Freigabe.',
      fuss: undefined,
    });
  }
  if (eingabe.pipelineFreigaben !== undefined && eingabe.pipelineFreigaben.length > 0) {
    spalten.push(pipelineSpalte(eingabe.pipelineFreigaben, jetzt));
  }
  return spalten;
}
