/**
 * `pauschalenAus` (COPI-254): Standardwerte und die Regeln für Werte aus der Umgebung — rein, ohne Datenbank.
 */
import { describe, expect, it } from 'vitest';
import { pauschalenAus } from '../src/pipeline/kalkulation.js';

describe('pauschalenAus', () => {
  it('nimmt ohne Angabe 5 Minuten je Freigabe und 15 je Eskalation', () => {
    expect(pauschalenAus({})).toEqual({ freigabeMin: 5, eskalationMin: 15 });
  });

  it('liest beide Werte aus der Umgebung, auch 0 und 240', () => {
    expect(pauschalenAus({ COCKPIT_PIPELINE_PAUSCHALE_FREIGABE_MIN: '0', COCKPIT_PIPELINE_PAUSCHALE_ESKALATION_MIN: '240' })).toEqual({
      freigabeMin: 0,
      eskalationMin: 240,
    });
  });

  it.each(['', ' ', '241', '-1', '5.5', '1e2', 'abc', '0x10', '1000'])('fällt bei „%s" auf den Standard zurück', (wert) => {
    expect(pauschalenAus({ COCKPIT_PIPELINE_PAUSCHALE_FREIGABE_MIN: wert, COCKPIT_PIPELINE_PAUSCHALE_ESKALATION_MIN: wert })).toEqual({
      freigabeMin: 5,
      eskalationMin: 15,
    });
  });

  it('prüft jeden Wert für sich', () => {
    expect(pauschalenAus({ COCKPIT_PIPELINE_PAUSCHALE_FREIGABE_MIN: '10', COCKPIT_PIPELINE_PAUSCHALE_ESKALATION_MIN: 'x' })).toEqual({
      freigabeMin: 10,
      eskalationMin: 15,
    });
  });
});
