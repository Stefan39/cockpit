/**
 * Übereinstimmungsprüfung: das Beispiel-Modul „Server & Dienste" (COPI-78,
 * `docs/beispiele/v_modul_server_zustand.sql` und `docs/beispiele/server-zustand.cockpit.yaml`) gegen
 * `wachenZustand` (`src/status/zustand.ts`) — dieselbe Überfälligkeitsregel wie die Übersicht (COPI-37),
 * nur einmal in SQL statt in TypeScript. Der Status einer Zeile muss für jede Konstellation genau der Farbe
 * entsprechen, die die Übersicht für dieselbe Wache anzeigen würde.
 *
 * `now()` in der View und der Zeitpunkt der reinen Funktion müssen dieselbe „Uhr" sehen: Doku und Test lesen
 * beide das SQL aus derselben Datei, und View wie Übereinstimmungsprüfung laufen in **einer** Transaktion,
 * damit `now()` beider Abfragen exakt gleich ist (Postgres: `now()` ist die Transaktionszeit).
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Räumt `cockpit.wache`/`cockpit.befund` und `cockpit.modul` ab; legt und
 * entfernt die Beispiel-View. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modulBlockAusText } from '../src/module/block.js';
import type { Rolle, Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { modulEinspielen } from '../src/module/modul-speicher.js';
import { katalogPruefen, modulViewPruefen, verlaufViewPruefen } from '../src/module/registry.js';
import { buildApp } from '../src/server/app.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { wachenZustand, type BefundStatus } from '../src/status/zustand.js';
import { rueckwege } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const VIEW_SQL = readFileSync('docs/beispiele/v_modul_server_zustand.sql', 'utf8');
/** Die Verlaufs-View des Beispiels (COPI-81), `uebersicht.verlauf` im Block. */
const VERLAUF_SQL = readFileSync('docs/beispiele/v_modul_server_zustand_verlauf.sql', 'utf8');
const BLOCK_YAML = readFileSync('docs/beispiele/server-zustand.cockpit.yaml', 'utf8');

const TAKT_SEKUNDEN = 300;
/** Takt + Toleranz (der halbe Takt, mindestens eine Minute) = 300 + 150 = 450 s (`toleranzSekunden`). */
const SCHWELLE_SEKUNDEN = 450;

interface ZeileErgebnis {
  readonly id: string;
  readonly status: string;
}

describe.skipIf(!datenbankUrl)('Beispiel-Modul „Server & Dienste": Übereinstimmung mit wachenZustand (echte Datenbank)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query(VIEW_SQL);
    await pool.query(VERLAUF_SQL);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cockpit.modul');
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_server_zustand_verlauf');
    await pool.query('DROP VIEW IF EXISTS cockpit.v_modul_server_zustand');
    await pool.end();
  });

  it('besteht die Katalogprüfung (inkl. Kundensicht und Verlaufs-View) mit den Rollen betreuer und betriebs_admin', async () => {
    const geparst = modulBlockAusText(BLOCK_YAML);
    expect(geparst.ok, !geparst.ok ? geparst.grund : undefined).toBe(true);
    if (!geparst.ok) return;

    expect(geparst.block.rollen).toEqual(['betreuer', 'betriebs_admin']);
    expect(geparst.block.uebersicht).toEqual({
      titel: 'Server & Dienste',
      kurztext: 'text',
      verlauf: 'v_modul_server_zustand_verlauf',
      reihenfolge: 10,
    });
    expect((await katalogPruefen(pool, geparst.block)).ok).toBe(true);
    // Die Messwert-Spalten (COPI-83) sind da, mit genau den erwarteten Typen.
    expect(await modulViewPruefen(pool, geparst.block)).toEqual({ ok: true, optionale: ['wert', 'einheit', 'wert_max', 'wert_warnung'] });
    expect(await verlaufViewPruefen(pool, geparst.block)).toEqual({ ok: true, optionale: ['wert', 'einheit'] });
  });

  /** Ein Befund `sekundenVor` Sekunden vor `jetzt`, kundensichtbar, für die genannte Wache — liefert den tatsächlich gespeicherten Zeitpunkt zurück. */
  async function befund(wache: string, status: BefundStatus, sekundenVor: number, jetzt: Date): Promise<Date> {
    const ergebnis = await befundMelden(pool, {
      wache,
      status,
      textIntern: `intern: ${status}`,
      textKunde: `Klartext: ${status}`,
      kundensichtbar: true,
      taktSekunden: TAKT_SEKUNDEN,
      quelle: 'test',
      jetzt: new Date(jetzt.getTime() - sekundenVor * 1000),
    });
    if (!ergebnis.ok) {
      throw new Error(`Befund für ${wache} konnte nicht angelegt werden`);
    }
    return ergebnis.gemeldetAm;
  }

  /** Liest View und `now()` der Transaktion **gemeinsam**, damit beide Abfragen exakt dieselbe Zeit sehen. */
  async function zeilenUndJetzt(): Promise<{ zeilen: readonly ZeileErgebnis[]; jetzt: Date }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const zeit = await client.query<{ jetzt: Date }>('SELECT now() AS jetzt');
      const zeilen = await client.query<ZeileErgebnis>('SELECT id, status FROM cockpit.v_modul_server_zustand');
      await client.query('COMMIT');
      const jetzt = zeit.rows[0]?.jetzt;
      if (jetzt === undefined) {
        throw new Error('now() lieferte keine Zeile');
      }
      return { zeilen: zeilen.rows, jetzt };
    } catch (fehler) {
      await client.query('ROLLBACK');
      throw fehler;
    } finally {
      client.release();
    }
  }

  it('stimmt für frisch grün, rot, überfällig (knapp drüber/drunter) und ohne Befund mit wachenZustand überein', async () => {
    // Referenzzeitpunkt für die Erwartung: kurz vor dem Schreiben der Befunde, damit reale Ausführungszeit die
    // Vergleichsschwellen (10 s Abstand zur Grenze) nicht erreicht.
    const vorher = await pool.query<{ jetzt: Date }>('SELECT now() AS jetzt');
    const referenz = vorher.rows[0]?.jetzt;
    if (referenz === undefined) throw new Error('now() lieferte keine Zeile');

    const gemeldetAm = {
      frischGruen: await befund('frisch-gruen', 'gruen', 10, referenz),
      rot: await befund('rot', 'rot', 10, referenz),
      drueber: await befund('ueberfaellig-drueber', 'gruen', SCHWELLE_SEKUNDEN + 10, referenz),
      drunter: await befund('ueberfaellig-drunter', 'gruen', SCHWELLE_SEKUNDEN - 10, referenz),
    };
    // Eine Wache ohne jeden (kundensichtbaren) Befund: taucht in der Kundensicht nirgends auf.
    await pool.query('INSERT INTO cockpit.wache (kennung, takt_sekunden) VALUES ($1, $2)', ['kein-befund', TAKT_SEKUNDEN]);

    const { zeilen, jetzt } = await zeilenUndJetzt();
    const nachId = new Map(zeilen.map((zeile) => [zeile.id, zeile.status]));

    function erwartet(letzterLauf: Date, letzterStatus: BefundStatus): string {
      return wachenZustand({ taktSekunden: TAKT_SEKUNDEN, letzterLauf, letzterStatus }, jetzt).farbe;
    }

    expect(nachId.get('frisch-gruen')).toBe(erwartet(gemeldetAm.frischGruen, 'gruen'));
    expect(nachId.get('frisch-gruen')).toBe('gruen');
    expect(nachId.get('rot')).toBe(erwartet(gemeldetAm.rot, 'rot'));
    expect(nachId.get('rot')).toBe('rot');
    expect(nachId.get('ueberfaellig-drueber')).toBe(erwartet(gemeldetAm.drueber, 'gruen'));
    expect(nachId.get('ueberfaellig-drueber')).toBe('gelb');
    expect(nachId.get('ueberfaellig-drunter')).toBe(erwartet(gemeldetAm.drunter, 'gruen'));
    expect(nachId.get('ueberfaellig-drunter')).toBe('gruen');
    expect(nachId.has('kein-befund')).toBe(false);

    // Überfällig, aber nicht rot: kein veralteter Klartext mehr, sondern der Hinweis auf die fehlende Prüfung.
    const texte = await pool.query<{ id: string; text: string }>('SELECT id, text FROM cockpit.v_modul_server_zustand');
    const textNachId = new Map(texte.rows.map((zeile) => [zeile.id, zeile.text]));
    expect(textNachId.get('ueberfaellig-drueber')).toBe('Keine aktuelle Prüfung: die letzte Meldung liegt zu lange zurück.');
    expect(textNachId.get('ueberfaellig-drunter')).toBe('Klartext: gruen');
    expect(textNachId.get('rot')).toBe('Klartext: rot');
  });

  describe('Messwerte (COPI-83): nur aus kundensichtbaren Befunden', () => {
    const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });

    async function melden(wache: string, minutenVor: number, sichtbar: boolean, messwert: { wert: number; einheit: string; max?: number; warnung?: number }) {
      const ergebnis = await befundMelden(pool, {
        wache,
        status: 'gruen',
        textIntern: `intern ${wache}`,
        textKunde: sichtbar ? `Klartext ${wache}` : undefined,
        kundensichtbar: sichtbar,
        taktSekunden: 3600,
        anzeigename: wache === 'platte' ? 'Plattenplatz' : 'Intern',
        messwert,
        quelle: 'test',
        jetzt: new Date(Date.now() - minutenVor * 60_000),
      });
      if (!ergebnis.ok) throw new Error('Befund nicht angelegt');
    }

    async function seite(url: string, rolle: Rolle): Promise<string> {
      const zugang: Zugang = { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'test' };
      const app = buildApp({ nodeEnv: 'test' }, { pool, jetzt: () => new Date(), sitzungLesen: MIT_FAKTOR, zugangLesen: () => Promise.resolve(zugang) });
      try {
        const antwort = await app.inject({ method: 'GET', url });
        expect(antwort.statusCode).toBe(200);
        return antwort.body;
      } finally {
        await app.close();
      }
    }

    beforeEach(async () => {
      const eingespielt = await modulEinspielen(pool, { rohtext: BLOCK_YAML, akteur: 'konsole' });
      if (!eingespielt.ok) throw new Error(eingespielt.grund);
      await melden('platte', 180, true, { wert: 80, einheit: '%', max: 100, warnung: 85 });
      await melden('platte', 60, true, { wert: 86, einheit: '%', max: 100, warnung: 85 });
      // Jünger, aber intern: weder Wert noch Kurvenpunkt dürfen beim Kunden ankommen.
      await melden('platte', 5, false, { wert: 4711, einheit: 'geheim' });
      await melden('intern', 5, false, { wert: 9999, einheit: 'geheim' });
    });

    // Je Seite ein eigener Fall: jeder baut eine App auf, fünf in einem Fall sprengten auf dem CI-Runner die 5 s.
    it.each([
      ['/module/server-zustand', '/module', 'Module'],
      ['/module/server-zustand?von=uebersicht', '/', 'Übersicht'],
      ['/module/server-zustand/platte', '/module/server-zustand', 'Liste'],
      ['/module/server-zustand/platte?von=uebersicht', '/', 'Übersicht'],
      // Nur ein bekannter Wert zählt; alles andere ist der gewöhnliche Rückweg (kein offener Weiterleiter).
      ['/module/server-zustand/platte?von=https://boese.example', '/module/server-zustand', 'Liste'],
    ])('führt auf %s mit dem Zurück-Knopf nach %s (COPI-100)', async (url, href, ziel) => {
      expect(rueckwege(await seite(url, 'betreuer'))).toEqual([{ href, ziel }]);
    });

    it.each(['/module/server-zustand', '/module/server-zustand/platte'])('lädt %s alle 60 s neu (COPI-105)', async (url) => {
      expect([...(await seite(url, 'betreuer')).matchAll(/data-aktualisieren="(\d+)"/g)].map((m) => m[1])).toEqual(['60']);
    });

    it('verlinkt die Karten der Übersicht mit ihrer Herkunft (COPI-100)', async () => {
      const html = await seite('/', 'betreuer');
      expect(html).toContain('href="/module/server-zustand/platte?von=uebersicht"');
      expect(rueckwege(html)).toEqual([]);
    });

    it.each(['betriebs_admin', 'betreuer'] as const)('zeigt %s Wert und Kurve aus den kundensichtbaren Befunden, nie einen internen', async (rolle) => {
      for (const url of ['/', '/module/server-zustand']) {
        const html = await seite(url, rolle);
        // Auf der Übersicht steht eine grüne Karte seit COPI-122 nur als Chip: Wert und Kurve zeigt die Modulseite.
        if (url !== '/') {
          expect(html).toContain('messwert-wert-gruen">86</span>');
          expect(html).toMatch(/aria-label="Plattenplatz, letzte (24 Stunden|7 Tage): 80 – 86 %, aktuell 86 %"/);
        }
        expect(html).not.toMatch(/4711|4\.711|9999|9\.999|geheim/);
      }
    });

    it('liest die Kurve aus der Verlaufs-View nur aus kundensichtbaren Befunden', async () => {
      const zeilen = await pool.query<{ id: string; wert: string | null }>(
        'SELECT id, wert FROM cockpit.v_modul_server_zustand_verlauf ORDER BY zeitpunkt',
      );
      expect(zeilen.rows).toEqual([
        { id: 'platte', wert: '80' },
        { id: 'platte', wert: '86' },
      ]);
    });
  });

  it('liefert im Verlauf nur kundensichtbare Befunde, mit der Wache als id', async () => {
    const jetzt = new Date();
    await befund('verlauf', 'gruen', 120, jetzt);
    await befundMelden(pool, {
      wache: 'verlauf',
      status: 'rot',
      textIntern: 'intern: rot',
      kundensichtbar: false,
      taktSekunden: TAKT_SEKUNDEN,
      quelle: 'test',
      jetzt: new Date(jetzt.getTime() - 60_000),
    });
    await befund('verlauf', 'gelb', 30, jetzt);

    const zeilen = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM cockpit.v_modul_server_zustand_verlauf ORDER BY zeitpunkt',
    );

    expect(zeilen.rows).toEqual([
      { id: 'verlauf', status: 'gruen' },
      { id: 'verlauf', status: 'gelb' },
    ]);
  });
});
