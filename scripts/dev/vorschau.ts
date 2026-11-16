/**
 * `./dev vorschau --rolle <rolle> [--port N]` (COPI-80): startet das Cockpit gegen die Dev-
 * Datenbank mit einer eingesetzten Sitzung für die gewählte Rolle — angemeldet, zweiter Faktor
 * aktiv, ohne Anmeldeformular und ohne Passkey. Dasselbe Muster wie in den Datenbank-Tests
 * (`test/modul-seiten-datenbank.test.ts`, `sitzungLesen`/`zugangLesen` aus `AppAbhaengigkeiten`,
 * `src/server/app.ts`), nur gegen einen echten, laufenden Server statt gegen `inject()`.
 *
 * Zweck: Wer am Cockpit arbeitet, soll Oberflächenänderungen lokal sehen können wie auf dem Pilotserver, in jeder
 * Rolle, ohne jedes Mal Erststart/Anmeldung durchzuspielen. Kein Ersatz für den echten Auth-Flow —
 * Sitzung und zweiter Faktor sind hier immer „vorhanden und aktiv", unabhängig von der Datenbank.
 *
 * Standard-Port 3100 (nie 3000 — dort läuft ggf. der normale Dev-Server, `npm run dev`).
 *
 * **Ein Konto je Vorschau-Rolle (COPI-85).** Die Übernahme-Sperre schreibt, wer übernommen hat, per Fremdschlüssel auf
 * `cockpit.user`. Damit „Übernehmen" in der Vorschau geht, legt sie ihr Konto `vorschau-<rolle>` an, falls es fehlt
 * (Name „Mitarbeiter Vorschau" usw., Adresse unter `.invalid`, aktiviert). Die Rolle in der Datenbank ist dabei nur ein
 * Platzhalter — die Vorschau setzt die Rolle selbst ein; für `betreuer` steht dort `betriebs_admin`, weil es höchstens
 * einen Betreuer geben darf und die Dev-Datenbank ihren echten vielleicht schon hat.
 */
import pg from 'pg';
import { ALLE_ROLLEN, type Rolle, type Zugang, type ZugangLesen } from '../../src/auth/berechtigung.js';
import { assetsBauen } from '../../src/assets/bauen.js';
import { zugangLesenMitModulen } from '../../src/module/sichtbarkeit.js';
import { zugangLesenMitPosteingang } from '../../src/posteingang/lesen.js';
import { buildApp } from '../../src/server/app.js';
import { paketVersionLesen } from '../../src/status/instanz.js';
import { zugangLesenMitUpdateHinweis } from '../../src/status/update-hinweis.js';
import type { SitzungLesen } from '../../src/auth/zwei-faktor-tor.js';
import { direktStarten } from './direkt-starten.js';
import { sicherstellenLokaleDatenbankUrl } from './lokal-schutz.js';

const STANDARD_PORT = 3100;

/** Immer angemeldet, immer mit aktivem zweiten Faktor — die Rolle selbst kommt aus `zugangLesen`. */
const MIT_ZWEITEM_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

export interface VorschauArgumente {
  readonly rolle: Rolle;
  readonly port: number;
}

function istRolle(wert: string | undefined): wert is Rolle {
  return wert !== undefined && (ALLE_ROLLEN as readonly string[]).includes(wert);
}

/** Anzeigename des Vorschau-Kontos je Rolle: das erste Wort erscheint in der Marke „übernommen · Mitarbeiter". */
const VORSCHAU_NAMEN: Readonly<Record<Rolle, string>> = {
  betreuer: 'Betreuer Vorschau',
  betriebs_admin: 'Betriebs-Admin Vorschau',
  betrieb_mitarbeiter: 'Mitarbeiter Vorschau',
};

/** Legt das Konto der Vorschau an, falls es fehlt (siehe Kopf). Ändert nie ein bestehendes Konto. */
async function vorschauKontoSicherstellen(pool: pg.Pool, rolle: Rolle, benutzerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO cockpit."user" (id, name, email, "emailVerified", rolle, aktiviert_am)
     VALUES ($1, $2, $3, true, $4, now())
     ON CONFLICT (id) DO NOTHING`,
    [benutzerId, VORSCHAU_NAMEN[rolle], `${benutzerId}@vorschau.invalid`, rolle === 'betreuer' ? 'betriebs_admin' : rolle],
  );
}

/** Reine Funktion — testbar ohne Server oder Datenbank. */
export function argumenteLesen(argv: readonly string[]): VorschauArgumente {
  let rolle: string | undefined;
  let portRoh: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--rolle') {
      rolle = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--port') {
      portRoh = argv[i + 1];
      i += 1;
    }
  }
  if (!istRolle(rolle)) {
    throw new Error(`--rolle ist Pflicht und muss eine von ${ALLE_ROLLEN.join(', ')} sein.`);
  }
  const port = portRoh === undefined ? STANDARD_PORT : Number.parseInt(portRoh, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('--port muss eine positive Ganzzahl sein.');
  }
  return { rolle, port };
}

async function main(): Promise<void> {
  const databaseUrl = sicherstellenLokaleDatenbankUrl({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
  });
  const { rolle, port } = argumenteLesen(process.argv.slice(2));

  // Frisch gebaut, wie `./dev up` es mit `npm run assets` tut — ohne gebaute Assets liest
  // `buildApp` kein Manifest und startet nicht (`src/assets/manifest.ts`).
  assetsBauen();

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const benutzerId = `vorschau-${rolle}`;
  await vorschauKontoSicherstellen(pool, rolle, benutzerId);
  const zugang: Zugang = {
    angemeldet: true,
    rolle,
    zweiterFaktorAktiv: true,
    benutzerId,
    angemeldetSeit: new Date(),
  };
  const basisZugangLesen: ZugangLesen = () => Promise.resolve(zugang);

  const app = buildApp(
    // Die Versionszeile (COPI-84) zeigt sonst nur eine im Image gebackene Version; hier die aus `package.json`.
    { nodeEnv: 'development', imageVersion: process.env.COCKPIT_VERSION ?? paketVersionLesen() },
    {
      pool,
      sitzungLesen: MIT_ZWEITEM_FAKTOR,
      // Wie `server/app.ts` es für den selbst gebauten Zugangsleser tut: `moduleSichtbar` kommt aus der
      // echten Modul-Registry, `updateVerfuegbar` (COPI-84) aus dem echten Befund der Versions-Wache.
      // Ebenso der Posteingang im Kopf (COPI-112).
      zugangLesen: zugangLesenMitPosteingang(zugangLesenMitUpdateHinweis(zugangLesenMitModulen(basisZugangLesen, pool), pool), pool, () => new Date()),
      instanzName: `Vorschau (${rolle})`,
    },
  );

  await app.listen({ port, host: '127.0.0.1' });
  // eslint-disable-next-line no-console
  console.log(`Vorschau (Rolle ${rolle}) läuft auf http://127.0.0.1:${String(port)} — Strg+C beendet sie.`);
}

direktStarten(import.meta.url, main);
