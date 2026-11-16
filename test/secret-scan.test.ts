/**
 * Der Secret-Scan (COPI-248): `scripts/secret-scan.sh` meldet ein Geheimnis in einer versionierten Datei mit Fehler und
 * lässt einen sauberen Stand durch. Läuft nur, wenn `gitleaks` installiert ist; die CI prüft den Scan als eigenen Schritt.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const GITLEAKS_DA = spawnSync('gitleaks', ['version']).status === 0;
const verzeichnisse: string[] = [];

afterEach(() => {
  for (const wo of verzeichnisse.splice(0)) rmSync(wo, { recursive: true, force: true });
});

function repo(dateien: Record<string, string>): string {
  const wo = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  verzeichnisse.push(wo);
  mkdirSync(join(wo, 'scripts'));
  copyFileSync(resolve('scripts/secret-scan.sh'), join(wo, 'scripts/secret-scan.sh'));
  copyFileSync(resolve('.gitleaks.toml'), join(wo, '.gitleaks.toml'));
  for (const [name, inhalt] of Object.entries(dateien)) writeFileSync(join(wo, name), inhalt);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: wo, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  return wo;
}

function scan(wo: string) {
  const lauf = spawnSync('sh', ['scripts/secret-scan.sh'], { cwd: wo, encoding: 'utf8' });
  return { code: lauf.status, ausgabe: `${lauf.stdout}${lauf.stderr}` };
}

describe.skipIf(!GITLEAKS_DA)('Secret-Scan', () => {
  // In Teilen zusammengesetzt, damit diese Datei selbst kein Geheimnis enthält.
  const GITHUB_TOKEN = ['ghp', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'].join('_');

  it('lässt einen sauberen Stand durch', () => {
    expect(scan(repo({ 'README.md': 'Nichts Geheimes.\n' })).code).toBe(0);
  });

  it('meldet ein Geheimnis in einer versionierten Datei und nennt den Wert nicht', () => {
    const lauf = scan(repo({ 'konfig.txt': `token = ${GITHUB_TOKEN}\n` }));

    expect(lauf.code).not.toBe(0);
    expect(lauf.ausgabe).toContain('konfig.txt');
    expect(lauf.ausgabe).not.toContain(GITHUB_TOKEN);
  });

  it('ignoriert Dateien, die nicht versioniert sind', () => {
    const wo = repo({ 'README.md': 'Nichts Geheimes.\n', '.gitignore': '.env\n' });
    writeFileSync(join(wo, '.env'), `TOKEN=${GITHUB_TOKEN}\n`);

    expect(scan(wo).code).toBe(0);
  });
});
