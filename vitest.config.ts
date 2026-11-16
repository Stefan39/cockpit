import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Legt die Testdatenbank an und migriert sie; bricht ab, wenn
    // TEST_DATABASE_URL nicht auf eine `_test`-Datenbank zeigt (COPI-21).
    globalSetup: ['test/global-setup.ts', 'test/global-setup-assets.ts'],
    // Testdateien laufen parallel (COPI-73). Sie räumen ihre Tabellen ab (Erststart, Einladung) und dürfen sich
    // deshalb keine Datenbank teilen: `global-setup.ts` legt je Worker eine Kopie `cockpit_w<N>_test` an,
    // `testdatenbank.ts` gibt jedem Worker über `VITEST_POOL_ID` die eigene. Lokal sechs Worker (8 Kerne: 70–75 s,
    // mit vier 78–82 s; je Worker kommen Verbindungspools dazu, Postgres erlaubt 100 Verbindungen). In der CI zwei:
    // die Standard-Runner privater Repos haben zwei Kerne, jeder Shard legt nur so viele Kopien an.
    fileParallelism: true,
    maxWorkers: process.env.CI ? 2 : 6,
    // Datenbanktests brauchen auf langsamen Runnern (CI, devbox) gelegentlich etwas über 5 s (COPI-148, PR #175).
    // Ein großzügiges Limit verhindert rote Läufe ohne Fehler; hängende Tests fallen weiter auf.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Kritische Pfade (Auth, Update-Freigabe, Übernahme-Sperre) brauchen laut
      // den Architektur-Leitplanken Tests, bevor sie als fertig gelten — Schwelle wird ab E2 verschärft.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
