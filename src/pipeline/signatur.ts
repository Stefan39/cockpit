/**
 * Die Anmeldung des Runners an der Pipeline-API (COPI-145): HMAC-SHA256 über `<zeitpunkt>.<roher Rumpf>` mit einem
 * gemeinsamen Geheimnis — dasselbe Verfahren wie der Webhook an den Koordinator (`chat/koordinator.ts`,
 * `docs/koordinator-api.md`), nur in die andere Richtung. Kopfzeilen: `x-cockpit-zeitpunkt` (Unix-Sekunden) und
 * `x-cockpit-signatur` (`sha256=<hex>`).
 *
 * Der Zeitpunkt darf höchstens `FENSTER_SEKUNDEN` von der Uhr des Cockpits abweichen (in beide Richtungen): eine
 * mitgeschnittene Anfrage lässt sich danach nicht mehr einspielen. Innerhalb des Fensters ist jede Anfrage so gebaut,
 * dass eine Wiederholung nichts anrichtet (`docs/pipeline-api.md`).
 *
 * Reine Funktionen, ohne Fastify und ohne Datenbank.
 */
import { timingSafeEqual } from 'node:crypto';
import { GEHEIMNIS_MINDESTENS, signatur } from '../chat/koordinator.js';

export const ZEITPUNKT_KOPF = 'x-cockpit-zeitpunkt';
export const SIGNATUR_KOPF = 'x-cockpit-signatur';

/** Das Replay-Fenster: fünf Minuten. */
export const FENSTER_SEKUNDEN = 5 * 60;

const ZEITPUNKT_FORM = /^[0-9]{1,12}$/;
const SIGNATUR_FORM = /^sha256=[0-9a-f]{64}$/;

export interface PipelineKonfiguration {
  readonly geheimnis: string;
}

/**
 * Das Geheimnis aus der Umgebung (`COCKPIT_PIPELINE_SECRET`). Ohne Wert gibt es keine Pipeline (`undefined`): jede
 * Anfrage an `/pipeline` bekommt dann 401. Ein zu kurzes Geheimnis hält den Start an.
 */
export function pipelineAusUmgebung(umgebung: { readonly pipelineGeheimnis: string | undefined }): PipelineKonfiguration | undefined {
  const geheimnis = umgebung.pipelineGeheimnis ?? '';
  if (geheimnis === '') {
    return undefined;
  }
  if (geheimnis.length < GEHEIMNIS_MINDESTENS) {
    throw new Error(`COCKPIT_PIPELINE_SECRET muss mindestens ${String(GEHEIMNIS_MINDESTENS)} Zeichen lang sein.`);
  }
  return { geheimnis };
}

/** Die beiden Kopfzeilen, wenn sie wohlgeformt sind und der Zeitpunkt im Fenster liegt. */
export interface SignaturKopf {
  readonly zeitpunkt: number;
  readonly signatur: string;
}

/** Prüft Form und Zeitfenster — vor dem Lesen des Rumpfs, ohne Geheimnis. */
export function kopfLesen(zeitpunkt: unknown, signaturWert: unknown, jetzt: Date): SignaturKopf | undefined {
  if (typeof zeitpunkt !== 'string' || typeof signaturWert !== 'string') {
    return undefined;
  }
  if (!ZEITPUNKT_FORM.test(zeitpunkt) || !SIGNATUR_FORM.test(signaturWert)) {
    return undefined;
  }
  const sekunden = Number(zeitpunkt);
  if (Math.abs(jetzt.getTime() / 1000 - sekunden) > FENSTER_SEKUNDEN) {
    return undefined;
  }
  return { zeitpunkt: sekunden, signatur: signaturWert };
}

/** Stimmt die Signatur zum rohen Rumpf? Vergleich in konstanter Zeit. */
export function signaturStimmt(geheimnis: string, kopf: SignaturKopf, rumpf: string): boolean {
  const erwartet = Buffer.from(signatur(geheimnis, kopf.zeitpunkt, rumpf));
  const erhalten = Buffer.from(kopf.signatur);
  return erwartet.length === erhalten.length && timingSafeEqual(erwartet, erhalten);
}

/** Die Kopfzeilen für einen Rumpf — für den Runner (und die Tests). */
export function signaturKopfzeilen(geheimnis: string, rumpf: string, jetzt: Date): Record<string, string> {
  const zeitpunkt = Math.floor(jetzt.getTime() / 1000);
  return { [ZEITPUNKT_KOPF]: String(zeitpunkt), [SIGNATUR_KOPF]: signatur(geheimnis, zeitpunkt, rumpf) };
}
