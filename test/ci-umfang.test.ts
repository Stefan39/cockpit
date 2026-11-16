/**
 * Welche Gates ein PR braucht (COPI-179): die CI liest die geänderten Dateien und entscheidet, ob die Tests
 * und der Docker-Build (Gate 6) laufen. Geprüft wird das Skript selbst, so wie der Workflow es aufruft.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SKRIPT = '.github/scripts/ci-umfang.sh';

function umfang(dateien: string[]) {
  const lauf = spawnSync('sh', [SKRIPT], { input: dateien.join('\n'), encoding: 'utf8' });
  return { code: lauf.status, ausgabe: lauf.stdout.trim().split('\n') };
}

describe('CI-Umfang', () => {
  it('lässt bei reiner Markdown-Doku Tests und Docker-Build weg', () => {
    expect(umfang(['README.md', 'docs/pipeline-api.md', 'docs/adr/0002-freigabe-direkt.md', 'AGENTS.md'])).toEqual({
      code: 0,
      ausgabe: ['tests=false', 'docker=false'],
    });
  });

  it('testet, wenn Beispiele unter docs/ geändert sind: Datenbanktests lesen die Views und YAML-Blöcke', () => {
    expect(umfang(['docs/beispiele/v_modul_akquise.sql', 'docs/agenten-api.md']).ausgabe).toEqual([
      'tests=true',
      'docker=false',
    ]);
  });

  it('testet ohne Docker-Build, wenn nur Tests oder Werkzeuge geändert sind', () => {
    expect(umfang(['test/assets.test.ts', 'scripts/dev/x.sh', 'eslint.config.js']).ausgabe).toEqual([
      'tests=true',
      'docker=false',
    ]);
  });

  it.each([
    ['src/server/app.ts'],
    ['views/layout.eta'],
    ['assets/app.css'],
    ['db/migrations/0040_x.sql'],
    ['docker/Dockerfile'],
    ['package.json'],
    ['package-lock.json'],
    ['config/cockpit.default.yaml'],
    ['tsconfig.build.json'],
    ['.dockerignore'],
    ['.github/workflows/ci.yaml'],
  ])('baut das Image, wenn %s geändert ist', (datei) => {
    expect(umfang(['README.md', datei]).ausgabe).toEqual(['tests=true', 'docker=true']);
  });

  it('prüft alles, wenn die Änderungen nicht bekannt sind', () => {
    expect(umfang([]).ausgabe).toEqual(['tests=true', 'docker=true']);
  });
});

describe('CI-Umfang im Workflow', () => {
  function imWorkflow(ereignis: string, cwd: string) {
    const lauf = spawnSync('sh', [path.resolve(SKRIPT), ereignis], { cwd, input: 'README.md', encoding: 'utf8' });
    return lauf.stdout.trim().split('\n');
  }

  it('vergleicht bei pull_request den Merge-Commit mit main', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'ci-umfang-'));
    const git = (...argumente: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...argumente], { cwd: repo });
    git('init', '-q');
    writeFileSync(path.join(repo, 'a.ts'), '');
    git('add', '.');
    git('commit', '-qm', 'main');
    writeFileSync(path.join(repo, 'README.md'), '');
    git('add', '.');
    git('commit', '-qm', 'pr');

    expect(imWorkflow('pull_request', repo)).toEqual(['tests=false', 'docker=false']);
  });

  it('prüft beim Start von Hand alles, ohne stdin zu lesen', () => {
    expect(imWorkflow('workflow_dispatch', tmpdir())).toEqual(['tests=true', 'docker=true']);
  });
});
