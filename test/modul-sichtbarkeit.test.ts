/**
 * `modulZugriffErlaubt` (COPI-78) und `modulHandelnErlaubt` (COPI-134) — reine Funktionen, ohne Datenbank. Dieselbe Regel
 * filtert die Navigation, die Liste unter `/module` und jede einzelne Modul- bzw. Detailseite
 * (`test/modul-seiten-datenbank.test.ts` und `test/betreuer-zugriff-datenbank.test.ts` prüfen das gegen echte Anfragen).
 *
 * Seit COPI-134 sieht der Betreuer ein Fachmodul nur mit dem Zugriff, den der Kunde freigegeben hat; ein technisches
 * Modul (`art: betrieb`) immer.
 */
import { describe, expect, it } from 'vitest';
import type { Zugang } from '../src/auth/berechtigung.js';
import type { BetreuerZugriff } from '../src/module/betreuer-zugriff.js';
import type { ModulBlock } from '../src/module/block.js';
import { modulHandelnErlaubt, modulZugriffErlaubt, type SichtbaresModul } from '../src/module/sichtbarkeit.js';

function modul(rollen: ModulBlock['rollen'], betreuerZugriff: BetreuerZugriff = 'aus', art?: ModulBlock['art']): SichtbaresModul {
  return {
    betreuerZugriff,
    block: {
      kennung: 'probe',
      menuename: 'Probe',
      ansicht: 'liste-detail',
      view: 'v_modul_probe',
      spalten: [{ name: 'titel', label: 'Titel' }],
      rollen,
      eingriffe: [],
      ...(art === undefined ? {} : { art }),
    },
  };
}

function zugang(teil: Partial<Zugang>): Zugang {
  return { angemeldet: true, zweiterFaktorAktiv: true, rolle: undefined, benutzerId: 'x', ...teil };
}

const BETREUER = zugang({ rolle: 'betreuer' });

describe('modulZugriffErlaubt', () => {
  it('lässt eine Rolle zu, die im Block steht', () => {
    expect(modulZugriffErlaubt(zugang({ rolle: 'betriebs_admin' }), modul(['betriebs_admin']))).toBe(true);
  });

  it('weist eine Rolle ab, die nicht im Block steht', () => {
    expect(modulZugriffErlaubt(zugang({ rolle: 'betrieb_mitarbeiter' }), modul(['betreuer', 'betriebs_admin']))).toBe(false);
  });

  it('weist eine unbekannte Rolle ab: im Zweifel sieht das Konto weniger', () => {
    expect(modulZugriffErlaubt(zugang({ rolle: undefined }), modul(['betreuer', 'betriebs_admin', 'betrieb_mitarbeiter'], 'entscheiden'))).toBe(false);
  });

  it('weist ohne Zugang ab', () => {
    expect(modulZugriffErlaubt(undefined, modul(['betriebs_admin'], 'entscheiden'))).toBe(false);
  });

  it('weist eine Sitzung ohne aktiven zweiten Faktor ab, auch den Betreuer mit Freigabe', () => {
    expect(modulZugriffErlaubt(zugang({ rolle: 'betreuer', zweiterFaktorAktiv: false }), modul(['betriebs_admin'], 'entscheiden'))).toBe(false);
  });

  it('weist eine nicht angemeldete Sitzung ab', () => {
    expect(modulZugriffErlaubt(zugang({ rolle: 'betreuer', angemeldet: false }), modul(['betriebs_admin'], 'entscheiden', 'betrieb'))).toBe(false);
  });

  describe('Betreuer (COPI-134)', () => {
    it('sieht ein Fachmodul ohne Freigabe nicht — auch wenn er in rollen steht', () => {
      expect(modulZugriffErlaubt(BETREUER, modul(['betriebs_admin']))).toBe(false);
      expect(modulZugriffErlaubt(BETREUER, modul(['betreuer', 'betriebs_admin']))).toBe(false);
      expect(modulZugriffErlaubt(BETREUER, modul(['betriebs_admin'], 'aus', 'fach'))).toBe(false);
    });

    it.each<BetreuerZugriff>(['lesen', 'entscheiden'])('sieht ein Fachmodul mit Freigabe %s', (stufe) => {
      expect(modulZugriffErlaubt(BETREUER, modul(['betriebs_admin'], stufe))).toBe(true);
    });

    it('sieht ein technisches Modul immer, ohne Freigabe und ohne Rolle in der Liste', () => {
      expect(modulZugriffErlaubt(BETREUER, modul(['betriebs_admin'], 'aus', 'betrieb'))).toBe(true);
    });

    it('macht für die Kundenrollen keinen Unterschied, was der Betreuer darf', () => {
      expect(modulZugriffErlaubt(zugang({ rolle: 'betriebs_admin' }), modul(['betriebs_admin'], 'aus'))).toBe(true);
      expect(modulZugriffErlaubt(zugang({ rolle: 'betrieb_mitarbeiter' }), modul(['betriebs_admin'], 'entscheiden'))).toBe(false);
    });
  });
});

describe('modulHandelnErlaubt (COPI-134)', () => {
  it('erlaubt dem Betreuer nur mit „entscheiden" zu handeln, nicht mit „lesen"', () => {
    expect(modulHandelnErlaubt(BETREUER, modul(['betriebs_admin'], 'entscheiden'))).toBe(true);
    expect(modulHandelnErlaubt(BETREUER, modul(['betriebs_admin'], 'lesen'))).toBe(false);
    expect(modulHandelnErlaubt(BETREUER, modul(['betriebs_admin'], 'aus'))).toBe(false);
  });

  it('erlaubt dem Betreuer in einem technischen Modul immer zu handeln', () => {
    expect(modulHandelnErlaubt(BETREUER, modul(['betriebs_admin'], 'aus', 'betrieb'))).toBe(true);
  });

  it('erlaubt jeder Kundenrolle, die das Modul sieht, zu handeln — unabhängig vom Betreuer-Zugriff', () => {
    expect(modulHandelnErlaubt(zugang({ rolle: 'betriebs_admin' }), modul(['betriebs_admin'], 'lesen'))).toBe(true);
    expect(modulHandelnErlaubt(zugang({ rolle: 'betrieb_mitarbeiter' }), modul(['betriebs_admin', 'betrieb_mitarbeiter']))).toBe(true);
  });

  it('erlaubt niemandem zu handeln, der das Modul nicht sieht', () => {
    expect(modulHandelnErlaubt(zugang({ rolle: 'betrieb_mitarbeiter' }), modul(['betriebs_admin'], 'entscheiden'))).toBe(false);
    expect(modulHandelnErlaubt(undefined, modul(['betriebs_admin'], 'entscheiden'))).toBe(false);
  });
});
