/**
 * Der E-Mail-Zweitkanal (COPI-60) gegen die echte Datenbank, mit einem Fake-Versand: eine dringende Nachricht, die
 * nach der Frist ungelesen ist, geht genau einmal per Mail an den Besitzer des Kanals — ohne ihren Inhalt. Gelesenes,
 * Nichtdringendes, Gelöschtes und der Team-Kanal lösen nichts aus; die Drosselung hält eine Stunde; ein SMTP-Fehler
 * vermerkt nichts, und ein Neustart zwischen Auswahl und Versand verliert nichts.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort Chat und Konten ab.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { kontoAlsGeloeschtMarkieren } from '../src/auth/konto-loeschen.js';
import {
  assistentKanal,
  lesestandSetzen,
  nachrichtAlsGeloeschtMarkieren,
  nachrichtAnlegen,
  teamKanal,
  type Nachricht,
} from '../src/chat/nachricht-speicher.js';
import { faelligeMails, ZWEITKANAL_DROSSEL_MS, zweitkanalLaufen, type ZweitkanalLauf } from '../src/chat/zweitkanal.js';
import { zweitkanalKandidaten } from '../src/chat/zweitkanal-speicher.js';
import type { Nachricht as Mail } from '../src/mail/versand.js';
import { chatLeeren, kontenLoeschen, protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const GEHEIM = 'GEHEIM: Heizung Haus 2 ausgefallen';
const MINUTE = 60 * 1000;

describe.skipIf(!datenbankUrl)('E-Mail-Zweitkanal (echte Datenbank, Fake-Versand)', () => {
  let pool: pg.Pool;
  let gesendet: Mail[];
  let versandScheitert: boolean;
  let logZeilen: string[];
  let lauf: ZweitkanalLauf;

  /** Ein Zeitpunkt nach den Nachrichten des Tests: die Datenbank setzt `erstellt_am`, der Lauf bekommt `jetzt`. */
  function inMinuten(minuten: number): Date {
    return new Date(Date.now() + minuten * MINUTE);
  }

  async function dringendFuer(benutzerId: string, teil: { dringend?: boolean } = {}): Promise<Nachricht> {
    const kanalId = (await assistentKanal(pool, benutzerId)).id;
    return nachrichtAnlegen(pool, { kanalId, absenderArt: 'system', inhalt: GEHEIM, dringend: true, ...teil });
  }

  async function vermerkt(): Promise<{ nachricht_id: number; benutzer_id: string }[]> {
    const ergebnis = await pool.query<{ nachricht_id: number; benutzer_id: string }>(
      'SELECT nachricht_id::int AS nachricht_id, benutzer_id FROM cockpit.chat_mail ORDER BY nachricht_id',
    );
    return ergebnis.rows;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    for (const id of ['anna', 'bert']) {
      await pool.query(
        `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1 || '@example.org', $1, true, now(), now())`,
        [id],
      );
    }
    gesendet = [];
    versandScheitert = false;
    logZeilen = [];
    lauf = {
      pool,
      versand: {
        senden: (mail) => {
          if (versandScheitert) {
            return Promise.reject(new Error('SMTP: 421 anna@example.org abgewiesen'));
          }
          gesendet.push(mail);
          return Promise.resolve();
        },
      },
      basisUrl: 'https://cockpit.example.org',
      fristMinuten: 15,
      log: { warn: (objekt, meldung) => logZeilen.push(`${meldung} ${JSON.stringify(objekt)}`) },
    };
  });

  afterAll(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.end();
  });

  it('meldet vor der Frist nichts, danach genau einmal — an den Besitzer, ohne den Inhalt', async () => {
    const nachricht = await dringendFuer('anna');

    expect(await zweitkanalLaufen(lauf, inMinuten(14))).toEqual({ gesendet: 0, fehlgeschlagen: 0 });
    expect(gesendet).toEqual([]);

    const marke = await protokollMarke(pool);
    expect(await zweitkanalLaufen(lauf, inMinuten(16))).toEqual({ gesendet: 1, fehlgeschlagen: 0 });
    expect(gesendet).toHaveLength(1);
    const [mail] = gesendet;
    expect(mail?.an).toBe('anna@example.org');
    expect(mail?.betreff).toBe('Eine dringende Nachricht wartet im Cockpit');
    expect(mail?.text).toContain('https://cockpit.example.org/chat');
    expect(`${mail?.betreff ?? ''} ${mail?.text ?? ''} ${mail?.html ?? ''}`).not.toContain('GEHEIM');
    expect(await vermerkt()).toEqual([{ nachricht_id: nachricht.id, benutzer_id: 'anna' }]);
    expect(await protokollSeit(pool, marke)).toEqual([
      { art: 'chat_mail_gesendet', akteur: 'system', ziel: 'anna', einzelheiten: { anzahl: 1 } },
    ]);

    // Auch Stunden später nicht noch einmal: die Nachricht ist vermerkt.
    expect(await zweitkanalLaufen(lauf, inMinuten(200))).toEqual({ gesendet: 0, fehlgeschlagen: 0 });
    expect(gesendet).toHaveLength(1);
  });

  it('meldet nichts, was gelesen, nicht dringend, als gelöscht markiert oder im Team-Kanal ist', async () => {
    const gelesen = await dringendFuer('anna');
    await lesestandSetzen(pool, 'anna', gelesen.kanalId, gelesen.id);
    await dringendFuer('bert', { dringend: false });
    const markiert = await dringendFuer('bert');
    await nachrichtAlsGeloeschtMarkieren(pool, markiert.kanalId, markiert.id, 'bert');
    await nachrichtAnlegen(pool, { kanalId: (await teamKanal(pool)).id, absenderArt: 'system', inhalt: GEHEIM, dringend: true });

    expect(await zweitkanalLaufen(lauf, inMinuten(30))).toEqual({ gesendet: 0, fehlgeschlagen: 0 });
    expect(gesendet).toEqual([]);
  });

  it('meldet eine dringende Nachricht nach dem Lesestand, auch wenn eine ältere gelesen ist', async () => {
    const alt = await dringendFuer('anna');
    await lesestandSetzen(pool, 'anna', alt.kanalId, alt.id);
    const neu = await dringendFuer('anna');

    expect((await zweitkanalLaufen(lauf, inMinuten(20))).gesendet).toBe(1);
    expect(await vermerkt()).toEqual([{ nachricht_id: neu.id, benutzer_id: 'anna' }]);
  });

  it('meldet nichts an ein als gelöscht markiertes Konto', async () => {
    await dringendFuer('anna');
    const client = await pool.connect();
    try {
      await kontoAlsGeloeschtMarkieren(client, 'anna', 'bert', 'kein-hash');
    } finally {
      client.release();
    }

    expect(await zweitkanalLaufen(lauf, inMinuten(30))).toEqual({ gesendet: 0, fehlgeschlagen: 0 });
    expect(await vermerkt()).toEqual([]);
  });

  it('fasst mehrere Nachrichten in einer Mail zusammen und drosselt auf eine Mail je Stunde', async () => {
    await dringendFuer('anna');
    await dringendFuer('anna');
    await dringendFuer('bert');

    expect((await zweitkanalLaufen(lauf, inMinuten(20))).gesendet).toBe(2);
    expect(gesendet.map((mail) => [mail.an, mail.betreff])).toEqual([
      ['anna@example.org', 'Dringende Nachrichten warten im Cockpit'],
      ['bert@example.org', 'Eine dringende Nachricht wartet im Cockpit'],
    ]);
    expect(gesendet[0]?.text).toContain('warten 2 dringende Nachrichten');

    // Eine neue dringende Nachricht an Anna wartet die Stunde ab, dann geht genau eine Mail.
    const spaeter = await dringendFuer('anna');
    expect((await zweitkanalLaufen(lauf, inMinuten(20 + 59))).gesendet).toBe(0);
    expect((await zweitkanalLaufen(lauf, inMinuten(20 + 60))).gesendet).toBe(1);
    expect(gesendet).toHaveLength(3);
    expect((await vermerkt()).at(-1)).toEqual({ nachricht_id: spaeter.id, benutzer_id: 'anna' });
  });

  it('vermerkt bei einem SMTP-Fehler nichts, loggt ohne Adresse, und der nächste Lauf sendet', async () => {
    await dringendFuer('anna');
    const marke = await protokollMarke(pool);
    versandScheitert = true;

    expect(await zweitkanalLaufen(lauf, inMinuten(20))).toEqual({ gesendet: 0, fehlgeschlagen: 1 });
    expect(await vermerkt()).toEqual([]);
    expect(await protokollSeit(pool, marke)).toEqual([]);
    expect(logZeilen).toHaveLength(1);
    expect(logZeilen.join('\n')).not.toContain('@');
    expect(logZeilen.join('\n')).toContain('"benutzer":"anna"');

    versandScheitert = false;
    expect(await zweitkanalLaufen(lauf, inMinuten(21))).toEqual({ gesendet: 1, fehlgeschlagen: 0 });
    expect(await vermerkt()).toHaveLength(1);
  });

  it('verliert nichts, wenn der Prozess zwischen Auswahl und Versand endet — und sendet danach genau einmal', async () => {
    await dringendFuer('anna');
    // Ein Lauf hat ausgewählt, dann endet der Prozess, bevor er vermerkt und sendet.
    const ausgewaehlt = faelligeMails(await zweitkanalKandidaten(pool, inMinuten(20)), inMinuten(20), {
      fristMs: 15 * MINUTE,
      drosselMs: ZWEITKANAL_DROSSEL_MS,
    });
    expect(ausgewaehlt).toHaveLength(1);
    expect(await vermerkt()).toEqual([]);

    // Nach dem Neustart: zwei Läufe hintereinander, eine Mail.
    expect((await zweitkanalLaufen(lauf, inMinuten(21))).gesendet).toBe(1);
    expect((await zweitkanalLaufen(lauf, inMinuten(22))).gesendet).toBe(0);
    expect(gesendet).toHaveLength(1);
  });

  it('sendet nicht doppelt, wenn zwei Läufe gleichzeitig dieselbe Nachricht ausgewählt haben', async () => {
    await dringendFuer('anna');

    const ergebnisse = await Promise.all([zweitkanalLaufen(lauf, inMinuten(20)), zweitkanalLaufen(lauf, inMinuten(20))]);

    expect(ergebnisse.map((ergebnis) => ergebnis.gesendet).toSorted()).toEqual([0, 1]);
    expect(gesendet).toHaveLength(1);
  });
});
