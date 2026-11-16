/**
 * Die Berechtigungsregeln — ohne Fastify, ohne Datenbank.
 *
 * Diese Datei prüft die Regeln selbst; `einladung-datenbank.test.ts` prüft
 * zusätzlich, dass die echte Route sie auch anwendet.
 *
 * Die erwarteten Werte stehen als Literale hier: würde der Test die Tabellen
 * des Produktivcodes benutzen, rechnete er eine versehentlich erweiterte
 * Berechtigung einfach mit.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLE_ROLLEN,
  darfEinladen,
  einladbareRollen,
  hatRecht,
  istRolle,
  istVergebbareRolle,
  OHNE_ZUGANG,
  RECHTE,
  ROLLEN,
  type Rolle,
  type Zugang,
} from '../src/auth/berechtigung.js';

function zugang(teil: Partial<Zugang>): Zugang {
  return {
    angemeldet: true,
    rolle: 'betriebs_admin',
    zweiterFaktorAktiv: true,
    benutzerId: 'konto-1',
    ...teil,
  };
}

/** Werte, die nie eine Rolle sind, aber in einer Datenbankspalte stehen könnten. */
const UNBEKANNTE_ROLLEN = ['admin', '', 'BETREUER', 'Betriebs_Admin', 'superadmin'];

describe('darfEinladen — Rolle des Einladenden × Rolle des Einzuladenden', () => {
  it.each([
    // Der Betreuer lädt Betriebs-Admins und Mitarbeiter ein.
    ['betreuer', 'betriebs_admin', true],
    ['betreuer', 'betrieb_mitarbeiter', true],
    // Der Betriebs-Admin nur Mitarbeiter (kleinstes Recht) — nie einen Admin oder Betreuer.
    ['betriebs_admin', 'betrieb_mitarbeiter', true],
    ['betriebs_admin', 'betriebs_admin', false],
    // Der Mitarbeiter niemanden.
    ['betrieb_mitarbeiter', 'betrieb_mitarbeiter', false],
    ['betrieb_mitarbeiter', 'betriebs_admin', false],
  ] as const)('%s lädt %s ein: %s', (einladender, eingeladener, erwartet) => {
    expect(darfEinladen(zugang({ rolle: einladender }), eingeladener)).toBe(erwartet);
  });

  it.each(['betreuer', 'betriebs_admin', 'betrieb_mitarbeiter'] as const)(
    'lädt niemand als %s ein — die Rolle betreuer ist nie einladbar',
    (einladender) => {
      expect(darfEinladen(zugang({ rolle: einladender }), 'betreuer' as never)).toBe(false);
    },
  );

  it.each(['betreuer', 'betriebs_admin'] as const)(
    'verweigert %s ohne aktiven zweiten Faktor',
    (rolle) => {
      const ohneFaktor = zugang({ rolle, zweiterFaktorAktiv: false });

      expect(darfEinladen(ohneFaktor, 'betrieb_mitarbeiter')).toBe(false);
      expect(einladbareRollen(ohneFaktor)).toEqual([]);
    },
  );

  it('verweigert ohne Anmeldung', () => {
    expect(darfEinladen(OHNE_ZUGANG, 'betrieb_mitarbeiter')).toBe(false);
    expect(darfEinladen(zugang({ angemeldet: false }), 'betrieb_mitarbeiter')).toBe(false);
    expect(darfEinladen(zugang({ angemeldet: false, rolle: 'betreuer' }), 'betriebs_admin')).toBe(
      false,
    );
  });

  it.each([undefined, ...UNBEKANNTE_ROLLEN])('verweigert bei fehlender oder unbekannter Rolle %j', (rolle) => {
    const konto = zugang({ rolle: rolle as Rolle | undefined });

    expect(darfEinladen(konto, 'betrieb_mitarbeiter')).toBe(false);
    expect(einladbareRollen(konto)).toEqual([]);
  });
});

describe('einladbareRollen — was das Formular anbieten darf', () => {
  it('bietet dem Betreuer Betriebs-Admin und Mitarbeiter an', () => {
    expect(einladbareRollen(zugang({ rolle: 'betreuer' }))).toEqual([
      'betriebs_admin',
      'betrieb_mitarbeiter',
    ]);
  });

  it('bietet dem Betriebs-Admin nur Mitarbeiter an', () => {
    expect(einladbareRollen(zugang({ rolle: 'betriebs_admin' }))).toEqual(['betrieb_mitarbeiter']);
  });

  it('bietet dem Mitarbeiter nichts an', () => {
    expect(einladbareRollen(zugang({ rolle: 'betrieb_mitarbeiter' }))).toEqual([]);
  });
});

describe('hatRecht — der Betreuer hat vollständige Rechte', () => {
  it('kennt mindestens das Recht einzuladen', () => {
    expect(RECHTE).toContain('einladen');
  });

  it.each(RECHTE.filter((recht) => recht !== 'betreuer_zugriff_freigeben'))('lässt den Betreuer das Recht %s haben — jedes Recht der Liste', (recht) => {
    expect(hatRecht(zugang({ rolle: 'betreuer' }), recht)).toBe(true);
  });

  it('gibt dem Betreuer nie das Recht, sich selbst Zugriff auf ein Fachmodul zu geben (COPI-134)', () => {
    expect(hatRecht(zugang({ rolle: 'betreuer' }), 'betreuer_zugriff_freigeben')).toBe(false);
    expect(hatRecht(zugang({ rolle: 'betriebs_admin' }), 'betreuer_zugriff_freigeben')).toBe(true);
    expect(hatRecht(zugang({ rolle: 'betrieb_mitarbeiter' }), 'betreuer_zugriff_freigeben')).toBe(false);
  });

  it.each(RECHTE)('verlangt auch vom Betreuer den zweiten Faktor für %s', (recht) => {
    expect(hatRecht(zugang({ rolle: 'betreuer', zweiterFaktorAktiv: false }), recht)).toBe(false);
  });

  it.each(RECHTE)('verlangt auch vom Betreuer die Anmeldung für %s', (recht) => {
    expect(hatRecht(OHNE_ZUGANG, recht)).toBe(false);
    expect(hatRecht(zugang({ rolle: 'betreuer', angemeldet: false }), recht)).toBe(false);
  });

  it('gibt dem Betriebs-Admin das Einladen, dem Mitarbeiter nichts', () => {
    expect(hatRecht(zugang({ rolle: 'betriebs_admin' }), 'einladen')).toBe(true);
    expect(hatRecht(zugang({ rolle: 'betrieb_mitarbeiter' }), 'einladen')).toBe(false);
  });

  it.each([undefined, ...UNBEKANNTE_ROLLEN])('gibt einer fehlenden oder unbekannten Rolle %j nichts', (rolle) => {
    expect(hatRecht(zugang({ rolle: rolle as Rolle | undefined }), 'einladen')).toBe(false);
  });
});

describe('Rollen', () => {
  it('erkennt alle gespeicherten Rollen, auch den Betreuer', () => {
    for (const rolle of ALLE_ROLLEN) {
      expect(istRolle(rolle)).toBe(true);
    }
    expect(istRolle('betreuer')).toBe(true);
  });

  it.each([...UNBEKANNTE_ROLLEN, null, undefined, 7, {}])('weist den Wert %o als Rolle ab', (wert) => {
    expect(istRolle(wert)).toBe(false);
    expect(istVergebbareRolle(wert)).toBe(false);
  });

  it('kennt die vergebbaren Rollen: der Betreuer gehört nicht dazu', () => {
    expect([...ROLLEN]).toEqual(['betriebs_admin', 'betrieb_mitarbeiter']);
    expect(istVergebbareRolle('betreuer')).toBe(false);
    expect(istVergebbareRolle('betriebs_admin')).toBe(true);
    expect(istVergebbareRolle('betrieb_mitarbeiter')).toBe(true);
  });

  it('listet genau drei gespeicherte Rollen, den Betreuer als einzige nicht vergebbare', () => {
    expect([...ALLE_ROLLEN].sort()).toEqual(['betreuer', 'betrieb_mitarbeiter', 'betriebs_admin']);
  });
});

/**
 * Das Recht, Rohbefunde zu sehen (COPI-37): auf der Übersicht sieht nur der Betreuer die Befunde, die
 * nicht für Kunden bestimmt sind. Wie jedes Recht steht es hier in der einen Regel und nicht als
 * Rollenvergleich in der Route — und wie jedes Recht braucht es Anmeldung und zweiten Faktor.
 */
describe('hatRecht — rohbefunde_sehen', () => {
  it('steht in der Liste der Rechte', () => {
    expect(RECHTE).toContain('rohbefunde_sehen');
  });

  it.each([
    ['betreuer', true],
    ['betriebs_admin', false],
    ['betrieb_mitarbeiter', false],
  ] as const)('%s: %s', (rolle, erwartet) => {
    expect(hatRecht(zugang({ rolle }), 'rohbefunde_sehen')).toBe(erwartet);
  });

  it('hat niemand ohne Anmeldung, auch der Betreuer nicht', () => {
    expect(hatRecht(OHNE_ZUGANG, 'rohbefunde_sehen')).toBe(false);
    expect(hatRecht(zugang({ rolle: 'betreuer', angemeldet: false }), 'rohbefunde_sehen')).toBe(false);
  });

  it('hat niemand ohne zweiten Faktor, auch der Betreuer nicht', () => {
    expect(hatRecht(zugang({ rolle: 'betreuer', zweiterFaktorAktiv: false }), 'rohbefunde_sehen')).toBe(false);
  });

  it.each([...UNBEKANNTE_ROLLEN, undefined])('hat eine unbekannte oder fehlende Rolle (%s) nie', (rolle) => {
    expect(hatRecht(zugang({ rolle: rolle as Rolle | undefined }), 'rohbefunde_sehen')).toBe(false);
  });
});

/**
 * `technik_sehen` (COPI-38): Kennung und Version der Agenten sehen. Ein eigenes Recht statt `rohbefunde_sehen`
 * mitzubenutzen: es sind zwei verschiedene Dinge, und wer eines später einer weiteren Rolle gibt, soll nicht
 * das andere mit vergeben.
 */
describe('hatRecht — technik_sehen', () => {
  it('steht in der Liste der Rechte', () => {
    expect(RECHTE).toContain('technik_sehen');
  });

  it.each([
    ['betreuer', true],
    ['betriebs_admin', false],
    ['betrieb_mitarbeiter', false],
  ] as const)('%s: %s', (rolle, erwartet) => {
    expect(hatRecht(zugang({ rolle }), 'technik_sehen')).toBe(erwartet);
  });

  it('hat niemand ohne Anmeldung oder ohne zweiten Faktor, auch der Betreuer nicht', () => {
    expect(hatRecht(OHNE_ZUGANG, 'technik_sehen')).toBe(false);
    expect(hatRecht(zugang({ rolle: 'betreuer', angemeldet: false }), 'technik_sehen')).toBe(false);
    expect(hatRecht(zugang({ rolle: 'betreuer', zweiterFaktorAktiv: false }), 'technik_sehen')).toBe(false);
  });

  it.each([...UNBEKANNTE_ROLLEN, undefined])('hat eine unbekannte oder fehlende Rolle (%s) nie', (rolle) => {
    expect(hatRecht(zugang({ rolle: rolle as Rolle | undefined }), 'technik_sehen')).toBe(false);
  });
});

/**
 * `update_beantragen` (COPI-40): ein Update des Cockpits beantragen und einen noch nicht freigegebenen Antrag
 * zurückziehen. Nur der Betreuer (ADR 13.1) — der Betriebs-Admin und der Mitarbeiter sehen nicht einmal den Knopf.
 */
describe('hatRecht — update_beantragen', () => {
  it('steht in der Liste der Rechte', () => {
    expect(RECHTE).toContain('update_beantragen');
  });

  it.each([
    ['betreuer', true],
    ['betriebs_admin', false],
    ['betrieb_mitarbeiter', false],
  ] as const)('%s: %s', (rolle, erwartet) => {
    expect(hatRecht(zugang({ rolle }), 'update_beantragen')).toBe(erwartet);
  });

  it('hat niemand ohne Anmeldung oder ohne zweiten Faktor, auch der Betreuer nicht', () => {
    expect(hatRecht(OHNE_ZUGANG, 'update_beantragen')).toBe(false);
    expect(hatRecht(zugang({ rolle: 'betreuer', angemeldet: false }), 'update_beantragen')).toBe(false);
    expect(hatRecht(zugang({ rolle: 'betreuer', zweiterFaktorAktiv: false }), 'update_beantragen')).toBe(false);
  });

  it.each([...UNBEKANNTE_ROLLEN, undefined])('hat eine unbekannte oder fehlende Rolle (%s) nie', (rolle) => {
    expect(hatRecht(zugang({ rolle: rolle as Rolle | undefined }), 'update_beantragen')).toBe(false);
  });

  it('macht den Betreuer nicht vergebbar: keine Rolle darf ihn einladen, keine Einladung trägt ihn', () => {
    for (const rolle of ALLE_ROLLEN) {
      expect(einladbareRollen(zugang({ rolle }))).not.toContain('betreuer');
    }
    expect(istVergebbareRolle('betreuer')).toBe(false);
    expect(ROLLEN).not.toContain('betreuer');
  });
});

/**
 * `benutzer_sehen` (COPI-45): die Seite Benutzer — alle Konten und offenen Einladungen. Betreuer und Betriebs-Admin; der
 * Mitarbeiter nicht.
 */
describe('hatRecht — benutzer_sehen', () => {
  it('steht in der Liste der Rechte', () => {
    expect(RECHTE).toContain('benutzer_sehen');
  });

  it.each([
    ['betreuer', true],
    ['betriebs_admin', true],
    ['betrieb_mitarbeiter', false],
  ] as const)('%s: %s', (rolle, erwartet) => {
    expect(hatRecht(zugang({ rolle }), 'benutzer_sehen')).toBe(erwartet);
  });

  it('hat niemand ohne Anmeldung oder ohne zweiten Faktor, auch der Betreuer nicht', () => {
    expect(hatRecht(OHNE_ZUGANG, 'benutzer_sehen')).toBe(false);
    expect(hatRecht(zugang({ rolle: 'betreuer', angemeldet: false }), 'benutzer_sehen')).toBe(false);
    expect(hatRecht(zugang({ rolle: 'betriebs_admin', zweiterFaktorAktiv: false }), 'benutzer_sehen')).toBe(false);
  });

  it.each([...UNBEKANNTE_ROLLEN, undefined])('hat eine unbekannte oder fehlende Rolle (%s) nie', (rolle) => {
    expect(hatRecht(zugang({ rolle: rolle as Rolle | undefined }), 'benutzer_sehen')).toBe(false);
  });

  it('hat jeder, der einladen darf: die Seite Einladen verlinkt die Benutzer in ihrer Navigation ohne eigene Prüfung', () => {
    for (const rolle of ALLE_ROLLEN) {
      if (hatRecht(zugang({ rolle }), 'einladen')) {
        expect(hatRecht(zugang({ rolle }), 'benutzer_sehen'), rolle).toBe(true);
      }
    }
  });
});
