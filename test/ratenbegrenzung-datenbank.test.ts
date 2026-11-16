/**
 * Zähler und Sperren der eigenen Ratenbegrenzung gegen eine echte PostgreSQL
 * (COPI-13). Läuft nur, wenn `TEST_DATABASE_URL` gesetzt ist.
 *
 * ACHTUNG: Der Test räumt die Tabelle `cockpit.anmeldeversuch` ab. Niemals
 * gegen eine Kundendatenbank laufen lassen.
 *
 * Die Zeit kommt überall als Parameter herein — kein `sleep` im Test.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ANMELDE_FENSTER_MS,
  ANMELDE_SPERRE_MS,
  versuchReservieren,
  istGesperrt,
  sperrePruefen,
  zaehlerAufraeumen,
  zaehlerGutschreiben,
  zaehlerZuruecksetzen,
} from '../src/auth/ratenbegrenzung.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const T0 = new Date('2026-09-19T12:00:00.000Z');

function spaeter(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

describe.skipIf(!datenbankUrl)('Ratenbegrenzung gegen echte Datenbank', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cockpit.anmeldeversuch');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('ist für eine unbekannte Kennung offen', async () => {
    expect(await sperrePruefen(pool, 'passwort-email', 'wer@example.org', T0)).toBe(false);
  });

  it('zählt Fehlversuche hoch und sperrt beim fünften', async () => {
    const staende = [];
    for (let versuch = 1; versuch <= 5; versuch += 1) {
      staende.push(await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0));
    }

    expect(staende.map((stand) => stand.fehlversuche)).toEqual([1, 2, 3, 4, 5]);
    expect(staende.slice(0, 4).every((stand) => stand.gesperrtBis === undefined)).toBe(true);
    expect(istGesperrt(staende[4]?.gesperrtBis, T0)).toBe(true);
    expect(await sperrePruefen(pool, 'passwort-email', 'a@example.org', T0)).toBe(true);
  });

  it('erlaubt die Prüfung nur für die ersten fünf Reservierungen', async () => {
    const erlaubt: boolean[] = [];
    for (let versuch = 1; versuch <= 6; versuch += 1) {
      erlaubt.push(
        (await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0)).erlaubt,
      );
    }

    // Die Grenze entscheidet zusammen mit dem Zählen — nicht danach.
    expect(erlaubt).toEqual([true, true, true, true, true, false]);
  });

  it('meldet genau eine Reservierung als die neu sperrende', async () => {
    const neu: boolean[] = [];
    for (let versuch = 1; versuch <= 8; versuch += 1) {
      neu.push(
        (await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0)).neuGesperrt,
      );
    }

    expect(neu.filter((wert) => wert)).toHaveLength(1);
    expect(neu[4]).toBe(true);
  });

  it('schreibt eine Reservierung gut und hebt eine gerade gesetzte Sperre auf', async () => {
    for (let versuch = 1; versuch <= 5; versuch += 1) {
      await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0);
    }
    expect(await sperrePruefen(pool, 'passwort-email', 'a@example.org', T0)).toBe(true);

    await zaehlerGutschreiben(pool, 'passwort-email', 'a@example.org');

    // Unter der Grenze darf keine Sperre stehen bleiben, die auf einem nie
    // ausgeführten Versuch beruht.
    expect(await sperrePruefen(pool, 'passwort-email', 'a@example.org', T0)).toBe(false);
    const stand = await pool.query<{ fehlversuche: number }>(
      'SELECT fehlversuche FROM cockpit.anmeldeversuch',
    );
    expect(stand.rows[0]?.fehlversuche).toBe(4);
  });

  it('lässt eine Sperre stehen, solange der Stand über der Grenze bleibt', async () => {
    for (let versuch = 1; versuch <= 9; versuch += 1) {
      await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0);
    }

    await zaehlerGutschreiben(pool, 'passwort-email', 'a@example.org');

    expect(await sperrePruefen(pool, 'passwort-email', 'a@example.org', T0)).toBe(true);
  });

  it('schreibt nicht unter null gut', async () => {
    await versuchReservieren(pool, 'passwort-ip', '203.0.113.1', T0);

    await zaehlerGutschreiben(pool, 'passwort-ip', '203.0.113.1');
    await zaehlerGutschreiben(pool, 'passwort-ip', '203.0.113.1');

    const stand = await pool.query<{ fehlversuche: number }>(
      'SELECT fehlversuche FROM cockpit.anmeldeversuch',
    );
    expect(stand.rows[0]?.fehlversuche).toBe(0);
  });

  it('sperrt eine unbekannte Adresse genauso — die Sperre verrät kein Konto', async () => {
    for (let versuch = 1; versuch <= 5; versuch += 1) {
      await versuchReservieren(pool, 'passwort-email', 'gibt-es-nicht@example.org', T0);
    }

    expect(await sperrePruefen(pool, 'passwort-email', 'gibt-es-nicht@example.org', T0)).toBe(
      true,
    );
  });

  it('hält die Kennungen getrennt', async () => {
    for (let versuch = 1; versuch <= 5; versuch += 1) {
      await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0);
    }

    expect(await sperrePruefen(pool, 'passwort-email', 'b@example.org', T0)).toBe(false);
    // Gleiche Kennung, andere Art: eigener Zähler.
    expect(await sperrePruefen(pool, 'passwort-ip', 'a@example.org', T0)).toBe(false);
  });

  it('sperrt je IP erst nach 20 Fehlversuchen', async () => {
    for (let versuch = 1; versuch <= 19; versuch += 1) {
      await versuchReservieren(pool, 'passwort-ip', '203.0.113.7', T0);
    }
    expect(await sperrePruefen(pool, 'passwort-ip', '203.0.113.7', T0)).toBe(false);

    await versuchReservieren(pool, 'passwort-ip', '203.0.113.7', T0);

    expect(await sperrePruefen(pool, 'passwort-ip', '203.0.113.7', T0)).toBe(true);
  });

  it('beginnt nach Ablauf des Fensters von vorn', async () => {
    for (let versuch = 1; versuch <= 4; versuch += 1) {
      await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0);
    }

    const nachFenster = await versuchReservieren(
      pool,
      'passwort-email',
      'a@example.org',
      spaeter(ANMELDE_FENSTER_MS + 1000),
    );

    expect(nachFenster.fehlversuche).toBe(1);
    expect(await sperrePruefen(pool, 'passwort-email', 'a@example.org', spaeter(ANMELDE_FENSTER_MS + 1000))).toBe(false);
  });

  it('öffnet nach Ablauf der Sperre wieder', async () => {
    for (let versuch = 1; versuch <= 5; versuch += 1) {
      await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0);
    }
    expect(await sperrePruefen(pool, 'passwort-email', 'a@example.org', spaeter(ANMELDE_SPERRE_MS - 1000))).toBe(true);

    expect(await sperrePruefen(pool, 'passwort-email', 'a@example.org', spaeter(ANMELDE_SPERRE_MS + 1000))).toBe(false);
  });

  it('verlängert die Sperre nicht bei weiteren Versuchen während der Sperre', async () => {
    for (let versuch = 1; versuch <= 5; versuch += 1) {
      await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0);
    }
    const ersteSperre = await pool.query<{ gesperrt_bis: Date }>(
      'SELECT gesperrt_bis FROM cockpit.anmeldeversuch',
    );

    await versuchReservieren(pool, 'passwort-email', 'a@example.org', spaeter(60_000));

    const zweiteSperre = await pool.query<{ gesperrt_bis: Date }>(
      'SELECT gesperrt_bis FROM cockpit.anmeldeversuch',
    );
    expect(zweiteSperre.rows[0]?.gesperrt_bis.getTime()).toBe(
      ersteSperre.rows[0]?.gesperrt_bis.getTime(),
    );
  });

  it('setzt den Zähler bei Erfolg zurück', async () => {
    for (let versuch = 1; versuch <= 4; versuch += 1) {
      await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0);
    }

    await zaehlerZuruecksetzen(pool, 'passwort-email', 'a@example.org');

    const naechster = await versuchReservieren(pool, 'passwort-email', 'a@example.org', T0);
    expect(naechster.fehlversuche).toBe(1);
  });

  it('verliert bei gleichzeitigen Versuchen keinen Zähler', async () => {
    // Zehn parallele Fehlversuche: der Zähler steht danach auf genau zehn.
    // Ein Lesen-Entscheiden-Schreiben in der Anwendung würde hier verlieren.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        versuchReservieren(pool, 'passwort-ip', '203.0.113.9', T0),
      ),
    );

    const ergebnis = await pool.query<{ fehlversuche: number }>(
      'SELECT fehlversuche FROM cockpit.anmeldeversuch',
    );
    expect(ergebnis.rows[0]?.fehlversuche).toBe(10);
  });

  it('speichert die Kennung nicht im Klartext', async () => {
    await versuchReservieren(pool, 'passwort-email', 'geheim@example.org', T0);

    const zeilen = await pool.query<{ zeile: string }>(
      'SELECT anmeldeversuch::text AS zeile FROM cockpit.anmeldeversuch',
    );
    expect(zeilen.rows[0]?.zeile).not.toContain('geheim@example.org');
  });

  it('räumt abgelaufene Zähler ab, laufende Sperren nicht', async () => {
    await versuchReservieren(pool, 'passwort-email', 'alt@example.org', T0);
    for (let versuch = 1; versuch <= 5; versuch += 1) {
      await versuchReservieren(pool, 'passwort-email', 'gesperrt@example.org', spaeter(60_000));
    }

    const entfernt = await zaehlerAufraeumen(pool, spaeter(ANMELDE_FENSTER_MS + 30_000));

    expect(entfernt).toBe(1);
    expect(await sperrePruefen(pool, 'passwort-email', 'gesperrt@example.org', spaeter(ANMELDE_FENSTER_MS + 30_000))).toBe(true);
  });
});
