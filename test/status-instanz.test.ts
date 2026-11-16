/**
 * Was das Cockpit beim Start über sich meldet (COPI-39) — rein, ohne Datenbank.
 *
 * Klarstellung zur ADR 13.1: ein Image kann seinen eigenen Digest nicht enthalten, er ist ein Hash über den
 * Inhalt. Deshalb:
 *
 *   * die **Version** (SemVer und Commit) wird beim Bauen ins Image gebacken (Build-Argumente
 *     `COCKPIT_VERSION` und `COCKPIT_COMMIT`, `docker/Dockerfile`, `release.yaml`);
 *   * der **Digest** kommt aus der Umgebung (`COCKPIT_IMAGE_DIGEST`, `docker/compose.fragment.yaml`, derselbe
 *     Platzhalter wie in der `image:`-Zeile).
 *
 * Nie wird ein Wert erfunden: ein fehlender oder kaputter Digest ist `undefined` (in der Datenbank NULL), mit
 * einem Hinweis. Ein Update gilt später nur als erledigt, wenn sich ein Cockpit mit dem Ziel-Digest meldet
 * (COPI-41) — ein erfundener Digest könnte das vortäuschen.
 */
import { describe, expect, it } from 'vitest';
import { anzeigeVersion, instanzAngaben, paketVersionLesen } from '../src/status/instanz.js';

const DIGEST = `sha256:${'a1'.repeat(32)}`;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('instanzAngaben — Version', () => {
  it('nimmt die gebackene Version und hängt den Commit (7 Zeichen) als SemVer-Build-Metadatum an', () => {
    const angaben = instanzAngaben({ nodeEnv: 'production', version: '1.4.0', commit: COMMIT, digest: DIGEST }, '0.1.0');

    expect(angaben.version).toBe('1.4.0+0123456');
    expect(angaben.hinweise).toEqual([]);
  });

  it('nimmt auch eine Vorabversion an', () => {
    expect(instanzAngaben({ nodeEnv: 'production', version: '2.0.0-rc.1', commit: COMMIT, digest: DIGEST }, '0.1.0').version).toBe(
      '2.0.0-rc.1+0123456',
    );
  });

  it('nimmt ohne Build-Argumente die Version aus package.json und kennzeichnet sie als lokal', () => {
    const angaben = instanzAngaben({ nodeEnv: 'development', version: undefined, commit: undefined, digest: undefined }, '0.1.0');

    expect(angaben.version).toBe('0.1.0+lokal');
    expect(angaben.hinweise).toEqual([]);
  });

  it('behandelt leere Build-Argumente wie fehlende (ARG ohne Wert ist eine leere Zeichenkette)', () => {
    expect(instanzAngaben({ nodeEnv: 'development', version: '', commit: '', digest: '' }, '0.1.0').version).toBe('0.1.0+lokal');
  });

  it.each([
    ['ein bewegliches Tag', 'latest'],
    ['ein führendes v', 'v1.4.0'],
    ['zwei Stellen', '1.4'],
    ['eigene Build-Metadaten', '1.4.0+abc'],
    ['Leerzeichen', '1.4.0 '],
  ])('verwirft als Version %s: Version aus package.json, mit Hinweis — der Start scheitert nicht an einer Beschriftung', (_name, version) => {
    const angaben = instanzAngaben({ nodeEnv: 'production', version, commit: COMMIT, digest: DIGEST }, '0.1.0');

    expect(angaben.version).toBe('0.1.0+0123456');
    expect(angaben.hinweise).toEqual(['COCKPIT_VERSION ist keine SemVer-Version; es gilt die Version aus package.json.']);
  });

  it.each([
    ['zu kurz', 'abc12'],
    ['Großbuchstaben', 'ABCDEF1'],
    ['kein Hex', 'xyz1234'],
  ])('verwirft einen Commit, der %s ist: „lokal", mit Hinweis', (_name, commit) => {
    const angaben = instanzAngaben({ nodeEnv: 'production', version: '1.4.0', commit, digest: DIGEST }, '0.1.0');

    expect(angaben.version).toBe('1.4.0+lokal');
    expect(angaben.hinweise).toEqual(['COCKPIT_COMMIT ist kein Commit-Hash; die Version trägt „lokal".']);
  });
});

describe('instanzAngaben — Digest', () => {
  it('übernimmt einen vollständigen sha256-Digest unverändert', () => {
    expect(instanzAngaben({ nodeEnv: 'production', version: '1.4.0', commit: COMMIT, digest: DIGEST }, '0.1.0').digest).toBe(DIGEST);
  });

  it('lässt den Digest in der Entwicklung ohne Hinweis leer: lokal gibt es keinen', () => {
    const angaben = instanzAngaben({ nodeEnv: 'development', version: undefined, commit: undefined, digest: undefined }, '0.1.0');

    expect(angaben.digest).toBeUndefined();
    expect(angaben.hinweise).toEqual([]);
  });

  it('weist in Produktion auf einen fehlenden Digest hin: ohne ihn lässt sich ein Update nicht bestätigen', () => {
    const angaben = instanzAngaben({ nodeEnv: 'production', version: '1.4.0', commit: COMMIT, digest: undefined }, '0.1.0');

    expect(angaben.digest).toBeUndefined();
    expect(angaben.hinweise).toEqual([
      'COCKPIT_IMAGE_DIGEST fehlt; ohne ihn lässt sich ein Update später nicht bestätigen (docker/compose.fragment.yaml).',
    ]);
  });

  it.each([
    ['den nicht ersetzten Platzhalter', '<DIGEST>'],
    ['ein bewegliches Tag', 'latest'],
    ['einen gekürzten Digest', 'sha256:9f2a1c'],
    ['Großbuchstaben', `sha256:${'A1'.repeat(32)}`],
    ['ein anderes Verfahren', `sha512:${'a1'.repeat(32)}`],
    ['Leerzeichen am Rand', ` ${DIGEST}`],
  ])('erfindet für %s keinen Digest: leer, mit Hinweis', (_name, digest) => {
    const angaben = instanzAngaben({ nodeEnv: 'production', version: '1.4.0', commit: COMMIT, digest }, '0.1.0');

    expect(angaben.digest).toBeUndefined();
    expect(angaben.hinweise).toEqual(['COCKPIT_IMAGE_DIGEST ist kein vollständiger sha256-Digest und bleibt leer.']);
  });

  it('nennt in keinem Hinweis den Wert selbst', () => {
    const angaben = instanzAngaben({ nodeEnv: 'production', version: 'GEHEIM-1', commit: 'GEHEIM-2', digest: 'GEHEIM-3' }, '0.1.0');

    expect(angaben.hinweise.join(' ')).not.toContain('GEHEIM');
    expect(angaben.hinweise).toHaveLength(3);
  });
});

describe('paketVersionLesen', () => {
  it('liest die Version aus package.json, so wie sie im Image neben dist/ liegt', () => {
    expect(paketVersionLesen()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('anzeigeVersion (COPI-84)', () => {
  it.each<[string | undefined, string | undefined]>([
    ['0.6.0', '0.6.0'],
    ['0.6.0+0620cc9', '0.6.0'],
    ['1.4.0-rc.1+0620cc9', '1.4.0-rc.1'],
    [undefined, undefined],
    ['', undefined],
    ['kaputt', undefined],
    ['v0.6.0', undefined],
    ['+0620cc9', undefined],
  ])('macht aus %j die Anzeige %j', (roh, erwartet) => {
    expect(anzeigeVersion(roh)).toBe(erwartet);
  });
});
