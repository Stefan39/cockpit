/**
 * Das Auth-Geheimnis (COPI-32): In der Entwicklung darf es nicht bei jedem Prozessstart neu
 * gewürfelt werden. Better Auth verschlüsselt damit den TOTP-Schlüssel und signiert die
 * Sitzungs-Cookies; ein neues Geheimnis macht beides unbrauchbar (`invalid tag`, und die
 * Anmeldeseite sagt nur „Code stimmt nicht"). Mit `tsx watch` passierte das bei jeder
 * Dateiänderung.
 *
 * Diese Datei prüft die Auswahl des Geheimnisses ohne Datenbank; `geheimnis-datenbank.test.ts`
 * prüft, dass ein Konto einen Neustart übersteht — und was mit einem anderen Geheimnis geschieht.
 *
 * Jeder Test arbeitet in einem eigenen Temp-Ordner; keiner fasst die echte Datei im Repo an.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEV_GEHEIMNIS_DATEI, geheimnisBesorgen, geheimnisDateiAnlegen } from '../src/auth/konfiguration.js';
import type { CockpitEnv } from '../src/server/env.js';

const wurzel = path.join(import.meta.dirname, '..');

function umgebung(nodeEnv: CockpitEnv['nodeEnv'], authSecret?: string): CockpitEnv {
  return {
    nodeEnv,
    port: 3000,
    host: '127.0.0.1',
    databaseUrl: undefined,
    cockpitDomain: undefined,
    authSecret,
    smtpHost: undefined,
    smtpPort: undefined,
    smtpUser: undefined,
    smtpPass: undefined,
    smtpFrom: undefined,
    imageVersion: undefined,
    imageCommit: undefined,
    imageDigest: undefined,
    instanzName: undefined,
    koordinatorUrl: undefined,
    koordinatorGeheimnis: undefined,
    koordinatorFristSekunden: undefined,
    chatTageslimit: undefined,
    chatMailNachMinuten: undefined,
    vapidOeffentlich: undefined,
    vapidPrivat: undefined,
    vapidKontakt: undefined,
    wartungsfenster: 'di 07-09',
    pipelineGeheimnis: undefined,
  };
}

const istWindows = process.platform === 'win32';

describe('geheimnisBesorgen', () => {
  let ordner: string;
  let datei: string;
  let hinweise: string[];
  const optionen = () => ({ datei, hinweis: (text: string) => hinweise.push(text) });

  beforeEach(() => {
    ordner = mkdtempSync(path.join(tmpdir(), 'cockpit-geheimnis-'));
    datei = path.join(ordner, '.cockpit-dev-secret');
    hinweise = [];
  });
  afterEach(() => {
    rmSync(ordner, { recursive: true, force: true });
  });

  describe('Entwicklung ohne Variable', () => {
    it('legt die Datei beim ersten Aufruf an und liefert ihr Geheimnis', () => {
      const geheimnis = geheimnisBesorgen(umgebung('development'), optionen());

      expect(existsSync(datei)).toBe(true);
      expect(readFileSync(datei, 'utf8').trim()).toBe(geheimnis);
      // 32 Zufallsbytes, base64url: 43 Zeichen; mindestens die 32, die Better Auth verlangt.
      expect(geheimnis).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it.skipIf(istWindows)('legt sie nur für den Eigentümer lesbar an (0600)', () => {
      geheimnisBesorgen(umgebung('development'), optionen());

      expect(statSync(datei).mode & 0o777).toBe(0o600);
    });

    it('liefert bei jedem weiteren Aufruf dasselbe Geheimnis — der Kern: ein Neustart würfelt nicht neu', () => {
      const erstes = geheimnisBesorgen(umgebung('development'), optionen());
      const zweites = geheimnisBesorgen(umgebung('development'), optionen());
      const drittes = geheimnisBesorgen(umgebung('development'), optionen());

      expect(zweites).toBe(erstes);
      expect(drittes).toBe(erstes);
    });

    it('sagt genau einmal Bescheid: beim Anlegen, mit Dateiname, ohne das Geheimnis zu nennen', () => {
      const geheimnis = geheimnisBesorgen(umgebung('development'), optionen());
      geheimnisBesorgen(umgebung('development'), optionen());

      expect(hinweise).toHaveLength(1);
      expect(hinweise[0]).toContain('.cockpit-dev-secret');
      expect(hinweise[0]).toContain('BETTER_AUTH_SECRET');
      expect(hinweise[0]).not.toContain(geheimnis);
    });

    it('darf ohne Hinweis-Funktion aufgerufen werden', () => {
      expect(() => geheimnisBesorgen(umgebung('development'), { datei })).not.toThrow();
    });

    it('hinterlässt nur die Datei selbst im Ordner (keine Zwischendatei)', () => {
      geheimnisBesorgen(umgebung('development'), optionen());

      expect(readdirSync(ordner)).toEqual(['.cockpit-dev-secret']);
    });

    it('würfelt für zwei verschiedene Dateien verschiedene Geheimnisse', () => {
      const andere = path.join(ordner, 'andere');
      const eins = geheimnisBesorgen(umgebung('development'), optionen());
      const zwei = geheimnisBesorgen(umgebung('development'), { datei: andere });

      expect(zwei).not.toBe(eins);
    });

    it('liest ein vorhandenes Geheimnis auch mit Zeilenumbruch am Ende (von Hand angelegt)', () => {
      const eigenes = 'ein-von-hand-gesetztes-geheimnis-mit-mehr-als-32-zeichen';
      writeFileSync(datei, `${eigenes}\n`, { mode: 0o600 });

      expect(geheimnisBesorgen(umgebung('development'), optionen())).toBe(eigenes);
      expect(hinweise).toEqual([]);
    });

    it('bricht bei einer zu kurzen Datei ab, statt still ein neues Geheimnis zu würfeln', () => {
      writeFileSync(datei, 'zu-kurz\n', { mode: 0o600 });

      expect(() => geheimnisBesorgen(umgebung('development'), optionen())).toThrow(/\.cockpit-dev-secret.*(löschen|Löschen)/s);
      // Die Datei bleibt, wie sie war: nichts wird überschrieben.
      expect(readFileSync(datei, 'utf8')).toBe('zu-kurz\n');
    });

    it('bricht ab, wenn sich die Datei nicht lesen lässt (hier: ein Ordner mit dem Namen)', () => {
      mkdirSync(datei);

      expect(() => geheimnisBesorgen(umgebung('development'), optionen())).toThrow(/EISDIR/);
    });

    it('legt die Datei nicht über eine vorhandene: wer zu spät kommt, überschreibt nichts (Wettlauf)', () => {
      writeFileSync(datei, 'das-geheimnis-des-schnelleren-prozesses-mit-32-zeichen', { mode: 0o600 });

      expect(geheimnisDateiAnlegen(datei, 'das-geheimnis-des-langsameren-prozesses-mit-32-zeichen')).toBe(false);

      expect(readFileSync(datei, 'utf8')).toBe('das-geheimnis-des-schnelleren-prozesses-mit-32-zeichen');
      expect(readdirSync(ordner)).toEqual(['.cockpit-dev-secret']); // keine Zwischendatei bleibt liegen
    });

    it('bricht bei einer leeren Datei ab', () => {
      writeFileSync(datei, '', { mode: 0o600 });

      expect(() => geheimnisBesorgen(umgebung('development'), optionen())).toThrow(/ungültig|zu kurz/i);
    });

    it('fällt auf ein Geheimnis je Prozess zurück und sagt es, wenn die Datei nicht angelegt werden kann', () => {
      const unmoeglich = path.join(ordner, 'gibt-es-nicht', '.cockpit-dev-secret');
      const geheimnis = geheimnisBesorgen(umgebung('development'), { datei: unmoeglich, hinweis: (text) => hinweise.push(text) });

      expect(geheimnis).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(existsSync(unmoeglich)).toBe(false);
      expect(hinweise).toHaveLength(1);
      expect(hinweise[0]).toMatch(/nicht (gespeichert|angelegt)/);
      expect(hinweise[0]).toContain('BETTER_AUTH_SECRET');
      // Kein dauerhaftes Geheimnis: der nächste Aufruf würfelt neu, und der Hinweis sagt, was das kostet.
      expect(geheimnisBesorgen(umgebung('development'), { datei: unmoeglich })).not.toBe(geheimnis);
      expect(hinweise[0]).toMatch(/Neustart/);
    });

    it.skipIf(istWindows || process.getuid?.() === 0)('fällt zurück, wenn der Ordner nicht beschreibbar ist', () => {
      const schreibgeschuetzt = path.join(ordner, 'ro');
      mkdirSync(schreibgeschuetzt);
      chmodSync(schreibgeschuetzt, 0o500);
      try {
        const geheimnis = geheimnisBesorgen(umgebung('development'), {
          datei: path.join(schreibgeschuetzt, '.cockpit-dev-secret'),
          hinweis: (text) => hinweise.push(text),
        });

        expect(geheimnis).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(hinweise).toHaveLength(1);
      } finally {
        chmodSync(schreibgeschuetzt, 0o700);
      }
    });

    it('teilen sich gleichzeitig startende Prozesse dasselbe Geheimnis (tsx watch, zwei Terminals)', async () => {
      const skript = `
        import { geheimnisBesorgen } from './src/auth/konfiguration.js';
        const env = { nodeEnv: 'development', authSecret: undefined };
        process.stdout.write(geheimnisBesorgen(env, { datei: process.argv[1] }));
      `;
      const starten = (): Promise<string> =>
        new Promise((ok, fehler) => {
          const kind = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', skript, datei], {
            cwd: wurzel,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let ausgabe = '';
          let meldung = '';
          kind.stdout.on('data', (stueck: Buffer) => (ausgabe += stueck.toString()));
          kind.stderr.on('data', (stueck: Buffer) => (meldung += stueck.toString()));
          kind.on('exit', (code) => (code === 0 ? ok(ausgabe) : fehler(new Error(`Exit ${String(code)}: ${meldung}`))));
        });

      const ergebnisse = await Promise.all(Array.from({ length: 6 }, starten));

      expect(new Set(ergebnisse).size).toBe(1);
      expect(ergebnisse[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(readFileSync(datei, 'utf8').trim()).toBe(ergebnisse[0]);
      expect(readdirSync(ordner)).toEqual(['.cockpit-dev-secret']);
    }, 60_000);
  });

  describe('gesetzte Variable', () => {
    it('gewinnt in der Entwicklung immer und legt keine Datei an', () => {
      const geheimnis = geheimnisBesorgen(umgebung('development', 'aus-der-umgebung-mit-mehr-als-32-zeichen'), optionen());

      expect(geheimnis).toBe('aus-der-umgebung-mit-mehr-als-32-zeichen');
      expect(existsSync(datei)).toBe(false);
      expect(hinweise).toEqual([]);
    });

    it('gewinnt auch gegen eine vorhandene Datei', () => {
      writeFileSync(datei, 'das-geheimnis-aus-der-datei-mit-mehr-als-32-zeichen', { mode: 0o600 });

      expect(geheimnisBesorgen(umgebung('development', 'aus-der-umgebung-mit-mehr-als-32-zeichen'), optionen())).toBe(
        'aus-der-umgebung-mit-mehr-als-32-zeichen',
      );
    });

    it('zählt eine leere Variable als nicht gesetzt', () => {
      const geheimnis = geheimnisBesorgen(umgebung('development', ''), optionen());

      expect(readFileSync(datei, 'utf8').trim()).toBe(geheimnis);
    });

    it('gilt in Produktion und in Tests unverändert', () => {
      expect(geheimnisBesorgen(umgebung('production', 'aus-der-umgebung-mit-mehr-als-32-zeichen'), optionen())).toBe(
        'aus-der-umgebung-mit-mehr-als-32-zeichen',
      );
      expect(geheimnisBesorgen(umgebung('test', 'aus-der-umgebung-mit-mehr-als-32-zeichen'), optionen())).toBe(
        'aus-der-umgebung-mit-mehr-als-32-zeichen',
      );
    });
  });

  describe('Produktion', () => {
    it('startet ohne Variable nicht und legt nichts an', () => {
      expect(() => geheimnisBesorgen(umgebung('production'), optionen())).toThrow(/BETTER_AUTH_SECRET ist nicht gesetzt/);
      expect(existsSync(datei)).toBe(false);
    });

    it('liest die Entwicklungsdatei nie — auch wenn eine im Ordner liegt', () => {
      writeFileSync(datei, 'das-geheimnis-aus-der-datei-mit-mehr-als-32-zeichen', { mode: 0o600 });

      expect(() => geheimnisBesorgen(umgebung('production'), optionen())).toThrow(/BETTER_AUTH_SECRET ist nicht gesetzt/);
      expect(() => geheimnisBesorgen(umgebung('production', ''), optionen())).toThrow(/BETTER_AUTH_SECRET ist nicht gesetzt/);
    });
  });

  describe('Test-Umgebung', () => {
    it('legt nichts an und würfelt je Aufruf neu (Tests setzen ihr Geheimnis selbst)', () => {
      const eins = geheimnisBesorgen(umgebung('test'), optionen());
      const zwei = geheimnisBesorgen(umgebung('test'), optionen());

      expect(eins).not.toBe(zwei);
      expect(existsSync(datei)).toBe(false);
      expect(hinweise).toEqual([]);
    });

    it('liest die Entwicklungsdatei nicht', () => {
      const inDatei = 'das-geheimnis-aus-der-datei-mit-mehr-als-32-zeichen';
      writeFileSync(datei, inDatei, { mode: 0o600 });

      expect(geheimnisBesorgen(umgebung('test'), optionen())).not.toBe(inDatei);
    });
  });
});

describe('Die Datei der Entwicklung liegt im Repo, aber nie in Git oder im Image', () => {
  it('heißt .cockpit-dev-secret und liegt in der Wurzel (von src/auth und dist/auth aus zwei Ordner nach oben)', () => {
    expect(DEV_GEHEIMNIS_DATEI).toBe(path.join(wurzel, '.cockpit-dev-secret'));
  });

  it('steht in .gitignore und in .dockerignore', () => {
    for (const ignorierdatei of ['.gitignore', '.dockerignore']) {
      const zeilen = readFileSync(path.join(wurzel, ignorierdatei), 'utf8').split('\n').map((zeile) => zeile.trim());
      expect(zeilen, ignorierdatei).toContain('.cockpit-dev-secret');
    }
  });

  it('wird von git tatsächlich ignoriert', () => {
    // Exit 0: ignoriert. `git check-ignore` prüft die Regeln, auch wenn die Datei nicht existiert.
    expect(() => execFileSync('git', ['check-ignore', '-q', '.cockpit-dev-secret'], { cwd: wurzel })).not.toThrow();
  });
});

describe('Der Log verweist auf das README', () => {
  it('hat den Abschnitt „Auth-Geheimnis", auf den Hinweis und Log zeigen', () => {
    const readme = readFileSync(path.join(wurzel, 'README.md'), 'utf8');

    expect(readme).toMatch(/^### Auth-Geheimnis/m);
    expect(readFileSync(path.join(wurzel, '.env.example'), 'utf8')).toContain('.cockpit-dev-secret');
  });
});

