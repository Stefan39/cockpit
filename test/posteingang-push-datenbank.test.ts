/**
 * Push bei neuen Einträgen im Posteingang (COPI-116) gegen die echte Datenbank, mit einem Fake-Push-Dienst: der Takt
 * meldet beim ersten Lauf nichts, danach jeden neuen Eintrag genau einmal und nie dessen Inhalt; nach einem Sofort-Push
 * (Antwort des Assistenten) meldet er dieselbe Nachricht nicht noch einmal; der Test-Push aus den Einstellungen.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort Chat, Konten und Befunde-Stände ab.
 */
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Zugang } from '../src/auth/berechtigung.js';
import type { SitzungLesen } from '../src/auth/zwei-faktor-tor.js';
import { ChatEreignisse } from '../src/chat/ereignisse.js';
import { assistentKanal, nachrichtAnlegen } from '../src/chat/nachricht-speicher.js';
import { vapidErzeugen, type PushKonfiguration, type Versender } from '../src/chat/push.js';
import { aboSpeichern } from '../src/chat/push-speicher.js';
import { posteingangPushLauf, type PushAbhaengigkeiten } from '../src/posteingang/push.js';
import { buildApp } from '../src/server/app.js';
import { TEST_RUMPF } from '../src/server/routes/push.js';
import { befundMelden } from '../src/status/befund-speicher.js';
import { chatLeeren, FORMULAR_KOPF, kontenLoeschen } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const MIT_FAKTOR: SitzungLesen = () => Promise.resolve({ sitzungVorhanden: true, zweiterFaktorAktiv: true });
const HERKUNFT = { host: 'localhost:3000', origin: 'http://localhost:3000' };
const PAAR = vapidErzeugen();
const PUSH: PushKonfiguration = { oeffentlich: PAAR.oeffentlich, privat: PAAR.privat, kontakt: 'mailto:cockpit@localhost' };
const SCHLUESSEL = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const T0 = new Date('2026-10-02T18:00:00.000Z');

function minute(n: number): Date {
  return new Date(T0.getTime() + n * 60_000);
}

describe.skipIf(!datenbankUrl)('Posteingang-Push (echte Datenbank, Fake-Push-Dienst)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let gesendet: { endpoint: string; rumpf: string }[];
  let angemeldet: Zugang;
  const chatEreignisse = new ChatEreignisse();
  const versender: Versender = (abo, rumpf) => {
    gesendet.push({ endpoint: abo.endpoint, rumpf });
    return Promise.resolve({ statusCode: 201 });
  };
  const log = { warn: () => undefined };

  function abhaengigkeiten(): PushAbhaengigkeiten {
    return { pool, konfiguration: PUSH, versender, log };
  }

  async function kontoAnlegen(id: string, rolle: string, zweiterFaktor = true): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt", rolle, "twoFactorEnabled")
       VALUES ($1, $1 || '@example.org', $1, true, now(), now(), $2, $3)`,
      [id, rolle, zweiterFaktor],
    );
    await aboSpeichern(pool, id, { endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, ...SCHLUESSEL });
  }

  async function meldung(wache: string, zeitpunkt: Date): Promise<void> {
    const ergebnis = await befundMelden(pool, {
      wache,
      status: 'rot',
      textIntern: 'GEHEIM: Festplatte von Familie Brandt voll',
      kundensichtbar: false,
      taktSekunden: 300,
      quelle: 'test',
      jetzt: zeitpunkt,
    });
    expect(ergebnis.ok).toBe(true);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    app = buildApp(
      { nodeEnv: 'test' },
      {
        pool,
        sitzungLesen: MIT_FAKTOR,
        zugangLesen: () => Promise.resolve(angemeldet),
        jetzt: () => minute(30),
        push: PUSH,
        pushVersender: versender,
        chatEreignisse,
        logStrom: new Writable({ write: (_teil, _kodierung, fertig) => fertig() }),
      },
    );
    await app.ready();
  });

  beforeEach(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.query('DELETE FROM cockpit.befund');
    await pool.query('DELETE FROM cockpit.wache');
    await kontoAnlegen('stefan', 'betreuer');
    angemeldet = { angemeldet: true, rolle: 'betreuer', zweiterFaktorAktiv: true, benutzerId: 'stefan' };
    gesendet = [];
  });

  afterAll(async () => {
    await app.close();
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.end();
  });

  async function stand(id: string): Promise<{ gesamt: number; gemeldet: boolean } | undefined> {
    const ergebnis = await pool.query<{ gesamt: number; gemeldet: boolean }>(
      'SELECT gesamt, gemeldet_am IS NOT NULL AS gemeldet FROM cockpit.posteingang_push WHERE benutzer_id = $1',
      [id],
    );
    return ergebnis.rows[0];
  }

  describe('der Takt', () => {
    it('meldet beim ersten Lauf nichts — auch wenn schon etwas da ist — und hält den Stand fest', async () => {
      await meldung('platte', minute(0));
      await posteingangPushLauf(abhaengigkeiten(), minute(0));
      await meldung('platte', minute(1));

      expect(await posteingangPushLauf(abhaengigkeiten(), minute(1))).toBe(0);
      expect(gesendet).toEqual([]);
      expect(await stand('stefan')).toMatchObject({ gemeldet: false });
    });

    it('meldet einen neuen Eintrag genau einmal, ohne Inhalt, mit der Zahl für das App-Symbol', async () => {
      await posteingangPushLauf(abhaengigkeiten(), minute(0));
      await meldung('platte', minute(1));

      expect(await posteingangPushLauf(abhaengigkeiten(), minute(2))).toBe(1);
      expect(await posteingangPushLauf(abhaengigkeiten(), minute(3))).toBe(0);

      expect(gesendet).toHaveLength(1);
      const [push] = gesendet;
      expect(push?.endpoint).toBe('https://fcm.googleapis.com/fcm/send/stefan');
      expect(JSON.parse(push?.rumpf ?? '{}')).toEqual({
        titel: 'Cockpit',
        text: 'Neue Meldung: ein Dienst braucht Aufmerksamkeit.',
        ziel: 'posteingang',
        anzahl: 1,
      });
      expect(push?.rumpf).not.toMatch(/GEHEIM|Brandt|platte/);
      expect(await stand('stefan')).toEqual({ gesamt: 1, gemeldet: true });
    });

    it('fasst mehrere Neue in einem Push zusammen', async () => {
      await posteingangPushLauf(abhaengigkeiten(), minute(0));
      await meldung('platte', minute(1));
      await meldung('zertifikat', minute(1));

      await posteingangPushLauf(abhaengigkeiten(), minute(2));

      expect(gesendet.map((push) => JSON.parse(push.rumpf).text)).toEqual(['2 neue Einträge im Posteingang.']);
    });

    it('übergeht Konten ohne zweiten Faktor, abgemeldete Abos und gelöschte Konten', async () => {
      await kontoAnlegen('ohne-faktor', 'betriebs_admin', false);
      await kontoAnlegen('abgemeldet', 'betriebs_admin');
      await pool.query(`UPDATE cockpit.push_abo SET abgemeldet_am = now() WHERE benutzer_id = 'abgemeldet'`);
      await kontoAnlegen('geloescht', 'betriebs_admin');
      await pool.query(`UPDATE cockpit."user" SET geloescht_am = now(), geloescht_von = 'stefan', geloescht_email = email, email = 'geloescht-geloescht@geloescht.invalid' WHERE id = 'geloescht'`);
      await posteingangPushLauf(abhaengigkeiten(), minute(0));
      await meldung('platte', minute(1));

      await posteingangPushLauf(abhaengigkeiten(), minute(2));

      expect(gesendet.map((push) => push.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/stefan']);
      expect(await stand('ohne-faktor')).toBeUndefined();
      expect(await stand('abgemeldet')).toBeUndefined();
      expect(await stand('geloescht')).toBeUndefined();
    });

    it('meldet eine Antwort des Assistenten nicht ein zweites Mal, nachdem sie sofort gepusht wurde', async () => {
      await posteingangPushLauf(abhaengigkeiten(), minute(0));
      const kanalId = (await assistentKanal(pool, 'stefan')).id;
      const antwort = await nachrichtAnlegen(pool, { kanalId, absenderArt: 'agent', inhalt: 'Erledigt.' });

      chatEreignisse.melden(antwort);
      await expect.poll(async () => (await stand('stefan'))?.gesamt, { timeout: 2000 }).toBe(1);

      expect(await posteingangPushLauf(abhaengigkeiten(), minute(2))).toBe(0);
      expect(gesendet.map((push) => JSON.parse(push.rumpf).ziel)).toEqual(['chat']);
    });
  });

  describe('Test-Push aus den Einstellungen', () => {
    function testPush(kopf: Record<string, string> = HERKUNFT) {
      return app.inject({ method: 'POST', url: '/push/test', headers: { ...FORMULAR_KOPF, ...kopf }, payload: '' });
    }

    it('schickt an alle eigenen Geräte und meldet es zurück; ein zweiter gleich danach geht nicht hinaus', async () => {
      const erster = await testPush();
      const zweiter = await testPush();

      expect(erster.statusCode).toBe(303);
      expect(erster.headers.location).toBe('/einstellungen?push=test');
      expect(zweiter.headers.location).toBe('/einstellungen?push=test-fehler');
      expect(gesendet).toEqual([{ endpoint: 'https://fcm.googleapis.com/fcm/send/stefan', rumpf: TEST_RUMPF }]);
    });

    it('meldet einen Fehler ohne eigenes Gerät und verlangt die Herkunft', async () => {
      await kontoAnlegen('anna', 'betrieb_mitarbeiter');
      await pool.query(`UPDATE cockpit.push_abo SET abgemeldet_am = now() WHERE benutzer_id = 'anna'`);
      angemeldet = { angemeldet: true, rolle: 'betrieb_mitarbeiter', zweiterFaktorAktiv: true, benutzerId: 'anna' };

      expect((await testPush()).headers.location).toBe('/einstellungen?push=test-fehler');
      expect((await testPush({})).statusCode).toBe(403);
      expect(gesendet).toEqual([]);
    });

    it('zeigt in den Einstellungen, wann ein Push kommt, den Knopf und das Ergebnis', async () => {
      const seite = await app.inject({ method: 'GET', url: '/einstellungen?push=test' });

      expect(seite.body).toContain('Ein Push kommt');
      expect(seite.body).toContain('action="/push/test"');
      expect(seite.body).toContain('Test-Push verschickt.');
      const fehler = await app.inject({ method: 'GET', url: '/einstellungen?push=test-fehler' });
      expect(fehler.body).toContain('Kein Gerät hat den Test-Push angenommen');
    });
  });
});
