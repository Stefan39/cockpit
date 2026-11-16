/**
 * Einfache Formatierung eines Agenten-Textes (COPI-125, Entscheidung Stefan 08.10.2026) — eine reine Funktion. Aus dem
 * Text werden Blöcke: Absätze (durch Leerzeilen getrennt), Überschriften (`## ` am Zeilenanfang, auch `### `) und Listen
 * (jede Zeile beginnt mit `* ` oder `- `). Keine Links, kein HTML. Die Vorlage maskiert jeden Text; Zeilenumbrüche
 * innerhalb eines Absatzes bleiben (CSS `pre-line`).
 *
 * Mit `betonung` (COPI-131, Stefan 09.10.2026, für Langtexte mit `formatierung: einfach`) zusätzlich **fett**
 * (`**x**`, `__x__`) und *kursiv* (`*x*`, `_x_`), nie über eine Zeile hinaus. Ein Unterstrich zählt nur an
 * Wortgrenzen (`snake_case` bleibt), ein offener Marker bleibt Text. Entwürfe bekommen das nicht: ein `**` im Post
 * soll sichtbar bleiben, weil es dort niemand rendert.
 */

/** Ein Stück Text mit seiner Betonung; ohne `betonung` ist jeder Text genau ein Stück ohne beides. */
export interface TextTeil {
  readonly text: string;
  readonly fett: boolean;
  readonly kursiv: boolean;
}

export type TextBlock =
  | { readonly art: 'ueberschrift'; readonly text: readonly TextTeil[] }
  | { readonly art: 'liste'; readonly punkte: readonly (readonly TextTeil[])[] }
  | { readonly art: 'absatz'; readonly text: readonly TextTeil[] };

const UEBERSCHRIFT = /^#{2,3} +(.+)$/;
const PUNKT = /^[*-] +(.+)$/;

const FETT = /\*\*(?=\S)([^\n]*?\S)\*\*|(?<![\p{L}\p{N}_])__(?=\S)([^\n]*?\S)__(?![\p{L}\p{N}_])/gu;
const KURSIV = /(?<![\p{L}\p{N}*])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_(?=[^\s_])([^\n_]*?[^\s_])_(?![\p{L}\p{N}_])/gu;

/** Zerlegt ein Stück an einem Marker: Treffer bekommen `art`, der Rest bleibt, wie er war. */
function zerlegen(teil: TextTeil, muster: RegExp, art: 'fett' | 'kursiv'): TextTeil[] {
  const teile: TextTeil[] = [];
  let ab = 0;
  for (const treffer of teil.text.matchAll(muster)) {
    const innen = treffer[1] ?? treffer[2] ?? '';
    teile.push({ ...teil, text: teil.text.slice(ab, treffer.index) }, { ...teil, text: innen, [art]: true });
    ab = treffer.index + treffer[0].length;
  }
  teile.push({ ...teil, text: teil.text.slice(ab) });
  return teile.filter((stueck) => stueck.text !== '');
}

function teileAus(text: string, betonung: boolean): readonly TextTeil[] {
  const ganz: TextTeil = { text, fett: false, kursiv: false };
  if (!betonung) {
    return [ganz];
  }
  return zerlegen(ganz, FETT, 'fett').flatMap((teil) => zerlegen(teil, KURSIV, 'kursiv'));
}

/** Teilt einen Block in Überschrift und Rest, wenn er mit einer Überschrift beginnt („## Fazit\nText ..."). */
function bloeckeAus(roh: string, betonung: boolean): TextBlock[] {
  const zeilen = roh.split('\n');
  const erste = zeilen[0] ?? '';
  const ueberschrift = UEBERSCHRIFT.exec(erste.trim());
  if (ueberschrift?.[1] !== undefined) {
    const rest = zeilen.slice(1).join('\n').trim();
    return [{ art: 'ueberschrift', text: teileAus(ueberschrift[1].trim(), betonung) }, ...(rest === '' ? [] : bloeckeAus(rest, betonung))];
  }
  const punkte = zeilen.map((zeile) => PUNKT.exec(zeile.trim())?.[1]);
  if (punkte.every((punkt) => punkt !== undefined)) {
    return [{ art: 'liste', punkte: punkte.map((punkt) => teileAus((punkt ?? '').trim(), betonung)) }];
  }
  return [{ art: 'absatz', text: teileAus(roh, betonung) }];
}

export function textBloecke(text: string, betonung = false): TextBlock[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .flatMap((block) => bloeckeAus(block, betonung));
}
