/**
 * Die Regeln, was ins Protokoll darf (COPI-23) — rein, ohne Datenbank.
 *
 * Das Protokoll ist append-only: was einmal drinsteht, lässt sich nicht mehr
 * löschen, auch nicht auf Antrag. Deshalb gilt Datensparsamkeit schon beim
 * Schreiben: nur Kennungen und feste Begriffe, nie Adresse, Token, Passwort
 * oder IP. Die Beispiele stehen als Literale, damit der Test eine aufgeweichte
 * Regel nicht einfach mitrechnet.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOKOLL_ARTEN, pruefeEreignis, type Ereignis } from '../src/auth/protokoll.js';

/** Eine Better-Auth-Konto-ID sieht so aus: 32 Zeichen. */
const KONTO_ID = 'iB5yPsXLcWk5V84G8zQbIDkPkx1fTxf4';
/** So lang ist ein Token (32 Byte, base64url): 43 Zeichen. */
const TOKEN_ARTIG = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

function ereignis(teil: Partial<Ereignis> = {}): Ereignis {
  return { art: 'anmeldung_erfolgreich', akteur: KONTO_ID, ...teil };
}

describe('PROTOKOLL_ARTEN', () => {
  it('nennt genau die Ereignisse dieses Tickets (neue Arten kommen mit den Tickets, die sie erzeugen)', () => {
    expect([...PROTOKOLL_ARTEN].sort()).toEqual(
      [
        'abmeldung',
        'api_token_erzeugt',
        'api_token_widerrufen',
        'api_zugriff_abgelehnt',
        'anmeldung_erfolgreich',
        'anmeldung_fehlgeschlagen',
        'betreuer_uebergeben',
        'einladung_eingeloest',
        'email_aenderung_beantragt',
        'email_geaendert',
        'chat_mail_gesendet',
        'vorgang_uebernommen',
        'vorgang_zurueckgegeben',
        'erscheinungsbild_geaendert',
        'antwort_freigegeben',
        'freigabe_zurueckgezogen',
        'zweiter_faktor_hinzugefuegt',
        'zweiter_faktor_entfernt',
        'ersatzcodes_erneuert',
        'faktor_bestaetigt',
        'anhang_heruntergeladen',
        'entscheidung_getroffen',
        'entscheidung_zurueckgenommen',
        'betreuer_zugriff_geaendert',
        'update_freigabemodus_geaendert',
        'einladung_erzeugt',
        'ersatzcode_verwendet',
        'erststart_token_erzeugt',
        'konto_angelegt',
        'konto_entfernt',
        'konto_entsperrt',
        'konto_verfallen',
        'name_geaendert',
        'rolle_geaendert',
        'sperre_ausgeloest',
        'update_beantragt',
        'update_erledigt',
        'update_fehlgeschlagen',
        'update_freigegeben',
        'update_gestartet',
        'update_zurueckgezogen',
        'zugang_wiederhergestellt',
        'zweiter_faktor_eingerichtet',
      ].sort(),
    );
  });
});

describe('pruefeEreignis — was erlaubt ist', () => {
  it('lässt ein Ereignis mit Konto-Kennung und festen Begriffen zu', () => {
    expect(() =>
      pruefeEreignis(
        ereignis({
          art: 'konto_angelegt',
          akteur: 'erststart',
          ziel: KONTO_ID,
          einzelheiten: { weg: 'erststart', rolle: 'betreuer' },
        }),
      ),
    ).not.toThrow();
  });

  it.each(['system', 'konsole', 'erststart', 'einladung'])(
    'lässt den Akteur %s als festen Begriff zu',
    (akteur) => {
      expect(() => pruefeEreignis(ereignis({ akteur }))).not.toThrow();
    },
  );

  it('lässt Zahlen und Wahrheitswerte in den Einzelheiten zu', () => {
    expect(() =>
      pruefeEreignis(ereignis({ einzelheiten: { einladung_id: 42, faktor: 'totp' } })),
    ).not.toThrow();
  });

  it('braucht keine Einzelheiten und kein Ziel', () => {
    expect(() => pruefeEreignis(ereignis())).not.toThrow();
  });

  it('lässt die Ereignisse der Agenten-API (COPI-35) mit Zugangsnummer, Name, Grund und Scope zu', () => {
    expect(() =>
      pruefeEreignis({
        art: 'api_token_erzeugt',
        akteur: 'konsole',
        ziel: 'api_token_7',
        einzelheiten: { token_id: 7, name: 'admin-agent', scope: 'befund_schreiben' },
      }),
    ).not.toThrow();
    expect(() =>
      pruefeEreignis({
        art: 'api_zugriff_abgelehnt',
        akteur: 'api_token_7',
        einzelheiten: { token_id: 7, grund: 'widerrufen' },
      }),
    ).not.toThrow();
  });

  it('lässt den Update-Antrag (COPI-40) mit der Nummer des Antrags zu: der Digest selbst steht in der Zeile, nicht hier', () => {
    for (const art of ['update_beantragt', 'update_zurueckgezogen'] as const) {
      expect(() => pruefeEreignis({ art, akteur: KONTO_ID, einzelheiten: { eingriff_id: 12 } })).not.toThrow();
    }
  });

  it('lässt die Übergänge des Eingriffs (COPI-41) mit Zugang oder `system` als Akteur zu, nur mit der Nummer', () => {
    for (const art of ['update_freigegeben', 'update_gestartet', 'update_fehlgeschlagen'] as const) {
      expect(() => pruefeEreignis({ art, akteur: 'api_token_7', einzelheiten: { eingriff_id: 12 } })).not.toThrow();
    }
    expect(() => pruefeEreignis({ art: 'update_erledigt', akteur: 'system', einzelheiten: { eingriff_id: 12 } })).not.toThrow();
  });

  it('weist eine Version in den Einzelheiten ab: sie steht in der Zeile, und `.` passt in keine Kennung', () => {
    expect(() => pruefeEreignis({ art: 'update_freigegeben', akteur: 'api_token_7', einzelheiten: { eingriff_id: '1.4.0' } })).toThrow(
      /Protokoll/,
    );
  });

  it('weist einen Digest in den Einzelheiten ab: er hat 71 Zeichen und passt in keine Kennung', () => {
    expect(() =>
      pruefeEreignis({ art: 'update_beantragt', akteur: KONTO_ID, einzelheiten: { eingriff_id: `sha256:${'a'.repeat(64)}` } }),
    ).toThrow(/Protokoll/);
  });

  it('weist ein Token der Agenten-API in den neuen Schlüsseln ab: es hat 47 Zeichen und passt in keine Kennung', () => {
    const apiToken = `cpk_${TOKEN_ARTIG}`;

    for (const schluessel of ['name', 'grund', 'scope'] as const) {
      expect(() =>
        pruefeEreignis({
          art: 'api_zugriff_abgelehnt',
          akteur: 'api_token_7',
          einzelheiten: { [schluessel]: apiToken },
        }),
      ).toThrow(/Protokoll/);
    }
    expect(() => pruefeEreignis({ art: 'api_zugriff_abgelehnt', akteur: apiToken })).toThrow(/Protokoll/);
  });
});

describe('pruefeEreignis — was nie ins Protokoll darf', () => {
  it.each([
    ['die Adresse als Akteur', { akteur: 'stefan@example.org' }],
    ['die Adresse als Ziel', { ziel: 'stefan@example.org' }],
    ['ein Leerzeichen im Akteur', { akteur: 'ein konto' }],
    ['einen leeren Akteur', { akteur: '' }],
    ['einen Akteur über 40 Zeichen', { akteur: 'a'.repeat(41) }],
    ['ein Token als Akteur (43 Zeichen)', { akteur: TOKEN_ARTIG }],
    ['ein Token als Ziel (43 Zeichen)', { ziel: TOKEN_ARTIG }],
    ['eine IP-Adresse als Ziel', { ziel: '203.0.113.7' }],
  ])('weist %s ab', (_beschreibung, teil) => {
    expect(() => pruefeEreignis(ereignis(teil))).toThrow(/Protokoll/);
  });

  it.each([
    ['eine Adresse', { weg: 'stefan@example.org' }],
    ['ein Token (43 Zeichen)', { weg: TOKEN_ARTIG }],
    ['ein Passwort mit Leerzeichen', { weg: 'ein ausreichend langes passwort' }],
    ['eine IP-Adresse', { weg: '203.0.113.7' }],
  ])('weist in den Einzelheiten %s ab', (_beschreibung, einzelheiten) => {
    expect(() => pruefeEreignis(ereignis({ einzelheiten }))).toThrow(/Protokoll/);
  });

  it.each([
    ['email', 'x'],
    ['passwort', 'x'],
    ['token', 'x'],
    ['ip', 'x'],
    ['beliebig', 'x'],
  ])('kennt den Schlüssel %s nicht', (schluessel, wert) => {
    expect(() => pruefeEreignis(ereignis({ einzelheiten: { [schluessel]: wert } }))).toThrow(
      /Protokoll/,
    );
  });

  it('weist verschachtelte Werte ab', () => {
    expect(() =>
      pruefeEreignis(ereignis({ einzelheiten: { rolle: { tief: 'x' } as never } })),
    ).toThrow(/Protokoll/);
    expect(() => pruefeEreignis(ereignis({ einzelheiten: { rolle: ['x'] as never } }))).toThrow(
      /Protokoll/,
    );
    expect(() => pruefeEreignis(ereignis({ einzelheiten: { rolle: null as never } }))).toThrow(
      /Protokoll/,
    );
  });

  it('weist eine unbekannte Art ab', () => {
    expect(() => pruefeEreignis(ereignis({ art: 'irgendwas' as never }))).toThrow(/Protokoll/);
  });

  it('nennt in der Meldung nie den abgewiesenen Wert', () => {
    let meldung = '';
    try {
      pruefeEreignis(ereignis({ akteur: 'stefan@example.org' }));
    } catch (fehler) {
      meldung = fehler instanceof Error ? fehler.message : String(fehler);
    }

    expect(meldung).toContain('Protokoll');
    expect(meldung).not.toContain('stefan@example.org');
  });
});

describe('das einzige Tor ins Protokoll', () => {
  /** Alle `.ts`-Dateien unter `src`, rekursiv. */
  function quelldateien(ordner: string): string[] {
    return readdirSync(ordner, { withFileTypes: true }).flatMap((eintrag) => {
      const pfad = path.join(ordner, eintrag.name);
      if (eintrag.isDirectory()) {
        return quelldateien(pfad);
      }
      return pfad.endsWith('.ts') ? [pfad] : [];
    });
  }

  it('schreibt nirgends per SQL am Protokoll vorbei: nur protokoll.ts fasst die Tabelle an', () => {
    // Sonst liefe ein Eintrag an der Prüfung von `pruefeEreignis` vorbei —
    // und mit ihr an der Datensparsamkeit, die sich im Nachhinein nicht mehr
    // korrigieren lässt.
    const tabelle = /cockpit\.protokoll|"protokoll"/;
    const treffer = quelldateien('src')
      .filter((datei) => tabelle.test(readFileSync(datei, 'utf8')))
      .map((datei) => path.relative('src', datei).split(path.sep).join('/'));

    expect(treffer).toEqual(['auth/protokoll.ts']);
  });
});
