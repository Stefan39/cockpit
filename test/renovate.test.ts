/**
 * Renovate lässt die Compose-Vorlage der Kundeninstanz in Ruhe (COPI-51).
 *
 * Dort steht der Platzhalter `<DIGEST>`. Welchen Digest eine Instanz fährt, entscheidet ein Update-Antrag samt
 * Freigabe, nie ein Bot (ADR 13.1). Renovate meldete dafür „Could not determine new digest“ — die Regel schaltet
 * die Datei ab. Dieser Test hält sie fest, samt dem Pfad: Zieht die Vorlage um, fällt es hier auf und nicht erst
 * an einer Warnung im Dashboard.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Regel {
  matchFileNames?: string[];
  enabled?: boolean;
  description?: string;
}

const VORLAGE = 'docker/compose.fragment.yaml';

const renovate = JSON.parse(readFileSync('renovate.json', 'utf8')) as { packageRules?: Regel[] };

describe('Renovate-Konfiguration', () => {
  const regel = renovate.packageRules?.find((eintrag) => eintrag.matchFileNames?.includes(VORLAGE));

  it('schaltet die Compose-Vorlage ab', () => {
    expect(regel?.enabled).toBe(false);
  });

  it('sagt, warum', () => {
    expect(regel?.description).toMatch(/COPI-51/);
  });

  it('meint eine Datei, die es gibt', () => {
    expect(existsSync(VORLAGE)).toBe(true);
  });

  it('lässt die übrigen Abhängigkeiten in Ruhe — nur diese eine Datei ist abgeschaltet', () => {
    const abgeschaltet = (renovate.packageRules ?? []).filter((eintrag) => eintrag.enabled === false);

    expect(abgeschaltet.map((eintrag) => eintrag.matchFileNames)).toEqual([[VORLAGE]]);
  });
});
