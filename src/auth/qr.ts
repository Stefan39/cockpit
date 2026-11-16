/**
 * QR-Code für die Einrichtung des zweiten Faktors (COPI-15).
 *
 * Wird **serverseitig** erzeugt und als inline-SVG in die Seite geschrieben:
 * Der Inhalt ist die `otpauth://`-URI samt Geheimnis, sie darf das System
 * weder an einen QR-Dienst noch an ein CDN-Skript verlassen. Kein JavaScript
 * im Browser, keine Fremd-Requests.
 *
 * Das Pfadformat (ein `M<x> <y>h<n>v1h-<n>z` je Reihe dunkler Module) ist
 * bewusst schlicht: `test/qr-lesen.ts` rechnet es zurück in Pixel und liest den
 * Code mit einem unabhängigen Dekodierer, so wie es ein Telefon täte.
 */
import qrcode from 'qrcode-generator';

/** Ruhezone um den Code in Modulen; die QR-Spezifikation verlangt vier. */
const RUHEZONE = 4;

const HTML_ERSATZ: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function attributMaskieren(wert: string): string {
  return wert.replace(/[&<>"]/g, (zeichen) => HTML_ERSATZ[zeichen] ?? zeichen);
}

/**
 * Liefert den QR-Code als SVG-Markup.
 *
 * Weißer Grund und schwarze Module, unabhängig vom Farbschema der Seite: Auf
 * dunklem Grund mit hellen Modulen liest kaum eine Kamera den Code. Das SVG
 * trägt nur eine `viewBox` und skaliert mit seinem Behälter; die Größe setzt das
 * Stylesheet (`.qr svg`). Kein `style`-Attribut (COPI-30): eine Content-Security-Policy
 * ohne `'unsafe-inline'` für Stile bliebe sonst nicht möglich.
 *
 * @param beschriftung Text für Screenreader; wird maskiert.
 */
export function qrCodeSvg(inhalt: string, beschriftung: string): string {
  if (inhalt.length === 0) {
    throw new Error('QR-Code ohne Inhalt');
  }

  // Typ 0 = kleinste passende Version, Fehlerkorrektur M (rund 15 %).
  const qr = qrcode(0, 'M');
  qr.addData(inhalt);
  qr.make();

  const module = qr.getModuleCount();
  const groesse = module + 2 * RUHEZONE;

  const reihen: string[] = [];
  for (let zeile = 0; zeile < module; zeile++) {
    let spalte = 0;
    while (spalte < module) {
      if (!qr.isDark(zeile, spalte)) {
        spalte++;
        continue;
      }
      const start = spalte;
      while (spalte < module && qr.isDark(zeile, spalte)) {
        spalte++;
      }
      const laenge = spalte - start;
      reihen.push(`M${start + RUHEZONE} ${zeile + RUHEZONE}h${laenge}v1h-${laenge}z`);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${groesse} ${groesse}" ` +
    `role="img" aria-label="${attributMaskieren(beschriftung)}" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="${groesse}" height="${groesse}" fill="#fff"/>` +
    `<path fill="#000" d="${reihen.join('')}"/>` +
    `</svg>`
  );
}
