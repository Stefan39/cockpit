/**
 * Die Seiten „Agenten" und „Zeitplan" aus dem Inventar (COPI-38) — reine Funktionen, der Zeitpunkt ist ein
 * Parameter.
 *
 * Sichtbarkeit je Rolle (mit Stefan abgestimmt): jedes angemeldete Konto sieht Rolle, Grenzen und Zeitplan der
 * Agenten; **Kennung und Version sieht nur der Betreuer**. Wie bei der Übersicht (COPI-37) liegt der
 * Unterschied in der Form der Daten, nicht in einer Bedingung: die Karte der Kundensicht hat kein Feld dafür.
 */
import { describe, expect, it } from 'vitest';
import type { AgentZeile } from '../src/status/agenten-speicher.js';
import { agentenAnsicht, zeitplanAnsicht } from '../src/status/agenten.js';

const JETZT = new Date('2026-09-21T12:00:00.000Z');
const vor = (sekunden: number): Date => new Date(JETZT.getTime() - sekunden * 1000);

function zeile(kennung: string, teil: Partial<AgentZeile> = {}): AgentZeile {
  return {
    kennung,
    rolle: `Rolle ${kennung}`,
    version: '1.0.0',
    grenzen: {},
    zeitplan: [],
    aktualisiertAm: vor(300),
    ...teil,
  };
}

const GEHEIME_KENNUNG = 'agent-rechnung-intern';
const GEHEIME_VERSION = '9.9.9-intern';

describe('agentenAnsicht — Kundensicht', () => {
  it('gibt jeder Karte genau die Felder Rolle, Grenzen und Link: keine Kennung, keine Version', () => {
    const { karten } = agentenAnsicht([zeile(GEHEIME_KENNUNG, { version: GEHEIME_VERSION })], 'kunde', JETZT);

    expect(karten).toHaveLength(1);
    expect(Object.keys(karten[0] ?? {}).sort()).toEqual(['grenzen', 'href', 'rolle']);
    // Der Link führt über den Schlüssel, nie über die Kennung (COPI-113).
    expect(karten[0]?.href).toMatch(/^\/agenten\/[0-9a-f]{16}$/);
  });

  it('enthält Kennung und Version an keiner Stelle des Ergebnisses', () => {
    const ansicht = agentenAnsicht(
      [zeile(GEHEIME_KENNUNG, { rolle: 'Rechnungs-Agent', version: GEHEIME_VERSION, grenzen: { Betrag: 5000 } })],
      'kunde',
      JETZT,
    );

    const alles = JSON.stringify(ansicht);
    expect(alles).not.toContain(GEHEIME_KENNUNG);
    expect(alles).not.toContain(GEHEIME_VERSION);
    expect(alles).toContain('Rechnungs-Agent');
  });

  it('zeigt jeden Agenten des Inventars: das Inventar kennt keine Sichtbarkeit je Agent', () => {
    const { karten } = agentenAnsicht([zeile('a'), zeile('b'), zeile('c')], 'kunde', JETZT);

    expect(karten).toHaveLength(3);
  });
});

describe('agentenAnsicht — Betreuersicht', () => {
  it('zeigt zusätzlich Kennung und Version', () => {
    const { karten } = agentenAnsicht([zeile(GEHEIME_KENNUNG, { version: GEHEIME_VERSION })], 'betreuer', JETZT);

    expect(karten[0]).toMatchObject({ kennung: GEHEIME_KENNUNG, version: GEHEIME_VERSION, rolle: `Rolle ${GEHEIME_KENNUNG}` });
  });
});

describe('agentenAnsicht — Inhalt', () => {
  it('schreibt Grenzen in Betriebssprache: Ja/Nein, Zahlen deutsch, Text unverändert', () => {
    const { karten } = agentenAnsicht(
      [zeile('a', { grenzen: { 'darf löschen': false, 'darf senden': true, Betrag: 5000, Anteil: 0.5, Währung: 'EUR' } })],
      'kunde',
      JETZT,
    );

    expect(karten[0]?.grenzen).toEqual([
      { name: 'Anteil', wert: '0,5' },
      { name: 'Betrag', wert: '5.000' },
      { name: 'darf löschen', wert: 'Nein' },
      { name: 'darf senden', wert: 'Ja' },
      { name: 'Währung', wert: 'EUR' },
    ]);
  });

  it('sortiert die Agenten nach Rolle (deutsche Sortierung), dann nach Kennung', () => {
    const { karten } = agentenAnsicht(
      [zeile('z', { rolle: 'Übersetzer' }), zeile('b', { rolle: 'Rechnung' }), zeile('a', { rolle: 'Rechnung' }), zeile('c', { rolle: 'Buchung' })],
      'betreuer',
      JETZT,
    );

    expect(karten.map((karte) => ('kennung' in karte ? karte.kennung : ''))).toEqual(['c', 'a', 'b', 'z']);
  });

  it('nennt den Stand des Inventars: wann es zuletzt gemeldet wurde', () => {
    expect(agentenAnsicht([zeile('a', { aktualisiertAm: vor(5 * 60) })], 'kunde', JETZT).stand).toBe('gemeldet vor 5 Minuten');
    expect(agentenAnsicht([zeile('a', { aktualisiertAm: vor(2 * 86_400) })], 'kunde', JETZT).stand).toBe('gemeldet vor 2 Tagen');
  });

  it('nimmt für den Stand die jüngste Meldung', () => {
    const { stand } = agentenAnsicht([zeile('a', { aktualisiertAm: vor(7200) }), zeile('b', { aktualisiertAm: vor(60) })], 'kunde', JETZT);

    expect(stand).toBe('gemeldet vor 1 Minute');
  });

  it('sagt „gerade eben", wenn die Uhr zurückgesprungen ist: nie ein negatives Alter', () => {
    const { stand } = agentenAnsicht([zeile('a', { aktualisiertAm: new Date(JETZT.getTime() + 3600_000) })], 'kunde', JETZT);

    expect(stand).toBe('gemeldet gerade eben');
  });

  it('behauptet ohne Inventar keinen Stand', () => {
    expect(agentenAnsicht([], 'kunde', JETZT)).toEqual({ stand: undefined, karten: [] });
    expect(agentenAnsicht([], 'betreuer', JETZT)).toEqual({ stand: undefined, karten: [] });
  });

  it('verändert seine Eingabe nicht', () => {
    const eingabe = [zeile('b', { rolle: 'B', grenzen: { y: 1, x: 2 } }), zeile('a', { rolle: 'A' })];
    const kopie = JSON.stringify(eingabe);

    agentenAnsicht(eingabe, 'betreuer', JETZT);

    expect(JSON.stringify(eingabe)).toBe(kopie);
  });
});

describe('zeitplanAnsicht', () => {
  it('führt alle Takte auf, je Agent unter seiner Rolle, in der Reihenfolge, die der Agent gemeldet hat', () => {
    const { gruppen } = zeitplanAnsicht(
      [
        zeile('rechnung', {
          rolle: 'Rechnungs-Agent',
          zeitplan: [
            { name: 'Rechnungslauf', wann: 'täglich 07:00' },
            { name: 'Mahnungen', wann: 'montags 09:00' },
          ],
        }),
        zeile('buchung', { rolle: 'Buchungs-Agent', zeitplan: [{ name: 'Anfragen prüfen', wann: 'alle 5 Minuten' }] }),
      ],
      JETZT,
    );

    expect(gruppen).toEqual([
      { agent: 'Buchungs-Agent', takte: [{ name: 'Anfragen prüfen', wann: 'alle 5 Minuten' }] },
      {
        agent: 'Rechnungs-Agent',
        takte: [
          { name: 'Rechnungslauf', wann: 'täglich 07:00' },
          { name: 'Mahnungen', wann: 'montags 09:00' },
        ],
      },
    ]);
  });

  it('lässt Agenten ohne Takt weg', () => {
    const { gruppen } = zeitplanAnsicht([zeile('a'), zeile('b', { zeitplan: [{ name: 'n', wann: 'w' }] })], JETZT);

    expect(gruppen.map((gruppe) => gruppe.agent)).toEqual(['Rolle b']);
  });

  it('enthält weder Kennung noch Version: der Zeitplan ist für alle Rollen derselbe', () => {
    const ansicht = zeitplanAnsicht(
      [zeile(GEHEIME_KENNUNG, { rolle: 'Rechnungs-Agent', version: GEHEIME_VERSION, zeitplan: [{ name: 'n', wann: 'w' }] })],
      JETZT,
    );

    const alles = JSON.stringify(ansicht);
    expect(alles).not.toContain(GEHEIME_KENNUNG);
    expect(alles).not.toContain(GEHEIME_VERSION);
  });

  it('nennt den Stand und behauptet ohne Inventar keinen', () => {
    expect(zeitplanAnsicht([zeile('a', { aktualisiertAm: vor(3 * 3600) })], JETZT).stand).toBe('gemeldet vor 3 Stunden');
    expect(zeitplanAnsicht([], JETZT)).toEqual({ stand: undefined, gruppen: [] });
  });

  it('hat ohne einen einzigen Takt keine Gruppen, aber einen Stand: es gibt ein Inventar, nur keinen Zeitplan', () => {
    const ansicht = zeitplanAnsicht([zeile('a')], JETZT);

    expect(ansicht.gruppen).toEqual([]);
    expect(ansicht.stand).toBe('gemeldet vor 5 Minuten');
  });
});
