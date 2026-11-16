/**
 * Der Sitzungs-Endpunkt aus COPI-27 legt für jedes Konto ohne weitere Prüfung eine
 * Sitzung an. Er ist nur im Prozess erreichbar; wer ihn aufruft, trägt die
 * Verantwortung, dass ein zweiter Faktor geprüft ist. Dieser Test hält fest, wer das
 * ist — ein neuer Aufrufer soll im Review auffallen und nicht nebenbei entstehen.
 *
 * Rein, ohne Datenbank.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function quelldateien(ordner: string): string[] {
  return readdirSync(ordner, { withFileTypes: true }).flatMap((eintrag) => {
    const pfad = path.join(ordner, eintrag.name);
    if (eintrag.isDirectory()) {
      return quelldateien(pfad);
    }
    return pfad.endsWith('.ts') ? [pfad] : [];
  });
}

describe('Sitzung nach dem zweiten Faktor', () => {
  it('wird nur von der Anmelderoute aufgerufen (und in ihrer eigenen Definition genannt)', () => {
    const treffer = quelldateien('src')
      .filter((datei) => readFileSync(datei, 'utf8').includes('sitzungNachZweitemFaktor'))
      .map((datei) => path.relative('src', datei).split(path.sep).join('/'))
      .sort();

    expect(treffer).toEqual(['auth/sitzung-anlegen.ts', 'server/routes/anmelden.ts']);
  });

  it('ist als nur-serverseitig gekennzeichnet: Better Calls Router nimmt ihn nicht auf', () => {
    // Fehlte die Kennzeichnung, wäre der Endpunkt unter /api/auth erreichbar; das Tor
    // finge ihn ab, aber das wäre der einzige Riegel. Gemessen in `passkey-anmeldung-datenbank.test.ts`.
    expect(readFileSync('src/auth/sitzung-anlegen.ts', 'utf8')).toContain('createAuthEndpoint.serverOnly(');
  });
});
