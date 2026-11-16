/**
 * Das Server-Kommando als echter Prozess (COPI-24): Exit-Codes, stdout, stderr und
 * Umgebungsvariablen, so wie ein Betreiber sie mit `docker compose exec` erlebt.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit."user"` und
 * `cockpit.erststart_token` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 *
 * Dem Prozess wird eine **ausdrücklich kleine** Umgebung mitgegeben: er erbt
 * nichts vom Test, insbesondere keine `DATABASE_URL` — sonst könnte ein
 * vergessenes Argument den Prozess gegen die Datenbank der Entwicklung richten.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { kontenLoeschen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const execFileAsync = promisify(execFile);
const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Lauf {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Startet `src/cli/index.ts` als eigenen Prozess mit genau der übergebenen Umgebung. */
async function kommando(argumente: string[], umgebung: Record<string, string>): Promise<Lauf> {
  try {
    const ergebnis = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', ...argumente],
      { cwd: wurzel, env: { PATH: process.env.PATH ?? '', ...umgebung }, timeout: 60_000 },
    );
    return { code: 0, stdout: ergebnis.stdout, stderr: ergebnis.stderr };
  } catch (fehler) {
    const f = fehler as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
}

describe.skipIf(!datenbankUrl)('Server-Kommando als Prozess (echte Datenbank)', () => {
  let pool: pg.Pool;
  const umgebung = (): Record<string, string> => ({
    DATABASE_URL: datenbankUrl ?? '',
    COCKPIT_DOMAIN: 'cockpit.example.org',
  });

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.erststart_token');
    await kontenLoeschen(pool);
  });

  afterAll(async () => {
    await kontenLoeschen(pool);
    await pool.end();
  });

  it('erzeugt ohne Benutzer ein Token: Exit 0, Link mit der Domain aus COCKPIT_DOMAIN, Token genau einmal auf stdout', async () => {
    const lauf = await kommando(['erststart'], umgebung());

    expect(lauf.code).toBe(0);
    const token = /https:\/\/cockpit\.example\.org\/erststart\/([A-Za-z0-9_-]+)/.exec(lauf.stdout)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(lauf.stdout.split(token)).toHaveLength(2);
    expect(lauf.stderr).not.toContain(token);
  });

  it('lehnt mit vorhandenem Benutzer ab: Exit 1, Meldung auf stderr, nichts auf stdout', async () => {
    await pool.query(
      `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ('prozess_vorhanden', 'prozess@example.org', 'p', true, now(), now())`,
    );

    const lauf = await kommando(['erststart'], umgebung());

    expect(lauf.code).toBe(1);
    expect(lauf.stdout).toBe('');
    expect(lauf.stderr).toContain('bereits ein Benutzer');
  });

  it('entsperrt ein Konto: Exit 0, Link mit der Domain aus COCKPIT_DOMAIN, Token genau einmal auf stdout, stderr leer', async () => {
    await pool.query(
      `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled", aktiviert_am)
       VALUES ('prozess_entsperren', 'entsperren@example.org', 'e', true, now(), now(), true, now())`,
    );
    await pool.query(
      `INSERT INTO cockpit.account (id, "accountId", "providerId", "userId", password, "updatedAt")
       VALUES ('prozess_konto', 'prozess_entsperren', 'credential', 'prozess_entsperren', 'alter-hash', now())`,
    );

    const lauf = await kommando(['entsperren', '--konto', 'Entsperren@Example.org'], umgebung());

    expect(lauf.code).toBe(0);
    const token = /https:\/\/cockpit\.example\.org\/zugang-wiederherstellen\/([A-Za-z0-9_-]+)/.exec(lauf.stdout)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(lauf.stdout.split(token)).toHaveLength(2);
    expect(lauf.stderr).toBe('');
    const konto = await pool.query<{ aktiv: boolean; password: string }>(
      `SELECT cockpit.zweiter_faktor_aktiv(u) AS aktiv, a.password
         FROM cockpit."user" u JOIN cockpit.account a ON a."userId" = u.id WHERE u.id = 'prozess_entsperren'`,
    );
    expect(konto.rows[0]?.aktiv).toBe(false);
    expect(konto.rows[0]?.password).not.toBe('alter-hash');
  });

  it('meldet beim Entsperren eine unbekannte Adresse mit Exit 1 und schreibt nichts auf stdout', async () => {
    const lauf = await kommando(['entsperren', '--konto', 'gibt-es-nicht@example.org'], umgebung());

    expect(lauf.code).toBe(1);
    expect(lauf.stdout).toBe('');
    expect(lauf.stderr).toContain('kein Konto');
  });

  it('lehnt entsperren ohne --konto mit Exit 2 ab', async () => {
    const lauf = await kommando(['entsperren'], umgebung());

    expect(lauf.code).toBe(2);
    expect(lauf.stdout).toBe('');
    expect(lauf.stderr).toContain('Nutzung');
  });

  it('lehnt einen Befehl ohne Pflichtangabe mit Exit 2 ab und schreibt die Nutzung auf stderr', async () => {
    const lauf = await kommando(['einladung', '--email', 'a@example.org'], umgebung());

    expect(lauf.code).toBe(2);
    expect(lauf.stdout).toBe('');
    expect(lauf.stderr).toContain('Nutzung');
  });

  it('endet ohne Befehl mit Exit 2', async () => {
    const lauf = await kommando([], umgebung());

    expect(lauf.code).toBe(2);
    expect(lauf.stdout).toBe('');
  });

  it('zeigt die Hilfe auf stdout und endet mit 0 — auch ohne DATABASE_URL', async () => {
    // Wer das Kommando zum ersten Mal ruft, will lesen, nicht eine Datenbank einrichten.
    const lauf = await kommando(['--hilfe'], {});

    expect(lauf.code).toBe(0);
    expect(lauf.stdout).toContain('betreuer-uebergeben');
    expect(lauf.stderr).toBe('');
  });

  it('meldet eine falsche Bedienung mit Exit 2 und der Nutzung — auch ohne DATABASE_URL', async () => {
    const lauf = await kommando(['irgendwas'], {});

    expect(lauf.code).toBe(2);
    expect(lauf.stderr).toContain('Nutzung');
    expect(lauf.stderr).not.toContain('DATABASE_URL ist nicht gesetzt');
  });

  it('endet ohne DATABASE_URL mit Exit 2 und einem Hinweis', async () => {
    const lauf = await kommando(['erststart'], { COCKPIT_DOMAIN: 'cockpit.example.org' });

    expect(lauf.code).toBe(2);
    expect(lauf.stderr).toContain('DATABASE_URL');
  });

  it('meldet eine nicht erreichbare Datenbank mit Exit 1, ohne die Zugangsdaten zu nennen', async () => {
    const lauf = await kommando(['erststart'], {
      DATABASE_URL: 'postgres://postgres:falsches-geheimnis@127.0.0.1:1/cockpit_test',
    });

    expect(lauf.code).toBe(1);
    expect(lauf.stderr).not.toBe('');
    expect(lauf.stderr).not.toContain('falsches-geheimnis');
    expect(lauf.stdout).toBe('');
  });
});
