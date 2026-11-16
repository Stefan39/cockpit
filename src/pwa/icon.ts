/**
 * Das App-Symbol des Cockpits (COPI-58), im Code gezeichnet und als PNG kodiert — ohne Bildbibliothek und ohne
 * Binärdatei im Repo: ein Instrument (Ring, Zeiger, Nabe) in Weiß auf der Akzentfarbe des Prototyps (#2954E0).
 *
 * Randlos gefüllt, das Motiv liegt in der sicheren Zone der Mitte: so taugt dasselbe Bild als `maskable` für Android
 * (das Gerät schneidet Kreis oder Tropfen aus) und als `apple-touch-icon` (iOS rundet selbst). Kanten werden mit 4×4
 * Abtastungen je Pixel geglättet. Beim Start einmal erzeugt, danach aus dem Speicher ausgeliefert.
 */
import { pngSchreiben } from './png.js';

const HINTERGRUND = [0x29, 0x54, 0xe0] as const;
const MOTIV = [0xff, 0xff, 0xff] as const;

/** Die Form in Einheitskoordinaten (0…1), Mittelpunkt leicht unter der Mitte wie bei einem Rundinstrument. */
const MITTE = { x: 0.5, y: 0.53 };
const RING_AUSSEN = 0.3;
const RING_INNEN = 0.235;
const NABE = 0.055;
const ZEIGER_BREITE = 0.028;
/** Der Zeiger steht auf „zwei Uhr" — oben rechts, wie ein Instrument im grünen Bereich. */
const ZEIGER_WINKEL = -Math.PI / 4;
const ZEIGER_LAENGE = 0.2;

const ABTASTUNGEN = 4;

/** Abstand eines Punktes zur Strecke von `a` nach `b`. */
function abstandZurStrecke(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Liegt der Punkt (Einheitskoordinaten) auf dem Motiv? */
export function aufMotiv(x: number, y: number): boolean {
  const r = Math.hypot(x - MITTE.x, y - MITTE.y);
  if (r <= RING_AUSSEN && r >= RING_INNEN) {
    return true;
  }
  if (r <= NABE) {
    return true;
  }
  const spitzeX = MITTE.x + Math.cos(ZEIGER_WINKEL) * ZEIGER_LAENGE;
  const spitzeY = MITTE.y + Math.sin(ZEIGER_WINKEL) * ZEIGER_LAENGE;
  return abstandZurStrecke(x, y, MITTE.x, MITTE.y, spitzeX, spitzeY) <= ZEIGER_BREITE;
}

/** Das Symbol als PNG (RGB, 8 Bit) mit `groesse` × `groesse` Pixeln. */
export function iconPng(groesse: number): Buffer {
  const pixel = Buffer.alloc(groesse * groesse * 3);
  for (let py = 0; py < groesse; py++) {
    for (let px = 0; px < groesse; px++) {
      let treffer = 0;
      for (let sy = 0; sy < ABTASTUNGEN; sy++) {
        for (let sx = 0; sx < ABTASTUNGEN; sx++) {
          if (aufMotiv((px + (sx + 0.5) / ABTASTUNGEN) / groesse, (py + (sy + 0.5) / ABTASTUNGEN) / groesse)) {
            treffer++;
          }
        }
      }
      const anteil = treffer / (ABTASTUNGEN * ABTASTUNGEN);
      const stelle = (py * groesse + px) * 3;
      for (let kanal = 0; kanal < 3; kanal++) {
        pixel[stelle + kanal] = Math.round((HINTERGRUND[kanal] ?? 0) * (1 - anteil) + (MOTIV[kanal] ?? 0) * anteil);
      }
    }
  }
  return pngSchreiben({ breite: groesse, hoehe: groesse, pixel });
}
