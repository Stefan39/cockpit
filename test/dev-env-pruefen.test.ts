/**
 * `./dev` prüft die `.env`, bevor es sie per Shell lädt (COPI-63).
 *
 * Anlass: Ein Secret mit `${`, `!`, `#` und `;` in doppelten Anführungszeichen brach das Laden mitten in der Datei ab.
 * Der Dev-Server lief trotzdem an, nur fehlten alle Variablen nach der Fehlerstelle, darunter die VAPID-Schlüssel.
 * Jetzt bricht `./dev up` vorher ab und nennt Zeile und Namen, **nie den Wert**, denn dort stehen Secrets.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PRUEFER = path.resolve('docker/env-pruefen.sh');
/** Steht in jedem Testwert; taucht er in der Ausgabe auf, ist ein Wert durchgesickert. */
const GEHEIM = 'GEHEIM';

const ordner: string[] = [];

afterEach(() => {
  for (const pfad of ordner.splice(0)) {
    rmSync(pfad, { recursive: true, force: true });
  }
});

function tempOrdner(): string {
  const pfad = mkdtempSync(path.join(tmpdir(), 'cockpit-env-'));
  ordner.push(pfad);
  return pfad;
}

function envDatei(inhalt: string): string {
  const datei = path.join(tempOrdner(), '.env');
  writeFileSync(datei, inhalt);
  return datei;
}

function pruefen(inhalt: string) {
  const ergebnis = spawnSync('bash', [PRUEFER, envDatei(inhalt)], { encoding: 'utf8' });
  return { status: ergebnis.status, ausgabe: `${ergebnis.stdout}${ergebnis.stderr}` };
}

/** Lädt die Datei so wie `./dev` und liefert den Wert einer Variable. */
function geladen(inhalt: string, name: string): string {
  const ergebnis = spawnSync('bash', ['-c', `set -a; . "$1"; set +a; printf '%s' "\${${name}}"`, 'bash', envDatei(inhalt)], {
    encoding: 'utf8',
  });
  return ergebnis.stdout;
}

const GUELTIG = [
  '# Kommentar',
  '',
  'NODE_ENV=development',
  'DATABASE_URL=postgres://postgres:dev@localhost:5432/cockpit',
  `COCKPIT_KOORDINATOR_URL=http://localhost:5678/webhook/koordinator`,
  `COCKPIT_KOORDINATOR_SECRET='${GEHEIM}\${abc}!#;"x' # Kommentar dahinter`,
  'export SMTP_FROM="cockpit@example.test"',
  'LEER=',
  "AUCH_LEER=''",
  '  EINGERUECKT=ja',
].join('\n');

describe('docker/env-pruefen.sh', () => {
  it('nimmt eine gültige Datei an, auch ohne Zeilenende am Schluss', () => {
    expect(pruefen(GUELTIG)).toEqual({ status: 0, ausgabe: '' });
  });

  it('lässt einfach gequotete Sonderzeichen beim Laden unverändert', () => {
    expect(geladen(GUELTIG, 'COCKPIT_KOORDINATOR_SECRET')).toBe(`${GEHEIM}\${abc}!#;"x`);
  });

  it.each([
    ['ein nicht geschlossenes doppeltes Anführungszeichen', `KOORDINATOR_SECRET="${GEHEIM}abc`],
    ['`${` in doppelten Anführungszeichen', `KOORDINATOR_SECRET="${GEHEIM}\${abc}"`],
    ['ein nicht geschlossenes einfaches Anführungszeichen', `KOORDINATOR_SECRET='${GEHEIM}abc`],
    ['Text hinter dem schließenden Anführungszeichen', `KOORDINATOR_SECRET='${GEHEIM}'abc`],
    ['Shell-Sonderzeichen ohne Anführungszeichen', `KOORDINATOR_SECRET=${GEHEIM};abc`],
    ['ein Leerzeichen ohne Anführungszeichen', `KOORDINATOR_SECRET=${GEHEIM} abc`],
    ['ein Windows-Zeilenende', `KOORDINATOR_SECRET=${GEHEIM}\r`],
  ])('weist %s ab: mit Zeile und Name, ohne den Wert', (_fall, zeile) => {
    const { status, ausgabe } = pruefen(`NODE_ENV=development\n# Kommentar\n${zeile}\nPORT=3000\n`);
    expect(status).not.toBe(0);
    expect(ausgabe).toContain('Zeile 3');
    expect(ausgabe).toContain('KOORDINATOR_SECRET');
    expect(ausgabe).not.toContain(GEHEIM);
  });

  it('weist eine Zeile ohne Zuweisung ab, ohne ihren Inhalt zu zeigen', () => {
    const { status, ausgabe } = pruefen(`NODE_ENV=development\n${GEHEIM}abc\n`);
    expect(status).not.toBe(0);
    expect(ausgabe).toContain('Zeile 2');
    expect(ausgabe).not.toContain(GEHEIM);
  });

  it('warnt bei halb eingerichteten Paaren, nennt nur Namen', () => {
    const { status, ausgabe } = pruefen(`COCKPIT_KOORDINATOR_URL=http://${GEHEIM}\nCOCKPIT_VAPID_PRIVATE_KEY=${GEHEIM}\n`);
    expect(status).toBe(0);
    expect(ausgabe).toContain('COCKPIT_KOORDINATOR_SECRET');
    expect(ausgabe).toContain('COCKPIT_VAPID_PUBLIC_KEY');
    expect(ausgabe).not.toContain(GEHEIM);
  });
});

describe('./dev up mit einer fehlerhaften .env', () => {
  it('bricht ab, bevor irgendetwas startet', () => {
    const wurzel = tempOrdner();
    mkdirSync(path.join(wurzel, 'docker'));
    copyFileSync('dev', path.join(wurzel, 'dev'));
    copyFileSync(PRUEFER, path.join(wurzel, 'docker', 'env-pruefen.sh'));
    writeFileSync(path.join(wurzel, '.env'), `NODE_ENV=development\nCOCKPIT_KOORDINATOR_SECRET="${GEHEIM}\${!x};#\nCOCKPIT_VAPID_PUBLIC_KEY=abc\n`);

    const ergebnis = spawnSync('bash', [path.join(wurzel, 'dev'), 'up'], { cwd: wurzel, encoding: 'utf8' });
    const ausgabe = `${ergebnis.stdout}${ergebnis.stderr}`;

    expect(ergebnis.status).not.toBe(0);
    expect(ausgabe).toContain('Zeile 2');
    expect(ausgabe).toContain('COCKPIT_KOORDINATOR_SECRET');
    expect(ausgabe).not.toContain(GEHEIM);
    expect(ausgabe).not.toContain('Starte Postgres');
  });
});
