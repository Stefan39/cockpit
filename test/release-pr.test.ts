/**
 * Der Release-PR entsteht von selbst (COPI-236): Nach jedem Merge auf main entscheidet .github/scripts/release-pr.sh,
 * ob ein Release-PR angelegt, aktualisiert oder nichts getan wird. Der Release-PR wird per Merge-Commit gemergt, sein
 * Head-Commit beginnt also nicht mit "release: " — den Rest übernimmt die Versionsprüfung. Geprüft wird das Skript
 * selbst, in echten Git-Repos, so wie der Workflow es aufruft. Die GitHub-Aufrufe (`anwenden`) laufen nur dort.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SKRIPT = resolve('.github/scripts/release-pr.sh');
const verzeichnisse: string[] = [];

afterEach(() => {
  for (const wo of verzeichnisse.splice(0)) rmSync(wo, { recursive: true, force: true });
});

function git(wo: string, ...args: string[]): string {
  const lauf = spawnSync('git', args, { cwd: wo, encoding: 'utf8' });
  if (lauf.status !== 0) throw new Error(`git ${args.join(' ')}: ${lauf.stderr}`);
  return lauf.stdout.trim();
}

function schreibeVersion(wo: string, version: string) {
  writeFileSync(join(wo, 'package.json'), `{\n  "name": "cockpit",\n  "version": "${version}",\n  "private": true\n}\n`);
  writeFileSync(
    join(wo, 'package-lock.json'),
    [
      '{',
      '  "name": "cockpit",',
      `  "version": "${version}",`,
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": {',
      '      "name": "cockpit",',
      `      "version": "${version}",`,
      '      "license": "UNLICENSED"',
      '    },',
      '    "node_modules/gleich": {',
      `      "version": "${version}",`,
      '      "license": "MIT"',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
}

function commit(wo: string, betreff: string, text?: string) {
  git(wo, 'commit', '--allow-empty', '-q', '-m', betreff, ...(text ? ['-m', text] : []));
}

// Ein Repo auf main mit dem ersten Commit, getaggt als v<version> (wie nach einem Release).
function repoMitRelease(version: string): string {
  const wo = mkdtempSync(join(tmpdir(), 'release-pr-'));
  verzeichnisse.push(wo);
  git(wo, 'init', '-q', '-b', 'main');
  git(wo, 'config', 'user.name', 'Test');
  git(wo, 'config', 'user.email', 'test@example.invalid');
  git(wo, 'config', 'commit.gpgsign', 'false');
  schreibeVersion(wo, version);
  git(wo, 'add', '.');
  commit(wo, `Ausgangsstand v${version}`);
  git(wo, 'tag', `v${version}`);
  return wo;
}

function skript(wo: string, args: string[], eingabe?: string) {
  const lauf = spawnSync('sh', [SKRIPT, ...args], { cwd: wo, encoding: 'utf8', input: eingabe });
  return { code: lauf.status, ausgabe: lauf.stdout.trim(), fehler: lauf.stderr.trim() };
}

function plan(wo: string): Record<string, string> {
  const lauf = skript(wo, ['plan']);
  expect(lauf.code, lauf.fehler).toBe(0);
  return Object.fromEntries(
    lauf.ausgabe.split('\n').map((zeile) => {
      const i = zeile.indexOf('=');
      return [zeile.slice(0, i), zeile.slice(i + 1)];
    }),
  );
}

describe('Release-PR: Entscheidung', () => {
  it('legt einen Release-PR mit Minor-Sprung an, wenn es neue Commits gibt', () => {
    const wo = repoMitRelease('0.40.0');
    commit(wo, 'Merge pull request #266 from Stefan39/feature/COPI-1', 'COPI-1: Titel');

    expect(plan(wo)).toEqual({ aktion: 'anlegen', version: '0.41.0', letzter: '0.40.0' });
  });

  it('springt über zweistellige Minor-Versionen als Zahl, nicht als Text', () => {
    const wo = repoMitRelease('0.9.3');
    commit(wo, 'Merge pull request #2 from Stefan39/feature/COPI-2');

    expect(plan(wo)).toMatchObject({ aktion: 'anlegen', version: '0.10.0' });
  });

  it('tut nichts, wenn es seit dem letzten Tag keine neuen Commits gibt', () => {
    const wo = repoMitRelease('0.40.0');

    expect(plan(wo)).toMatchObject({ aktion: 'nichts', grund: expect.stringContaining('keine neuen Commits') });
  });

  it('tut nichts, solange die Version in package.json noch keinen Tag hat (Release läuft)', () => {
    const wo = repoMitRelease('0.40.0');
    schreibeVersion(wo, '0.41.0');
    git(wo, 'add', '.');
    commit(wo, 'Merge pull request #267 from Stefan39/release/0.41.0', 'release: 0.41.0');

    expect(plan(wo)).toMatchObject({ aktion: 'nichts', grund: expect.stringContaining('noch keinen Tag') });
  });

  it('tut nichts nach dem Merge des Release-PR, auch wenn der Tag schon da ist und der Commit der Merge war', () => {
    const wo = repoMitRelease('0.40.0');
    schreibeVersion(wo, '0.41.0');
    git(wo, 'add', '.');
    commit(wo, 'Merge pull request #267 from Stefan39/release/0.41.0', 'release: 0.41.0');
    git(wo, 'tag', 'v0.41.0');

    expect(plan(wo)).toMatchObject({ aktion: 'nichts' });
  });

  it('erkennt den Merge eines Release-PR am Betreff, auch ohne neuere Version', () => {
    const wo = repoMitRelease('0.40.0');
    commit(wo, 'Merge pull request #267 from Stefan39/release/0.40.1', 'release: 0.40.1');

    expect(plan(wo)).toMatchObject({ aktion: 'nichts', grund: expect.stringContaining('Release-PR') });
  });

  it('erkennt einen Squash-Commit des Release-PR am Betreff', () => {
    const wo = repoMitRelease('0.40.0');
    commit(wo, 'release: 0.41.0');

    expect(plan(wo)).toMatchObject({ aktion: 'nichts', grund: expect.stringContaining('Release-PR') });
  });

  it('aktualisiert einen offenen Release-PR, statt einen zweiten anzulegen', () => {
    const wo = repoMitRelease('0.40.0');
    commit(wo, 'Merge pull request #266 from Stefan39/feature/COPI-1');
    git(wo, 'update-ref', 'refs/remotes/origin/release/0.41.0', 'HEAD');
    commit(wo, 'Merge pull request #268 from Stefan39/feature/COPI-2');

    expect(plan(wo)).toEqual({ aktion: 'aktualisieren', version: '0.41.0', letzter: '0.40.0' });
  });

  it('übergeht Release-Zweige veröffentlichter Versionen', () => {
    const wo = repoMitRelease('0.40.0');
    git(wo, 'update-ref', 'refs/remotes/origin/release/0.40.0', 'HEAD');
    git(wo, 'update-ref', 'refs/remotes/origin/release/0.9.0', 'HEAD');
    git(wo, 'update-ref', 'refs/remotes/origin/release/v0.12.0', 'HEAD');
    commit(wo, 'Merge pull request #266 from Stefan39/feature/COPI-1');

    expect(plan(wo)).toMatchObject({ aktion: 'anlegen', version: '0.41.0' });
  });

  it('tut nichts, solange es noch kein Release-Tag gibt', () => {
    const wo = repoMitRelease('0.1.0');
    git(wo, 'tag', '-d', 'v0.1.0');

    expect(plan(wo)).toMatchObject({ aktion: 'nichts', grund: expect.stringContaining('noch kein Release-Tag') });
  });

  it('bricht bei einer Version ab, die keine Release-Version ist', () => {
    const wo = repoMitRelease('0.40.0');
    schreibeVersion(wo, '1.0.0-rc.1');

    const lauf = skript(wo, ['plan']);

    expect(lauf.code).toBe(1);
    expect(lauf.fehler).toContain('keine Release-Version');
  });
});

describe('Release-PR: Liste der gemergten PRs', () => {
  it('nennt Merge-Commits mit Nummer und Titel, Squash-Commits mit dem Betreff', () => {
    const wo = repoMitRelease('0.40.0');
    commit(wo, 'Merge pull request #264 from Stefan39/bundle/20261108-5', 'Bündel 20261108-5: COPI-240');
    commit(wo, 'COPI-9: Einzelner Commit (#265)');
    commit(wo, 'Merge pull request #266 from Stefan39/feature/COPI-234', 'COPI-234: Preis-Trigger');

    expect(skript(wo, ['liste', '0.40.0']).ausgabe.split('\n')).toEqual([
      '- #266 COPI-234: Preis-Trigger',
      '- COPI-9: Einzelner Commit (#265)',
      '- #264 Bündel 20261108-5: COPI-240',
    ]);
  });

  it('lässt den Release-PR selbst weg und nimmt nur Commits seit dem Tag', () => {
    const wo = repoMitRelease('0.40.0');
    commit(wo, 'Merge pull request #265 from Stefan39/release/0.40.0', 'release: 0.40.0');
    commit(wo, 'release: 0.40.1');
    commit(wo, 'Merge pull request #270 from Stefan39/feature/COPI-5', 'COPI-5: Neu');

    expect(skript(wo, ['liste', '0.40.0']).ausgabe).toBe('- #270 COPI-5: Neu');
  });

  it('fällt auf den Betreff zurück, wenn der Merge-Commit keinen Titel trägt', () => {
    const wo = repoMitRelease('0.40.0');
    commit(wo, 'Merge pull request #271 from Stefan39/feature/COPI-6');

    expect(skript(wo, ['liste', '0.40.0']).ausgabe).toBe('- #271 Merge pull request #271 from Stefan39/feature/COPI-6');
  });
});

describe('Release-PR: Version anheben', () => {
  it('ändert package.json einmal und package-lock.json zweimal, nicht die gleiche Version einer Abhängigkeit', () => {
    const wo = repoMitRelease('0.40.0');

    expect(skript(wo, ['anheben', '0.40.0', '0.41.0']).code).toBe(0);

    expect(readFileSync(join(wo, 'package.json'), 'utf8')).toBe(
      '{\n  "name": "cockpit",\n  "version": "0.41.0",\n  "private": true\n}\n',
    );
    const lock = readFileSync(join(wo, 'package-lock.json'), 'utf8');
    expect(lock.split('\n').filter((zeile) => zeile.includes('"version": "0.41.0"'))).toHaveLength(2);
    expect(lock).toContain('    "node_modules/gleich": {\n      "version": "0.40.0",');
  });

  it('bricht ab und lässt die Dateien unverändert, wenn die alte Version nicht dort steht', () => {
    const wo = repoMitRelease('0.40.0');
    const vorher = readFileSync(join(wo, 'package.json'), 'utf8');

    const lauf = skript(wo, ['anheben', '0.39.0', '0.41.0']);

    expect(lauf.code).toBe(1);
    expect(lauf.fehler).toContain('nicht an den erwarteten Stellen');
    expect(readFileSync(join(wo, 'package.json'), 'utf8')).toBe(vorher);
    expect(git(wo, 'status', '--short')).toBe('');
  });
});

describe('Release-PR: Text als JSON', () => {
  it('maskiert Anführungszeichen, Backslashes und Zeilenumbrüche', () => {
    const wo = repoMitRelease('0.40.0');
    const text = 'Zeile "eins" mit \\ Backslash\n\n- #1 Titel mit Umlauten: Bündel äöü\n  eingerückt';

    expect(JSON.parse(skript(wo, ['json'], text).ausgabe)).toBe(text);
  });
});

describe('Release-PR: Aufruf', () => {
  it('zeigt die Nutzung bei einem unbekannten Unterbefehl', () => {
    const lauf = skript(repoMitRelease('0.40.0'), ['unbekannt']);

    expect(lauf.code).toBe(2);
    expect(lauf.fehler).toContain('Nutzung');
  });

  it('verlangt für anwenden das Token', () => {
    const lauf = spawnSync('sh', [SKRIPT, 'anwenden'], {
      cwd: repoMitRelease('0.40.0'),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });

    expect(lauf.status).not.toBe(0);
    expect(lauf.stderr).toContain('GH_TOKEN fehlt');
  });
});

describe('Release-PR: Antworten der GitHub-API lesen', () => {
  const PR = { url: 'https://api.github.com/repos/o/r/pulls/273', number: 273, html_url: 'https://github.com/o/r/pull/273', user: { id: 1 }, head: { repo: { id: 7 } } };
  const kompakt = JSON.stringify([PR]);
  const eingerueckt = JSON.stringify([PR], null, 2);

  function lies(befehl: string, eingabe: string) {
    const lauf = spawnSync('sh', [SKRIPT, befehl], { encoding: 'utf8', input: eingabe });
    return { code: lauf.status, aus: lauf.stdout.trim() };
  }

  it.each([
    ['kompakt (User-Agent ohne curl)', kompakt],
    ['eingerückt (curl)', eingerueckt],
  ])('findet die PR-Nummer in einer Liste, %s', (_name, antwort) => {
    expect(lies('nummer', antwort)).toEqual({ code: 0, aus: '273' });
  });

  it.each([
    ['kompakt', JSON.stringify(PR)],
    ['eingerückt', JSON.stringify(PR, null, 2)],
  ])('findet die PR-Adresse in der Antwort auf das Anlegen, %s', (_name, antwort) => {
    expect(lies('url', antwort)).toEqual({ code: 0, aus: 'https://github.com/o/r/pull/273' });
  });

  it('liefert nichts bei einer leeren Liste', () => {
    expect(lies('nummer', '[]')).toEqual({ code: 0, aus: '' });
  });
});
