/**
 * Wer an wem was bearbeiten darf (COPI-46) — die reine Regel, ohne Datenbank: jede Kombination aus handelnder Rolle,
 * Rolle des Ziels und Aktion, dazu die frische Anmeldung.
 */
import { describe, expect, it } from 'vitest';
import { ALLE_ROLLEN, hatRecht, OHNE_ZUGANG, type Rolle, type Zugang } from '../src/auth/berechtigung.js';
import {
  BEARBEITEN_AKTIONEN,
  erlaubteAktionen,
  frischAngemeldet,
  FRISCH_MS,
  istBearbeitenAktion,
  vergebbareRollenFuer,
} from '../src/auth/benutzer-bearbeiten.js';

const JETZT = new Date('2026-09-22T12:00:00.000Z');

function akteur(rolle: Rolle | undefined, teil: Partial<Zugang> = {}): Zugang {
  return { angemeldet: true, rolle, zweiterFaktorAktiv: true, benutzerId: 'ich', angemeldetSeit: JETZT, ...teil };
}

const ziel = (rolle: string, id = 'anderes-konto') => ({ id, rolle });

describe('erlaubteAktionen — die Matrix', () => {
  const ALLES = [...BEARBEITEN_AKTIONEN];
  const OHNE_ROLLE = ALLES.filter((aktion) => aktion !== 'rolle');

  it.each<[Rolle, string, readonly string[]]>([
    ['betreuer', 'betreuer', []],
    ['betreuer', 'betriebs_admin', ALLES],
    ['betreuer', 'betrieb_mitarbeiter', ALLES],
    ['betriebs_admin', 'betreuer', []],
    ['betriebs_admin', 'betriebs_admin', []],
    ['betriebs_admin', 'betrieb_mitarbeiter', OHNE_ROLLE],
    ['betrieb_mitarbeiter', 'betreuer', []],
    ['betrieb_mitarbeiter', 'betriebs_admin', []],
    ['betrieb_mitarbeiter', 'betrieb_mitarbeiter', []],
  ])('%s an %s: %j', (wer, an, erwartet) => {
    expect(erlaubteAktionen(akteur(wer), ziel(an))).toEqual(erwartet);
  });

  it.each(ALLE_ROLLEN)('lässt %s am eigenen Konto nichts tun, auch wenn die Rolle darunter läge', (rolle) => {
    expect(erlaubteAktionen(akteur(rolle), ziel('betrieb_mitarbeiter', 'ich'))).toEqual([]);
  });

  it('lässt an einem Konto mit unbekannter Rolle nichts zu', () => {
    expect(erlaubteAktionen(akteur('betreuer'), ziel('irgendwas'))).toEqual([]);
    expect(erlaubteAktionen(akteur('betreuer'), ziel(''))).toEqual([]);
  });

  it('lässt einen Zugang mit unbekannter oder ohne Rolle nichts tun', () => {
    expect(erlaubteAktionen(akteur(undefined), ziel('betrieb_mitarbeiter'))).toEqual([]);
    expect(erlaubteAktionen(akteur('irgendwas' as Rolle), ziel('betrieb_mitarbeiter'))).toEqual([]);
  });

  it('lässt ohne Anmeldung, ohne zweiten Faktor oder ohne eigene Kennung nichts zu, auch den Betreuer nicht', () => {
    expect(erlaubteAktionen(OHNE_ZUGANG, ziel('betrieb_mitarbeiter'))).toEqual([]);
    expect(erlaubteAktionen(akteur('betreuer', { angemeldet: false }), ziel('betrieb_mitarbeiter'))).toEqual([]);
    expect(erlaubteAktionen(akteur('betreuer', { zweiterFaktorAktiv: false }), ziel('betrieb_mitarbeiter'))).toEqual([]);
    expect(erlaubteAktionen(akteur('betreuer', { benutzerId: undefined }), ziel('betrieb_mitarbeiter'))).toEqual([]);
  });
});

describe('vergebbareRollenFuer', () => {
  it('lässt den Betreuer einen Admin zum Mitarbeiter machen und umgekehrt — nie zum Betreuer', () => {
    expect(vergebbareRollenFuer(akteur('betreuer'), ziel('betriebs_admin'))).toEqual(['betrieb_mitarbeiter']);
    expect(vergebbareRollenFuer(akteur('betreuer'), ziel('betrieb_mitarbeiter'))).toEqual(['betriebs_admin']);
  });

  it('gibt dem Betriebs-Admin keine Rolle zu vergeben', () => {
    expect(vergebbareRollenFuer(akteur('betriebs_admin'), ziel('betrieb_mitarbeiter'))).toEqual([]);
  });

  it('gibt am Betreuer-Konto und am eigenen nichts zu vergeben', () => {
    expect(vergebbareRollenFuer(akteur('betreuer'), ziel('betreuer'))).toEqual([]);
    expect(vergebbareRollenFuer(akteur('betreuer'), ziel('betriebs_admin', 'ich'))).toEqual([]);
  });
});

describe('Rechte', () => {
  it.each<[Rolle, boolean, boolean]>([
    ['betreuer', true, true],
    ['betriebs_admin', true, false],
    ['betrieb_mitarbeiter', false, false],
  ])('%s: benutzer_bearbeiten %s, rollen_aendern %s', (rolle, bearbeiten, rollen) => {
    expect(hatRecht(akteur(rolle), 'benutzer_bearbeiten')).toBe(bearbeiten);
    expect(hatRecht(akteur(rolle), 'rollen_aendern')).toBe(rollen);
  });
});

describe('frischAngemeldet', () => {
  it.each([
    ['gerade angemeldet', 0, true],
    ['vor genau 15 Minuten', FRISCH_MS, true],
    ['vor 15 Minuten und einer Millisekunde', FRISCH_MS + 1, false],
    ['vor einer Stunde', 60 * 60_000, false],
    ['angeblich in der Zukunft', -1000, false],
  ])('%s: %s', (_name, alterMs, erwartet) => {
    expect(frischAngemeldet(akteur('betreuer', { angemeldetSeit: new Date(JETZT.getTime() - alterMs) }), JETZT)).toBe(erwartet);
  });

  it('ist ohne Zeitpunkt der Anmeldung nie frisch', () => {
    const ohneZeitpunkt: Zugang = { angemeldet: true, rolle: 'betreuer', zweiterFaktorAktiv: true, benutzerId: 'ich' };

    expect(frischAngemeldet(ohneZeitpunkt, JETZT)).toBe(false);
  });
});

describe('istBearbeitenAktion', () => {
  it.each([...BEARBEITEN_AKTIONEN])('%s ist gültig', (aktion) => {
    expect(istBearbeitenAktion(aktion)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['andere Schreibweise', 'Name'],
    ['leerer Text', ''],
    ['unbekannte Aktion', 'loeschen'],
    ['Zahl', 1],
    ['undefined', undefined],
  ])('%s ist ungültig', (_beschreibung, wert) => {
    expect(istBearbeitenAktion(wert)).toBe(false);
  });
});
