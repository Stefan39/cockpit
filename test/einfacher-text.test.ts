/**
 * Die einfache Formatierung eines Agenten-Textes (COPI-125, `src/module/einfacher-text.ts`): Absätze, Überschriften,
 * Listen — und sonst nichts. Maskiert wird in der Vorlage; hier geht es nur um die Blöcke.
 */
import { describe, expect, it } from 'vitest';
import { textBloecke, type TextTeil } from '../src/module/einfacher-text.js';

/** Ein Text ohne Betonung, wie ihn jeder Block ohne `betonung` trägt. */
const t = (text: string): TextTeil[] => [{ text, fett: false, kursiv: false }];

describe('textBloecke', () => {
  it('macht aus Leerzeilen Absätze, aus „## " Überschriften und aus „* "-Zeilen Listen', () => {
    expect(textBloecke('Einstieg\nzweite Zeile\n\n## Warum\n\nText\n\n* eins\n* zwei\n\n### Fazit\nSchluss.')).toEqual([
      { art: 'absatz', text: t('Einstieg\nzweite Zeile') },
      { art: 'ueberschrift', text: t('Warum') },
      { art: 'absatz', text: t('Text') },
      { art: 'liste', punkte: [t('eins'), t('zwei')] },
      { art: 'ueberschrift', text: t('Fazit') },
      { art: 'absatz', text: t('Schluss.') },
    ]);
  });

  it('lässt alles andere als Text stehen: „#Hashtag", „# H1", Links und HTML', () => {
    expect(textBloecke('#Passkeys #Mittelstand')).toEqual([{ art: 'absatz', text: t('#Passkeys #Mittelstand') }]);
    expect(textBloecke('# Groß')).toEqual([{ art: 'absatz', text: t('# Groß') }]);
    expect(textBloecke('[Link](https://boese.example) <b>fett</b>')).toEqual([{ art: 'absatz', text: t('[Link](https://boese.example) <b>fett</b>') }]);
  });

  it('macht eine gemischte Zeilengruppe nicht zur Liste und versteht „- " und Windows-Zeilenenden', () => {
    expect(textBloecke('* eins\nkein Punkt')).toEqual([{ art: 'absatz', text: t('* eins\nkein Punkt') }]);
    expect(textBloecke('- a\r\n- b')).toEqual([{ art: 'liste', punkte: [t('a'), t('b')] }]);
    expect(textBloecke('\n\n  \n')).toEqual([]);
  });

  it('kennt ohne Betonung kein fett und kursiv: „**" bleibt im Entwurf sichtbar', () => {
    expect(textBloecke('**fett** und *kursiv*')).toEqual([{ art: 'absatz', text: t('**fett** und *kursiv*') }]);
  });
});

describe('textBloecke mit Betonung (COPI-131)', () => {
  const f = (text: string): TextTeil => ({ text, fett: true, kursiv: false });
  const k = (text: string): TextTeil => ({ text, fett: false, kursiv: true });
  const n = (text: string): TextTeil => ({ text, fett: false, kursiv: false });

  it('macht aus „**x**" und „__x__" fett, aus „*x*" und „_x_" kursiv', () => {
    expect(textBloecke('Das ist **wichtig** und *leise*, __auch__ _so_.', true)).toEqual([
      { art: 'absatz', text: [n('Das ist '), f('wichtig'), n(' und '), k('leise'), n(', '), f('auch'), n(' '), k('so'), n('.')] },
    ]);
  });

  it('betont auch in Überschriften und Listenpunkten, kursiv innerhalb von fett', () => {
    expect(textBloecke('## **Befunde**\n- **Alfred** — Profil\n- *offen*', true)).toEqual([
      { art: 'ueberschrift', text: [f('Befunde')] },
      { art: 'liste', punkte: [[f('Alfred'), n(' — Profil')], [k('offen')]] },
    ]);
    expect(textBloecke('**ganz *sehr* wichtig**', true)).toEqual([
      { art: 'absatz', text: [f('ganz '), { text: 'sehr', fett: true, kursiv: true }, f(' wichtig')] },
    ]);
  });

  it('lässt Unterstriche in Wörtern, Rechenzeichen, offene Marker und Zeilenwechsel stehen', () => {
    expect(textBloecke('snake_case_name und __init__x', true)).toEqual([{ art: 'absatz', text: t('snake_case_name und __init__x') }]);
    expect(textBloecke('2 * 3 * 4 und 5*3*2', true)).toEqual([{ art: 'absatz', text: t('2 * 3 * 4 und 5*3*2') }]);
    expect(textBloecke('**offen und *auch', true)).toEqual([{ art: 'absatz', text: t('**offen und *auch') }]);
    expect(textBloecke('**erste\nzweite**', true)).toEqual([{ art: 'absatz', text: t('**erste\nzweite**') }]);
  });

  it('macht aus HTML und Links nur Text — maskiert wird in der Vorlage, verlinkt nie', () => {
    expect(textBloecke('**<script>alert(1)</script>** [Link](https://boese.example)', true)).toEqual([
      { art: 'absatz', text: [f('<script>alert(1)</script>'), n(' [Link](https://boese.example)')] },
    ]);
  });
});
