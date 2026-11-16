/**
 * Die Views halten die strenge CSP ein (COPI-93): kein Inline-Skript, kein Inline-Stil, keine Ereignis-Attribute,
 * keine `javascript:`-Links und keine fremden Quellen. Der Browser würde all das unter der CSP stumm blockieren — hier
 * fällt es schon beim Schreiben der Seite auf.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const VIEWS = path.join(import.meta.dirname, '..', 'views');

function etaDateien(ordner: string): string[] {
  return readdirSync(ordner, { withFileTypes: true, recursive: true })
    .filter((eintrag) => eintrag.isFile() && eintrag.name.endsWith('.eta'))
    .map((eintrag) => path.relative(VIEWS, path.join(eintrag.parentPath, eintrag.name)));
}

const VERSTOESSE: readonly (readonly [string, RegExp])[] = [
  ['Inline-Skript', /<script(?![^>]*\ssrc=)[^>]*>/i],
  ['Inline-Stil', /<style[\s>]/i],
  ['style-Attribut', /\sstyle\s*=/i],
  ['Ereignis-Attribut', /\son[a-z]+\s*=/i],
  ['javascript:-Link', /javascript:/i],
  ['fremde Quelle', /\s(?:src|href|action)\s*=\s*["']?(?:https?:)?\/\//i],
];

const dateien = etaDateien(VIEWS);

describe('Views unter der CSP', () => {
  it('findet die Views', () => {
    expect(dateien.length).toBeGreaterThan(20);
    expect(dateien).toContain('layout.eta');
  });

  it.each(dateien)('%s', (datei) => {
    const inhalt = readFileSync(path.join(VIEWS, datei), 'utf8');
    for (const [art, muster] of VERSTOESSE) {
      expect(inhalt.match(muster)?.[0], `${art} in ${datei}`).toBeUndefined();
    }
  });

  it.each([
    ['ein Inline-Skript', '<script>alert(1)</script>'],
    ['ein Modul-Skript ohne Quelle', '<script type="module">x()</script>'],
    ['ein style-Attribut', '<div style="color:red">'],
    ['ein onclick', '<button onclick="x()">'],
    ['eine fremde Quelle', '<img src="https://boese.example/x.png">'],
    ['eine protokollrelative Quelle', '<script src="//boese.example/x.js"></script>'],
  ])('erkennt %s', (_name, html) => {
    expect(VERSTOESSE.some(([, muster]) => muster.test(html))).toBe(true);
  });

  it('lässt ein Skript mit eigener Quelle durch', () => {
    expect(VERSTOESSE.some(([, muster]) => muster.test('<script type="module" src="/pwa.js"></script>'))).toBe(false);
  });
});
