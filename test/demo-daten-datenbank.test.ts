/**
 * Der Demo-Seed (COPI-249, `scripts/dev/demo-daten.ts`) gegen eine echte PostgreSQL: Er läuft vollständig durch, ist
 * wiederholbar (ein zweiter Lauf verdoppelt nichts) und schreibt keine internen Namen in die Demodaten.
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import { existsSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoDatenEinspielen } from '../scripts/dev/demo-daten.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const JETZT = new Date('2026-11-16T09:00:00Z');
const INTERNE_NAMEN = /jacomeit|vps\.|\bsven\b|\badam\b|\btim\b|\bstefan\b|\bheiko\b|upwork|freelancermap|agent-blueprints/i;

/** Alles, was der Seed anlegt und was ein zweiter Lauf nicht verdoppeln darf. */
const ZAEHLER = [
  `SELECT count(*) FROM cockpit.wache WHERE kennung LIKE 'demo-%'`,
  `SELECT count(*) FROM cockpit.befund WHERE wache LIKE 'demo-%'`,
  `SELECT count(*) FROM cockpit.modul WHERE aktiv`,
  'SELECT count(*) FROM cockpit.agent',
  'SELECT count(*) FROM cockpit.nachricht',
  'SELECT count(*) FROM eingang.vorgang',
  'SELECT count(*) FROM eingang.anhang',
  'SELECT count(*) FROM eingang.entwurf',
  'SELECT count(*) FROM auswahl.treffer',
  'SELECT count(*) FROM auswahl.schritt',
] as const;

/** Der Text aller Zeilen, die der Seed schreibt, als eine Zeichenkette zum Durchsuchen. */
const TEXTE = [
  'SELECT row_to_json(t)::text AS zeile FROM cockpit.agent t',
  'SELECT row_to_json(t)::text AS zeile FROM cockpit.nachricht t',
  `SELECT row_to_json(t)::text AS zeile FROM cockpit.befund t WHERE wache LIKE 'demo-%'`,
  `SELECT row_to_json(t)::text AS zeile FROM cockpit.wache t WHERE kennung LIKE 'demo-%'`,
  'SELECT row_to_json(t)::text AS zeile FROM eingang.vorgang t',
  'SELECT row_to_json(t)::text AS zeile FROM eingang.entwurf t',
  'SELECT row_to_json(t)::text AS zeile FROM auswahl.treffer t',
  'SELECT row_to_json(t)::text AS zeile FROM auswahl.schritt t',
] as const;

/**
 * Räumt weg, was der Seed an Schemas und Views anlegt, in dieser Worker-Datenbank sonst für andere Tests sichtbar bliebe
 * (etwa listet `nie-loeschen-datenbank.test.ts` jede Tabelle mit `nie_loeschen`-Sperre in allen Schemas).
 */
async function seedAufraeumen(pool: pg.Pool): Promise<void> {
  const ordner = ['docs/beispiele', 'docs/demo'].filter((name) => existsSync(name));
  const views = ordner.flatMap((name) => readdirSync(name).filter((datei) => /^v_modul_[a-z0-9_]+\.sql$/.test(datei)).map((datei) => datei.slice(0, -4)));
  const schemas = ordner.flatMap((name) => (existsSync(`${name}/fach`) ? readdirSync(`${name}/fach`) : []));
  for (const view of [...views, 'v_modul_demo_anfragen']) {
    await pool.query(`DROP VIEW IF EXISTS cockpit.${pg.escapeIdentifier(view)}`);
  }
  for (const schema of [...schemas, 'demo']) {
    await pool.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
  }
}

describe.skipIf(!datenbankUrl)('Demo-Seed (echte Datenbank)', () => {
  let pool: pg.Pool;
  const meldungen: string[] = [];

  async function stand(): Promise<number[]> {
    const zahlen: number[] = [];
    for (const sql of ZAEHLER) {
      zahlen.push(Number((await pool.query<{ count: string }>(sql)).rows[0]?.count));
    }
    return zahlen;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await seedAufraeumen(pool);
    await demoDatenEinspielen(pool, JETZT, (zeile) => meldungen.push(zeile));
  });

  afterAll(async () => {
    await seedAufraeumen(pool);
    await pool.end();
  });

  it('legt Wachen, Module, Agenten und die Fachdaten der Demo-Module an', async () => {
    const zahlen = await stand();

    expect(zahlen.every((zahl) => zahl > 0)).toBe(true);
    const module = await pool.query<{ kennung: string }>('SELECT kennung FROM cockpit.modul WHERE aktiv ORDER BY kennung');
    expect(module.rows.map((zeile) => zeile.kennung)).toEqual(expect.arrayContaining(['auswahl', 'eingang', 'ki-verbrauch', 'server-zustand']));
    expect(meldungen.at(-1)).toMatch(/^Demodaten angelegt: \d+ Wachen, \d+ Befunde\.$/);
  });

  it('ist wiederholbar: ein zweiter Lauf verdoppelt nichts', async () => {
    const vorher = await stand();

    await demoDatenEinspielen(pool, JETZT, () => undefined);

    expect(await stand()).toEqual(vorher);
  });

  it('schreibt keine internen Namen in die Demodaten', async () => {
    let geprueft = 0;
    for (const sql of TEXTE) {
      for (const zeile of (await pool.query<{ zeile: string }>(sql)).rows) {
        expect(zeile.zeile).not.toMatch(INTERNE_NAMEN);
        geprueft += 1;
      }
    }
    expect(geprueft).toBeGreaterThan(50);
  });
});
