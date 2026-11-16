/**
 * Die reinen Regeln der eigenen Ratenbegrenzung (COPI-13) — ohne Datenbank.
 *
 * Die Zählerarbeit selbst steckt in einer einzelnen atomaren SQL-Anweisung und
 * wird in `test/ratenbegrenzung-datenbank.test.ts` gegen eine echte PostgreSQL
 * geprüft. Hier stehen nur die Festlegungen, die ohne Speicher gelten.
 */
import { describe, expect, it } from 'vitest';
import {
  ANMELDE_FENSTER_MS,
  ANMELDE_SPERRE_MS,
  grenzeFuer,
  istGesperrt,
} from '../src/auth/ratenbegrenzung.js';

const JETZT = new Date('2026-09-19T12:00:00.000Z');

describe('Grenzen', () => {
  it('erlaubt am Passwortschritt fünf Fehlversuche je Adresse', () => {
    expect(grenzeFuer('passwort-email')).toBe(5);
  });

  it('erlaubt je IP mehr als je Adresse — sonst sperrt ein Büro sich selbst aus', () => {
    expect(grenzeFuer('passwort-ip')).toBe(20);
    expect(grenzeFuer('passwort-ip')).toBeGreaterThan(grenzeFuer('passwort-email'));
  });

  it('erlaubt am Codeschritt fünf Fehlversuche je Konto', () => {
    expect(grenzeFuer('code-konto')).toBe(5);
  });

  it('hält Fenster und Sperre bei 15 Minuten', () => {
    expect(ANMELDE_FENSTER_MS).toBe(15 * 60 * 1000);
    expect(ANMELDE_SPERRE_MS).toBe(15 * 60 * 1000);
  });

  it('lässt die Sperre nicht kürzer als das Fenster werden', () => {
    // Sonst liefe eine Sperre ab, während der Zähler noch am Anschlag steht,
    // und der erste Versuch danach würde sofort wieder sperren.
    expect(ANMELDE_SPERRE_MS).toBeGreaterThanOrEqual(ANMELDE_FENSTER_MS);
  });
});

describe('istGesperrt', () => {
  it('ist ohne Sperrzeitpunkt offen', () => {
    expect(istGesperrt(undefined, JETZT)).toBe(false);
  });

  it('ist während der Sperre zu', () => {
    expect(istGesperrt(new Date(JETZT.getTime() + 1000), JETZT)).toBe(true);
  });

  it('ist nach Ablauf der Sperre wieder offen', () => {
    expect(istGesperrt(new Date(JETZT.getTime() - 1000), JETZT)).toBe(false);
  });

  it('ist genau im Ablaufmoment offen', () => {
    expect(istGesperrt(new Date(JETZT.getTime()), JETZT)).toBe(false);
  });
});
