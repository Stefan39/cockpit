/**
 * Server-Kommando `pipeline-repo` und `pipeline-repos` (COPI-145) gegen eine echte PostgreSQL: Einstellungen je Repo
 * aus YAML anlegen und ersetzen, die Sperrliste für Auto-Merge, die Übersicht.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { befehlLesen, cliAusfuehren, EXIT_ABGELEHNT, EXIT_BEDIENUNG, EXIT_ERLEDIGT } from '../src/cli/befehle.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

describe('Server-Kommando: Pipeline (Bedienung)', () => {
  it('kennt beide Befehle ohne Optionen', () => {
    expect(befehlLesen(['pipeline-repo'])).toEqual({ befehl: 'pipeline-repo' });
    expect(befehlLesen(['pipeline-repos'])).toEqual({ befehl: 'pipeline-repos' });
    expect(befehlLesen(['pipeline-repo', '--name', 'x'])).toEqual({ fehler: 'Die Option --name gehört nicht zu diesem Befehl.' });
  });

  it('liest pipeline-anbieter-setzen, aus wird zu disabled (COPI-181)', () => {
    expect(befehlLesen(['pipeline-anbieter'])).toEqual({ befehl: 'pipeline-anbieter' });
    expect(befehlLesen(['pipeline-anbieter-setzen', '--anbieter', 'codex', '--zustand', 'aus'])).toEqual({
      befehl: 'pipeline-anbieter-setzen',
      anbieter: 'codex',
      zustand: 'disabled',
    });
    expect(befehlLesen(['pipeline-anbieter-setzen', '--anbieter', 'claude', '--zustand', 'ok'])).toEqual({
      befehl: 'pipeline-anbieter-setzen',
      anbieter: 'claude',
      zustand: 'ok',
    });
  });

  it.each([
    ['ohne Anbieter', ['pipeline-anbieter-setzen', '--zustand', 'ok']],
    ['mit unbekanntem Anbieter', ['pipeline-anbieter-setzen', '--anbieter', 'openai', '--zustand', 'ok']],
    ['ohne Zustand', ['pipeline-anbieter-setzen', '--anbieter', 'codex']],
    ['mit exhausted', ['pipeline-anbieter-setzen', '--anbieter', 'codex', '--zustand', 'exhausted']],
    ['mit fremder Option', ['pipeline-anbieter-setzen', '--anbieter', 'codex', '--zustand', 'ok', '--name', 'x']],
    ['pipeline-anbieter mit Option', ['pipeline-anbieter', '--anbieter', 'codex']],
  ])('lehnt pipeline-anbieter-setzen %s ab', (_name, argumente) => {
    expect(befehlLesen(argumente)).toHaveProperty('fehler');
  });
});

describe.skipIf(!datenbankUrl)('Server-Kommando: Pipeline (echte Datenbank)', () => {
  let pool: pg.Pool;

  async function laufen(argumente: string[], eingabe = '', sperrliste: readonly string[] = []) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await cliAusfuehren(argumente, {
      pool,
      sperrliste,
      basisUrl: 'http://localhost:3000',
      ausgabe: (zeile) => stdout.push(zeile),
      fehlerausgabe: (zeile) => stderr.push(zeile),
      eingabeLesen: () => Promise.resolve(eingabe),
      jetzt: () => new Date('2026-10-16T08:00:00Z'),
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  async function leeren(): Promise<void> {
    await pool.query(
      'TRUNCATE cockpit.pipeline_usage, cockpit.pipeline_job_event, cockpit.pipeline_job, cockpit.pipeline_provider_state, cockpit.pipeline_repo_config',
    );
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(leeren);

  afterAll(async () => {
    await leeren();
    await pool.end();
  });

  it('legt die Einstellungen eines Repos an, ersetzt sie und zeigt sie', async () => {
    const angelegt = await laufen(['pipeline-repo'], 'repo: Stefan39/cockpit\nquelle: jira\njira_project: COPI\nreviewers: [codex, gemini]\n');
    expect(angelegt).toEqual({ code: EXIT_ERLEDIGT, stdout: 'Stefan39/cockpit angelegt: Phase 0, Auto-Merge aus, Reviewer codex, gemini.', stderr: '' });

    const geaendert = await laufen(['pipeline-repo'], 'repo: Stefan39/cockpit\nquelle: jira\njira_project: COPI\nphase: 1\nauto_merge: true\n');
    expect(geaendert.stdout).toBe('Stefan39/cockpit geändert: Phase 1, Auto-Merge an, Reviewer codex.');

    await laufen(['pipeline-repo'], 'repo: Stefan39/MiteBundle\nquelle: github\nbase_branch: develop\n');
    const liste = await laufen(['pipeline-repos']);
    expect(liste.stdout.split('\n')).toEqual([
      `${'Stefan39/MiteBundle'.padEnd(32)} ${'github'.padEnd(12)} Basis develop  Phase 0  Auto-Merge aus`,
      `${'Stefan39/cockpit'.padEnd(32)} ${'jira COPI'.padEnd(12)} Basis main  Phase 1  Auto-Merge an`,
    ]);
  });

  it('lehnt Auto-Merge für ein Repo der Sperrliste ab und speichert nichts', async () => {
    const lauf = await laufen(['pipeline-repo'], 'repo: Acme/Web\nquelle: jira\njira_project: WEB\nauto_merge: true\n', ['acme/web']);
    expect(lauf.code).toBe(EXIT_ABGELEHNT);
    expect(lauf.stderr).toContain('Sperrliste');
    expect((await laufen(['pipeline-repos'])).stdout).toBe('Kein Repo in der Pipeline.');
  });

  it('zeigt und setzt die Anbieter (COPI-181)', async () => {
    expect((await laufen(['pipeline-anbieter'])).stdout).toBe('alle ok (keine Einträge)');

    const aus = await laufen(['pipeline-anbieter-setzen', '--anbieter', 'codex', '--zustand', 'aus']);
    expect(aus).toEqual({ code: EXIT_ERLEDIGT, stdout: 'codex: disabled', stderr: '' });
    expect((await laufen(['pipeline-anbieter-setzen', '--anbieter', 'gemini', '--zustand', 'ok'])).stdout).toBe('gemini: ok');

    expect((await laufen(['pipeline-anbieter'])).stdout.split('\n')).toEqual([
      'Anbieter   Zustand    bis                      geändert',
      'codex      disabled   -                        2026-10-16T08:00:00.000Z',
      'gemini     ok         -                        2026-10-16T08:00:00.000Z',
    ]);
  });

  it('meldet eine falsche Bedienung', async () => {
    expect((await laufen(['pipeline-repos', '--modul', 'x'])).code).toBe(EXIT_BEDIENUNG);
  });
});
