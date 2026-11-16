/**
 * Führt `main` nur aus, wenn die Datei direkt gestartet wurde (`tsx scripts/dev/<datei>.ts …`) — nie beim Import aus
 * einem Test heraus (`test/vorschau-argumente.test.ts`, `test/demo-daten-datenbank.test.ts`). Das ESM-Gegenstück zu
 * `require.main === module`; `path.resolve` gleicht eine relative gegen eine absolute Schreibweise desselben Pfades an.
 * Ein Fehler steht auf der Fehlerausgabe und setzt den Exit-Code.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function direktStarten(metaUrl: string, main: () => Promise<void>): void {
  if (process.argv[1] !== undefined && fileURLToPath(metaUrl) === path.resolve(process.argv[1])) {
    main().catch((fehler: unknown) => {
      console.error(fehler);
      process.exitCode = 1;
    });
  }
}
