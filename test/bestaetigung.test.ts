/**
 * Die signierte Bestätigung aus zwei Schritten (allgemein seit COPI-46): gilt nur für denselben Zweck, denselben
 * Inhalt und höchstens zehn Minuten. Die Fälle des Update-Antrags stehen in `update-antrag.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BESTAETIGUNG_GUELTIG_MS, bestaetigungAusstellen, bestaetigungPruefen } from '../src/auth/bestaetigung.js';
import { bestaetigungAusstellen as antragAusstellen } from '../src/status/update-antrag.js';

const SCHLUESSEL = randomBytes(32);
const JETZT = new Date('2026-09-22T12:00:00.000Z');
const INHALT = ['betreuer-1', 'konto-7', 'name', 'Anna'];

describe('bestaetigungPruefen', () => {
  it('nimmt die eigene Bestätigung an, bis kurz vor Ablauf', () => {
    const felder = bestaetigungAusstellen(SCHLUESSEL, 'benutzer-bearbeiten', INHALT, JETZT);

    expect(bestaetigungPruefen(SCHLUESSEL, felder, 'benutzer-bearbeiten', INHALT, JETZT)).toBe(true);
    expect(bestaetigungPruefen(SCHLUESSEL, felder, 'benutzer-bearbeiten', INHALT, new Date(JETZT.getTime() + BESTAETIGUNG_GUELTIG_MS - 1))).toBe(true);
  });

  it.each([
    ['ein anderer Zweck', 'cockpit-update-antrag', INHALT],
    ['ein anderes Ziel', 'benutzer-bearbeiten', ['betreuer-1', 'konto-8', 'name', 'Anna']],
    ['ein anderer Wert', 'benutzer-bearbeiten', ['betreuer-1', 'konto-7', 'name', 'Annа']],
    ['ein anderer Handelnder', 'benutzer-bearbeiten', ['admin-2', 'konto-7', 'name', 'Anna']],
    ['verschobene Felder', 'benutzer-bearbeiten', ['betreuer-1', 'konto-7name', '', 'Anna']],
  ])('lehnt %s ab', (_name, zweck, inhalt) => {
    const felder = bestaetigungAusstellen(SCHLUESSEL, 'benutzer-bearbeiten', INHALT, JETZT);

    expect(bestaetigungPruefen(SCHLUESSEL, felder, zweck, inhalt, JETZT)).toBe(false);
  });

  it('lehnt eine abgelaufene, eine mit fremdem Schlüssel und eine kaputte Bestätigung ab', () => {
    const felder = bestaetigungAusstellen(SCHLUESSEL, 'benutzer-bearbeiten', INHALT, JETZT);

    expect(bestaetigungPruefen(SCHLUESSEL, felder, 'benutzer-bearbeiten', INHALT, new Date(JETZT.getTime() + BESTAETIGUNG_GUELTIG_MS))).toBe(false);
    expect(bestaetigungPruefen(randomBytes(32), felder, 'benutzer-bearbeiten', INHALT, JETZT)).toBe(false);
    expect(bestaetigungPruefen(SCHLUESSEL, { bis: felder.bis }, 'benutzer-bearbeiten', INHALT, JETZT)).toBe(false);
    expect(bestaetigungPruefen(SCHLUESSEL, { ...felder, bis: `${felder.bis}0` }, 'benutzer-bearbeiten', INHALT, JETZT)).toBe(false);
  });

  it('lässt eine Bestätigung des Update-Antrags nicht für das Bearbeiten eines Kontos gelten', () => {
    const antrag = antragAusstellen(SCHLUESSEL, { kontoId: 'betreuer-1', ziel: 'konto-7', vorher: 'name' }, JETZT);

    expect(bestaetigungPruefen(SCHLUESSEL, antrag, 'benutzer-bearbeiten', ['betreuer-1', 'konto-7', 'name'], JETZT)).toBe(false);
    expect(bestaetigungPruefen(SCHLUESSEL, antrag, 'cockpit-update-antrag', ['betreuer-1', 'konto-7', 'name'], JETZT)).toBe(true);
  });
});
