/**
 * `./dev demo` (COPI-80): füllt die lokale Dev-Datenbank mit realistischen Demodaten — sechs Wachen
 * mit einem 7-Tage-Befund-Verlauf (`demo-wachen.ts`), dem Beispiel-Modul „Server & Dienste"
 * (COPI-78, `docs/beispiele/`), dem Demo-Modul „Anfragen" mit Übernahme (COPI-85, `demo-anfragen.ts`) und dem Modul
 * „KI-Verbrauch" mit 35 Tagen Verbrauch (COPI-98, `demo-ki-verbrauch.ts`) und den neutralen Demo-Modulen „Eingang" mit vier
 * Nachrichten (COPI-88, `demo-eingang.ts`) und „Auswahl" (COPI-91, `demo-auswahl.ts`).
 * Danach zeigt `./dev vorschau` dieselben Daten wie auf dem Pilotserver, in jeder Rolle, ohne Anmeldung.
 *
 * **Wiederholbar.** Vor dem Einspielen räumt dieses Skript ausschließlich seine eigenen Zeilen ab
 * (Präfix `demo-`, `DEMO_PRAEFIX`: Wachen, ihre Befunde und die Übernahmen des Demo-Moduls); ein zweiter Lauf
 * verdoppelt nichts. Das Modul wird über dieselbe
 * Funktion eingespielt wie das Server-Kommando (`modulEinspielen`) und bleibt bei unverändertem
 * Block ohnehin bei seiner Version stehen (Prüfsumme).
 *
 * **Nur lokal.** Ein Löschschutz sitzt in der Datenbank (`cockpit.nie_loeschen()`, Migration 0025)
 * und weist ein `DELETE` auf `wache`/`befund` normalerweise ab — das ist Absicht (ADR: „nie
 * physisch löschen"). Für das Abräumen der eigenen Demodaten hebelt dieses Skript ihn **innerhalb
 * einer Transaktion** mit `SET LOCAL session_replication_role = replica` aus: das schaltet für die
 * Dauer der Transaktion jeden Trigger ab (nicht nur den Löschschutz) und gelingt nur einer
 * Superuser-Verbindung — `postgres` im lokalen Dev-Stack (`docker/compose.dev.yaml`); eine
 * Kundeninstanz verbindet sich nie als Superuser, dort schlägt derselbe Befehl fehl. Davor steht
 * zusätzlich `sicherstellenLokal` (`lokal-schutz.ts`): Host aus `DATABASE_URL` muss lokal sein,
 * `NODE_ENV` darf nicht `production` sein.
 */
import { agentenEinspielen, DEMO_WACHEN_AGENT } from './demo-agenten.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { migrationenAnwenden } from '../../src/datenbank/migrationen.js';
import { modulEinspielen } from '../../src/module/modul-speicher.js';
import { befundMelden } from '../../src/status/befund-speicher.js';
import { auswahlEinspielen } from './demo-auswahl.js';
import { anfragenEinspielen } from './demo-anfragen.js';
import { fachMigrationenEinspielen } from './fach-migrationen.js';
import { kiVerbrauchEinspielen } from './demo-ki-verbrauch.js';
import { eingangEinspielen } from './demo-eingang.js';
import { DEMO_PRAEFIX, wachenDefinitionen } from './demo-wachen.js';
import { direktStarten } from './direkt-starten.js';
import { sicherstellenLokaleDatenbankUrl } from './lokal-schutz.js';

const VIEW_SCHEMA = 'cockpit';
/**
 * Alle Beispiel-Views (`v_modul_*.sql`, Dateiname = Viewname) und Fachmigrationen aus diesen Ordnern: die technischen
 * Module (`docs/beispiele`) und die neutralen Demo-Module (`docs/demo`). Ein fehlender Ordner wird übersprungen.
 */
const BEISPIELE_ORDNER = ['docs/beispiele', 'docs/demo'].filter((ordner) => existsSync(ordner));
const MODUL_YAML_DATEI = 'docs/beispiele/server-zustand.cockpit.yaml';
/** Wie `konsole` beim Server-Kommando: die Kennung des Aufrufers, kein Konto (`eingespielt_von`/`quelle`). */
const AKTEUR = 'demo';

/** Wohin die Meldungen gehen: im Skript auf die Konsole, im Test nirgendwohin. */
export type Ausgabe = (zeile: string) => void;

/**
 * Räumt ausschließlich die eigenen Demodaten ab (Präfix `demo-`, siehe Kopf). `SET LOCAL` gilt nur
 * für diese Transaktion; nach `COMMIT`/`ROLLBACK` gilt der Löschschutz wieder wie zuvor.
 */
async function demoDatenAufraeumen(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query('DELETE FROM cockpit.befund WHERE wache LIKE $1', [`${DEMO_PRAEFIX}%`]);
    await client.query('DELETE FROM cockpit.wache WHERE kennung LIKE $1', [`${DEMO_PRAEFIX}%`]);
    // Die Übernahmen der Demo-Module (COPI-85): jeder Lauf beginnt mit freien Anfragen.
    await client.query('DELETE FROM cockpit.vorgang_sperre WHERE modul_kennung LIKE $1', [`${DEMO_PRAEFIX}%`]);
    await client.query('COMMIT');
  } catch (fehler) {
    await client.query('ROLLBACK');
    throw fehler;
  } finally {
    client.release();
  }
}

/**
 * Spielt die Fachmigrationen der Beispiel-Module ein (`<Ordner>/fach/<schema>/NNNN_*.sql`, COPI-107), bevor ihre
 * Views entstehen — über denselben Weg wie die Tests; gebuchte Versionen werden übersprungen.
 */
async function sicherstellenFachtabellen(pool: pg.Pool, ausgabe: Ausgabe): Promise<void> {
  for (const ordner of BEISPIELE_ORDNER) {
    const fachOrdner = `${ordner}/fach`;
    if (!existsSync(fachOrdner)) {
      continue;
    }
    for (const schema of readdirSync(fachOrdner).sort()) {
      const eingespielt = await fachMigrationenEinspielen(pool, `${fachOrdner}/${schema}`, ordner);
      ausgabe(`Fachschema ${schema}: ${eingespielt.length === 0 ? 'auf dem Stand' : `eingespielt ${eingespielt.join(', ')}`}.`);
    }
  }
}

/**
 * Bringt jede Beispiel-View auf den Stand der Datei (COPI-83: eine ältere Fassung ohne die Messwert-Spalten wird
 * ersetzt). Erst `CREATE OR REPLACE VIEW` — das gelingt, solange nur Spalten hinten dazukommen; lehnt Postgres es
 * ab (Spalten umbenannt, entfernt oder umgetypt), wird die View in derselben Transaktion gelöscht und neu angelegt.
 * Beides nur lokal (siehe Kopf): eine Kundeninstanz bekommt ihre Views vom Einrichter, nie von diesem Skript.
 */
async function sicherstellenViews(pool: pg.Pool, ausgabe: Ausgabe): Promise<void> {
  const dateien = BEISPIELE_ORDNER.flatMap((ordner) =>
    readdirSync(ordner)
      .filter((datei) => /^v_modul_[a-z0-9_]+\.sql$/.test(datei))
      .sort()
      .map((datei) => `${ordner}/${datei}`),
  );
  for (const pfad of dateien) {
    const viewName = pfad.slice(pfad.lastIndexOf('/') + 1, -'.sql'.length);
    const sql = readFileSync(pfad, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SAVEPOINT ersetzen');
      try {
        await client.query(sql.replace(/\bCREATE VIEW\b/, 'CREATE OR REPLACE VIEW'));
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT ersetzen');
        await client.query(`DROP VIEW IF EXISTS ${VIEW_SCHEMA}.${pg.escapeIdentifier(viewName)}`);
        await client.query(sql);
      }
      await client.query('COMMIT');
    } catch (fehler) {
      await client.query('ROLLBACK');
      throw fehler;
    } finally {
      client.release();
    }
    ausgabe(`View ${VIEW_SCHEMA}.${viewName} auf dem Stand der Beispieldatei.`);
  }
}

/** Spielt das Beispiel-Modul über denselben Weg wie das Server-Kommando `modul-einspielen` ein. */
async function modulEinspielenAusVorlage(pool: pg.Pool, ausgabe: Ausgabe): Promise<void> {
  const ergebnis = await modulEinspielen(pool, {
    rohtext: readFileSync(MODUL_YAML_DATEI, 'utf8'),
    akteur: AKTEUR,
    herkunft: 'scripts/dev/demo-daten.ts',
  });
  if (!ergebnis.ok) {
    throw new Error(`Modul „Server & Dienste" konnte nicht eingespielt werden: ${ergebnis.grund}`);
  }
  ausgabe(`Modul ${ergebnis.kennung}: ${ergebnis.status}, Version ${String(ergebnis.version)}.`);
}

/** Schreibt jede Wache mit ihrem ganzen Verlauf über `befundMelden` — dieselbe Funktion wie die Agenten-API. */
async function wachenEinspielen(pool: pg.Pool, jetzt: Date): Promise<number> {
  let anzahl = 0;
  for (const wache of wachenDefinitionen()) {
    for (const punkt of wache.verlauf) {
      const ergebnis = await befundMelden(pool, {
        wache: wache.kennung,
        status: punkt.status,
        textIntern: punkt.textIntern,
        textKunde: wache.kundensichtbar ? punkt.textKunde : undefined,
        kundensichtbar: wache.kundensichtbar,
        taktSekunden: wache.taktSekunden,
        anzeigename: wache.anzeigename,
        agent: DEMO_WACHEN_AGENT,
        messwert: punkt.messwert,
        quelle: AKTEUR,
        jetzt: new Date(jetzt.getTime() - punkt.versatzSekunden * 1000),
      });
      if (!ergebnis.ok) {
        throw new Error(`Befund für ${wache.kennung} konnte nicht geschrieben werden (${ergebnis.grund}).`);
      }
      anzahl += 1;
    }
  }
  return anzahl;
}

/**
 * Spielt alle Demodaten ein: Migrationen, Fachtabellen und Views, die Module, die Agenten, die Wachen mit ihrem
 * Verlauf. Wiederholbar (siehe Kopf). Der Aufrufer sorgt dafür, dass `pool` auf eine lokale oder eine Testdatenbank
 * zeigt (`main` prüft das über `lokal-schutz.ts`); `jetzt` ist der Bezugspunkt aller relativen Zeiten.
 */
export async function demoDatenEinspielen(pool: pg.Pool, jetzt: Date, ausgabe: Ausgabe): Promise<void> {
  await migrationenAnwenden(pool);
  await demoDatenAufraeumen(pool);
  await sicherstellenFachtabellen(pool, ausgabe);
  await sicherstellenViews(pool, ausgabe);
  await modulEinspielenAusVorlage(pool, ausgabe);
  ausgabe(await anfragenEinspielen(pool, jetzt, AKTEUR));
  ausgabe(await kiVerbrauchEinspielen(pool, jetzt, AKTEUR));
  ausgabe(await eingangEinspielen(pool, jetzt, AKTEUR));
  ausgabe(await auswahlEinspielen(pool, jetzt, AKTEUR));
  ausgabe(await agentenEinspielen(pool, jetzt));
  const anzahlBefunde = await wachenEinspielen(pool, jetzt);
  ausgabe(`Demodaten angelegt: ${String(wachenDefinitionen().length)} Wachen, ${String(anzahlBefunde)} Befunde.`);
}

async function main(): Promise<void> {
  const databaseUrl = sicherstellenLokaleDatenbankUrl({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
  });

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    // eslint-disable-next-line no-console
    await demoDatenEinspielen(pool, new Date(), (zeile) => console.log(zeile));
  } finally {
    await pool.end();
  }
}

direktStarten(import.meta.url, main);
