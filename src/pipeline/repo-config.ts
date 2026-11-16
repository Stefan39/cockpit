/**
 * Die Einstellungen je Repo der Entwicklungspipeline (COPI-145, Konzept Abschnitte 2a, 3, 7 und 10): Herkunft der
 * Aufgaben, Basis-Branch, Auto-Merge, Phase, Reviewer, geschützte Pfade.
 *
 * **Nur Stefan ändert sie** — über das Server-Kommando `pipeline-repo` (der Serverzugang ist die Vertrauensgrenze),
 * nie über die Agenten-API. Phase und Auto-Merge sind seine Entscheidungen, nicht die des Koordinators.
 *
 * **Sperrliste:** Repos, die nie `auto_merge` haben dürfen. Sie ist Sache der Instanz und kommt aus der Umgebung
 * (`COCKPIT_AUTO_MERGE_SPERRLISTE`, kommagetrennte `owner/name`); ohne Wert ist sie leer. Geprüft beim Anlegen,
 * mit verständlicher Meldung.
 */
import type pg from 'pg';
import { parse } from 'yaml';
import * as z from 'zod';

/** Die Umgebungsvariable mit den Repos, die nie automatisch gemerged werden. */
export const SPERRLISTE_VARIABLE = 'COCKPIT_AUTO_MERGE_SPERRLISTE';

/** Liest die Sperrliste aus der Umgebung: kommagetrennt, klein geschrieben, ohne Leerwerte. */
export function sperrlisteAusUmgebung(umgebung: NodeJS.ProcessEnv = process.env): readonly string[] {
  return (umgebung[SPERRLISTE_VARIABLE] ?? '')
    .split(',')
    .map((eintrag) => eintrag.trim().toLowerCase())
    .filter((eintrag) => eintrag !== '');
}

export const REPO_FORM = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const JIRA_PROJEKT = /^[A-Z][A-Z0-9]{1,19}$/;

function schemaFuer(sperrliste: readonly string[]) {
  return z
    .strictObject({
      repo: z.string().regex(REPO_FORM),
      quelle: z.enum(['jira', 'github']),
      jira_project: z.string().regex(JIRA_PROJEKT).optional(),
      base_branch: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/).default('main'),
      auto_merge: z.boolean().default(false),
      phase: z.int().min(0).max(2).default(0),
      reviewers: z.array(z.enum(['codex', 'gemini', 'copilot'])).default(['codex']),
      protected_paths: z.array(z.string().min(1).max(200)).max(100).default([]),
    })
    .refine((wert) => wert.quelle !== 'jira' || wert.jira_project !== undefined, {
      path: ['jira_project'],
      message: 'Bei quelle: jira ist jira_project Pflicht.',
    })
    .refine((wert) => !(wert.auto_merge && sperrliste.includes(wert.repo.toLowerCase())), {
      path: ['auto_merge'],
      message: 'Dieses Repo steht auf der Sperrliste: auto_merge ist dort nie erlaubt.',
    });
}

export type RepoConfig = z.output<ReturnType<typeof schemaFuer>>;

/** Liest die Einstellungen aus YAML; bei einem Fehler die Meldungen je Feld (ohne Werte). */
export function repoConfigPruefen(
  rohtext: string,
  sperrliste: readonly string[] = sperrlisteAusUmgebung(),
): { ok: true; wert: RepoConfig } | { ok: false; grund: string } {
  let roh: unknown;
  try {
    roh = parse(rohtext);
  } catch {
    return { ok: false, grund: 'Die Eingabe ist kein gültiges YAML.' };
  }
  const geprueft = schemaFuer(sperrliste).safeParse(roh);
  if (!geprueft.success) {
    const zeilen = geprueft.error.issues.map((problem) => {
      const feld = problem.path.join('.') || '(Eingabe)';
      return problem.code === 'custom' ? `${feld}: ${problem.message}` : `${feld}: ungültig`;
    });
    return { ok: false, grund: [...new Set(zeilen)].join('\n') };
  }
  return { ok: true, wert: geprueft.data };
}

/** Legt die Einstellungen an oder ersetzt sie; liefert, ob das Repo neu war. */
export async function repoConfigSpeichern(pool: pg.Pool, config: RepoConfig, jetzt: Date): Promise<'angelegt' | 'geaendert'> {
  const ergebnis = await pool.query<{ neu: boolean }>(
    `INSERT INTO cockpit.pipeline_repo_config
       (repo, quelle, jira_project, base_branch, auto_merge, phase, reviewers, protected_paths, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (repo) DO UPDATE SET
       quelle = EXCLUDED.quelle, jira_project = EXCLUDED.jira_project, base_branch = EXCLUDED.base_branch,
       auto_merge = EXCLUDED.auto_merge, phase = EXCLUDED.phase, reviewers = EXCLUDED.reviewers,
       protected_paths = EXCLUDED.protected_paths, updated_at = EXCLUDED.updated_at
     RETURNING (xmax = 0) AS neu`,
    [
      config.repo,
      config.quelle,
      config.jira_project ?? null,
      config.base_branch,
      config.auto_merge,
      config.phase,
      config.reviewers,
      config.protected_paths,
      jetzt,
    ],
  );
  return ergebnis.rows[0]?.neu === true ? 'angelegt' : 'geaendert';
}

export interface RepoZeile {
  readonly repo: string;
  readonly quelle: string;
  readonly jiraProject: string | null;
  readonly baseBranch: string;
  readonly autoMerge: boolean;
  readonly phase: number;
  readonly reviewers: string[];
  readonly protectedPaths: string[];
}

interface RepoSpalten {
  repo: string;
  quelle: string;
  jira_project: string | null;
  base_branch: string;
  auto_merge: boolean;
  phase: number;
  reviewers: string[];
  protected_paths: string[];
}

const REPO_SPALTEN = 'repo, quelle, jira_project, base_branch, auto_merge, phase, reviewers, protected_paths';

function repoAus(z: RepoSpalten): RepoZeile {
  return {
    repo: z.repo,
    quelle: z.quelle,
    jiraProject: z.jira_project,
    baseBranch: z.base_branch,
    autoMerge: z.auto_merge,
    phase: z.phase,
    reviewers: z.reviewers,
    protectedPaths: z.protected_paths,
  };
}

/** Die Einstellungen eines Repos, oder `undefined`. */
export async function repoConfigFuer(pool: pg.Pool, repo: string): Promise<RepoZeile | undefined> {
  const ergebnis = await pool.query<RepoSpalten>(`SELECT ${REPO_SPALTEN} FROM cockpit.pipeline_repo_config WHERE repo = $1`, [repo]);
  const zeile = ergebnis.rows[0];
  return zeile === undefined ? undefined : repoAus(zeile);
}

export async function repoConfigsLesen(pool: pg.Pool): Promise<RepoZeile[]> {
  const ergebnis = await pool.query<RepoSpalten>(`SELECT ${REPO_SPALTEN} FROM cockpit.pipeline_repo_config ORDER BY repo`);
  return ergebnis.rows.map(repoAus);
}
