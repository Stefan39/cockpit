/**
 * Kanäle und Nachrichten des Chats (COPI-52, Migration 0024).
 *
 * Läuft nur mit `TEST_DATABASE_URL`. Niemals gegen eine Kundendatenbank laufen lassen. Die Chat-Tabellen weisen jedes
 * DELETE ab (nie löschen, nur markieren); aufgeräumt wird deshalb per TRUNCATE, danach legt der Test den Team-Kanal der
 * Migration wieder an. Die erwarteten Werte stehen als Literale.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentAntwortNach,
  assistentKanal,
  INHALT_HOECHSTENS,
  lesestandLesen,
  lesestandSetzen,
  nachrichtAlsGeloeschtMarkieren,
  nachrichtAlsZugestelltMarkieren,
  nachrichtAnlegen,
  nachrichtenSeit,
  nachrichtLesen,
  teamKanal,
  ungeleseneZaehlen,
  verlaufLesen,
  type NeueNachricht,
} from '../src/chat/nachricht-speicher.js';
import { CHAT_TABELLEN, chatLeeren, kontenLoeschen, wieImBetrieb } from './hilfen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;

describe.skipIf(!datenbankUrl)('Chat-Speicher (echte Datenbank)', () => {
  let pool: pg.Pool;
  /** Annas Assistenten-Kanal, in jedem Test frisch. */
  let anna: number;

  async function konto(id: string): Promise<void> {
    await pool.query(
      `INSERT INTO cockpit."user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $1 || '@example.org', $1, true, now(), now())`,
      [id],
    );
  }

  function frage(teil: Partial<NeueNachricht> = {}): NeueNachricht {
    return { kanalId: anna, absenderArt: 'mensch', absenderId: 'anna', inhalt: 'Wie viele Buchungen gibt es heute?', ...teil };
  }

  function antwort(auf: number, teil: Partial<NeueNachricht> = {}): NeueNachricht {
    return { kanalId: anna, absenderArt: 'agent', inhalt: 'Heute reisen 3 Gäste an.', antwortAuf: auf, ...teil };
  }

  /** Legt `anzahl` Fragen in Annas Kanal an und liefert ihre IDs. */
  async function fragen(anzahl: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 1; i <= anzahl; i++) {
      ids.push((await nachrichtAnlegen(pool, frage({ inhalt: `Frage ${String(i)}` }))).id);
    }
    return ids;
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
  });

  beforeEach(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await konto('anna');
    await konto('bert');
    anna = (await assistentKanal(pool, 'anna')).id;
  });

  afterAll(async () => {
    await chatLeeren(pool);
    await kontenLoeschen(pool);
    await pool.end();
  });

  describe('Kanäle', () => {
    it('gibt jedem Benutzer genau einen Assistenten-Kanal, auch bei gleichzeitigen Aufrufen', async () => {
      const kanaele = await Promise.all([assistentKanal(pool, 'bert'), assistentKanal(pool, 'bert'), assistentKanal(pool, 'bert')]);

      expect(new Set(kanaele.map((k) => k.id)).size).toBe(1);
      expect(kanaele[0]).toMatchObject({ art: 'assistent', besitzerId: 'bert' });
      expect((await assistentKanal(pool, 'anna')).id).toBe(anna);
      expect(kanaele[0]?.id).not.toBe(anna);
    });

    it('hat genau einen Team-Kanal, ohne Besitzer', async () => {
      expect(await teamKanal(pool)).toMatchObject({ art: 'team', besitzerId: undefined });
      await expect(pool.query(`INSERT INTO cockpit.kanal (art) VALUES ('team')`)).rejects.toThrow('kanal_ein_team_idx');
    });

    it.each([
      ['Assistent ohne Besitzer', `INSERT INTO cockpit.kanal (art) VALUES ('assistent')`, 'kanal_besitzer_nur_beim_assistenten'],
      ['Team mit Besitzer', `INSERT INTO cockpit.kanal (art, besitzer_id) VALUES ('team', 'anna')`, 'kanal_besitzer_nur_beim_assistenten'],
      ['unbekannte Art', `INSERT INTO cockpit.kanal (art) VALUES ('vorgang')`, 'kanal_art_bekannt'],
    ])('lehnt ab: %s', async (_fall, sql, bedingung) => {
      await expect(pool.query(sql)).rejects.toThrow(bedingung);
    });
  });

  describe('nachrichtAnlegen', () => {
    it('legt eine Frage an; Zeitpunkt und ID setzt die Datenbank, dringend ist per Default aus', async () => {
      const vorher = new Date();
      const nachricht = await nachrichtAnlegen(pool, frage());

      expect(nachricht).toMatchObject({
        kanalId: anna,
        absenderArt: 'mensch',
        absenderId: 'anna',
        inhalt: 'Wie viele Buchungen gibt es heute?',
        dringend: false,
        antwortAuf: undefined,
        geloeschtAm: undefined,
      });
      expect(nachricht.id).toBeGreaterThan(0);
      expect(nachricht.erstelltAm.getTime()).toBeGreaterThanOrEqual(vorher.getTime() - 1000);
    });

    it('speichert Inhalte als Klartext, unverändert — auch HTML und Links', async () => {
      const inhalt = '<script>alert(1)</script> [hier](javascript:alert(1)) https://example.org';
      const nachricht = await nachrichtAnlegen(pool, frage({ inhalt }));

      expect((await nachrichtLesen(pool, anna, nachricht.id))?.inhalt).toBe(inhalt);
    });

    it('legt eine dringende Antwort des Koordinators auf eine Frage an', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      const a = await nachrichtAnlegen(pool, antwort(f.id, { dringend: true }));

      expect(a).toMatchObject({ absenderArt: 'agent', absenderId: undefined, dringend: true, antwortAuf: f.id });
    });

    it('lässt im Team-Kanal mehrere Menschen schreiben', async () => {
      const team = (await teamKanal(pool)).id;
      await nachrichtAnlegen(pool, frage({ kanalId: team, inhalt: 'Wer übernimmt heute?' }));
      await nachrichtAnlegen(pool, frage({ kanalId: team, absenderId: 'bert', inhalt: 'Ich.' }));

      expect((await verlaufLesen(pool, team)).map((n) => [n.absenderId, n.inhalt])).toEqual([
        ['anna', 'Wer übernimmt heute?'],
        ['bert', 'Ich.'],
      ]);
    });

    it('nimmt genau die Höchstlänge an', async () => {
      const nachricht = await nachrichtAnlegen(pool, frage({ inhalt: 'x'.repeat(INHALT_HOECHSTENS) }));
      expect(nachricht.inhalt).toHaveLength(4000);
    });

    it.each([
      ['leer', { inhalt: '' }, 'nachricht_inhalt_nicht_leer'],
      ['nur Leerraum und Zeilenumbrüche', { inhalt: '  \n\t ' }, 'nachricht_inhalt_nicht_leer'],
      ['zu lang', { inhalt: 'x'.repeat(4001) }, 'nachricht_inhalt_laenge'],
      ['dringende Frage', { dringend: true }, 'nachricht_dringend_nicht_vom_menschen'],
      ['Agent mit Absender', { absenderArt: 'agent' }, 'nachricht_absender_nur_beim_menschen'],
    ] as const)('lehnt ab: %s', async (_fall, teil, bedingung) => {
      await expect(nachrichtAnlegen(pool, frage(teil))).rejects.toThrow(bedingung);
    });

    it('lehnt einen Menschen ohne Absender ab', async () => {
      const ohne: NeueNachricht = { kanalId: anna, absenderArt: 'mensch', inhalt: 'Hallo' };
      await expect(nachrichtAnlegen(pool, ohne)).rejects.toThrow('nachricht_absender_nur_beim_menschen');
    });

    it('lehnt eine Frage mit Bezug auf eine andere Nachricht ab', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      await expect(nachrichtAnlegen(pool, frage({ antwortAuf: f.id }))).rejects.toThrow('nachricht_frage_hat_keinen_bezug');
    });

    it('lehnt eine unbekannte Absender-Art ab (direkt in der Datenbank)', async () => {
      await expect(
        pool.query(`INSERT INTO cockpit.nachricht (kanal_id, absender_art, inhalt) VALUES ($1, 'gast', 'hallo')`, [anna]),
      ).rejects.toThrow('nachricht_absender_bekannt');
    });

    it('lässt je Frage nur eine Antwort des Koordinators zu, aber weitere Meldungen des Cockpits', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      await nachrichtAnlegen(pool, antwort(f.id));

      await expect(nachrichtAnlegen(pool, antwort(f.id))).rejects.toThrow('nachricht_eine_antwort_je_frage_idx');
      await nachrichtAnlegen(pool, antwort(f.id, { absenderArt: 'system', inhalt: 'Der Assistent antwortet gerade nicht.' }));
      await nachrichtAnlegen(pool, antwort(f.id, { absenderArt: 'system', inhalt: 'Noch einmal versucht.' }));
    });
  });

  describe('nachrichtLesen', () => {
    it('liefert keine Nachricht aus einem anderen Kanal', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      const bert = (await assistentKanal(pool, 'bert')).id;

      expect(await nachrichtLesen(pool, anna, f.id)).toMatchObject({ id: f.id });
      expect(await nachrichtLesen(pool, bert, f.id)).toBeUndefined();
      expect(await nachrichtLesen(pool, anna, f.id + 1000)).toBeUndefined();
    });
  });

  describe('verlaufLesen', () => {
    it('liefert die jüngsten Nachrichten, älteste zuerst, und mit `vor` die Seite davor', async () => {
      const ids = await fragen(5);

      expect((await verlaufLesen(pool, anna, { hoechstens: 2 })).map((n) => n.inhalt)).toEqual(['Frage 4', 'Frage 5']);
      expect((await verlaufLesen(pool, anna, { vor: ids[3] ?? 0, hoechstens: 2 })).map((n) => n.inhalt)).toEqual(['Frage 2', 'Frage 3']);
      expect((await verlaufLesen(pool, anna, { vor: ids[1] ?? 0, hoechstens: 2 })).map((n) => n.inhalt)).toEqual(['Frage 1']);
    });

    it('liefert höchstens 50 je Seite, auch wenn mehr verlangt wird', async () => {
      await pool.query(
        `INSERT INTO cockpit.nachricht (kanal_id, absender_art, absender_id, inhalt)
         SELECT $1, 'mensch', 'anna', 'Frage ' || i FROM generate_series(1, 55) i`,
        [anna],
      );

      const seite = await verlaufLesen(pool, anna, { hoechstens: 500 });
      expect(seite).toHaveLength(50);
      expect(seite[0]?.inhalt).toBe('Frage 6');
      expect(seite[49]?.inhalt).toBe('Frage 55');
    });

    it('zeigt nur den Verlauf dieses Kanals', async () => {
      await nachrichtAnlegen(pool, frage({ inhalt: 'an den Assistenten' }));
      await nachrichtAnlegen(pool, frage({ kanalId: (await teamKanal(pool)).id, inhalt: 'ans Team' }));

      expect((await verlaufLesen(pool, anna)).map((n) => n.inhalt)).toEqual(['an den Assistenten']);
    });

    it('ist leer für einen neuen Kanal', async () => {
      expect(await verlaufLesen(pool, anna)).toEqual([]);
    });
  });

  describe('nachrichtenSeit', () => {
    it('liefert, was nach einer ID dazukam, älteste zuerst, nur aus diesem Kanal', async () => {
      const ids = await fragen(3);
      await nachrichtAnlegen(pool, frage({ kanalId: (await teamKanal(pool)).id, inhalt: 'ans Team' }));

      expect((await nachrichtenSeit(pool, anna, ids[0] ?? 0)).map((n) => n.inhalt)).toEqual(['Frage 2', 'Frage 3']);
      expect(await nachrichtenSeit(pool, anna, ids[2] ?? 0)).toEqual([]);
    });
  });

  describe('nie löschen, nur markieren', () => {
    it('markiert eine Nachricht: sie steht weiter im Verlauf, ohne Inhalt — im Bestand bleibt der Inhalt', async () => {
      const [erste, zweite] = await fragen(2);

      expect(await nachrichtAlsGeloeschtMarkieren(pool, anna, erste ?? 0, 'bert')).toBe('markiert');

      const verlauf = await verlaufLesen(pool, anna);
      expect(verlauf.map((n) => [n.id, n.inhalt])).toEqual([
        [erste, undefined],
        [zweite, 'Frage 2'],
      ]);
      expect(verlauf[0]?.geloeschtAm).toBeInstanceOf(Date);
      const bestand = await pool.query(`SELECT inhalt, geloescht_von FROM cockpit.nachricht WHERE id = $1`, [erste]);
      expect(bestand.rows).toEqual([{ inhalt: 'Frage 1', geloescht_von: 'bert' }]);
    });

    it('meldet eine schon markierte, eine unbekannte und eine Nachricht aus einem anderen Kanal', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      await nachrichtAlsGeloeschtMarkieren(pool, anna, f.id, 'anna');

      expect(await nachrichtAlsGeloeschtMarkieren(pool, anna, f.id, 'bert')).toBe('schon_geloescht');
      expect(await nachrichtAlsGeloeschtMarkieren(pool, anna, f.id + 1000, 'anna')).toBe('unbekannt');
      expect(await nachrichtAlsGeloeschtMarkieren(pool, (await teamKanal(pool)).id, f.id, 'anna')).toBe('unbekannt');
      const bestand = await pool.query(`SELECT geloescht_von FROM cockpit.nachricht WHERE id = $1`, [f.id]);
      expect(bestand.rows).toEqual([{ geloescht_von: 'anna' }]);
    });

    it.each(CHAT_TABELLEN)('weist jedes DELETE in %s ab', async (tabelle) => {
      const f = await nachrichtAnlegen(pool, frage());
      await lesestandSetzen(pool, 'anna', anna, f.id);
      await pool.query(
        `INSERT INTO cockpit.push_abo (benutzer_id, endpoint, schluessel_p256dh, schluessel_auth)
         VALUES ('anna', 'https://push.example.org/abc', 'BNcR', 'auth')`,
      );
      await pool.query(`INSERT INTO cockpit.chat_verbrauch (benutzer_id, tag, anzahl) VALUES ('anna', '2026-09-23', 1)`);
      await pool.query(`INSERT INTO cockpit.chat_mail (nachricht_id, benutzer_id, gesendet_am) VALUES ($1, 'anna', now())`, [f.id]);

      await expect(wieImBetrieb(pool, `DELETE FROM cockpit.${tabelle}`)).rejects.toThrow(
        `nie_loeschen: In ${tabelle} wird nie geloescht, nur als geloescht markiert`,
      );
    });

    it('lässt ein Konto mit Nachrichten nicht physisch löschen', async () => {
      await nachrichtAnlegen(pool, frage());
      // Selbst mit der Ausnahme der Testdatenbank: der Fremdschlüssel ohne CASCADE hält das Konto.
      await expect(pool.query(`DELETE FROM cockpit."user" WHERE id = 'anna'`)).rejects.toThrow('violates foreign key constraint');
    });

    it.each([
      ['Inhalt', `UPDATE cockpit.nachricht SET inhalt = 'geändert' WHERE id = $1`, 'nachricht_unveraenderlich'],
      ['dringend', `UPDATE cockpit.nachricht SET dringend = true WHERE id = $1`, 'nachricht_unveraenderlich'],
      ['Zeitpunkt', `UPDATE cockpit.nachricht SET erstellt_am = now() - interval '1 day' WHERE id = $1`, 'nachricht_unveraenderlich'],
      ['Markierung zurücknehmen', `UPDATE cockpit.nachricht SET geloescht_am = NULL, geloescht_von = NULL WHERE id = $1`, 'nachricht_geloescht_endgueltig'],
      ['Markierung umschreiben', `UPDATE cockpit.nachricht SET geloescht_von = 'bert' WHERE id = $1`, 'nachricht_geloescht_endgueltig'],
    ])('lässt nach dem Schreiben nichts ändern: %s', async (_fall, sql, fehler) => {
      const f = await nachrichtAnlegen(pool, frage());
      if (fehler === 'nachricht_geloescht_endgueltig') {
        await nachrichtAlsGeloeschtMarkieren(pool, anna, f.id, 'anna');
      }
      await expect(pool.query(sql, [f.id])).rejects.toThrow(fehler);
    });

    it('verlangt zur Markierung Zeitpunkt und Person zusammen', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      await expect(pool.query(`UPDATE cockpit.nachricht SET geloescht_am = now() WHERE id = $1`, [f.id])).rejects.toThrow(
        'nachricht_geloescht_vollstaendig',
      );
    });
  });

  describe('Quittung des Koordinators (COPI-69)', () => {
    it('setzt den Zeitpunkt einmal, lässt ihn danach stehen und ändert sonst nichts', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      const andere = await nachrichtAnlegen(pool, frage({ inhalt: 'Zweite' }));
      expect(f.zugestelltAm).toBeUndefined();

      await nachrichtAlsZugestelltMarkieren(pool, f.id);
      const erste = (await nachrichtLesen(pool, anna, f.id))?.zugestelltAm;
      expect(erste).toBeInstanceOf(Date);
      await nachrichtAlsZugestelltMarkieren(pool, f.id);

      expect((await nachrichtLesen(pool, anna, f.id))?.zugestelltAm).toEqual(erste);
      expect((await nachrichtLesen(pool, anna, andere.id))?.zugestelltAm).toBeUndefined();
    });

    it('lässt den Zeitpunkt weder zurücknehmen noch umschreiben', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      await nachrichtAlsZugestelltMarkieren(pool, f.id);

      await expect(pool.query(`UPDATE cockpit.nachricht SET zugestellt_am = NULL WHERE id = $1`, [f.id])).rejects.toThrow('nachricht_zugestellt_endgueltig');
      await expect(pool.query(`UPDATE cockpit.nachricht SET zugestellt_am = now() + interval '1 day' WHERE id = $1`, [f.id])).rejects.toThrow(
        'nachricht_zugestellt_endgueltig',
      );
    });

    it('findet eine Antwort des Koordinators nach einer ID, und den Lesestand', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      expect(await agentAntwortNach(pool, anna, f.id)).toBe(false);
      const a = await nachrichtAnlegen(pool, antwort(f.id));
      expect(await agentAntwortNach(pool, anna, f.id)).toBe(true);
      expect(await agentAntwortNach(pool, anna, a.id)).toBe(false);

      expect(await lesestandLesen(pool, 'anna', anna)).toBe(0);
      await lesestandSetzen(pool, 'anna', anna, a.id);
      expect(await lesestandLesen(pool, 'anna', anna)).toBe(a.id);
    });
  });

  describe('Lesestand', () => {
    it('zählt ohne die eigenen und ohne markierte, nur nach dem Lesestand', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      const a = await nachrichtAnlegen(pool, antwort(f.id));
      await nachrichtAnlegen(pool, antwort(f.id, { absenderArt: 'system', inhalt: 'Hinweis.' }));
      const weg = await nachrichtAnlegen(pool, antwort(f.id, { absenderArt: 'system', inhalt: 'gleich markiert' }));
      await nachrichtAlsGeloeschtMarkieren(pool, anna, weg.id, 'anna');

      expect(await ungeleseneZaehlen(pool, 'anna', anna)).toBe(2);

      await lesestandSetzen(pool, 'anna', anna, a.id);
      expect(await ungeleseneZaehlen(pool, 'anna', anna)).toBe(1);
    });

    it('führt ihn je Benutzer und Kanal: im Team-Kanal zählen die Nachrichten der anderen', async () => {
      const team = (await teamKanal(pool)).id;
      await nachrichtAnlegen(pool, frage({ kanalId: team, inhalt: 'von Anna' }));
      const b = await nachrichtAnlegen(pool, frage({ kanalId: team, absenderId: 'bert', inhalt: 'von Bert' }));

      expect(await ungeleseneZaehlen(pool, 'anna', team)).toBe(1);
      expect(await ungeleseneZaehlen(pool, 'bert', team)).toBe(1);

      await lesestandSetzen(pool, 'anna', team, b.id);
      expect(await ungeleseneZaehlen(pool, 'anna', team)).toBe(0);
      expect(await ungeleseneZaehlen(pool, 'bert', team)).toBe(1);
    });

    it('geht nur vorwärts: ein späterer, älterer Stand setzt ihn nicht zurück', async () => {
      const f = await nachrichtAnlegen(pool, frage());
      const a1 = await nachrichtAnlegen(pool, antwort(f.id, { absenderArt: 'system', inhalt: 'eins' }));
      const a2 = await nachrichtAnlegen(pool, antwort(f.id, { absenderArt: 'system', inhalt: 'zwei' }));

      await lesestandSetzen(pool, 'anna', anna, a2.id);
      await lesestandSetzen(pool, 'anna', anna, a1.id);

      expect(await ungeleseneZaehlen(pool, 'anna', anna)).toBe(0);
      const stand = await pool.query<{ bis_id: string }>(`SELECT bis_id FROM cockpit.nachricht_lesestand WHERE benutzer_id = 'anna'`);
      expect(Number(stand.rows[0]?.bis_id)).toBe(a2.id);
    });
  });

  describe('Push-Abo und Verbrauch (Regeln der Datenbank)', () => {
    const abo = (endpoint: string, p256dh = 'BNcR') =>
      pool.query(
        `INSERT INTO cockpit.push_abo (benutzer_id, endpoint, schluessel_p256dh, schluessel_auth) VALUES ('anna', $1, $2, 'auth')`,
        [endpoint, p256dh],
      );

    it.each([
      ['http statt https', 'http://push.example.org/abc', 'BNcR', 'push_abo_endpoint_https'],
      ['Schlüssel mit fremden Zeichen', 'https://push.example.org/abc', 'BN cR', 'push_abo_schluessel_form'],
    ])('lehnt ein Push-Abo ab: %s', async (_fall, endpoint, p256dh, bedingung) => {
      await expect(abo(endpoint, p256dh)).rejects.toThrow(bedingung);
    });

    it('lässt einen Endpoint nur einmal aktiv zu, nach dem Abmelden wieder', async () => {
      await abo('https://push.example.org/abc');
      await expect(abo('https://push.example.org/abc')).rejects.toThrow('push_abo_endpoint_aktiv_idx');

      await pool.query(`UPDATE cockpit.push_abo SET abgemeldet_am = now()`);
      await abo('https://push.example.org/abc');
    });

    it('lehnt einen negativen Verbrauch ab', async () => {
      await expect(
        pool.query(`INSERT INTO cockpit.chat_verbrauch (benutzer_id, tag, anzahl) VALUES ('anna', '2026-09-23', -1)`),
      ).rejects.toThrow('chat_verbrauch_anzahl_positiv');
    });
  });
});
