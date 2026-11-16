/**
 * `scripts/dev/demo-wachen.ts` (COPI-80): die Definitionen und der 7-Tage-Verlauf der Demodaten —
 * reine Funktionen, ohne Datenbank und ohne Bezug zur echten Uhr (jeder Punkt trägt nur einen
 * Versatz in Sekunden vor „jetzt").
 *
 * Geprüft wird, was `./dev demo` versprechen muss: gültige, eindeutig abräumbare Kennungen
 * (Präfix `demo-`, Form nach `wache_kennung_form`), genau eine rein interne Wache ohne
 * kundensichtbare Befunde, ein passender Kundentext bei jedem kundensichtbaren Befund
 * (`befund_kundentext_noetig`), ein chronologischer Verlauf und der geforderte aktuelle Stand:
 * eine rot, eine überfällig, Plattenplatz gelb über der Warnschwelle, der Rest grün — und die Messwerte (COPI-83).
 */
import { describe, expect, it } from 'vitest';
import { toleranzSekunden } from '../src/status/zustand.js';
import { DEMO_PRAEFIX, INTERNER_MESSWERT, wachenDefinitionen } from '../scripts/dev/demo-wachen.js';

const WACHE_KENNUNG_FORM = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

describe('wachenDefinitionen (COPI-80)', () => {
  const wachen = wachenDefinitionen();

  it('legt genau sechs Wachen an, alle mit dem Präfix demo- und gültiger Kennung', () => {
    expect(wachen).toHaveLength(6);
    for (const wache of wachen) {
      expect(wache.kennung.startsWith(DEMO_PRAEFIX)).toBe(true);
      expect(wache.kennung).toMatch(WACHE_KENNUNG_FORM);
      expect(wache.anzeigename.trim().length).toBeGreaterThan(0);
      expect(wache.anzeigename.length).toBeLessThanOrEqual(60);
      expect(wache.taktSekunden).toBeGreaterThan(0);
      expect(wache.verlauf.length).toBeGreaterThan(0);
    }
  });

  it('hat genau eine rein interne Wache, deren Befunde nie kundensichtbar sind', () => {
    const interne = wachen.filter((wache) => !wache.kundensichtbar);
    expect(interne).toHaveLength(1);
    expect(interne[0]?.kennung).toBe(`${DEMO_PRAEFIX}intern`);
    for (const punkt of interne[0]?.verlauf ?? []) {
      expect(punkt.textKunde).toBeUndefined();
    }
  });

  it('trägt bei jedem kundensichtbaren Befund einen nicht-leeren Kundentext (befund_kundentext_noetig)', () => {
    for (const wache of wachen.filter((eintrag) => eintrag.kundensichtbar)) {
      for (const punkt of wache.verlauf) {
        expect(punkt.textKunde?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('jeder Verlauf ist chronologisch (ältester Punkt zuerst, Versatz streng fallend)', () => {
    for (const wache of wachen) {
      const versaetze = wache.verlauf.map((punkt) => punkt.versatzSekunden);
      for (let i = 1; i < versaetze.length; i += 1) {
        expect(versaetze[i]).toBeLessThan(versaetze[i - 1] ?? Infinity);
      }
      expect(versaetze.at(-1)).toBeGreaterThanOrEqual(0);
    }
  });

  it('Erreichbarkeit ist aktuell rot', () => {
    const erreichbarkeit = wachen.find((wache) => wache.kennung === `${DEMO_PRAEFIX}erreichbarkeit`);
    expect(erreichbarkeit?.verlauf.at(-1)?.status).toBe('rot');
  });

  it('Zertifikat ist aktuell überfällig (letzter Punkt älter als Takt + Toleranz)', () => {
    const zertifikat = wachen.find((wache) => wache.kennung === `${DEMO_PRAEFIX}zertifikat`);
    expect(zertifikat).toBeDefined();
    if (zertifikat === undefined) return;
    const letzterVersatz = zertifikat.verlauf.at(-1)?.versatzSekunden ?? 0;
    expect(letzterVersatz).toBeGreaterThan(zertifikat.taktSekunden + toleranzSekunden(zertifikat.taktSekunden));
  });

  it('Container und Datensicherung sind aktuell grün, Plattenplatz gelb über der Warnschwelle (COPI-83)', () => {
    const plattenplatz = wachen.find((wache) => wache.kennung === `${DEMO_PRAEFIX}plattenplatz`);
    expect(plattenplatz?.verlauf.at(-1)?.status).toBe('gelb');
    expect(plattenplatz?.verlauf.at(-1)?.messwert).toEqual({ wert: 86, einheit: '%', max: 100, warnung: 85 });
    for (const kennung of ['container', 'datensicherung']) {
      const wache = wachen.find((eintrag) => eintrag.kennung === `${DEMO_PRAEFIX}${kennung}`);
      expect(wache?.verlauf.at(-1)?.status).toBe('gruen');
    }
  });

  it('Plattenplatz und Datensicherung tragen mindestens eine gelbe bzw. rote Episode in der Vergangenheit', () => {
    const plattenplatz = wachen.find((wache) => wache.kennung === `${DEMO_PRAEFIX}plattenplatz`);
    expect(plattenplatz?.verlauf.some((punkt) => punkt.status === 'gelb')).toBe(true);
    const datensicherung = wachen.find((wache) => wache.kennung === `${DEMO_PRAEFIX}datensicherung`);
    expect(datensicherung?.verlauf.some((punkt) => punkt.status === 'rot')).toBe(true);
  });

  it('trägt realistische Messwerte je Wache (COPI-83)', () => {
    const werte = (kennung: string) =>
      (wachen.find((wache) => wache.kennung === `${DEMO_PRAEFIX}${kennung}`)?.verlauf ?? []).map((punkt) => punkt.messwert?.wert);

    expect(werte('plattenplatz').at(0)).toBe(71);
    expect(werte('zertifikat').at(0)).toBe(70);
    expect(werte('zertifikat').at(-1)).toBe(64);
    // Ein Ausreißer von 410 ms vor der Störung, während der Timeouts keine Antwortzeit (Lücke der Kurve), zuletzt
    // wieder eine Antwort, aber über der Warnschwelle.
    const erreichbarkeit = werte('erreichbarkeit');
    expect(Math.max(...erreichbarkeit.slice(0, -5).flatMap((wert) => (wert === undefined ? [] : [wert])))).toBe(410);
    expect(erreichbarkeit.at(-2)).toBeUndefined();
    expect(erreichbarkeit.at(-1)).toBe(1240);
    expect(new Set(werte('container'))).toEqual(new Set([4, 5]));
    expect(werte('datensicherung').every((wert) => wert === undefined)).toBe(true);
  });

  it('gibt der internen Wache einen Messwert, der nirgends sonst vorkommt', () => {
    for (const wache of wachen) {
      for (const punkt of wache.verlauf) {
        expect(punkt.messwert?.wert === INTERNER_MESSWERT.wert).toBe(!wache.kundensichtbar);
      }
    }
  });

  it('ist deterministisch: zweimal aufgerufen liefert dasselbe Ergebnis', () => {
    expect(wachenDefinitionen()).toEqual(wachenDefinitionen());
  });
});
