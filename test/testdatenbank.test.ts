/**
 * Schutzschicht für die Datenbank-Tests (COPI-21): Die Tests räumen ihre
 * Datenbank ab (`DELETE FROM cockpit."user"`) und dürfen deshalb nie gegen die
 * Datenbank laufen, mit der `npm run dev` arbeitet. Rein, ohne Datenbank.
 *
 * Die Beispiele stehen als Literale hier: würde der Test die Regel des
 * Produktivcodes benutzen, rechnete er eine aufgeweichte Regel einfach mit.
 */
import { describe, expect, it } from 'vitest';
import {
  istTestDatenbank,
  pruefeTestDatenbankUrl,
  testDatenbankName,
} from './testdatenbank.js';

const PASSWORT = 'geheim-nicht-in-der-meldung';

/** Meldung des geworfenen Fehlers; ein Test, der nichts wirft, schlägt hier fehl. */
function meldungVon(aufruf: () => unknown): string {
  try {
    aufruf();
  } catch (fehler) {
    return fehler instanceof Error ? fehler.message : String(fehler);
  }
  throw new Error('Es wurde kein Fehler geworfen');
}

describe('istTestDatenbank', () => {
  it.each([
    'postgres://postgres:dev@localhost:5432/cockpit_test',
    'postgresql://cockpit:cockpit@localhost:5432/cockpit_test',
    'postgres://u:p@h/cockpit_test?sslmode=require',
    'postgres://u:p@h/ci_cockpit_test',
    // Groß-/Kleinschreibung des Namens ändert nichts daran, dass es eine Testdatenbank ist.
    'postgres://u:p@h:5432/COCKPIT_TEST',
    'postgres://u:p@h:5432/Cockpit_Test',
    // Ohne Zugangsdaten und ohne Port.
    'postgres://h/cockpit_test',
  ])('erkennt %s als Testdatenbank', (url) => {
    expect(istTestDatenbank(url)).toBe(true);
  });

  it.each([
    // Die Dev-Datenbank selbst, und Namen, die nur ähnlich aussehen.
    'postgres://postgres:dev@localhost:5432/cockpit',
    'postgres://u:p@h/cockpit_test2',
    'postgres://u:p@h/cockpit_testing',
    'postgres://u:p@h/cockpit_test_alt',
    'postgres://u:p@h/test',
    'postgres://u:p@h/_test',
    'postgres://u:p@h/prod',
    'postgres://u:p@h/postgres',
    // Kein Name, kein Pfad, kein Datenbankname.
    'postgres://u:p@h:5432',
    'postgres://u:p@h:5432/',
    // Zeichen, die in einem Datenbanknamen nicht vorgesehen sind.
    'postgres://u:p@h/cockpit-test',
    'postgres://u:p@h/cockpit%5Ftest',
    'postgres://u:p@h/cockpit_test/extra',
    'postgres://u:p@h/cockpit_test;DROP',
    // Ein Query-Parameter kann den Datenbanknamen aus dem Pfad überstimmen.
    'postgres://u:p@h/cockpit_test?dbname=cockpit',
    'postgres://u:p@h/cockpit_test?database=cockpit',
    'postgres://u:p@h/cockpit_test?DBNAME=cockpit',
    // Falsches Protokoll, leer, keine URL.
    'mysql://u:p@h/cockpit_test',
    'http://h/cockpit_test',
    '',
    '   ',
    'cockpit_test',
    'kein url',
  ])('weist %j ab', (url) => {
    expect(istTestDatenbank(url)).toBe(false);
  });
});

describe('testDatenbankName', () => {
  it('liefert den Datenbanknamen', () => {
    expect(testDatenbankName('postgres://u:p@h:5432/cockpit_test?sslmode=require')).toBe(
      'cockpit_test',
    );
  });

  it('liefert für eine Nicht-Testdatenbank nichts', () => {
    expect(testDatenbankName('postgres://u:p@h:5432/cockpit')).toBeUndefined();
  });
});

describe('pruefeTestDatenbankUrl', () => {
  it('gibt den Namen einer Testdatenbank zurück', () => {
    expect(pruefeTestDatenbankUrl('postgres://u:p@h/cockpit_test')).toBe('cockpit_test');
  });

  it('bricht bei der Dev-Datenbank ab und nennt die Variable und die Regel', () => {
    expect(() => pruefeTestDatenbankUrl('postgres://postgres:dev@localhost/cockpit')).toThrow(
      /TEST_DATABASE_URL.*_test/s,
    );
  });

  it('nennt in der Meldung keine Zugangsdaten', () => {
    const meldung = meldungVon(() =>
      pruefeTestDatenbankUrl(`postgres://postgres:${PASSWORT}@localhost/cockpit`),
    );

    expect(meldung).toContain('TEST_DATABASE_URL');
    expect(meldung).not.toContain(PASSWORT);
  });

  it('bricht auch bei einer ungültigen URL ab, ohne sie zu wiederholen', () => {
    const meldung = meldungVon(() => pruefeTestDatenbankUrl(`kein-url-${PASSWORT}`));

    expect(meldung).toContain('TEST_DATABASE_URL');
    expect(meldung).not.toContain(PASSWORT);
  });
});
