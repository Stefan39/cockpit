/**
 * Schutzschicht für die Datenbank-Tests (COPI-21).
 *
 * Die Datenbank-Tests räumen ihre Datenbank ab (`DELETE FROM cockpit."user"`
 * u. a.). Sie lesen deshalb ausschließlich `TEST_DATABASE_URL`, nie
 * `DATABASE_URL` — die Variable, mit der `npm run dev` arbeitet und die eine
 * Shell mit geladener `.env` ohnehin gesetzt hat. Und sie laufen nur gegen eine
 * Datenbank, deren Name auf `_test` endet.
 *
 * Kein Testfall, sondern Werkzeug: Die Prüfung steht in `testdatenbank.test.ts`.
 * Dieses Modul wird von jeder Datenbank-Testdatei importiert und bricht dort
 * beim Laden ab, wenn `TEST_DATABASE_URL` nicht auf eine Testdatenbank zeigt —
 * unabhängig davon, ob das `globalSetup` läuft.
 */

/** Buchstaben, Ziffern, Unterstrich; endet auf `_test`, davor mindestens ein Zeichen. */
const TESTDATENBANK_NAME = /^[a-z0-9_]+_test$/i;

/** Query-Parameter, die den Datenbanknamen aus dem Pfad überstimmen könnten. */
const NAME_IM_QUERY = ['dbname', 'database'];

/**
 * Der Datenbankname, wenn die URL eindeutig auf eine Testdatenbank zeigt,
 * sonst `undefined`. Im Zweifel `undefined`: ungültige URL, fremdes Protokoll,
 * Name mit Sonderzeichen oder ein Query-Parameter, der den Namen überstimmt.
 */
export function testDatenbankName(url: string): string | undefined {
  let adresse: URL;
  try {
    adresse = new URL(url);
  } catch {
    return undefined;
  }
  if (adresse.protocol !== 'postgres:' && adresse.protocol !== 'postgresql:') {
    return undefined;
  }
  for (const schluessel of adresse.searchParams.keys()) {
    if (NAME_IM_QUERY.includes(schluessel.toLowerCase())) {
      return undefined;
    }
  }
  const name = adresse.pathname.slice(1);
  return TESTDATENBANK_NAME.test(name) ? name : undefined;
}

export function istTestDatenbank(url: string): boolean {
  return testDatenbankName(url) !== undefined;
}

/**
 * Wie `testDatenbankName`, bricht aber ab, statt `undefined` zu liefern. Die
 * Meldung nennt bewusst weder die URL noch Zugangsdaten — sie landet in
 * Terminals und CI-Logs.
 */
export function pruefeTestDatenbankUrl(url: string): string {
  const name = testDatenbankName(url);
  if (name === undefined) {
    throw new Error(
      'TEST_DATABASE_URL zeigt nicht auf eine Testdatenbank. Die Datenbank-Tests ' +
        'räumen ihre Datenbank ab und laufen deshalb nur gegen einen Datenbanknamen ' +
        'auf `_test` (Buchstaben, Ziffern, Unterstrich), z. B. ' +
        'postgres://postgres:dev@localhost:5432/cockpit_test',
    );
  }
  return name;
}

/**
 * Name der Kopie für Vitest-Worker `n` (COPI-73): `cockpit_test` wird zu `cockpit_w<n>_test`. Endet damit weiter
 * auf `_test`, die Schutzschicht gilt also auch für die Kopien. Das `globalSetup` legt sie an.
 */
export function workerDatenbankName(vorlage: string, n: number): string {
  return `${vorlage.replace(/_test$/i, '')}_w${n}_test`;
}

/** Die URL, die dieser Worker verwendet: seine Kopie, wenn Vitest ihm eine Pool-Nummer gibt, sonst die Vorlage. */
function urlFuerWorker(url: string): string {
  const pool = Number(process.env.VITEST_POOL_ID);
  if (!Number.isInteger(pool) || pool < 1) {
    return url;
  }
  const adresse = new URL(url);
  adresse.pathname = `/${workerDatenbankName(pruefeTestDatenbankUrl(url), pool)}`;
  return adresse.toString();
}

const gesetzt = process.env.TEST_DATABASE_URL;
if (gesetzt) {
  pruefeTestDatenbankUrl(gesetzt);
}

/**
 * Die Datenbank der Datenbank-Tests; im Vitest-Worker die eigene Kopie (COPI-73); ohne Wert werden diese Tests übersprungen.
 * `DATABASE_URL` liest kein Test.
 */
export const testDatenbankUrl: string | undefined = gesetzt ? urlFuerWorker(gesetzt) : undefined;
