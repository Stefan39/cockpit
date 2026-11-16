/**
 * Konten bearbeiten (COPI-46), der ganze Weg mit echten Sitzungen je Rolle gegen die echte Datenbank.
 *
 * Sicherheitskritisch: hier kann ein Zugang andere Konten ändern, entfernen und ihren zweiten Faktor zurücksetzen. Der
 * Test hält fest, dass das nur geht, wer es darf, an wem er es darf, frisch angemeldet, von dieser Seite aus und mit
 * gültiger Bestätigung — und dass in jedem anderen Fall nichts geändert wird.
 *
 * Handelnde (Betreuer, Betriebs-Admin, Mitarbeiter) haben echte Sitzungen mit zweitem Faktor; die Konten, an denen
 * gehandelt wird, legt jeder Test frisch per SQL an.
 *
 * Läuft nur mit `TEST_DATABASE_URL` und räumt dort `cockpit."user"` und `cockpit.einladung` ab. Niemals gegen eine
 * Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Rolle } from '../src/auth/berechtigung.js';
import { wiederherstellungPruefen } from '../src/auth/entsperrung.js';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { buildApp } from '../src/server/app.js';
import { FORMULAR_KOPF, formular, kontenLoeschen, kontoEinrichten, protokollMarke, protokollSeit } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

const PASSWORT = 'ein-ausreichend-langes-passwort';
const BASIS_URL = 'http://localhost:3000';
const HERKUNFT = { host: 'localhost:3000', origin: BASIS_URL };

type Wer = 'betreuer' | 'admin' | 'mitarbeiter';
type Aktion = 'name' | 'rolle' | 'entfernen' | 'zuruecksetzen';

describe.skipIf(!datenbankUrl)('Konten bearbeiten mit echten Sitzungen je Rolle (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let einrichtung: FastifyInstance;
  const cookies: Record<Wer, string> = { betreuer: '', admin: '', mitarbeiter: '' };
  const ids: Record<Wer, string> = { betreuer: '', admin: '', mitarbeiter: '' };

  /** Ein Konto, an dem gehandelt wird: ohne Sitzung, mit Passwort (fürs Zurücksetzen). */
  async function ziel(id: string, rolle: Rolle): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", rolle, aktiviert_am)
       VALUES ($1, $1, $1 || '@example.org', true, now(), now(), $2, now())`,
      [id, rolle],
    );
    await pool.query(
      `INSERT INTO cockpit.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       VALUES ($1 || '-konto', $1, 'credential', $1, 'altes-passwort', now(), now())`,
      [id],
    );
  }

  async function zeile(id: string): Promise<{ name: string; rolle: string } | undefined> {
    const ergebnis = await pool.query<{ name: string; rolle: string }>('SELECT name, rolle FROM cockpit."user" WHERE id = $1', [id]);
    return ergebnis.rows[0];
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    auth = erzeugeAuth({ databaseUrl: datenbankUrl ?? '', basisUrl: BASIS_URL, secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge', pool });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    einrichtung = buildApp({ nodeEnv: 'test' }, { auth, pool, basisUrl: BASIS_URL });
    await app.ready();
    const rollen: Record<Wer, Rolle> = { betreuer: 'betreuer', admin: 'betriebs_admin', mitarbeiter: 'betrieb_mitarbeiter' };
    for (const wer of Object.keys(cookies) as Wer[]) {
      const konto = await kontoEinrichten(einrichtung, auth, { email: `${wer}@example.org`, passwort: PASSWORT, name: wer, mitZweitemFaktor: true });
      cookies[wer] = konto.cookie;
      ids[wer] = konto.id;
      await pool.query('UPDATE cockpit."user" SET rolle = $2 WHERE id = $1', [konto.id, rollen[wer]]);
    }
  }, 90_000);

  beforeEach(async () => {
    // Die Konten, an denen gehandelt wird, frisch; die Handelnden bleiben, frisch angemeldet.
    await pool.query(`DELETE FROM cockpit."user" WHERE id LIKE 'ziel-%'`);
    await ziel('ziel-admin', 'betriebs_admin');
    await ziel('ziel-mitarbeiter', 'betrieb_mitarbeiter');
    await pool.query(`UPDATE cockpit.session SET "createdAt" = now()`);
  });

  afterAll(async () => {
    await app.close();
    await einrichtung.close();
    await pool.query('DELETE FROM cockpit.einladung');
    await kontenLoeschen(pool);
    await pool.end();
  });

  function seite(wer: Wer, url: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: cookies[wer] } });
  }

  function senden(wer: Wer, url: string, felder: Record<string, string>, kopf: Record<string, string> = HERKUNFT) {
    return app.inject({ method: 'POST', url, headers: { ...FORMULAR_KOPF, ...kopf, cookie: cookies[wer] }, payload: formular(felder) });
  }

  /** Schritt 1: die Bestätigungsseite; gibt Bestätigung und Antwort zurück. */
  async function vorbereiten(wer: Wer, zielId: string, aktion: Aktion, wert = '') {
    const antwort = await senden(wer, `/benutzer/${zielId}/aendern`, { aktion, wert });
    const bis = /name="bis" value="(\d+)"/.exec(antwort.body)?.[1] ?? '';
    const token = /name="token" value="([A-Za-z0-9_-]{43})"/.exec(antwort.body)?.[1] ?? '';
    return { antwort, felder: { aktion, wert, bis, token } };
  }

  /** Beide Schritte, wie ein Mensch mit Formularen. */
  async function durchfuehren(wer: Wer, zielId: string, aktion: Aktion, wert = '') {
    const { felder } = await vorbereiten(wer, zielId, aktion, wert);
    return senden(wer, `/benutzer/${zielId}/bestaetigen`, felder);
  }

  function formulare(html: string): string[] {
    return [...html.matchAll(/<input type="hidden" name="aktion" value="([a-z]+)" \/>/g)].map((treffer) => treffer[1] ?? '');
  }

  describe('wer an wem was sieht', () => {
    it.each<[Wer, string, readonly string[]]>([
      ['betreuer', 'ziel-admin', ['name', 'rolle', 'zuruecksetzen', 'entfernen']],
      ['betreuer', 'ziel-mitarbeiter', ['name', 'rolle', 'zuruecksetzen', 'entfernen']],
      ['admin', 'ziel-mitarbeiter', ['name', 'zuruecksetzen', 'entfernen']],
    ])('%s an %s: die Formulare %j', async (wer, zielId, erwartet) => {
      const antwort = await seite(wer, `/benutzer/${zielId}`);

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['cache-control']).toBe('no-store');
      expect(formulare(antwort.body)).toEqual(erwartet);
    });

    it.each<[Wer, () => string]>([
      ['betreuer', () => ids.betreuer],
      ['admin', () => 'ziel-admin'],
      ['admin', () => ids.betreuer],
      ['admin', () => ids.admin],
      ['mitarbeiter', () => 'ziel-mitarbeiter'],
      ['mitarbeiter', () => ids.betreuer],
      ['betreuer', () => 'gibt-es-nicht'],
      ['betreuer', () => '..%2F..%2Fbenutzer'],
    ])('%s bekommt zu einem Konto, an dem es nichts darf, die neutrale 404 — auf jeder Route', async (wer, zielId) => {
      const id = zielId();
      const antworten = [
        await seite(wer, `/benutzer/${id}`),
        await senden(wer, `/benutzer/${id}/aendern`, { aktion: 'name', wert: 'Neu' }),
        await senden(wer, `/benutzer/${id}/bestaetigen`, { aktion: 'name', wert: 'Neu', bis: '1', token: 'A'.repeat(43) }),
      ];

      expect(antworten.map((antwort) => antwort.statusCode)).toEqual([404, 404, 404]);
      expect(antworten.every((antwort) => !antwort.body.includes('@example.org'))).toBe(true);
    });

    it('verlinkt „Bearbeiten" in der Liste nur, wo es geht: beim Admin nur an Mitarbeitern', async () => {
      const betreuer = await seite('betreuer', '/benutzer');
      const admin = await seite('admin', '/benutzer');

      const links = (html: string) => [...html.matchAll(/href="\/benutzer\/([^"]+)"/g)].map((treffer) => treffer[1]).sort();
      expect(links(betreuer.body)).toEqual([ids.admin, ids.mitarbeiter, 'ziel-admin', 'ziel-mitarbeiter'].sort());
      expect(links(admin.body)).toEqual([ids.mitarbeiter, 'ziel-mitarbeiter'].sort());
    });

    it('lässt den Admin keine Rolle vergeben, auch nicht mit einem selbstgebauten Formular', async () => {
      const antwort = await senden('admin', '/benutzer/ziel-mitarbeiter/aendern', { aktion: 'rolle', wert: 'betriebs_admin' });

      expect(antwort.statusCode).toBe(403);
      expect((await zeile('ziel-mitarbeiter'))?.rolle).toBe('betrieb_mitarbeiter');
    });

    it('lässt auch den Betreuer niemanden zum Betreuer machen', async () => {
      const antwort = await senden('betreuer', '/benutzer/ziel-admin/aendern', { aktion: 'rolle', wert: 'betreuer' });

      expect(antwort.statusCode).toBe(403);
      expect((await zeile('ziel-admin'))?.rolle).toBe('betriebs_admin');
    });
  });

  describe('ausführen', () => {
    it('ändert den Namen erst nach der Bestätigung, und protokolliert es', async () => {
      const { antwort } = await vorbereiten('betreuer', 'ziel-mitarbeiter', 'name', '  Lena Neu  ');
      expect(antwort.statusCode).toBe(200);
      expect(antwort.body).toContain('„Lena Neu"');
      expect((await zeile('ziel-mitarbeiter'))?.name).toBe('ziel-mitarbeiter');
      const marke = await protokollMarke(pool);

      const bestaetigt = await durchfuehren('betreuer', 'ziel-mitarbeiter', 'name', 'Lena Neu');

      expect(bestaetigt.statusCode).toBe(303);
      expect(bestaetigt.headers.location).toBe('/benutzer/ziel-mitarbeiter?erledigt=name');
      expect((await zeile('ziel-mitarbeiter'))?.name).toBe('Lena Neu');
      expect(await protokollSeit(pool, marke)).toEqual([{ art: 'name_geaendert', akteur: ids.betreuer, ziel: 'ziel-mitarbeiter', einzelheiten: {} }]);
      expect((await seite('betreuer', '/benutzer/ziel-mitarbeiter?erledigt=name')).body).toContain('Der Name ist geändert.');
    });

    it('weist einen zu kurzen Namen ab, ohne etwas zu ändern', async () => {
      const antwort = await senden('admin', '/benutzer/ziel-mitarbeiter/aendern', { aktion: 'name', wert: ' x ' });

      expect(antwort.statusCode).toBe(400);
      expect(antwort.body).toContain('Bitte einen Namen mit 2 bis 100 Zeichen angeben.');
      expect((await zeile('ziel-mitarbeiter'))?.name).toBe('ziel-mitarbeiter');
    });

    it('lässt den Betreuer die Rolle wechseln, mit von/an im Protokoll', async () => {
      const marke = await protokollMarke(pool);

      const antwort = await durchfuehren('betreuer', 'ziel-admin', 'rolle', 'betrieb_mitarbeiter');

      expect(antwort.statusCode).toBe(303);
      expect((await zeile('ziel-admin'))?.rolle).toBe('betrieb_mitarbeiter');
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'rolle_geaendert', akteur: ids.betreuer, ziel: 'ziel-admin', einzelheiten: { von: 'betriebs_admin', an: 'betrieb_mitarbeiter' } },
      ]);
    });

    it('lässt den Admin einen Mitarbeiter entfernen und meldet es auf der Seite Benutzer', async () => {
      const antwort = await durchfuehren('admin', 'ziel-mitarbeiter', 'entfernen');

      expect(antwort.statusCode).toBe(303);
      expect(antwort.headers.location).toBe('/benutzer?entfernt=1');
      // Nie physisch gelöscht (COPI-62): die Zeile bleibt, als gelöscht markiert, und die Übersicht zeigt sie nicht mehr.
      const markiert = await pool.query(`SELECT geloescht_am IS NOT NULL AS geloescht FROM cockpit."user" WHERE id = 'ziel-mitarbeiter'`);
      expect(markiert.rows).toEqual([{ geloescht: true }]);
      const uebersicht = (await seite('admin', '/benutzer?entfernt=1')).body;
      expect(uebersicht).toContain('Das Konto ist entfernt.');
      expect(uebersicht).not.toContain('ziel-mitarbeiter');
      expect((await seite('admin', '/benutzer/ziel-mitarbeiter')).statusCode).toBe(404);
    });

    it('setzt den zweiten Faktor zurück und zeigt den Link genau einmal — und der Link öffnet die Wiederherstellung', async () => {
      const marke = await protokollMarke(pool);

      const antwort = await durchfuehren('betreuer', 'ziel-admin', 'zuruecksetzen');

      expect(antwort.statusCode).toBe(200);
      expect(antwort.headers['cache-control']).toBe('no-store');
      expect(antwort.body).toContain('Er ist 3 Stunden gültig und wird nur jetzt angezeigt.');
      const token = /http:\/\/localhost:3000\/zugang-wiederherstellen\/([A-Za-z0-9_-]+)/.exec(antwort.body)?.[1] ?? '';
      expect(await wiederherstellungPruefen(pool, token)).toMatchObject({ gueltig: true, email: 'ziel-admin@example.org' });
      expect((await app.inject({ method: 'GET', url: `/zugang-wiederherstellen/${token}` })).statusCode).toBe(200);
      expect(await protokollSeit(pool, marke)).toEqual([
        { art: 'konto_entsperrt', akteur: ids.betreuer, ziel: 'ziel-admin', einzelheiten: { rolle: 'betriebs_admin', weg: 'oberflaeche' } },
      ]);
      // Die Seite des Kontos zeigt den Link nicht noch einmal.
      expect((await seite('betreuer', '/benutzer/ziel-admin')).body).not.toContain(token);
    });
  });

  describe('was nichts ändert', () => {
    it('ohne frische Anmeldung: keine Formulare, und ein POST — auch mit gültiger Bestätigung — ändert nichts', async () => {
      const { felder } = await vorbereiten('betreuer', 'ziel-mitarbeiter', 'entfernen');
      await pool.query(`UPDATE cockpit.session SET "createdAt" = now() - interval '16 minutes' WHERE "userId" = $1`, [ids.betreuer]);

      const seiteAlt = await seite('betreuer', '/benutzer/ziel-mitarbeiter');
      const schritt1 = await senden('betreuer', '/benutzer/ziel-mitarbeiter/aendern', { aktion: 'entfernen', wert: '' });
      const schritt2 = await senden('betreuer', '/benutzer/ziel-mitarbeiter/bestaetigen', felder);

      expect(formulare(seiteAlt.body)).toEqual([]);
      expect(seiteAlt.body).toContain('Abmelden und neu anmelden');
      expect([schritt1.statusCode, schritt2.statusCode]).toEqual([403, 403]);
      expect(schritt2.body).toContain('älter als 15 Minuten');
      expect(await zeile('ziel-mitarbeiter')).toBeDefined();
    });

    it.each([
      ['fremder Herkunft', { host: 'localhost:3000', origin: 'https://nachbar.example.com' }],
      ['ohne Herkunft', { host: 'localhost:3000' }],
    ])('mit %s: 403, nichts geändert', async (_name, kopf) => {
      const { felder } = await vorbereiten('betreuer', 'ziel-mitarbeiter', 'entfernen');

      const antwort = await senden('betreuer', '/benutzer/ziel-mitarbeiter/bestaetigen', felder, kopf);

      expect(antwort.statusCode).toBe(403);
      expect(await zeile('ziel-mitarbeiter')).toBeDefined();
    });

    it('mit einem nachträglich geänderten Wert: die Bestätigung passt nicht mehr', async () => {
      const { felder } = await vorbereiten('betreuer', 'ziel-mitarbeiter', 'name', 'Anna');

      const antwort = await senden('betreuer', '/benutzer/ziel-mitarbeiter/bestaetigen', { ...felder, wert: 'Mallory' });

      expect(antwort.statusCode).toBe(403);
      expect((await zeile('ziel-mitarbeiter'))?.name).toBe('ziel-mitarbeiter');
    });

    it('mit der Bestätigung für ein anderes Konto oder eine andere Aktion', async () => {
      const { felder } = await vorbereiten('betreuer', 'ziel-mitarbeiter', 'name', 'Anna');

      const anderesKonto = await senden('betreuer', '/benutzer/ziel-admin/bestaetigen', felder);
      const andereAktion = await senden('betreuer', '/benutzer/ziel-mitarbeiter/bestaetigen', { ...felder, aktion: 'entfernen', wert: '' });

      expect([anderesKonto.statusCode, andereAktion.statusCode]).toEqual([403, 403]);
      expect((await zeile('ziel-admin'))?.name).toBe('ziel-admin');
      expect(await zeile('ziel-mitarbeiter')).toBeDefined();
    });

    it('mit der Bestätigung eines anderen Handelnden', async () => {
      const { felder } = await vorbereiten('betreuer', 'ziel-mitarbeiter', 'entfernen');

      const antwort = await senden('admin', '/benutzer/ziel-mitarbeiter/bestaetigen', felder);

      expect(antwort.statusCode).toBe(403);
      expect(await zeile('ziel-mitarbeiter')).toBeDefined();
    });

    it('wenn das Konto zwischen Bestätigung und Ausführung über den Handelnden hinaus befördert wurde', async () => {
      const { felder } = await vorbereiten('admin', 'ziel-mitarbeiter', 'entfernen');
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betriebs_admin' WHERE id = 'ziel-mitarbeiter'`);

      const antwort = await senden('admin', '/benutzer/ziel-mitarbeiter/bestaetigen', felder);

      expect(antwort.statusCode).toBe(404);
      expect(await zeile('ziel-mitarbeiter')).toBeDefined();
    });

    it('wenn der Handelnde inzwischen herabgestuft wurde: die Rolle kommt aus der Datenbank', async () => {
      const { felder } = await vorbereiten('admin', 'ziel-mitarbeiter', 'entfernen');
      await pool.query(`UPDATE cockpit."user" SET rolle = 'betrieb_mitarbeiter' WHERE id = $1`, [ids.admin]);
      try {
        const antwort = await senden('admin', '/benutzer/ziel-mitarbeiter/bestaetigen', felder);

        expect(antwort.statusCode).toBe(404);
        expect(await zeile('ziel-mitarbeiter')).toBeDefined();
      } finally {
        await pool.query(`UPDATE cockpit."user" SET rolle = 'betriebs_admin' WHERE id = $1`, [ids.admin]);
      }
    });
  });
});
