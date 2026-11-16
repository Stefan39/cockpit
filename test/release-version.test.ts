/**
 * Die Entscheidung des Release-Workflows (COPI-49): wird der Stand auf main ein Release? Die Version aus
 * package.json wird genau dann veröffentlicht, wenn es ihren Tag noch nicht gibt und sie nicht kleiner ist als
 * das jüngste Release. Geprüft wird das Skript selbst, so wie der Workflow es aufruft.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SKRIPT = '.github/scripts/release-version.sh';

function entscheiden(version: string, tags: string[] = [], ...weitere: string[]) {
  const lauf = spawnSync('sh', [SKRIPT, version, ...weitere], { input: tags.join('\n'), encoding: 'utf8' });
  return { code: lauf.status, ausgabe: lauf.stdout.trim(), fehler: lauf.stderr.trim() };
}

describe('Release-Entscheidung', () => {
  it('veröffentlicht die erste Version, wenn es noch kein Release gibt', () => {
    expect(entscheiden('0.1.0')).toEqual({ code: 0, ausgabe: 'neu', fehler: '' });
  });

  it('veröffentlicht eine angehobene Version', () => {
    expect(entscheiden('0.2.0', ['v0.1.0', 'v0.1.1'])).toMatchObject({ code: 0, ausgabe: 'neu' });
  });

  it('tut nichts, wenn die Version schon veröffentlicht ist', () => {
    expect(entscheiden('0.1.0', ['v0.1.0'])).toMatchObject({ code: 0, ausgabe: 'vorhanden' });
  });

  it('vergleicht die Teile als Zahlen, nicht als Text', () => {
    expect(entscheiden('0.10.0', ['v0.9.3'])).toMatchObject({ code: 0, ausgabe: 'neu' });
    expect(entscheiden('0.9.4', ['v0.10.0'])).toMatchObject({ code: 1 });
  });

  it('lehnt eine Version ab, die kleiner ist als das jüngste Release', () => {
    const ergebnis = entscheiden('0.1.5', ['v0.2.0', 'v0.1.0']);

    expect(ergebnis.code).toBe(1);
    expect(ergebnis.ausgabe).toBe('');
    expect(ergebnis.fehler).toContain('kleiner als das jüngste Release v0.2.0');
  });

  it('übergeht Tags, die keine Releases sind', () => {
    expect(entscheiden('0.1.0', ['v9.9.9-rc.1', 'test', 'v1.0', 'x1.0.0'])).toMatchObject({ code: 0, ausgabe: 'neu' });
  });

  it.each([['1.0.0-rc.1'], ['v0.1.0'], ['0.1'], ['01.0.0'], ['0.1.0+abc'], ['']])(
    'lehnt „%s“ als Release-Version ab',
    (version) => {
      const ergebnis = entscheiden(version);

      expect(ergebnis.code).toBe(1);
      expect(ergebnis.fehler).toContain('keine Release-Version');
    },
  );

  it('verlangt genau eine Version', () => {
    expect(entscheiden('0.1.0', [], '0.2.0')).toMatchObject({ code: 2 });
  });

  it('die Version in package.json ist eine Release-Version', () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

    expect(entscheiden(version).code).toBe(0);
  });
});
