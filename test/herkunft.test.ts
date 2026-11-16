/**
 * Die Herkunftsprüfung (COPI-13, COPI-40): die nachsichtige Form für die Anmeldung (ohne Angabe durchlassen) und die
 * strenge für Formulare, die mit einer Sitzung etwas verändern (ohne Angabe abweisen).
 */
import { describe, expect, it } from 'vitest';
import { herkunftBelegt, herkunftErlaubt } from '../src/auth/herkunft.js';

const HOST = 'kunde.example.com';

describe.each([
  ['herkunftErlaubt', herkunftErlaubt, true],
  ['herkunftBelegt', herkunftBelegt, false],
] as const)('%s', (_name, pruefen, ohneAngabe) => {
  it.each<[string, string | undefined, string | undefined, boolean]>([
    ['die eigene Origin', `https://${HOST}`, undefined, true],
    ['die eigene Origin auch über http (lokal)', `http://${HOST}`, undefined, true],
    ['den eigenen Referer', undefined, `https://${HOST}/einstellungen`, true],
    ['eine fremde Origin', 'https://boese.example', undefined, false],
    ['eine Nachbar-Subdomain (same site, aber nicht dieselbe Adresse)', 'https://anderer.example.com', undefined, false],
    ['einen anderen Port', `https://${HOST}:8443`, undefined, false],
    ['„Origin: null"', 'null', undefined, false],
    ['eine fremde Origin, auch wenn der Referer passt (Origin zählt)', 'https://boese.example', `https://${HOST}/`, false],
    ['einen fremden Referer', undefined, 'https://boese.example/seite', false],
  ])('prüft %s', (_fall, origin, referer, erwartet) => {
    expect(pruefen(origin, referer, HOST)).toBe(erwartet);
  });

  it(`antwortet ohne jede Herkunftsangabe mit ${String(ohneAngabe)}`, () => {
    expect(pruefen(undefined, undefined, HOST)).toBe(ohneAngabe);
    expect(pruefen('', undefined, HOST)).toBe(ohneAngabe);
  });

  it('weist eine Angabe ohne eigenen Host ab', () => {
    expect(pruefen(`https://${HOST}`, undefined, undefined)).toBe(false);
    expect(pruefen(`https://${HOST}`, undefined, '')).toBe(false);
  });
});
