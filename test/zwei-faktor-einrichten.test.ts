/**
 * Die Einrichtungsseite für den zweiten Faktor zeigt das Geheimnis als
 * QR-Code (COPI-15) — nicht mehr als Text zum Abtippen.
 *
 * Läuft nur mit `TEST_DATABASE_URL` (echtes Better Auth, echte Datenbank) und räumt
 * dort `cockpit."user"` ab. Niemals gegen eine Kundendatenbank laufen lassen.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erzeugeAuth, type CockpitAuth } from '../src/auth/konfiguration.js';
import { buildApp } from '../src/server/app.js';
import { geheimnisAusUri } from '../src/server/routes/zwei-faktor.js';
import {
  formular,
  FORMULAR_KOPF,
  kontenLoeschen,
  kontoEinrichten,
  protokollMarke,
  protokollSeit,
  totpCode,
} from './hilfen.js';
import { enthaeltQrCode, qrAusSeiteLesen } from './qr-lesen.js';
import { testDatenbankUrl } from './testdatenbank.js';

const datenbankUrl = testDatenbankUrl;
const PASSWORT = 'ein-ausreichend-langes-passwort';

const SCHLUESSEL_FELD = 'einrichtungsschluessel';
const ADRESSE_FELD = 'einrichtungsadresse';

const HTML_ENTITAETEN: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

/** Ein `<input>` der Seite: roher Tag, Attributteil und dekodierter Wert. */
function eingabefeld(html: string, id: string): { roh: string; attribute: string; value: string } {
  const roh = new RegExp(`<input[^>]*\\sid="${id}"[^>]*>`).exec(html)?.[0];
  if (!roh) {
    throw new Error(`Kein Eingabefeld mit id="${id}"`);
  }
  const wert = /\svalue="([^"]*)"/.exec(roh)?.[1] ?? '';
  return {
    roh,
    attribute: roh,
    value: wert.replace(/&(amp|quot|#39|lt|gt);/g, (e) => HTML_ENTITAETEN[e] ?? e),
  };
}

/** Die Seite ohne alle `<form>`-Blöcke. */
function ausserhalbVonFormularen(html: string): string {
  return html.replace(/<form[\s\S]*?<\/form>/g, '');
}

describe.skipIf(!datenbankUrl)('TOTP-Einrichtung mit QR-Code (echte Datenbank)', () => {
  let pool: pg.Pool;
  let auth: CockpitAuth;
  let app: FastifyInstance;
  let cookie = '';
  let einrichtung: Awaited<ReturnType<FastifyInstance['inject']>>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: datenbankUrl });
    await kontenLoeschen(pool);
    auth = erzeugeAuth({
      databaseUrl: datenbankUrl ?? '',
      basisUrl: 'http://localhost:3000',
      secret: 'test-geheimnis-mit-mehr-als-32-zeichen-laenge',
      pool,
    });
    app = buildApp({ nodeEnv: 'test' }, { auth, pool });

    const konto = await kontoEinrichten(app, auth, {
      email: 'qr@example.org',
      passwort: PASSWORT,
      name: 'QR-Test',
      mitZweitemFaktor: false,
    });
    cookie = konto.cookie;
    einrichtung = await app.inject({
      method: 'POST',
      url: '/zwei-faktor/einrichten',
      headers: { ...FORMULAR_KOPF, cookie },
      payload: formular({ passwort: PASSWORT }),
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('zeigt einen QR-Code, der die Einrichtungs-Adresse der Authenticator-App enthält', () => {
    expect(einrichtung.statusCode).toBe(200);

    const uri = qrAusSeiteLesen(einrichtung.body);

    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(geheimnisAusUri(uri)).not.toBe('');
  });

  describe('kopierbare Text-Alternative (COPI-16)', () => {
    it('zeigt den Einrichtungsschlüssel als schreibgeschütztes Feld, gleich dem Geheimnis im QR-Code', () => {
      const feld = eingabefeld(einrichtung.body, SCHLUESSEL_FELD);

      expect(feld.value).toBe(geheimnisAusUri(qrAusSeiteLesen(einrichtung.body)));
      // Gültiges base32 ohne Leer- oder Trennzeichen, damit es sich unverändert einfügen lässt.
      expect(feld.value).toMatch(/^[A-Z2-7]+=*$/);
    });

    it('zeigt die vollständige Adresse als schreibgeschütztes Feld, gleich dem Inhalt des QR-Codes', () => {
      const feld = eingabefeld(einrichtung.body, ADRESSE_FELD);

      expect(feld.value).toBe(qrAusSeiteLesen(einrichtung.body));
    });

    it.each([SCHLUESSEL_FELD, ADRESSE_FELD])(
      'Feld %s ist beschriftet, schreibgeschützt und wird weder gespeichert noch abgeschickt',
      (id) => {
        const feld = eingabefeld(einrichtung.body, id);

        expect(einrichtung.body).toMatch(new RegExp(`<label for="${id}">[^<]+</label>`));
        expect(feld.attribute).toMatch(/\sreadonly(\s|>|\/)/);
        expect(feld.attribute).toContain('autocomplete="off"');
        expect(feld.attribute).toContain('spellcheck="false"');
        // Ohne `name` und außerhalb jedes Formulars: der Browser schickt das
        // Geheimnis mit keinem Formular mit.
        expect(feld.attribute).not.toMatch(/\sname=/);
        expect(ausserhalbVonFormularen(einrichtung.body)).toContain(`id="${id}"`);
      },
    );

    it('führt Geheimnis und Adresse ausschließlich in diesen beiden Feldern', () => {
      const geheimnis = geheimnisAusUri(qrAusSeiteLesen(einrichtung.body));
      const ohneFelder = einrichtung.body
        .replace(eingabefeld(einrichtung.body, SCHLUESSEL_FELD).roh, '')
        .replace(eingabefeld(einrichtung.body, ADRESSE_FELD).roh, '');

      expect(ohneFelder).not.toContain(geheimnis);
      expect(ohneFelder).not.toContain('otpauth');
    });
  });

  it('zeigt die Ersatzcodes weiterhin an', () => {
    expect(einrichtung.body).toContain('Ersatzcodes');
    expect(einrichtung.body.match(/<li><code>/g)?.length).toBeGreaterThan(0);
  });

  it('verbietet das Zwischenspeichern der Seite mit dem Geheimnis', () => {
    expect(String(einrichtung.headers['cache-control'])).toContain('no-store');
  });

  it('zeigt bei falschem Passwort weder QR-Code noch Adresse', async () => {
    const abgelehnt = await app.inject({
      method: 'POST',
      url: '/zwei-faktor/einrichten',
      headers: { ...FORMULAR_KOPF, cookie },
      payload: formular({ passwort: 'ein-falsches-passwort' }),
    });

    expect(abgelehnt.statusCode).toBe(400);
    expect(enthaeltQrCode(abgelehnt.body)).toBe(false);
    expect(abgelehnt.body).not.toContain('otpauth://');
  });

  it('schaltet den zweiten Faktor mit dem Geheimnis aus dem QR-Code scharf', async () => {
    // `kontoEinrichten` liest das Geheimnis wie ein Telefon aus dem QR-Code und
    // bestätigt mit einem daraus berechneten Code.
    const konto = await kontoEinrichten(app, auth, {
      email: 'qr-komplett@example.org',
      passwort: PASSWORT,
      name: 'QR-Komplett',
      mitZweitemFaktor: true,
    });

    const seite = await app.inject({
      method: 'GET',
      url: '/zwei-faktor',
      headers: { cookie: konto.cookie },
    });

    // Aktiver zweiter Faktor: die Einrichtungsseite schickt zurück zur Übersicht.
    expect(seite.statusCode).toBe(303);
    expect(seite.headers.location).toBe('/');
  });
  describe('Protokoll (COPI-23)', () => {
    it('hält die erste Aktivierung des zweiten Faktors genau einmal fest, weitere Prüfungen nicht', async () => {
      const marke = await protokollMarke(pool);

      // Legt das Konto direkt an (kein Eintrag dafür) und richtet den Faktor
      // über die Seiten ein: Passwort bestätigen, Code aus dem QR-Code prüfen.
      const konto = await kontoEinrichten(app, auth, {
        email: 'qr-protokoll@example.org',
        passwort: PASSWORT,
        name: 'QR-Protokoll',
        mitZweitemFaktor: true,
      });

      expect(await protokollSeit(pool, marke)).toEqual([
        {
          art: 'zweiter_faktor_eingerichtet',
          akteur: konto.id,
          ziel: null,
          einzelheiten: { faktor: 'totp' },
        },
      ]);

      // Eine erneute Prüfung mit gültigem Code ist keine neue Einrichtung.
      const marke2 = await protokollMarke(pool);
      await app.inject({
        method: 'POST',
        url: '/zwei-faktor/pruefen',
        headers: { ...FORMULAR_KOPF, cookie: konto.cookie },
        payload: formular({ code: await totpCode(auth, konto.geheimnis) }),
      });
      expect(await protokollSeit(pool, marke2)).toEqual([]);
    });

    it('schreibt bei einem falschen Code nichts', async () => {
      const marke = await protokollMarke(pool);

      const abgelehnt = await app.inject({
        method: 'POST',
        url: '/zwei-faktor/pruefen',
        headers: { ...FORMULAR_KOPF, cookie },
        payload: formular({ code: '000000' }),
      });

      expect(abgelehnt.statusCode).toBe(400);
      expect(await protokollSeit(pool, marke)).toEqual([]);
    });
  });
});
