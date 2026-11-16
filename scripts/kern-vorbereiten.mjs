/**
 * `prepare` (COPI-250): Ist der Kern eine Abhängigkeit eines anderen Projekts (etwa ein eigenes Projekt mit privaten Seiten, Installation aus
 * einem Git-Tag), baut npm ihn hier nach dem Holen, denn `dist/`, die Typdateien und die gebauten Assets (Stylesheet,
 * Schriften) liegen nicht im Repo. Der Verbraucher braucht dafür weder Tailwind noch die Schriftpakete. Beim
 * normalen `npm install` oder `npm ci` im Kern selbst, und im Dockerfile, wo `src/` noch fehlt, passiert nichts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const alsAbhaengigkeit = process.env.INIT_CWD !== undefined && resolve(process.env.INIT_CWD) !== process.cwd();
if (!alsAbhaengigkeit || !existsSync('src')) {
  process.exit(0);
}
const SCHRITTE = [
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  ['node_modules/tsx/dist/cli.mjs', 'src/assets/cli.ts'],
];
for (const argumente of SCHRITTE) {
  const lauf = spawnSync(process.execPath, argumente, { stdio: 'inherit' });
  if (lauf.status !== 0) {
    process.exit(lauf.status ?? 1);
  }
}
