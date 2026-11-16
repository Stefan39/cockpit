/**
 * Woher Version und Digest des laufenden Cockpits kommen (COPI-39) — die Dateien passen zueinander.
 *
 * Die Kette hat drei Enden, die niemand zusammen sieht: das Dockerfile backt die Version ein, der Release-Workflow
 * liefert sie, die Compose-Datei der Instanz setzt den Digest. Fehlt ein Glied, meldet das Cockpit „lokal" oder
 * keinen Digest, und ein Update ließe sich nie bestätigen (COPI-41) — ohne dass ein Build scheitert. Dieser Test
 * prüft die Konfiguration, er baut nichts. Dass das Image die Werte wirklich meldet, prüft der Smoke-Test in der
 * CI (Gate 6, `docker/smoke-schema.sh`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const lesen = (pfad: string): string => readFileSync(pfad, 'utf8');

/** Der letzte Stage des Dockerfiles: der, aus dem das ausgelieferte Image besteht. */
function laufzeitStage(dockerfile: string): string {
  const teile = dockerfile.split(/^FROM /m);
  return teile[teile.length - 1] ?? '';
}

describe('Dockerfile', () => {
  const dockerfile = lesen('docker/Dockerfile');
  const laufzeit = laufzeitStage(dockerfile);

  it('baut aus dem Stage „runtime" aus', () => {
    expect(laufzeit).toMatch(/^base AS runtime\b/);
  });

  it.each(['COCKPIT_VERSION', 'COCKPIT_COMMIT'])('nimmt %s als Build-Argument im Laufzeit-Stage und reicht es als Umgebung weiter', (name) => {
    // Ein ARG gilt nur in seinem Stage: in einem Build-Stage käme es nie im ausgelieferten Image an.
    expect(laufzeit).toMatch(new RegExp(`^ARG ${name}=""$`, 'm'));
    expect(laufzeit).toMatch(new RegExp(`^ENV ${name}=\\$${name}$`, 'm'));
  });

  it('backt keinen Digest ein: den kennt das Image nicht', () => {
    expect(dockerfile).not.toMatch(/^(?:ARG|ENV)\s+COCKPIT_IMAGE_DIGEST/m);
  });
});

describe('Release-Workflow', () => {
  const release = lesen('.github/workflows/release.yaml');

  it('übergibt die geprüfte Version aus package.json und den Commit als Build-Argumente', () => {
    // Seit COPI-49 kommt die Version aus package.json und nicht mehr aus einem von Hand gesetzten Tag; den Tag
    // legt der Workflow erst nach dem Push an.
    expect(release).toContain('COCKPIT_VERSION=${{ needs.version.outputs.version }}');
    expect(release).toContain('COCKPIT_COMMIT=${{ github.sha }}');
  });

  it('veröffentlicht nur, was die Release-Entscheidung als neu meldet', () => {
    expect(release).toContain("sh .github/scripts/release-version.sh");
    for (const schritt of ['docker/build-push-action', 'gh release create']) {
      // Seit COPI-86 in eigenen Jobs: jeder hängt an der Entscheidung des Jobs `version`.
      expect(release.slice(0, release.indexOf(schritt))).toContain("if: needs.version.outputs.stand == 'neu'");
    }
    expect(release.match(/if: needs\.version\.outputs\.stand == 'neu'/g)).toHaveLength(2);
  });

  it('gibt dem Image genau ein Tag, die Version: Instanzen ziehen nie ein bewegliches Tag', () => {
    // Seit COPI-86 bekommt erst das Manifest das Tag; die Einzel-Images sind nur per Digest gepusht.
    expect(release).toContain('imagetools create -t "$BILD:$VERSION"');
    expect(release).toContain('push-by-digest=true');
    expect(release).not.toMatch(/type=semver|value=latest|:latest/);
  });

  it('baut amd64 und arm64 je nativ und fasst beide zu einem Manifest zusammen (COPI-86)', () => {
    expect(release).toMatch(/plattform: linux\/amd64\s+runner: ubuntu-latest/);
    expect(release).toMatch(/plattform: linux\/arm64\s+runner: ubuntu-24\.04-arm/);
    expect(release).toContain('platforms: ${{ matrix.plattform }}');
    // Ohne beide Digests kein Manifest: ein halbes Release wäre für eine der Architekturen kaputt.
    expect(release).toContain('test "$#" -eq 2');
  });

  it('lässt den Versions-Check und den amd64-Build auf dem Runner aus CI_RUNS_ON laufen (JAC-770)', () => {
    // Der Versions-Check läuft nach jedem Merge auf main; auf GitHub kostete er jedes Mal Actions-Minuten.
    const version = release.slice(release.indexOf('name: Version prüfen'), release.indexOf('outputs:'));
    expect(version).toContain(`runs-on: \${{ fromJSON(vars.CI_RUNS_ON || '"ubuntu-latest"') }}`);
    expect(release).toContain("runs-on: ${{ matrix.runner == 'ubuntu-latest' && fromJSON(vars.CI_RUNS_ON || '\"ubuntu-latest\"') || matrix.runner }}");
    expect(release).toContain('docker logout ghcr.io');
  });

  it('liest die Version ohne node: auf der devbox gibt es keins (JAC-770)', () => {
    const version = release.slice(release.indexOf('name: Version prüfen'), release.indexOf('bauen:'));
    expect(version).not.toMatch(/\bnode\b -p|setup-node/);
    expect(version).toContain('package.json');
  });
});

describe('CI (Gate 6)', () => {
  const ci = lesen('.github/workflows/ci.yaml');

  it('baut das Prüf-Image mit denselben Build-Argumenten', () => {
    expect(ci).toMatch(/COCKPIT_VERSION=0\.0\.0-ci/);
    expect(ci).toContain('COCKPIT_COMMIT=${{ github.sha }}');
  });

  it('lässt den Smoke-Test die gemeldete Version prüfen', () => {
    expect(ci).toMatch(/SMOKE_VERSION="0\.0\.0-ci\+\$\{GITHUB_SHA:0:7\}" sh docker\/smoke-schema\.sh/);
  });
});

describe('Compose-Fragment der Instanz', () => {
  const fragment = lesen('docker/compose.fragment.yaml');

  it('setzt COCKPIT_IMAGE_DIGEST mit genau dem Platzhalter der image-Zeile: beide stimmen immer überein', () => {
    const imageZeile = /^\s+image: ghcr\.io\/stefan39\/cockpit@(\S+)$/m.exec(fragment)?.[1];
    const digestZeile = /^\s+COCKPIT_IMAGE_DIGEST: "([^"]+)"$/m.exec(fragment)?.[1];

    expect(imageZeile).toBe('<DIGEST>');
    expect(digestZeile).toBe(imageZeile);
  });

  it('setzt weder Version noch Commit: die trägt das Image selbst', () => {
    expect(fragment).not.toMatch(/COCKPIT_VERSION|COCKPIT_COMMIT/);
  });
});

describe('Anwendung', () => {
  it.each(['COCKPIT_VERSION', 'COCKPIT_COMMIT', 'COCKPIT_IMAGE_DIGEST'])('liest %s unter genau diesem Namen', (name) => {
    expect(lesen('src/server/env.ts')).toContain(`process.env.${name}`);
  });
});
