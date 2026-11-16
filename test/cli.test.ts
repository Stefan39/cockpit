/**
 * Das Server-Kommando (COPI-24): Argumente lesen und Fehlbedienung — rein, ohne
 * Datenbank. Bedienfehler dürfen die Datenbank nie berühren; das prüft der Test
 * mit einem Pool, der bei jeder Benutzung fehlschlägt.
 *
 * Die erwarteten Werte stehen als Literale: der Test soll nicht mitrechnen, wenn
 * der Produktivcode Befehle oder Rollen umbenennt.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { befehlLesen, cliAusfuehren, NUTZUNG } from '../src/cli/befehle.js';

/** Ein Pool, der jeden Zugriff verrät: ein Bedienfehler darf nie bis zur Datenbank kommen. */
const KEIN_POOL = new Proxy(
  {},
  {
    get() {
      throw new Error('Die Datenbank wurde angefasst');
    },
  },
) as never;

async function ausfuehren(argumente: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await cliAusfuehren(argumente, {
    pool: KEIN_POOL,
    basisUrl: 'http://localhost:3000',
    ausgabe: (text) => stdout.push(text),
    fehlerausgabe: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('befehlLesen — gültige Aufrufe', () => {
  it('liest erststart ohne Optionen', () => {
    expect(befehlLesen(['erststart'])).toEqual({ befehl: 'erststart' });
  });

  it.each(['aus', 'lesen', 'entscheiden'] as const)('liest modul-freigabe mit der Stufe %s (COPI-134)', (stufe) => {
    expect(befehlLesen(['modul-freigabe', '--modul', 'akquise', '--stufe', stufe])).toEqual({ befehl: 'modul-freigabe', modul: 'akquise', stufe });
  });

  it.each(['betriebs_admin', 'betrieb_mitarbeiter'] as const)(
    'liest einladung mit der Rolle %s',
    (rolle) => {
      expect(befehlLesen(['einladung', '--email', 'neu@example.org', '--rolle', rolle])).toEqual({
        befehl: 'einladung',
        email: 'neu@example.org',
        rolle,
      });
    },
  );

  it('normalisiert die Adresse wie die Mail-Einladung (klein, ohne Leerraum)', () => {
    expect(
      befehlLesen(['einladung', '--email', '  Neu@Example.ORG ', '--rolle', 'betrieb_mitarbeiter']),
    ).toMatchObject({ email: 'neu@example.org' });
  });

  it('liest betreuer-uebergeben ohne Rolle für den bisherigen Betreuer', () => {
    expect(befehlLesen(['betreuer-uebergeben', '--an', 'Neu@Example.org'])).toEqual({
      befehl: 'betreuer-uebergeben',
      an: 'neu@example.org',
    });
  });

  it.each(['betriebs_admin', 'betrieb_mitarbeiter'] as const)(
    'liest betreuer-uebergeben mit --bisheriger-wird %s',
    (rolle) => {
      expect(
        befehlLesen(['betreuer-uebergeben', '--an', 'neu@example.org', '--bisheriger-wird', rolle]),
      ).toEqual({
        befehl: 'betreuer-uebergeben',
        an: 'neu@example.org',
        bisherigerWirdRolle: rolle,
      });
    },
  );

  it('liest entsperren mit dem Konto, normalisiert wie die Einladung', () => {
    expect(befehlLesen(['entsperren', '--konto', '  Verloren@Example.ORG '])).toEqual({
      befehl: 'entsperren',
      konto: 'verloren@example.org',
    });
  });

  it('liest migrieren ohne Optionen als Anwenden', () => {
    expect(befehlLesen(['migrieren'])).toEqual({ befehl: 'migrieren', modus: 'anwenden' });
  });

  it('liest migrieren --status', () => {
    expect(befehlLesen(['migrieren', '--status'])).toEqual({ befehl: 'migrieren', modus: 'status' });
  });

  it('liest migrieren --zurueck --bestaetigt, in jeder Reihenfolge', () => {
    const erwartet = { befehl: 'migrieren', modus: 'zurueck' };
    expect(befehlLesen(['migrieren', '--zurueck', '--bestaetigt'])).toEqual(erwartet);
    expect(befehlLesen(['migrieren', '--bestaetigt', '--zurueck'])).toEqual(erwartet);
  });

  it.each([['hilfe'], ['--hilfe'], ['-h'], ['--help']])('liest %s als Hilfe', (...argumente) => {
    expect(befehlLesen(argumente)).toEqual({ befehl: 'hilfe' });
  });
});

describe('befehlLesen — Fehlbedienung', () => {
  it.each([
    ['keinen Befehl', []],
    ['modul-freigabe ohne Modul', ['modul-freigabe', '--stufe', 'lesen']],
    ['modul-freigabe mit ungültiger Kennung', ['modul-freigabe', '--modul', 'Akquise!', '--stufe', 'lesen']],
    ['modul-freigabe ohne Stufe', ['modul-freigabe', '--modul', 'akquise']],
    ['modul-freigabe mit unbekannter Stufe', ['modul-freigabe', '--modul', 'akquise', '--stufe', 'alles']],
    ['modul-freigabe mit fremder Option', ['modul-freigabe', '--modul', 'akquise', '--stufe', 'lesen', '--email', 'a@example.org']],
    ['einen unbekannten Befehl', ['irgendwas']],
    ['erststart mit einer Option', ['erststart', '--email', 'a@example.org']],
    ['erststart mit einem zusätzlichen Wort', ['erststart', 'extra']],
    ['einladung ohne Adresse', ['einladung', '--rolle', 'betrieb_mitarbeiter']],
    ['einladung ohne Rolle', ['einladung', '--email', 'a@example.org']],
    ['einladung mit unplausibler Adresse', ['einladung', '--email', 'keine-adresse', '--rolle', 'betrieb_mitarbeiter']],
    ['einladung mit unbekannter Rolle', ['einladung', '--email', 'a@example.org', '--rolle', 'superadmin']],
    ['einladung mit leerer Rolle', ['einladung', '--email', 'a@example.org', '--rolle', '']],
    ['einladung mit unbekannter Option', ['einladung', '--email', 'a@example.org', '--rolle', 'betrieb_mitarbeiter', '--x', 'y']],
    ['betreuer-uebergeben ohne Ziel', ['betreuer-uebergeben']],
    ['betreuer-uebergeben mit unplausibler Adresse', ['betreuer-uebergeben', '--an', 'nein']],
    ['migrieren --zurueck ohne Bestätigung (es löscht Daten)', ['migrieren', '--zurueck']],
    ['migrieren --bestaetigt ohne --zurueck', ['migrieren', '--bestaetigt']],
    ['migrieren --status zusammen mit --zurueck', ['migrieren', '--status', '--zurueck', '--bestaetigt']],
    ['migrieren mit einer Option, die nicht dazugehört', ['migrieren', '--konto', 'a@example.org']],
    ['entsperren ohne Konto', ['entsperren']],
    ['entsperren mit unplausibler Adresse', ['entsperren', '--konto', 'nein']],
    ['entsperren mit einer Option, die nicht dazugehört', ['entsperren', '--konto', 'a@example.org', '--rolle', 'betriebs_admin']],
    ['entsperren mit dem Namen der Einladung statt --konto', ['entsperren', '--email', 'a@example.org']],
    ['betreuer-uebergeben mit unbekannter Rolle', ['betreuer-uebergeben', '--an', 'a@example.org', '--bisheriger-wird', 'root']],
  ])('lehnt %s ab', (_beschreibung, argumente) => {
    expect(befehlLesen(argumente)).toHaveProperty('fehler');
  });

  it('lehnt die Rolle betreuer bei einer Einladung ab und nennt den richtigen Weg', () => {
    const ergebnis = befehlLesen(['einladung', '--email', 'a@example.org', '--rolle', 'betreuer']);

    expect(ergebnis).toHaveProperty('fehler');
    expect(JSON.stringify(ergebnis)).toContain('betreuer-uebergeben');
  });

  it('lehnt betreuer als Rolle des bisherigen Betreuers ab', () => {
    expect(
      befehlLesen(['betreuer-uebergeben', '--an', 'a@example.org', '--bisheriger-wird', 'betreuer']),
    ).toHaveProperty('fehler');
  });
});

describe('cliAusfuehren — Ende bei Fehlbedienung, ohne die Datenbank anzufassen', () => {
  it.each([
    [[]],
    [['irgendwas']],
    [['einladung', '--email', 'a@example.org']],
    [['einladung', '--email', 'a@example.org', '--rolle', 'betreuer']],
    [['betreuer-uebergeben']],
    [['entsperren']],
    [['entsperren', '--konto', 'nein']],
    [['migrieren', '--zurueck']],
  ])('meldet %j mit Exit-Code 2, Text auf stderr und nichts auf stdout', async (argumente) => {
    const ergebnis = await ausfuehren(argumente);

    expect(ergebnis.code).toBe(2);
    expect(ergebnis.stdout).toBe('');
    expect(ergebnis.stderr).not.toBe('');
  });

  it('zeigt die Hilfe auf stdout und endet mit 0', async () => {
    const ergebnis = await ausfuehren(['--hilfe']);

    expect(ergebnis.code).toBe(0);
    expect(ergebnis.stdout).toContain('erststart');
    expect(ergebnis.stderr).toBe('');
  });

  it('nennt in der Fehlermeldung nie mehr als das Nötige: keine Adresse aus der Eingabe wiederholt', async () => {
    const ergebnis = await ausfuehren(['einladung', '--email', 'geheim-adresse', '--rolle', 'betrieb_mitarbeiter']);

    expect(ergebnis.code).toBe(2);
    expect(ergebnis.stderr).not.toContain('geheim-adresse');
  });
});

describe('NUTZUNG', () => {
  it.each(['erststart', 'einladung', 'betreuer-uebergeben', 'entsperren', 'migrieren', '--email', '--rolle', '--an', '--bisheriger-wird', '--konto', '--status', '--zurueck', '--bestaetigt'])(
    'erwähnt %s',
    (wort) => {
      expect(NUTZUNG).toContain(wort);
    },
  );
});

describe('Das Kommando kennt keine Mail', () => {
  it('importiert nichts aus dem Mailversand: eine Konsolen-Einladung geht nie per Mail raus', () => {
    // Die Einladung ohne Mail ist der Zweck (Kunde ohne Mail, ADR 13.2). Ein Import
    // aus `src/mail` oder `nodemailer` wäre der erste Schritt zu einer Mail, die niemand bestellt hat.
    const dateien = readdirSync('src/cli').filter((datei) => datei.endsWith('.ts'));
    expect(dateien.length).toBeGreaterThan(0);

    for (const datei of dateien) {
      const quelle = readFileSync(`src/cli/${datei}`, 'utf8');
      expect(quelle, `${datei} importiert Mailversand`).not.toMatch(/from '[^']*(\/mail\/|nodemailer)/);
    }
  });
});

/**
 * Die Zugänge der Agenten-API (COPI-35): `api-token-erzeugen`, `api-token-auflisten` und
 * `api-token-widerrufen`. Nur das Server-Kommando erzeugt und widerruft sie — es gibt keinen Weg über
 * die Oberfläche, so wenig wie für die Rolle `betreuer`.
 */
describe('befehlLesen — Zugänge der Agenten-API', () => {
  it('liest api-token-erzeugen mit Name und einem Recht', () => {
    expect(befehlLesen(['api-token-erzeugen', '--name', 'admin-agent', '--scope', 'befund_schreiben'])).toEqual({
      befehl: 'api-token-erzeugen',
      name: 'admin-agent',
      scopes: ['befund_schreiben'],
    });
  });

  it('liest api-token-erzeugen mit mehreren Rechten, in der genannten Reihenfolge', () => {
    expect(
      befehlLesen([
        'api-token-erzeugen',
        '--scope',
        'eingriff_verwalten',
        '--name',
        'admin-agent',
        '--scope',
        'befund_schreiben',
      ]),
    ).toEqual({
      befehl: 'api-token-erzeugen',
      name: 'admin-agent',
      scopes: ['eingriff_verwalten', 'befund_schreiben'],
    });
  });

  it('nimmt ein mehrfach genanntes Recht nur einmal', () => {
    expect(
      befehlLesen(['api-token-erzeugen', '--name', 'a', '--scope', 'befund_schreiben', '--scope', 'befund_schreiben']),
    ).toMatchObject({ scopes: ['befund_schreiben'] });
  });

  it('liest api-token-auflisten ohne Optionen', () => {
    expect(befehlLesen(['api-token-auflisten'])).toEqual({ befehl: 'api-token-auflisten' });
  });

  it('liest api-token-widerrufen mit der Nummer des Zugangs', () => {
    expect(befehlLesen(['api-token-widerrufen', '--id', '12'])).toEqual({ befehl: 'api-token-widerrufen', id: 12 });
  });

  it.each([
    ['api-token-erzeugen ohne Namen', ['api-token-erzeugen', '--scope', 'befund_schreiben']],
    ['api-token-erzeugen ohne Recht', ['api-token-erzeugen', '--name', 'admin-agent']],
    ['api-token-erzeugen mit unbekanntem Recht', ['api-token-erzeugen', '--name', 'a', '--scope', 'alles']],
    ['api-token-erzeugen mit leerem Recht', ['api-token-erzeugen', '--name', 'a', '--scope', '']],
    ['api-token-erzeugen mit Doppelpunkt im Recht', ['api-token-erzeugen', '--name', 'a', '--scope', 'befund:schreiben']],
    ['api-token-erzeugen mit einem unbekannten unter mehreren Rechten', ['api-token-erzeugen', '--name', 'a', '--scope', 'befund_schreiben', '--scope', 'alles']],
    ['api-token-erzeugen mit Großbuchstaben im Namen', ['api-token-erzeugen', '--name', 'Admin', '--scope', 'befund_schreiben']],
    ['api-token-erzeugen mit Leerzeichen im Namen', ['api-token-erzeugen', '--name', 'admin agent', '--scope', 'befund_schreiben']],
    ['api-token-erzeugen mit einer Adresse als Namen', ['api-token-erzeugen', '--name', 'a@example.org', '--scope', 'befund_schreiben']],
    ['api-token-erzeugen mit zu langem Namen', ['api-token-erzeugen', '--name', 'a'.repeat(41), '--scope', 'befund_schreiben']],
    ['api-token-erzeugen mit --id', ['api-token-erzeugen', '--name', 'a', '--scope', 'befund_schreiben', '--id', '1']],
    ['api-token-erzeugen mit einer Option, die nicht dazugehört', ['api-token-erzeugen', '--name', 'a', '--scope', 'befund_schreiben', '--email', 'a@example.org']],
    ['api-token-auflisten mit einer Option', ['api-token-auflisten', '--name', 'a']],
    ['api-token-auflisten mit einem zusätzlichen Wort', ['api-token-auflisten', 'extra']],
    ['api-token-widerrufen ohne Nummer', ['api-token-widerrufen']],
    ['api-token-widerrufen mit Namen statt Nummer', ['api-token-widerrufen', '--name', 'admin-agent']],
    ['api-token-widerrufen mit Text als Nummer', ['api-token-widerrufen', '--id', 'abc']],
    ['api-token-widerrufen mit der Nummer null', ['api-token-widerrufen', '--id', '0']],
    ['api-token-widerrufen mit negativer Nummer', ['api-token-widerrufen', '--id', '-1']],
    ['api-token-widerrufen mit Dezimalzahl', ['api-token-widerrufen', '--id', '1.5']],
    ['api-token-widerrufen mit Exponent', ['api-token-widerrufen', '--id', '1e3']],
    ['api-token-widerrufen mit Nummer mit führenden Nullen', ['api-token-widerrufen', '--id', '007']],
    ['api-token-widerrufen mit riesiger Nummer', ['api-token-widerrufen', '--id', '99999999999999999999']],
    ['api-token-widerrufen mit zwei Nummern', ['api-token-widerrufen', '--id', '1', '--id', '2']],
  ])('lehnt %s ab', (_beschreibung, argumente) => {
    expect(befehlLesen(argumente)).toHaveProperty('fehler');
  });

  it('meldet Fehlbedienung mit Exit-Code 2, ohne die Datenbank anzufassen und ohne die Eingabe zu wiederholen', async () => {
    const ergebnis = await ausfuehren(['api-token-erzeugen', '--name', 'geheim-name!', '--scope', 'befund_schreiben']);

    expect(ergebnis.code).toBe(2);
    expect(ergebnis.stdout).toBe('');
    expect(ergebnis.stderr).not.toContain('geheim-name!');
  });

  it.each(['api-token-erzeugen', 'api-token-auflisten', 'api-token-widerrufen', '--name', '--scope', '--id', 'befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten'])(
    'erwähnt %s in der Hilfe',
    (wort) => {
      expect(NUTZUNG).toContain(wort);
    },
  );
});
