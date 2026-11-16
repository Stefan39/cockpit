/**
 * Ob ein Konto einen aktiven zweiten Faktor hat, wird an einer Stelle entschieden
 * (COPI-25): in der Datenbank, in `cockpit.zweiter_faktor_aktiv`. Dieser Test
 * stellt rein, ohne Datenbank, sicher, dass im Code niemand die Spalte
 * `twoFactorEnabled` daran vorbei liest.
 *
 * Hintergrund: die Spalte setzt das Better-Auth-Plugin nur für TOTP. Ein Passkey
 * (COPI-26) würde sie nicht setzen; wer sie direkt liest, hielte ein Konto mit
 * Passkey für ungeschützt. Kommen Tor, Rechteprüfung, Einrichtungsseite und
 * Übergabe alle an der einen Funktion vorbei, ist das an einer Stelle behoben.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Alle `.ts`-Dateien unter `ordner`, rekursiv. */
function quelldateien(ordner: string): string[] {
  return readdirSync(ordner, { withFileTypes: true }).flatMap((eintrag) => {
    const pfad = path.join(ordner, eintrag.name);
    if (eintrag.isDirectory()) {
      return quelldateien(pfad);
    }
    return pfad.endsWith('.ts') ? [pfad] : [];
  });
}

/** Quelltext ohne Kommentare: Erklärungen dürfen die Spalte nennen, Code nicht. */
function ohneKommentare(quelle: string): string {
  return quelle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
}

describe('eine Quelle für „zweiter Faktor aktiv"', () => {
  it('liest die Spalte twoFactorEnabled im Code nirgends: weder als Feld noch in SQL', () => {
    const treffer = quelldateien('src')
      .filter((datei) => ohneKommentare(readFileSync(datei, 'utf8')).includes('twoFactorEnabled'))
      .map((datei) => path.relative('src', datei).split(path.sep).join('/'));

    // Erlaubt ist sie nur in den Migrationen (db/migrations), die die Funktion und die
    // Trigger definieren — die stehen bewusst nicht unter `src`.
    expect(treffer).toEqual([]);
  });

  it('fragt stattdessen die Funktion: Tor, Rechteprüfung, Einrichtungsseite und Übergabe rufen sie', () => {
    const ruft = (datei: string): boolean =>
      readFileSync(datei, 'utf8').includes('zweiter_faktor_aktiv') ||
      readFileSync(datei, 'utf8').includes('zweiterFaktorAktiv(');

    for (const datei of [
      'src/auth/sitzung.ts',
      'src/auth/berechtigung.ts',
      'src/server/routes/zwei-faktor.ts',
      'src/auth/betreuer.ts',
    ]) {
      expect(ruft(datei), `${datei} fragt „zweiter Faktor aktiv" nicht über die Funktion`).toBe(true);
    }
  });
});
