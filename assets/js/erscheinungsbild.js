/**
 * Das App-Symbol in den Einstellungen ändern (COPI-101). Reines JavaScript ohne Build-Schritt.
 *
 * Der Browser liest das gewählte Bild (PNG, JPEG oder WebP), zeigt es so, wie es auf iPhone, Android und im Browser-Tab
 * aussieht, und schickt nach „Speichern" ein PNG mit genau 512 × 512 Pixeln an das Cockpit — nie die Originaldatei.
 * Das Cockpit prüft es noch einmal streng und kodiert es neu (`src/pwa/png.ts`). Die Vorschau zeichnet das Skript in
 * `<canvas>`-Flächen, ohne `blob:`- oder `data:`-Adressen: die Sicherheitsregeln (CSP) bleiben, wie sie sind.
 *
 * Ohne Skript zeigt der Abschnitt nur das aktuelle Symbol und „Auf Standard zurücksetzen" (ein Formular).
 */

/** Was der Browser zuverlässig lesen kann. SVG nie: aktiver Inhalt. */
const TYPEN = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const HOECHSTENS_BYTES = 5 * 1024 * 1024;
export const MINDESTENS_PIXEL = 512;
export const GROESSE = 512;
/** Weiß: passt zu den meisten Logos. Steht hier, nicht in der Seite — die Views tragen keine festen Farbwerte. */
export const HINTERGRUND = '#ffffff';

/**
 * Prüft die gewählte Datei, bevor sie gelesen wird: SVG, ein anderer Typ oder zu groß. `undefined`, wenn sie passt.
 * @param {{ name: string, type: string, size: number }} datei
 */
export function dateiFehler(datei) {
  if (datei.type === 'image/svg+xml' || /\.svgz?$/i.test(datei.name)) {
    return 'svg';
  }
  if (!TYPEN.has(datei.type)) {
    return 'typ';
  }
  return datei.size > HOECHSTENS_BYTES ? 'gross' : undefined;
}

/**
 * Reicht das Bild für ein scharfes Symbol? Maßgeblich ist die längere Seite: ein breites Logo liegt mit Rand ohnehin
 * ganz im Symbol, seine kurze Seite füllt es nie.
 */
export function grossGenug(breite, hoehe) {
  return Math.max(breite, hoehe) >= MINDESTENS_PIXEL;
}

/** Die Meldung zu einem Fehler; `klein` nennt die Größe des Bildes. */
export function meldung(fehler, breite = 0, hoehe = 0) {
  switch (fehler) {
    case 'svg':
      return 'SVG geht nicht, bitte als PNG speichern.';
    case 'typ':
      return 'Das ist kein Bild, das sich lesen lässt. Möglich sind PNG, JPEG und WebP.';
    case 'gross':
      return 'Die Datei ist größer als 5 MB.';
    case 'klein':
      return `Das Bild ist zu klein (${breite} × ${hoehe} Pixel). Es braucht an der längeren Seite mindestens ${MINDESTENS_PIXEL} Pixel, sonst wird das Symbol unscharf.`;
    case 'unlesbar':
      return 'Das ist kein Bild, das sich lesen lässt.';
    default:
      return 'Das Speichern hat nicht geklappt. Bitte die Seite neu laden und noch einmal versuchen.';
  }
}

/**
 * Wohin das Bild auf die quadratische Fläche kommt.
 *
 * Ohne Rand füllt es die Fläche: ein quadratischer Ausschnitt aus der Mitte. Mit Rand bleibt es ganz und liegt in der
 * sicheren Zone für `maskable` — einem Kreis mit 40 % Radius um die Mitte, den Android nie wegschneidet: das Bild wird
 * so skaliert, dass seine Diagonale genau in diesen Kreis passt.
 * @param {number} breite
 * @param {number} hoehe
 * @param {boolean} rand
 */
export function zeichenFlaeche(breite, hoehe, rand, groesse = GROESSE) {
  if (!rand) {
    const seite = Math.min(breite, hoehe);
    return {
      quelle: { x: (breite - seite) / 2, y: (hoehe - seite) / 2, b: seite, h: seite },
      ziel: { x: 0, y: 0, b: groesse, h: groesse },
    };
  }
  const massstab = (0.8 * groesse) / Math.hypot(breite, hoehe);
  const b = breite * massstab;
  const h = hoehe * massstab;
  return { quelle: { x: 0, y: 0, b: breite, h: hoehe }, ziel: { x: (groesse - b) / 2, y: (groesse - h) / 2, b, h } };
}

function base64(blob) {
  return new Promise((erfuellt, verworfen) => {
    const leser = new FileReader();
    leser.onload = () => erfuellt(String(leser.result).split(',')[1] ?? '');
    leser.onerror = () => verworfen(new Error('lesen'));
    leser.readAsDataURL(blob);
  });
}

function einrichten(wurzel) {
  const teil = (name) => wurzel.querySelector(`[data-symbol-${name}]`);
  const datei = teil('datei');
  const fehler = teil('fehler');
  const farbe = teil('farbe');
  const speichern = teil('speichern');
  const titel = teil('titel');
  const stand = teil('stand');
  const titelVorher = titel.textContent;
  const standVorher = stand.textContent;
  const flaeche = document.createElement('canvas');
  flaeche.width = GROESSE;
  flaeche.height = GROESSE;
  let bild;

  farbe.value = HINTERGRUND;
  teil('ohne-skript').hidden = true;
  teil('wahl').hidden = false;

  function fehlerZeigen(text) {
    teil('fehlertext').textContent = text ?? '';
    fehler.hidden = text === undefined;
  }

  function zeichnen() {
    const kontext = flaeche.getContext('2d');
    kontext.fillStyle = farbe.value;
    kontext.fillRect(0, 0, GROESSE, GROESSE);
    const rand = wurzel.querySelector('[data-symbol-rand]:checked')?.value === 'mit';
    const { quelle, ziel } = zeichenFlaeche(bild.width, bild.height, rand);
    kontext.imageSmoothingQuality = 'high';
    kontext.drawImage(bild, quelle.x, quelle.y, quelle.b, quelle.h, ziel.x, ziel.y, ziel.b, ziel.h);
    for (const vorschau of wurzel.querySelectorAll('[data-symbol-flaeche]')) {
      const klein = vorschau.getContext('2d');
      klein.imageSmoothingQuality = 'high';
      klein.drawImage(flaeche, 0, 0, vorschau.width, vorschau.height);
    }
    teil('farbwert').textContent = farbe.value.toUpperCase();
  }

  function umschalten(auswahl) {
    teil('aktuell').hidden = auswahl;
    teil('neu').hidden = !auswahl;
    teil('optionen').hidden = !auswahl;
    teil('wahl').hidden = auswahl;
  }

  function verwerfen() {
    farbe.value = HINTERGRUND;
    bild?.close?.();
    bild = undefined;
    datei.value = '';
    titel.textContent = titelVorher;
    stand.textContent = standVorher;
    umschalten(false);
  }

  datei.addEventListener('change', async () => {
    fehlerZeigen(undefined);
    const gewaehlt = datei.files?.[0];
    if (!gewaehlt) {
      return;
    }
    const grund = dateiFehler(gewaehlt);
    if (grund) {
      datei.value = '';
      fehlerZeigen(meldung(grund));
      return;
    }
    let gelesen;
    try {
      gelesen = await window.createImageBitmap(gewaehlt);
    } catch {
      datei.value = '';
      fehlerZeigen(meldung('unlesbar'));
      return;
    }
    if (!grossGenug(gelesen.width, gelesen.height)) {
      datei.value = '';
      fehlerZeigen(meldung('klein', gelesen.width, gelesen.height));
      gelesen.close?.();
      return;
    }
    bild = gelesen;
    titel.textContent = `Vorschau mit ${gewaehlt.name}`;
    stand.textContent = 'Noch nicht gespeichert';
    umschalten(true);
    zeichnen();
  });

  for (const wahl of wurzel.querySelectorAll('[data-symbol-rand]')) {
    wahl.addEventListener('change', () => bild && zeichnen());
  }
  farbe.addEventListener('input', () => bild && zeichnen());
  teil('verwerfen').addEventListener('click', verwerfen);

  speichern.addEventListener('click', async () => {
    if (!bild) {
      return;
    }
    speichern.disabled = true;
    fehlerZeigen(undefined);
    try {
      const png = await new Promise((erfuellt) => flaeche.toBlob(erfuellt, 'image/png'));
      const antwort = await fetch(wurzel.dataset.symbol, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ png: await base64(png) }),
      });
      if (!antwort.ok) {
        throw new Error(String(antwort.status));
      }
      window.location.assign('/einstellungen?symbol=gespeichert');
    } catch {
      fehlerZeigen(meldung('server'));
      speichern.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') {
  const wurzel = document.querySelector('[data-symbol]');
  if (wurzel && typeof window.createImageBitmap === 'function') {
    einrichten(wurzel);
  }
}
