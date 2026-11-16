/**
 * Was die Oberfläche über einen Anhang sagt (COPI-110, freigegebener Entwurf): die Zeile der Anhangliste auf der
 * Detailseite und die Sätze der Warnseite. Reine Funktionen; alles hier wird beim Ausgeben maskiert, denn der Dateiname
 * ist Fremdtext.
 */
import { ANHANG_HOECHSTENS_BYTES, groesseText, type AnhangKlasse, type WarnGrund } from './anhang-pruefung.js';
import type { Anhang } from './anhaenge.js';

/** Der kurze Grund in der zweiten Zeile der Liste (farbig, damit die Klasse nie nur an der Farbe hängt). */
const KURZGRUND: Readonly<Record<WarnGrund, string>> = {
  archiv: 'Archiv, Inhalt nicht geprüft',
  makro: 'Kann Makros enthalten',
  web: 'Kann Skripte enthalten',
  widerspruch: 'Endung passt nicht zum Inhalt',
};

export interface AnhangZeileAnsicht {
  readonly id: string;
  readonly name: string;
  readonly klasse: AnhangKlasse;
  /** „PDF · 412 KB" bzw. beim Widerspruch „Inhalt: ZIP-Archiv · 88 KB". */
  readonly meta: string;
  readonly grund: string | undefined;
  /** Die Warnseite; nur bei `normal` und `warnung`. */
  readonly href: string | undefined;
  /** Welches Symbol die Zeile trägt (`views/partials/symbol.eta`). */
  readonly symbol: 'datei' | 'archiv' | 'schloss' | 'posteingang';
}

/** Die Größe, die die Seite zeigt: gemessen, wenn der Inhalt da ist, sonst die Angabe des Absenders. */
function groesse(anhang: Anhang): number {
  return anhang.laenge ?? anhang.groesse;
}

function postfachGrund(anhang: Anhang): string {
  return groesse(anhang) > ANHANG_HOECHSTENS_BYTES ? 'Zu groß fürs Cockpit, liegt im Postfach' : 'Liegt im Postfach';
}

export function anhangMeta(anhang: Anhang): string {
  const { einstufung } = anhang;
  const art = einstufung.warnGrund === 'widerspruch' ? `Inhalt: ${einstufung.art}` : einstufung.art;
  return `${art} · ${groesseText(groesse(anhang))}`;
}

export function anhangZeileAnsicht(anhang: Anhang, warnseite: string): AnhangZeileAnsicht {
  const { klasse, warnGrund } = anhang.einstufung;
  const ladbar = klasse === 'normal' || klasse === 'warnung';
  return {
    id: anhang.id,
    name: anhang.dateiname,
    klasse,
    meta: anhangMeta(anhang),
    grund: klasse === 'gesperrt' ? 'Gesperrt, liegt im Postfach' : klasse === 'postfach' ? postfachGrund(anhang) : warnGrund === undefined ? undefined : KURZGRUND[warnGrund],
    href: ladbar ? warnseite : undefined,
    symbol: klasse === 'gesperrt' ? 'schloss' : klasse === 'postfach' ? 'posteingang' : klasse === 'warnung' ? 'archiv' : 'datei',
  };
}

/** Die starke Warnung der Warnseite: Überschrift und Satz je Grund. */
export function starkeWarnung(anhang: Anhang): { readonly titel: string; readonly text: string } | undefined {
  const { warnGrund, art, endungsArt } = anhang.einstufung;
  switch (warnGrund) {
    case 'archiv':
      return {
        titel: 'Archiv: kann Programme und Makros enthalten.',
        text: 'Das Cockpit sieht nicht in Archive hinein. Entpacken und öffnen Sie es nur auf einem aktuellen, geschützten Rechner.',
      };
    case 'makro':
      return {
        titel: 'Office-Datei, die Makros enthalten kann.',
        text: 'Makros können beim Öffnen Programme starten. Öffnen Sie die Datei nur, wenn Sie sie erwartet haben, und lassen Sie Makros ausgeschaltet.',
      };
    case 'web':
      return {
        titel: 'Webseite oder Grafik, die Skripte enthalten kann.',
        text: 'Im Browser geöffnet, kann sie Skripte ausführen und Anmeldeseiten nachahmen. Geben Sie nie Zugangsdaten in eine solche Datei ein.',
      };
    case 'widerspruch':
      return {
        titel: 'Die Endung passt nicht zum Inhalt.',
        text:
          art === endungsArt
            ? `Der Name sagt „${endungsArt}“, der Inhalt passt aber nicht dazu. Das ist ein typisches Merkmal von Schadmails.`
            : `Der Name sagt „${endungsArt}“, der Inhalt ist aber „${art}“. Das ist ein typisches Merkmal von Schadmails.`,
      };
    case undefined:
      return undefined;
  }
}
