/**
 * Der Asset-Build und die Auslieferung (COPI-30): Tailwind erzeugt das Stylesheet, jede Datei
 * bekommt den Hash ihres Inhalts im Namen, das Cockpit liefert sie mit `immutable` aus — und
 * nur das, was im Manifest steht.
 *
 * Läuft ohne Datenbank. Gebaut wird in einen Temp-Ordner (nicht in `assets/gebaut`, das der
 * globale Setup für alle anderen Tests füllt), damit der Test den Build selbst misst.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetsBauen, schriftenEinsammeln } from '../src/assets/bauen.js';
import { assetsLaden, type AssetsManifest } from '../src/assets/manifest.js';
import { buildApp } from '../src/server/app.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const hash = (inhalt: Buffer | string): string => createHash('sha256').update(inhalt).digest('hex').slice(0, 16);

let ordner: string;
let manifest: AssetsManifest;

beforeAll(() => {
  ordner = mkdtempSync(path.join(tmpdir(), 'cockpit-assets-'));
  manifest = assetsBauen({ ziel: ordner });
}, 60_000);

afterAll(() => {
  rmSync(ordner, { recursive: true, force: true });
});

describe('Asset-Build', () => {
  it('nennt das Stylesheet mit dem Hash seines Inhalts im Namen', () => {
    const name = manifest.stylesheet;
    const inhalt = readFileSync(path.join(ordner, name));

    expect(name).toMatch(/^cockpit\.[0-9a-f]{16}\.css$/);
    expect(name).toBe(`cockpit.${hash(inhalt)}.css`);
  });

  it('baut reproduzierbar: gleiche Quelle, gleicher Name', () => {
    const zweiter = mkdtempSync(path.join(tmpdir(), 'cockpit-assets-'));
    try {
      expect(assetsBauen({ ziel: zweiter })).toEqual(manifest);
    } finally {
      rmSync(zweiter, { recursive: true, force: true });
    }
  });

  it('hat Tailwind wirklich laufen lassen: Basisstile, Dunkelmodus über light-dark() und den Schalter, Schriften', () => {
    const css = readFileSync(path.join(ordner, manifest.stylesheet), 'utf8');

    expect(css).toMatch(/tailwindcss v4\./);
    // Farben mit beiden Werten; welcher gilt, entscheidet color-scheme — ohne Wahl das Gerät, sonst der Schalter.
    expect(css).toMatch(/--color-page:\s*light-dark\(#f4f7fa,\s*#0b1424\)/);
    expect(css).toMatch(/\[data-theme=["']?dunkel["']?\][^{]*\{[^}]*color-scheme:\s*dark/);
    expect(css).toMatch(/@font-face/);
    expect(css).toContain('IBM Plex Sans');
    expect(css).toContain('IBM Plex Mono');
    expect(css).toMatch(/font-display:\s*swap/); // Text erscheint sofort, die Schrift zieht nach
    expect(css.length).toBeGreaterThan(5_000);
  });

  it('erzeugt keine Klassen aus Ordnern außerhalb der Views (source(none) plus @source)', () => {
    const css = readFileSync(path.join(ordner, manifest.stylesheet), 'utf8');

    // In `src/`, `test/` und `README.md` stehen viele Wörter, die wie Klassen aussehen.
    // Wäre die automatische Erkennung an, käme z. B. `.container` oder `.table` aus dem Fließtext.
    expect(css).not.toMatch(/\.table\s*\{/);
    expect(css).not.toMatch(/\.container\s*\{/);
  });

  it('liefert die Schriften selbst: jede url() zeigt auf eine Datei mit Hash im Manifest', () => {
    const css = readFileSync(path.join(ordner, manifest.stylesheet), 'utf8');
    const adressen = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((treffer) => treffer[1] ?? '');

    expect(adressen.length).toBeGreaterThanOrEqual(2);
    for (const adresse of adressen) {
      expect(adresse, 'nur Adressen unter /assets/').toMatch(/^\/assets\/[a-z0-9-]+\.[0-9a-f]{16}\.woff2$/);
      const name = adresse.replace('/assets/', '');
      expect(manifest.dateien[name], `${name} fehlt im Manifest`).toBe('font/woff2');
      const inhalt = readFileSync(path.join(ordner, name));
      expect(name.split('.')[1], `Hash von ${name}`).toBe(hash(inhalt));
      expect(inhalt.subarray(0, 4).toString('latin1'), `${name} ist eine woff2-Datei`).toBe('wOF2');
    }
  });

  it('enthält weder Pfade aus node_modules noch einen fremden Host', () => {
    const css = readFileSync(path.join(ordner, manifest.stylesheet), 'utf8');

    expect(css).not.toContain('node_modules');
    expect(css).not.toMatch(/(?:url\(\s*["']?\s*|@import\s+(?:url\(\s*)?["']?\s*)(?:https?:)?\/\//i);
    expect(css).not.toMatch(/googleapis|gstatic|cloudflare|jsdelivr|unpkg|cdnjs/i);
  });

  it('schreibt ein Manifest, das genau die Dateien im Ordner nennt', () => {
    const geschrieben = JSON.parse(readFileSync(path.join(ordner, 'manifest.json'), 'utf8')) as AssetsManifest;

    expect(geschrieben).toEqual(manifest);
    expect(manifest.dateien[manifest.stylesheet]).toBe('text/css; charset=utf-8');
    expect(Object.keys(manifest.dateien).length).toBeGreaterThanOrEqual(3);
  });
});

describe('Schriften einsammeln', () => {
  let arbeit: string;
  let ziel: string;

  beforeAll(() => {
    arbeit = mkdtempSync(path.join(tmpdir(), 'cockpit-schriften-'));
    ziel = path.join(arbeit, 'ziel');
    mkdirSync(ziel);
    mkdirSync(path.join(arbeit, 'quelle'));
    writeFileSync(path.join(arbeit, 'quelle', 'a.woff2'), 'wOF2-inhalt-a');
    writeFileSync(path.join(arbeit, 'quelle', 'b.woff2'), 'wOF2-inhalt-a'); // gleicher Inhalt, anderer Name
    writeFileSync(path.join(arbeit, 'quelle', 'bild.png'), 'kein Font');
  });
  afterAll(() => {
    rmSync(arbeit, { recursive: true, force: true });
  });

  const einsammeln = (css: string): { css: string; dateien: Record<string, string> } => {
    const dateien: Record<string, string> = {};
    return { css: schriftenEinsammeln(css, path.join(arbeit, 'quelle'), ziel, dateien), dateien };
  };

  it('kopiert die Datei mit Hash ins Ziel und schreibt die Adresse um (mit und ohne Anführungszeichen)', () => {
    const { css, dateien } = einsammeln('a{src:url(a.woff2)}b{src:url("b.woff2")}c{src:url( \'./a.woff2\' )}');
    const hashA = hash('wOF2-inhalt-a');

    expect(css).toBe(
      `a{src:url(/assets/a.${hashA}.woff2)}b{src:url(/assets/b.${hashA}.woff2)}c{src:url(/assets/a.${hashA}.woff2)}`,
    );
    expect(Object.keys(dateien).sort()).toEqual([`a.${hashA}.woff2`, `b.${hashA}.woff2`]);
    expect(readdirSync(ziel).sort()).toEqual(Object.keys(dateien).sort());
  });

  it.each([
    ['einen fremden Host', 'a{src:url(https://fonts.example/x.woff2)}', /Fremdadresse/],
    ['eine protokollrelative Adresse', 'a{src:url(//fonts.example/x.woff2)}', /Fremdadresse/],
    ['eine data-Adresse', 'a{src:url(data:font/woff2;base64,AAAA)}', /Fremdadresse/],
    ['eine Datei, die kein woff2 ist', 'a{src:url(bild.png)}', /nicht kennt/],
    ['eine fehlende Schriftdatei', 'a{src:url(gibt-es-nicht.woff2)}', /Schriftdatei fehlt/],
  ])('bricht ab bei %s', (_beschreibung, css, meldung) => {
    expect(() => einsammeln(css)).toThrow(meldung);
  });
});

describe('Manifest prüfen', () => {
  it.each([
    ['kein Objekt', '"text"'],
    ['null', 'null'],
    ['ohne Stylesheet', '{"dateien":{}}'],
    ['ohne Dateien', '{"stylesheet":"cockpit.0123456789abcdef.css"}'],
    ['mit unerlaubtem Dateinamen', '{"stylesheet":"a.css","dateien":{"a.css":"text/css"}}'],
    ['ohne Inhaltstyp', '{"stylesheet":"cockpit.0123456789abcdef.css","dateien":{"cockpit.0123456789abcdef.css":5}}'],
    ['mit einem Stylesheet, das nicht unter den Dateien steht', '{"stylesheet":"cockpit.0123456789abcdef.css","dateien":{}}'],
  ])('weist ein Manifest %s ab', (_beschreibung, inhalt) => {
    const arbeit = mkdtempSync(path.join(tmpdir(), 'cockpit-manifest-'));
    try {
      writeFileSync(path.join(arbeit, 'manifest.json'), inhalt);
      expect(() => assetsLaden(arbeit)).toThrow(/Manifest der Assets ungültig/);
    } finally {
      rmSync(arbeit, { recursive: true, force: true });
    }
  });
});

describe('npm run assets (Kommandozeile)', () => {
  const wurzel = path.join(import.meta.dirname, '..');
  const cli = (...argumente: string[]): string[] => ['--import', 'tsx', 'src/assets/cli.ts', ...argumente];

  it('baut einmal und nennt das Stylesheet', () => {
    const ausgabe = execFileSync(process.execPath, cli(), { cwd: wurzel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    expect(ausgabe).toBe('');
    // Die Meldung geht auf stderr (console.warn); ein Blick ins Manifest belegt das Ergebnis.
    const manifest = JSON.parse(readFileSync(path.join(wurzel, 'assets', 'gebaut', 'manifest.json'), 'utf8')) as AssetsManifest;
    expect(manifest.stylesheet).toMatch(/^cockpit\.[0-9a-f]{16}\.css$/);
    expect(existsSync(path.join(wurzel, 'assets', 'gebaut', manifest.stylesheet))).toBe(true);
  }, 30_000);

  it('baut im Watch-Betrieb neu, sobald sich die Quelle ändert', async () => {
    const kind = spawn(process.execPath, cli('--watch'), { cwd: wurzel, stdio: ['ignore', 'pipe', 'pipe'] });
    let meldungen = '';
    kind.stderr.on('data', (teil: Buffer) => (meldungen += teil.toString()));
    const warten = async (bedingung: () => boolean, was: string): Promise<void> => {
      const ende = Date.now() + 20_000;
      while (!bedingung()) {
        if (Date.now() > ende) {
          throw new Error(`Zeitüberschreitung: ${was}. Ausgabe: ${meldungen}`);
        }
        await new Promise((fertig) => setTimeout(fertig, 100));
      }
    };
    try {
      await warten(() => meldungen.includes('Beobachte'), 'der Watcher meldet sich');
      expect(meldungen.match(/Assets gebaut:/g)?.length).toBe(1);
      // Speichern der Quelle (nur die Zeit ändert sich): der Watcher baut ein zweites Mal.
      const jetzt = new Date();
      utimesSync(path.join(wurzel, 'assets', 'css', 'input.css'), jetzt, jetzt);
      await warten(() => (meldungen.match(/Assets gebaut:/g)?.length ?? 0) >= 2, 'der Watcher baut neu');
    } finally {
      kind.kill();
    }
  }, 60_000);
});

describe('assetsLaden', () => {
  it('liest das Manifest und die Dateien; die Adresse des Stylesheets beginnt mit /assets/', () => {
    const assets = assetsLaden(ordner);

    expect(assets.stylesheet).toBe(`/assets/${manifest.stylesheet}`);
    expect(assets.datei(manifest.stylesheet)?.inhalt.length).toBeGreaterThan(0);
    expect(assets.datei('gibt-es-nicht.css')).toBeUndefined();
    expect(assets.datei('manifest.json'), 'das Manifest selbst ist nicht öffentlich').toBeUndefined();
  });

  it('bricht mit einem klaren Hinweis ab, wenn das Manifest fehlt (Start ohne Build)', () => {
    const leer = mkdtempSync(path.join(tmpdir(), 'cockpit-assets-leer-'));
    try {
      expect(() => assetsLaden(leer)).toThrow(/npm run assets/);
    } finally {
      rmSync(leer, { recursive: true, force: true });
    }
  });

  it('weist ein Manifest ab, das aus dem Ordner hinaus zeigt', () => {
    const boese = mkdtempSync(path.join(tmpdir(), 'cockpit-assets-boese-'));
    try {
      writeFileSync(
        path.join(boese, 'manifest.json'),
        JSON.stringify({ stylesheet: '../x.css', dateien: { '../x.css': 'text/css' } }),
      );
      expect(() => assetsLaden(boese)).toThrow(/Manifest/);
    } finally {
      rmSync(boese, { recursive: true, force: true });
    }
  });
});

describe('Auslieferung unter /assets', () => {
  it('liefert das Stylesheet mit immutable, nosniff und richtigem Typ — ohne Sitzung', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { assetsOrdner: ordner });
    try {
      const antwort = await app.inject({ method: 'GET', url: `/assets/${manifest.stylesheet}` });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['content-type']).toBe('text/css; charset=utf-8');
      expect(antwort.headers['cache-control']).toBe(IMMUTABLE);
      expect(antwort.headers['x-content-type-options']).toBe('nosniff');
      expect(antwort.headers['set-cookie']).toBeUndefined();
      expect(antwort.body).toBe(readFileSync(path.join(ordner, manifest.stylesheet), 'utf8'));
    } finally {
      await app.close();
    }
  });

  it('liefert jede Schrift mit immutable und dem Typ font/woff2', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { assetsOrdner: ordner });
    try {
      const schriften = Object.entries(manifest.dateien).filter(([, typ]) => typ === 'font/woff2');
      expect(schriften.length).toBeGreaterThanOrEqual(2);
      for (const [name] of schriften) {
        const antwort = await app.inject({ method: 'GET', url: `/assets/${name}` });

        expect(antwort.statusCode, name).toBe(200);
        expect(antwort.headers['content-type'], name).toBe('font/woff2');
        expect(antwort.headers['cache-control'], name).toBe(IMMUTABLE);
        expect(antwort.rawPayload.equals(readFileSync(path.join(ordner, name))), `${name} unverändert`).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it('beantwortet HEAD wie GET, nur ohne Rumpf', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { assetsOrdner: ordner });
    try {
      const antwort = await app.inject({ method: 'HEAD', url: `/assets/${manifest.stylesheet}` });

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['cache-control']).toBe(IMMUTABLE);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['einen unbekannten Namen', '/assets/gibt-es-nicht.css', 404],
    ['das Manifest', '/assets/manifest.json', 404],
    ['einen Pfad mit Schrägstrich', '/assets/a/b.css', 404],
    ['den Ordner selbst', '/assets/', 404],
    ['einen Namen mit Prozent-Kodierung', '/assets/%63ockpit.css', 404],
    // Das Tor prüft auch die dekodierte Schreibweise: ein `..` macht den Pfad zum unbekannten
    // Pfad, und Anonyme werden zur Anmeldung geschickt, bevor die Route etwas sagt.
    ['einen Pfad aus dem Ordner hinaus', '/assets/..%2Fpackage.json', 303],
  ])('antwortet auf %s ohne Datei und ohne immutable', async (_beschreibung, url, status) => {
    const app = buildApp({ nodeEnv: 'test' }, { assetsOrdner: ordner });
    try {
      const antwort = await app.inject({ method: 'GET', url });

      expect(antwort.statusCode).toBe(status);
      expect(antwort.headers['cache-control'] ?? '').not.toContain('immutable');
      expect(antwort.body).not.toContain('"name"'); // nicht die package.json
    } finally {
      await app.close();
    }
  });

  it('setzt die Adresse des Stylesheets aus dem Manifest in jede Seite', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { assetsOrdner: ordner });
    try {
      const html = await app.render('nicht-gefunden.eta', { titel: 'Nicht gefunden' });

      expect(html).toContain(`href="/assets/${manifest.stylesheet}"`);
    } finally {
      await app.close();
    }
  });

  it('lässt eine Seite das Stylesheet nicht überschreiben: die Adresse setzt die Anwendung', async () => {
    const app = buildApp({ nodeEnv: 'test' }, { assetsOrdner: ordner });
    try {
      const html = await app.render('nicht-gefunden.eta', { titel: 'x', stylesheet: 'https://fremd.example/boese.css' });

      expect(html).toContain(`href="/assets/${manifest.stylesheet}"`);
      expect(html).not.toContain('fremd.example');
    } finally {
      await app.close();
    }
  });

  it('liest das Manifest außerhalb von Produktion bei jeder Anfrage neu, in Produktion nie (Watch-Betrieb)', async () => {
    const arbeit = mkdtempSync(path.join(tmpdir(), 'cockpit-assets-neu-'));
    try {
      const erster = assetsBauen({ ziel: arbeit });
      const entwicklung = buildApp({ nodeEnv: 'development' }, { assetsOrdner: arbeit });
      const produktion = buildApp({ nodeEnv: 'production' }, { assetsOrdner: arbeit });

      // Ein neuer Build ersetzt das Stylesheet unter neuem Namen und schreibt das Manifest neu.
      const neuerName = `cockpit.${'0'.repeat(16)}.css`;
      writeFileSync(path.join(arbeit, neuerName), '/* neu */');
      writeFileSync(
        path.join(arbeit, 'manifest.json'),
        JSON.stringify({ ...erster, stylesheet: neuerName, dateien: { ...erster.dateien, [neuerName]: 'text/css; charset=utf-8' } }),
      );

      expect(await entwicklung.render('nicht-gefunden.eta', { titel: 'x' })).toContain(neuerName);
      expect(await produktion.render('nicht-gefunden.eta', { titel: 'x' })).toContain(erster.stylesheet);
      expect((await entwicklung.inject({ method: 'GET', url: `/assets/${neuerName}` })).statusCode).toBe(200);
      expect((await produktion.inject({ method: 'GET', url: `/assets/${neuerName}` })).statusCode).toBe(404);

      await entwicklung.close();
      await produktion.close();
    } finally {
      rmSync(arbeit, { recursive: true, force: true });
    }
  });
});
