/**
 * Die Start-Prüfung als echter Prozess (COPI-31): `src/server/index.ts`, so wie das Image ihn
 * startet. Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist; jeder Test bekommt eine eigene, leere
 * Datenbank.
 *
 * Der Befund aus COPI-24: auf einer leeren Datenbank brach der Container mit
 * `relation "cockpit.user" does not exist` ab — ein SQL-Fehler mitten im Start, der nicht sagt, was
 * zu tun ist. Jetzt bricht er **vor allem anderen** ab (Exit-Code 3) und nennt Migration und
 * Befehl; mit vollständigem Schema startet er und antwortet auf `/gesund`.
 *
 * Dem Prozess wird eine ausdrücklich kleine Umgebung mitgegeben: er erbt nichts vom Test,
 * insbesondere keine `DATABASE_URL` der Entwicklung.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationenAnwenden, migrationenLaden } from '../src/datenbank/migrationen.js';
import { eingriffIn } from './hilfen.js';
import { leereDatenbankAnlegen, type LeereDatenbank, LEERE_DATENBANK_TIMEOUT_MS } from './leere-datenbank.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Prozess {
  readonly kind: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Wartet auf das Ende und liefert den Exit-Code. */
  beendet(millisekunden: number): Promise<number | null>;
}

/** Ein freier Port: der Test fragt das Betriebssystem, statt einen festen zu raten. */
async function freierPort(): Promise<number> {
  return new Promise((ok, fehler) => {
    const server = createServer();
    server.once('error', fehler);
    server.listen(0, '127.0.0.1', () => {
      const adresse = server.address();
      const port = typeof adresse === 'object' && adresse !== null ? adresse.port : 0;
      server.close(() => ok(port));
    });
  });
}

describe.skipIf(!datenbankUrl)('Start-Prüfung als Prozess (echte Datenbank)', { timeout: LEERE_DATENBANK_TIMEOUT_MS }, () => {
  let datenbank: LeereDatenbank;
  const prozesse: ChildProcess[] = [];

  beforeEach(async () => {
    datenbank = await leereDatenbankAnlegen(datenbankUrl ?? '');
  });

  afterEach(async () => {
    for (const kind of prozesse.splice(0)) {
      kind.kill('SIGKILL');
    }
    await datenbank.aufraeumen();
  });

  async function starten(port: number, zusatz: Record<string, string> = {}): Promise<Prozess> {
    const kind = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
      cwd: wurzel,
      env: {
        PATH: process.env.PATH ?? '',
        DATABASE_URL: datenbank.url,
        PORT: String(port),
        HOST: '127.0.0.1',
        BETTER_AUTH_SECRET: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
        ...zusatz,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    prozesse.push(kind);
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (stueck: Buffer) => {
      stdout += stueck.toString();
    });
    kind.stderr.on('data', (stueck: Buffer) => {
      stderr += stueck.toString();
    });
    return {
      kind,
      stdout: () => stdout,
      stderr: () => stderr,
      beendet: (millisekunden) =>
        new Promise((ok, fehler) => {
          if (kind.exitCode !== null) {
            ok(kind.exitCode);
            return;
          }
          const zeit = setTimeout(() => fehler(new Error(`Der Prozess endete nicht innerhalb von ${String(millisekunden)} ms`)), millisekunden);
          kind.once('exit', (code) => {
            clearTimeout(zeit);
            ok(code);
          });
        }),
    };
  }

  /** Fragt `/gesund`, bis es antwortet oder der Prozess endet. */
  async function gesundAbwarten(port: number, prozess: Prozess): Promise<number> {
    const ende = Date.now() + 30_000;
    while (Date.now() < ende) {
      if (prozess.kind.exitCode !== null) {
        throw new Error(`Der Prozess endete vorzeitig (Exit ${String(prozess.kind.exitCode)}): ${prozess.stderr()}`);
      }
      try {
        const antwort = await fetch(`http://127.0.0.1:${String(port)}/gesund`);
        return antwort.status;
      } catch {
        await new Promise((weiter) => setTimeout(weiter, 200));
      }
    }
    throw new Error('Keine Antwort auf /gesund');
  }

  it('startet auf einer leeren Datenbank nicht und sagt klar, was fehlt: Exit 3, keine SQL-Fehlermeldung', async () => {
    const anzahl = (await migrationenLaden()).length;
    const prozess = await starten(await freierPort());

    const code = await prozess.beendet(30_000);

    expect(code).toBe(3);
    expect(prozess.stderr()).toContain(
      `Das Schema cockpit fehlt in der Datenbank. Migration 0001_init ausstehend (und ${String(anzahl - 1)} weitere).`,
    );
    expect(prozess.stderr()).toContain('docker compose run --rm cockpit node dist/cli/index.js migrieren');
    // Das war der Fehler aus COPI-24: ein SQL-Fehler mitten im Start.
    expect(prozess.stderr() + prozess.stdout()).not.toContain('does not exist');
  });

  it('startet nicht, solange eine Migration aussteht, und nennt genau diese', async () => {
    const pool = datenbank.neuerPool();
    await migrationenAnwenden(pool);
    const alle = await migrationenLaden();
    const letzte = alle[alle.length - 1]?.id ?? '';
    await pool.query('DELETE FROM cockpit.schema_migrations WHERE id = $1', [letzte]);
    const prozess = await starten(await freierPort());

    const code = await prozess.beendet(30_000);

    expect(code).toBe(3);
    expect(prozess.stderr()).toContain(`Migration ${letzte} ausstehend.`);
  });

  it('startet mit vollständigem Schema, antwortet auf /gesund und gibt das Erststart-Token aus', async () => {
    await migrationenAnwenden(datenbank.neuerPool());
    const port = await freierPort();
    const prozess = await starten(port);

    const status = await gesundAbwarten(port, prozess);

    expect(status).toBe(200);
    // Auf einer frischen Instanz ohne Konto gibt das Cockpit beim Start das Token für den Betreuer aus.
    expect(prozess.stdout()).toContain('/erststart/');
    expect(prozess.stderr()).not.toContain('ausstehend');
  });

  describe('Selbstmeldung (COPI-39)', () => {
    const DIGEST = `sha256:${'c3'.repeat(32)}`;

    async function instanz(): Promise<unknown[]> {
      const ergebnis = await datenbank.neuerPool().query('SELECT version, digest, gestartet_am FROM cockpit.instanz');
      return ergebnis.rows;
    }

    it('schreibt beim Start Version (gebacken, mit Commit) und Digest (aus der Umgebung) in cockpit.instanz, bevor es antwortet', async () => {
      await migrationenAnwenden(datenbank.neuerPool());
      const port = await freierPort();
      const vorher = Date.now();
      const prozess = await starten(port, {
        COCKPIT_VERSION: '1.4.0',
        COCKPIT_COMMIT: '0123456789abcdef0123456789abcdef01234567',
        COCKPIT_IMAGE_DIGEST: DIGEST,
      });

      // Wer auf /gesund antwortet, hat sich schon gemeldet: die Meldung kommt vor dem Lauschen.
      await gesundAbwarten(port, prozess);

      const zeilen = (await instanz()) as { version: string; digest: string | null; gestartet_am: Date }[];
      expect(zeilen).toHaveLength(1);
      expect(zeilen[0]?.version).toBe('1.4.0+0123456');
      expect(zeilen[0]?.digest).toBe(DIGEST);
      expect(zeilen[0]?.gestartet_am.getTime()).toBeGreaterThanOrEqual(vorher - 1000);
    });

    it('belegt beim Start ein laufendes Update als erledigt, wenn es selbst dessen Ziel ist (COPI-41)', async () => {
      const pool = datenbank.neuerPool();
      await migrationenAnwenden(pool);
      const id = await eingriffIn(pool, 'laeuft', { ziel: DIGEST, zielVersion: '1.5.0' });
      const port = await freierPort();
      const prozess = await starten(port, {
        COCKPIT_VERSION: '1.5.0',
        COCKPIT_COMMIT: '0123456789abcdef0123456789abcdef01234567',
        COCKPIT_IMAGE_DIGEST: DIGEST,
      });

      await gesundAbwarten(port, prozess);

      const zeile = await pool.query<{ status: string }>('SELECT status FROM cockpit.eingriff WHERE id = $1', [id]);
      expect(zeile.rows[0]?.status).toBe('erledigt');
      expect(prozess.stdout()).toContain('Update belegt');
    });

    it('meldet ohne Build-Argumente die Version aus package.json als „lokal" und keinen Digest', async () => {
      await migrationenAnwenden(datenbank.neuerPool());
      const port = await freierPort();
      const prozess = await starten(port);

      await gesundAbwarten(port, prozess);

      const zeilen = (await instanz()) as { version: string; digest: string | null }[];
      expect(zeilen).toHaveLength(1);
      expect(zeilen[0]?.version).toMatch(/^\d+\.\d+\.\d+\+lokal$/);
      expect(zeilen[0]?.digest).toBeNull();
    });

    it('startet mit einem kaputten Digest, lässt ihn leer und sagt es im Log, ohne den Wert zu nennen', async () => {
      await migrationenAnwenden(datenbank.neuerPool());
      const port = await freierPort();
      const prozess = await starten(port, { COCKPIT_IMAGE_DIGEST: '<DIGEST>-NICHT-ERSETZT' });

      await gesundAbwarten(port, prozess);

      const zeilen = (await instanz()) as { digest: string | null }[];
      expect(zeilen[0]?.digest).toBeNull();
      expect(prozess.stdout()).toContain('COCKPIT_IMAGE_DIGEST ist kein vollständiger sha256-Digest und bleibt leer.');
      expect(prozess.stdout() + prozess.stderr()).not.toContain('NICHT-ERSETZT');
    });
  });

  it('startet auch mit einer Datenbank, die neuer ist als das Image, und warnt', async () => {
    const pool = datenbank.neuerPool();
    await migrationenAnwenden(pool);
    await pool.query(`INSERT INTO cockpit.schema_migrations (id) VALUES ('9999_aus_der_zukunft')`);
    const port = await freierPort();
    const prozess = await starten(port);

    const status = await gesundAbwarten(port, prozess);

    expect(status).toBe(200);
    expect(prozess.stdout()).toContain('9999_aus_der_zukunft');
  });
});
