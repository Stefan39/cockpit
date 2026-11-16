/**
 * Der Zähler der Agenten-API (COPI-35) — rein, ohne Datenbank.
 *
 * Er schützt Ressourcen, nicht ein Geheimnis: Ein Token hat 256 Bit und lässt sich nicht
 * erraten. Deshalb genügt der Arbeitsspeicher (ein Neustart setzt ihn zurück, das ist
 * harmlos) — anders als bei der Anmeldung, wo eine Sperre einen Neustart überstehen muss.
 * Die Zeit ist Parameter, damit Fensterende und Sperre ohne Warten prüfbar sind.
 */
import { describe, expect, it } from 'vitest';
import { FensterZaehler } from '../src/intern/ratenbegrenzung.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);

describe('FensterZaehler', () => {
  it('erlaubt genau so viele Reservierungen wie die Grenze und weist die nächste ab', () => {
    const zaehler = new FensterZaehler(3, MINUTE);

    const ergebnisse = [0, 1, 2, 3, 4].map(() => zaehler.reservieren('a', T0).erlaubt);

    expect(ergebnisse).toEqual([true, true, true, false, false]);
  });

  it('nennt bei einer Abweisung, wie lange es bis zum Ende des Fensters dauert (für Retry-After)', () => {
    const zaehler = new FensterZaehler(1, MINUTE);
    zaehler.reservieren('a', T0);

    const abgewiesen = zaehler.reservieren('a', T0 + 20_000);

    expect(abgewiesen.erlaubt).toBe(false);
    // Rest des Fensters: 40 Sekunden, aufgerundet auf ganze Sekunden.
    expect(abgewiesen.wiederNachSekunden).toBe(40);
  });

  it('beginnt nach Ablauf des Fensters von vorn', () => {
    const zaehler = new FensterZaehler(2, MINUTE);
    zaehler.reservieren('a', T0);
    zaehler.reservieren('a', T0);
    expect(zaehler.reservieren('a', T0 + MINUTE - 1).erlaubt).toBe(false);

    expect(zaehler.reservieren('a', T0 + MINUTE).erlaubt).toBe(true);
    expect(zaehler.reservieren('a', T0 + MINUTE).erlaubt).toBe(true);
    expect(zaehler.reservieren('a', T0 + MINUTE).erlaubt).toBe(false);
  });

  it('zählt jeden Schlüssel für sich', () => {
    const zaehler = new FensterZaehler(1, MINUTE);
    zaehler.reservieren('a', T0);

    expect(zaehler.reservieren('a', T0).erlaubt).toBe(false);
    expect(zaehler.reservieren('b', T0).erlaubt).toBe(true);
  });

  it('schreibt eine Reservierung wieder gut — nie unter null', () => {
    const zaehler = new FensterZaehler(2, MINUTE);
    zaehler.reservieren('a', T0);
    zaehler.reservieren('a', T0);

    zaehler.gutschreiben('a');

    expect(zaehler.reservieren('a', T0).erlaubt).toBe(true);
    expect(zaehler.reservieren('a', T0).erlaubt).toBe(false);

    // Beliebig oft gutschreiben und für einen unbekannten Schlüssel: kein negativer Stand, kein Fehler.
    for (let i = 0; i < 10; i += 1) {
      zaehler.gutschreiben('a');
      zaehler.gutschreiben('unbekannt');
    }
    expect(zaehler.reservieren('a', T0).erlaubt).toBe(true);
    expect(zaehler.reservieren('a', T0).erlaubt).toBe(true);
    expect(zaehler.reservieren('a', T0).erlaubt).toBe(false);
  });

  it('hebt eine Sperre durch Gutschreiben nicht auf, wenn der Stand über der Grenze bleibt', () => {
    const zaehler = new FensterZaehler(2, MINUTE);
    for (let i = 0; i < 6; i += 1) {
      zaehler.reservieren('a', T0);
    }

    zaehler.gutschreiben('a');

    expect(zaehler.reservieren('a', T0).erlaubt).toBe(false);
  });

  describe('Speicher', () => {
    it('hält höchstens so viele Schlüssel, wie erlaubt: sonst ließe sich der Prozess mit erfundenen Adressen füllen', () => {
      const zaehler = new FensterZaehler(5, MINUTE, { hoechstensSchluessel: 100 });

      for (let i = 0; i < 1000; i += 1) {
        zaehler.reservieren(`ip-${String(i)}`, T0);
      }

      expect(zaehler.groesse()).toBeLessThanOrEqual(100);
    });

    it('wirft zuerst abgelaufene Schlüssel weg, bevor es einen laufenden verdrängt', () => {
      const zaehler = new FensterZaehler(1, MINUTE, { hoechstensSchluessel: 10 });
      for (let i = 0; i < 10; i += 1) {
        zaehler.reservieren(`alt-${String(i)}`, T0);
      }
      // Ein laufender Schlüssel mit erreichter Grenze, der nicht verdrängt werden soll.
      const spaeter = T0 + 2 * MINUTE;
      zaehler.reservieren('laufend', spaeter);
      expect(zaehler.reservieren('laufend', spaeter).erlaubt).toBe(false);

      for (let i = 0; i < 9; i += 1) {
        zaehler.reservieren(`neu-${String(i)}`, spaeter);
      }

      expect(zaehler.groesse()).toBeLessThanOrEqual(10);
      expect(zaehler.reservieren('laufend', spaeter).erlaubt).toBe(false);
    });
  });
});
