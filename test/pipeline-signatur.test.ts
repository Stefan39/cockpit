/**
 * Die Signatur der Pipeline-API (COPI-145) als reine Funktionen: Konfiguration aus der Umgebung, Form der Kopfzeilen,
 * das Fenster von fünf Minuten und der Vergleich über den rohen Rumpf.
 */
import { describe, expect, it } from 'vitest';
import { signatur } from '../src/chat/koordinator.js';
import { kopfLesen, pipelineAusUmgebung, signaturKopfzeilen, signaturStimmt } from '../src/pipeline/signatur.js';

const GEHEIMNIS = 'ein-gemeinsames-geheimnis-mit-mindestens-32-zeichen';
const JETZT = new Date('2026-10-16T08:00:00Z');
const SEKUNDEN = JETZT.getTime() / 1000;

describe('pipelineAusUmgebung', () => {
  it('ist ohne Geheimnis aus und hält bei einem zu kurzen den Start an', () => {
    expect(pipelineAusUmgebung({ pipelineGeheimnis: undefined })).toBeUndefined();
    expect(pipelineAusUmgebung({ pipelineGeheimnis: '' })).toBeUndefined();
    expect(() => pipelineAusUmgebung({ pipelineGeheimnis: 'zu-kurz' })).toThrow(/mindestens 32 Zeichen/);
    expect(pipelineAusUmgebung({ pipelineGeheimnis: GEHEIMNIS })).toEqual({ geheimnis: GEHEIMNIS });
  });
});

describe('kopfLesen', () => {
  const gueltig = `sha256=${'a'.repeat(64)}`;

  it('nimmt wohlgeformte Kopfzeilen im Fenster an', () => {
    expect(kopfLesen(String(SEKUNDEN), gueltig, JETZT)).toEqual({ zeitpunkt: SEKUNDEN, signatur: gueltig });
    expect(kopfLesen(String(SEKUNDEN - 300), gueltig, JETZT)).toBeDefined();
    expect(kopfLesen(String(SEKUNDEN + 300), gueltig, JETZT)).toBeDefined();
  });

  it.each([
    ['zu alt', String(SEKUNDEN - 301), gueltig],
    ['zu weit in der Zukunft', String(SEKUNDEN + 301), gueltig],
    ['Zeitpunkt in Millisekunden', String(JETZT.getTime()), gueltig],
    ['Zeitpunkt keine Zahl', '1e9', gueltig],
    ['Signatur ohne Präfix', String(SEKUNDEN), 'a'.repeat(64)],
    ['Signatur in Großbuchstaben', String(SEKUNDEN), `sha256=${'A'.repeat(64)}`],
    ['Signatur zu kurz', String(SEKUNDEN), 'sha256=abc'],
  ])('weist ab: %s', (_fall, zeitpunkt, wert) => {
    expect(kopfLesen(zeitpunkt, wert, JETZT)).toBeUndefined();
  });

  it('weist fehlende und mehrfache Kopfzeilen ab', () => {
    expect(kopfLesen(undefined, gueltig, JETZT)).toBeUndefined();
    expect(kopfLesen(String(SEKUNDEN), [gueltig, gueltig], JETZT)).toBeUndefined();
  });
});

describe('signaturStimmt', () => {
  const rumpf = '{"runner":"mini-pc"}';

  it('erkennt die Signatur des Koordinator-Verfahrens über <zeitpunkt>.<rumpf>', () => {
    const kopf = { zeitpunkt: SEKUNDEN, signatur: signatur(GEHEIMNIS, SEKUNDEN, rumpf) };
    expect(signaturStimmt(GEHEIMNIS, kopf, rumpf)).toBe(true);
  });

  it('weist einen anderen Rumpf, Zeitpunkt oder ein anderes Geheimnis ab', () => {
    const kopf = { zeitpunkt: SEKUNDEN, signatur: signatur(GEHEIMNIS, SEKUNDEN, rumpf) };
    expect(signaturStimmt(GEHEIMNIS, kopf, '{"runner":"mini-pc" }')).toBe(false);
    expect(signaturStimmt(GEHEIMNIS, { ...kopf, zeitpunkt: SEKUNDEN + 1 }, rumpf)).toBe(false);
    expect(signaturStimmt(`${GEHEIMNIS}x`, kopf, rumpf)).toBe(false);
  });

  it('baut die Kopfzeilen für den Runner', () => {
    expect(signaturKopfzeilen(GEHEIMNIS, rumpf, JETZT)).toEqual({
      'x-cockpit-zeitpunkt': String(SEKUNDEN),
      'x-cockpit-signatur': signatur(GEHEIMNIS, SEKUNDEN, rumpf),
    });
  });
});
