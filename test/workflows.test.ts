/**
 * Die Workflow-Dateien sind gültiges YAML und haben die Form, die GitHub erwartet (COPI-50).
 *
 * Anlass: Im Release-Workflow stand ein Doppelpunkt in einem Schrittnamen („Metadaten (genau ein Tag: die
 * Version)“). YAML liest das als neues Feld, GitHub lehnte die Datei ab — der Lauf auf `main` brach ohne einen
 * einzigen Job ab, und das erste Release entstand nicht. Gates 1–4 und der Docker-Build lesen den Code, nie die
 * CI-Dateien; diese Fehlerklasse fiel deshalb erst nach dem Merge auf.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ORDNER = '.github/workflows';

interface Schritt {
  name?: string;
  uses?: string;
  run?: string;
}

interface Job {
  'runs-on'?: string;
  steps?: Schritt[];
}

interface Workflow {
  on?: unknown;
  jobs?: Record<string, Job>;
}

const dateien = readdirSync(ORDNER).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'));

describe('Workflow-Dateien', () => {
  it('es gibt welche — sonst prüft dieser Test nichts', () => {
    expect(dateien.length).toBeGreaterThan(0);
  });

  describe.each(dateien)('%s', (datei) => {
    const geladen = (): Workflow => load(readFileSync(`${ORDNER}/${datei}`, 'utf8')) as Workflow;

    it('ist gültiges YAML mit Auslöser und Jobs', () => {
      const workflow = geladen();

      // `on:` liest YAML als booleschen Schlüssel `true` — beides zählt, entscheidend ist, dass es ihn gibt.
      expect(workflow.on ?? (workflow as Record<string, unknown>)['true']).toBeDefined();
      expect(Object.keys(workflow.jobs ?? {}).length).toBeGreaterThan(0);
    });

    it('jeder Job hat einen Läufer und Schritte, jeder Schritt tut etwas', () => {
      for (const [name, job] of Object.entries(geladen().jobs ?? {})) {
        expect(job['runs-on'], `Job ${name}`).toBeTypeOf('string');
        expect(job.steps?.length, `Job ${name}`).toBeGreaterThan(0);

        for (const schritt of job.steps ?? []) {
          expect(Boolean(schritt.uses ?? schritt.run), `Schritt „${schritt.name ?? '(ohne Namen)'}“ in ${name}`).toBe(true);
        }
      }
    });
  });

  it('erkennt einen Doppelpunkt im Schrittnamen — der Fehler aus COPI-50', () => {
    const kaputt = ['jobs:', '  bauen:', '    runs-on: ubuntu-latest', '    steps:', '      - name: Metadaten (ein Tag: die Version)', '        uses: x@v1'].join('\n');

    expect(() => load(kaputt)).toThrow();
  });
});
