/**
 * Stimmen Build, Dockerfile, `npm start` und README über die Startpunkte überein
 * (COPI-24)? Ohne diesen Test hat der Fehler bis hierher niemand bemerkt: Der
 * Build legte alles unter `dist/src/…` ab, das Image startete aber
 * `dist/server/index.js` — es konnte nie starten, und die CI baute es nur.
 *
 * Rein und schnell: prüft die Konfiguration, kompiliert nichts. Dass das Image
 * wirklich startet, prüft der Smoke-Test in der CI (Gate 6).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** `dist/x/y.js` ist das Ergebnis von `src/x/y.ts`, wenn `src` das Wurzelverzeichnis ist. */
function quelleZu(distPfad: string): string {
  return distPfad.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
}

describe('Build-Layout', () => {
  it('kompiliert src ohne Zwischenordner nach dist (rootDir src, nur src im Build)', () => {
    const build = JSON.parse(readFileSync('tsconfig.build.json', 'utf8')) as {
      compilerOptions: { rootDir?: string };
      include: string[];
    };

    // Mit `rootDir` „.“ oder einem zusätzlichen `db` im Build entstünde `dist/src/…`,
    // und keiner der Startpunkte unten würde existieren.
    expect(build.compilerOptions.rootDir).toBe('src');
    expect(build.include).toEqual(['src']);
  });

  it('startet aus dem Dockerfile ein Modul, das es im Quellbaum gibt', () => {
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
    const start = /^CMD \["node", "([^"]+)"\]/m.exec(dockerfile)?.[1] ?? '';

    expect(start).toBe('dist/server/index.js');
    expect(existsSync(quelleZu(start))).toBe(true);
  });

  it('startet mit `npm start` dasselbe Modul wie das Image', () => {
    const paket = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const start = /^node (\S+)$/.exec(paket.scripts.start ?? '')?.[1] ?? '';

    expect(start).toBe('dist/server/index.js');
    expect(existsSync(quelleZu(start))).toBe(true);
  });

  it('nennt im Handbuch das Server-Kommando dort, wo es im Image liegt', () => {
    const readme = readFileSync('docs/handbuch.md', 'utf8');
    const genannt = [...readme.matchAll(/node (dist\/[\w/]+\.js)/g)].map((treffer) => treffer[1] ?? '');

    expect(genannt).toContain('dist/cli/index.js');
    for (const pfad of genannt) {
      expect(existsSync(quelleZu(pfad)), `${pfad} hat keine Quelle`).toBe(true);
    }
  });

  it('findet die Views dort, wo das Image sie ablegt', () => {
    // app.ts sucht `views` zwei Ordner über `dist/server`; das Image legt sie nach /app/views.
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8');

    expect(dockerfile).toMatch(/COPY --from=build \/app\/views \.\/views/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/dist \.\/dist/);
    expect(readFileSync('src/server/app.ts', 'utf8')).toContain("path.join(hierOrdner, '..', '..', 'views')");
  });

  it('findet die Browser-Skripte (Passkey, Chat) dort, wo das Image den Ordner assets ablegt', () => {
    // Die Route liest das Skript beim Start: `src/server/routes` und `dist/server/routes`
    // liegen beide drei Ordner unter der Wurzel, das Image legt `assets` neben `dist`.
    // Fehlte der Ordner im Image, startete die Anwendung nicht (Smoke-Test, Gate 6).
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8');

    expect(dockerfile).toMatch(/COPY --from=build \/app\/assets \.\/assets/);
    expect(readFileSync('src/server/routes/passkey-skript.ts', 'utf8')).toMatch(/'\.\.',\s*'\.\.',\s*'\.\.',\s*'assets',\s*'js'\)/);
    expect(existsSync('assets/js/passkey.js')).toBe(true);
    expect(existsSync('assets/js/chat.js')).toBe(true);
  });

  it('bringt die Migrationen mit ins Image und findet sie dort, wo der Runner sie sucht (COPI-31)', () => {
    // Bis COPI-31 enthielt das Image keine einzige .sql-Datei und keinen Runner: auf einer neuen
    // Instanz gab es keinen Weg zum Schema. `src/datenbank` und `dist/datenbank` liegen beide zwei
    // Ordner unter der Wurzel, das Image legt `db/migrations` neben `dist`.
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8');

    expect(dockerfile).toMatch(/COPY --from=build \/app\/db\/migrations \.\/db\/migrations/);
    expect(readFileSync('src/datenbank/migrationen.ts', 'utf8')).toMatch(
      /'\.\.',\s*'\.\.',\s*'db',\s*'migrations'/,
    );
    expect(existsSync('db/migrations/0001_init.up.sql')).toBe(true);
  });

  it('kompiliert den Runner in den Build: er liegt in src, nicht nur in db/', () => {
    // `db/migrate.ts` läuft über tsx und gehört nicht zum Build; der Runner im Image ist der aus src.
    expect(existsSync('src/datenbank/migrationen.ts')).toBe(true);
    expect(readFileSync('db/migrate.ts', 'utf8')).toContain("from '../src/datenbank/migrationen.js'");
  });

  it('baut das Stylesheet im Build-Stage des Images und legt es dorthin, wo die Route es sucht (COPI-30)', () => {
    // Tailwind läuft nur beim Bauen; das Image enthält das fertige, gehashte Stylesheet unter
    // `assets/gebaut`. Ohne den Schritt startete die Anwendung nicht (assetsLaden bricht ab).
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
    const buildStage = /FROM deps AS build\n([\s\S]*?)\n\nFROM /.exec(dockerfile)?.[1] ?? '';
    const paket = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

    expect(buildStage).toMatch(/RUN npm run assets/);
    expect(paket.scripts.assets).toMatch(/^tsx src\/assets\/cli\.ts$/);
    expect(paket.scripts['assets:watch']).toMatch(/^tsx src\/assets\/cli\.ts --watch$/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/assets \.\/assets/); // enthält assets/gebaut
    expect(readFileSync('src/assets/manifest.ts', 'utf8')).toMatch(/'\.\.',\s*'\.\.',\s*'assets',\s*'gebaut'/);
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^assets\/gebaut\/$/m);
    expect(readFileSync('.dockerignore', 'utf8')).toMatch(/^assets\/gebaut$/m);
  });

  it('nutzt Tailwind und die Schriften nur im Build, nicht zur Laufzeit', () => {
    const paket = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    for (const name of ['tailwindcss', '@tailwindcss/cli', '@fontsource-variable/ibm-plex-sans', '@fontsource/ibm-plex-mono']) {
      expect(paket.devDependencies[name], name).toBeDefined();
      expect(paket.dependencies[name], `${name} gehört nicht in die Laufzeit-Abhängigkeiten`).toBeUndefined();
    }
  });
});
