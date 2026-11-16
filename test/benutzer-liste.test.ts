/**
 * Die Seite Benutzer (COPI-45) — reine Funktionen: Stand eines Kontos, zweiter Faktor in Betriebssprache, Reihenfolge,
 * „Sie", zuletzt angemeldet, offene Einladungen. Der Zeitpunkt ist ein Parameter.
 */
import { describe, expect, it } from 'vitest';
import { benutzerListe, faktorText, kontoStand, type EinladungDaten, type KontoDaten } from '../src/auth/benutzer-liste.js';

const JETZT = new Date('2026-09-22T12:00:00.000Z');
const vor = (sekunden: number): Date => new Date(JETZT.getTime() - sekunden * 1000);
const STUNDE = 3600;

function konto(teil: Partial<KontoDaten> = {}): KontoDaten {
  return {
    id: 'konto-1',
    name: 'Anna',
    email: 'anna@example.org',
    rolle: 'betrieb_mitarbeiter',
    zweiterFaktorAktiv: true,
    passkeys: 1,
    totp: false,
    angelegtAm: vor(10 * 86_400),
    aktiviertAm: vor(10 * 86_400),
    zuletztAngemeldet: vor(2 * STUNDE),
    ...teil,
  };
}

function einladung(teil: Partial<EinladungDaten> = {}): EinladungDaten {
  return { email: 'neu@example.org', rolle: 'betrieb_mitarbeiter', eingeladenVon: 'Stefan', ablaufAm: new Date(JETZT.getTime() + 2 * STUNDE * 1000), ...teil };
}

describe('kontoStand', () => {
  it('nennt ein Konto mit zweitem Faktor aktiv', () => {
    expect(kontoStand(konto(), JETZT)).toEqual({ text: 'aktiv', farbe: 'gruen', hinweis: undefined });
  });

  it('nennt ein Konto ohne zweiten Faktor, das nie aktiv war, „Einrichtung offen" und sagt, wann es verfällt (72 h)', () => {
    const stand = kontoStand(konto({ zweiterFaktorAktiv: false, aktiviertAm: undefined, angelegtAm: vor(70 * STUNDE) }), JETZT);

    expect(stand).toEqual({ text: 'Einrichtung offen', farbe: 'gelb', hinweis: 'verfällt in 2 Stunden' });
  });

  it('sagt „in weniger als einer Minute", wenn die Frist schon um ist: das Aufräumen läuft alle 15 Minuten', () => {
    const stand = kontoStand(konto({ zweiterFaktorAktiv: false, aktiviertAm: undefined, angelegtAm: vor(73 * STUNDE) }), JETZT);

    expect(stand.hinweis).toBe('verfällt in weniger als einer Minute');
  });

  it('nennt ein entsperrtes Konto „wird wiederhergestellt": es war aktiv und verfällt nicht', () => {
    const stand = kontoStand(konto({ zweiterFaktorAktiv: false, passkeys: 0, aktiviertAm: vor(5 * 86_400) }), JETZT);

    expect(stand).toEqual({ text: 'wird wiederhergestellt', farbe: 'gelb', hinweis: 'Zweiter Faktor wird neu eingerichtet' });
  });
});

describe('faktorText', () => {
  it.each([
    [0, false, 'keiner'],
    [1, false, 'Passkey'],
    [3, false, '3 Passkeys'],
    [0, true, 'Authenticator-App'],
    [1, true, 'Passkey und Authenticator-App'],
    [2, true, '2 Passkeys und Authenticator-App'],
  ])('nennt %i Passkeys und TOTP %s „%s"', (passkeys, totp, text) => {
    expect(faktorText({ passkeys, totp })).toBe(text);
  });
});

describe('benutzerListe — Konten', () => {
  it('ordnet nach Rolle (Betreuer, Betriebs-Admin, Mitarbeiter, unbekannt), darin nach Name', () => {
    const { konten } = benutzerListe(
      {
        konten: [
          konto({ id: 'm2', name: 'Zoe', rolle: 'betrieb_mitarbeiter' }),
          konto({ id: 'x', name: 'Aaron', rolle: 'irgendwas' }),
          konto({ id: 'a', name: 'Bernd', rolle: 'betriebs_admin' }),
          konto({ id: 'b', name: 'Stefan', rolle: 'betreuer' }),
          konto({ id: 'm1', name: 'Änne', rolle: 'betrieb_mitarbeiter' }),
        ],
        einladungen: [],
        selbstId: undefined,
      },
      JETZT,
    );

    expect(konten.map((zeile) => [zeile.name, zeile.rolle])).toEqual([
      ['Stefan', 'Betreuer'],
      ['Bernd', 'Betriebs-Admin'],
      ['Änne', 'Mitarbeiter'],
      ['Zoe', 'Mitarbeiter'],
      ['Aaron', 'unbekannte Rolle'],
    ]);
  });

  it('markiert das eigene Konto mit „Sie" und nur dieses', () => {
    const { konten } = benutzerListe({ konten: [konto({ id: 'a', name: 'A' }), konto({ id: 'b', name: 'B' })], einladungen: [], selbstId: 'b' }, JETZT);

    expect(konten.map((zeile) => [zeile.name, zeile.selbst])).toEqual([
      ['A', false],
      ['B', true],
    ]);
  });

  it('zeigt angelegt und zuletzt angemeldet als „vor …", ohne Anmeldung „noch nie"', () => {
    const { konten } = benutzerListe(
      { konten: [konto({ name: 'A' }), konto({ name: 'B', zuletztAngemeldet: undefined })], einladungen: [], selbstId: undefined },
      JETZT,
    );

    expect(konten.map((zeile) => [zeile.angelegt, zeile.zuletzt])).toEqual([
      ['vor 10 Tagen', 'vor 2 Stunden'],
      ['vor 10 Tagen', 'noch nie'],
    ]);
  });

  it('sagt „gerade eben", wenn die Uhr zurückgesprungen ist', () => {
    const spaeter = new Date(JETZT.getTime() + 60_000);
    const { konten } = benutzerListe({ konten: [konto({ angelegtAm: spaeter, zuletztAngemeldet: spaeter })], einladungen: [], selbstId: undefined }, JETZT);

    expect([konten[0]?.angelegt, konten[0]?.zuletzt]).toEqual(['gerade eben', 'gerade eben']);
  });

  it('gibt jeder Zeile genau die Felder der Seite: keine Kennung, kein Geheimnis', () => {
    const { konten } = benutzerListe({ konten: [konto()], einladungen: [], selbstId: undefined }, JETZT);

    expect(Object.keys(konten[0] ?? {}).sort()).toEqual(['angelegt', 'bearbeiten', 'email', 'faktor', 'name', 'rolle', 'selbst', 'stand', 'zuletzt']);
  });

  it('verlinkt das Bearbeiten nur bei Konten, die der Ansehende bearbeiten darf (COPI-46)', () => {
    const { konten } = benutzerListe(
      { konten: [konto({ id: 'a', name: 'A' }), konto({ id: 'b/c', name: 'B' })], einladungen: [], selbstId: undefined, bearbeitbar: (k) => k.id !== 'a' },
      JETZT,
    );

    expect(konten.map((zeile) => zeile.bearbeiten)).toEqual([undefined, '/benutzer/b%2Fc']);
  });
});

describe('benutzerListe — offene Einladungen', () => {
  it('ordnet nach Ablauf, nennt Rolle, wer eingeladen hat und wann sie abläuft', () => {
    const { einladungen } = benutzerListe(
      {
        konten: [],
        einladungen: [
          einladung({ email: 'spaet@example.org', ablaufAm: new Date(JETZT.getTime() + 2 * STUNDE * 1000) }),
          einladung({ email: 'bald@example.org', rolle: 'betriebs_admin', ablaufAm: new Date(JETZT.getTime() + 20 * 60_000) }),
        ],
        selbstId: undefined,
      },
      JETZT,
    );

    expect(einladungen).toEqual([
      { email: 'bald@example.org', rolle: 'Betriebs-Admin', von: 'Stefan', ablauf: 'läuft ab in 20 Minuten' },
      { email: 'spaet@example.org', rolle: 'Mitarbeiter', von: 'Stefan', ablauf: 'läuft ab in 2 Stunden' },
    ]);
  });

  it('sagt, wenn das einladende Konto nicht mehr besteht, statt einen Namen zu erfinden', () => {
    const { einladungen } = benutzerListe({ konten: [], einladungen: [einladung({ eingeladenVon: undefined })], selbstId: undefined }, JETZT);

    expect(einladungen[0]?.von).toBe('ein nicht mehr bestehendes Konto');
  });
});
