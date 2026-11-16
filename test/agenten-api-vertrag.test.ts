/**
 * Der Vertrag der Agenten-API (`docs/agenten-api.md`, COPI-42) hält mit dem Code Schritt — rein, ohne Datenbank.
 *
 * Der Vertrag ist die Grundlage der Werkzeuge im Repo `agent-blueprints`; die Agenten-Seite schaut nicht in diesen Code.
 * Eine neue Route unter `/intern`, ein neues Recht oder ein neuer Fehlercode, den der Vertrag nicht nennt, wäre dort
 * unsichtbar. Der Test liest Routen und Rechte aus derselben Quelle wie der Routen-Test (`routen-kategorien.ts`) bzw.
 * aus dem Code, und die Fehlercodes aus den Quelldateien der API.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SCOPES } from '../src/intern/token.js';
import { ROUTEN } from './routen-kategorien.js';

const vertrag = readFileSync('docs/agenten-api.md', 'utf8');

/** Die Fehlercodes, die die Agenten-API sendet: jedes `antworten(reply, <status>, '<code>'` in `src/intern`. */
function fehlercodes(): string[] {
  const codes = new Set<string>();
  for (const datei of readdirSync('src/intern')) {
    const quelle = readFileSync(path.join('src/intern', datei), 'utf8');
    for (const treffer of quelle.matchAll(/antworten\(reply, \d{3}, '([a-z_]+)'/g)) {
      codes.add(treffer[1] ?? '');
    }
  }
  return [...codes].sort();
}

describe('docs/agenten-api.md', () => {
  const routen = Object.entries(ROUTEN)
    .filter(([, kategorie]) => kategorie === 'maschinell')
    .map(([route]) => route);

  it('kennt Routen der Agenten-API', () => {
    expect(routen.length).toBeGreaterThan(5);
  });

  it.each(routen)('nennt die Route %s', (route) => {
    expect(vertrag).toContain(`\`${route}\``);
  });

  it.each([...API_SCOPES])('nennt das Recht %s', (recht) => {
    expect(vertrag).toContain(`\`${recht}\``);
  });

  it('findet die Fehlercodes im Code', () => {
    expect(fehlercodes()).toContain('status_passt_nicht');
  });

  it.each(fehlercodes())('nennt den Fehlercode %s', (code) => {
    expect(vertrag).toContain(`\`${code}\``);
  });
});
