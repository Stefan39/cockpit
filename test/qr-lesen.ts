/**
 * Liest einen QR-Code aus dem SVG einer Seite — so wie es ein Telefon täte,
 * nämlich über einen **unabhängigen** Dekodierer (jsQR) statt über dieselbe
 * Bibliothek, die den Code erzeugt hat.
 *
 * Kein Testfall, sondern Werkzeug: Seit COPI-15 steht das TOTP-Geheimnis nur
 * noch im QR-Code und nicht mehr als Text auf der Seite. Die Tests holen es
 * deshalb genau dort ab, wo auch die Authenticator-App es abholt.
 *
 * Das SVG wird über das Pfadformat aus `src/auth/qr.ts` zurück in Pixel
 * gerechnet (ein `M<x> <y>h<n>v1h-<n>z` je Reihe dunkler Module).
 */
import jsQR from 'jsqr';

/** Pixel je Modul beim Zurückrechnen; genug Auflösung für einen sauberen Scan. */
const MASSSTAB = 6;

const VIEWBOX = /viewBox="0 0 (\d+) (\d+)"/;
const REIHE = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;

export function qrSvgLesen(svg: string): string {
  const box = VIEWBOX.exec(svg);
  const groesse = Number(box?.[1]);
  if (!Number.isInteger(groesse) || groesse <= 0) {
    throw new Error('SVG ohne gültige viewBox');
  }

  const kante = groesse * MASSSTAB;
  // Weißer, deckender Grund; dunkle Module werden schwarz darübergemalt.
  const pixel = new Uint8ClampedArray(kante * kante * 4).fill(255);

  for (const treffer of svg.matchAll(REIHE)) {
    const x = Number(treffer[1]);
    const y = Number(treffer[2]);
    const breite = Number(treffer[3]);
    for (let py = y * MASSSTAB; py < (y + 1) * MASSSTAB; py++) {
      for (let px = x * MASSSTAB; px < (x + breite) * MASSSTAB; px++) {
        const index = (py * kante + px) * 4;
        pixel[index] = 0;
        pixel[index + 1] = 0;
        pixel[index + 2] = 0;
      }
    }
  }

  // `jsqr` ist ein CommonJS-Paket: Unter NodeNext beschreiben seine Typen den
  // Default-Import als Namensraum mit `default`, und zur Laufzeit trägt die
  // importierte Funktion dieselbe Eigenschaft. `.default` stimmt in beiden.
  const ergebnis = jsQR.default(pixel, kante, kante);
  if (!ergebnis) {
    throw new Error('QR-Code nicht lesbar');
  }
  return ergebnis.data;
}

/**
 * Der QR-Code auf einer Seite: das SVG mit `role="img"` (so baut ihn `src/auth/qr.ts`). Seit dem
 * Layout (COPI-30) tragen Kopf und Hinweisboxen eigene Symbol-SVGs; das erste `<svg>` der Seite
 * ist deshalb nicht mehr der QR-Code.
 */
const QR_SVG = /<svg\b[^>]*\brole="img"[\s\S]*?<\/svg>/;

/** Steht auf der Seite ein QR-Code? */
export function enthaeltQrCode(html: string): boolean {
  return QR_SVG.test(html);
}

/** Holt das QR-SVG aus einer HTML-Seite und liest den QR-Code darin. */
export function qrAusSeiteLesen(html: string): string {
  const svg = QR_SVG.exec(html)?.[0];
  if (!svg) {
    throw new Error('Kein QR-Code (SVG mit role="img") auf der Seite');
  }
  return qrSvgLesen(svg);
}
