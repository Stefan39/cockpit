/**
 * Das Wartungsfenster für automatische Cockpit-Image-Updates (COPI-235, `COCKPIT_WARTUNGSFENSTER`, ADR 0003 Nachtrag
 * „Fenster je Instanz"): Standard Dienstag 07:00–09:00 mit höchstens einem automatischen Antrag je Kalendertag,
 * `jederzeit` ohne Fenster und ohne Tagesgrenze. Der Schutz je Ziel (gescheitert, zurückgezogen) gilt in beiden Fällen.
 */
export const WARTUNGSFENSTER = ['di 07-09', 'jederzeit'] as const;

export type Wartungsfenster = (typeof WARTUNGSFENSTER)[number];

export const WARTUNGSFENSTER_STANDARD: Wartungsfenster = 'di 07-09';

/** Der Satz für die Einstellungsseite. */
export const WARTUNGSFENSTER_TEXT: Readonly<Record<Wartungsfenster, string>> = {
  'di 07-09': 'Dienstag 07:00–09:00',
  jederzeit: 'jederzeit',
};

/** Der Wert der Variable; fehlt sie oder ist leer, gilt der Standard. Jeder andere Wert wirft, ohne ihn zu wiederholen. */
export function wartungsfensterAus(roh: string | undefined): Wartungsfenster {
  if (roh === undefined || roh === '') {
    return WARTUNGSFENSTER_STANDARD;
  }
  const treffer = WARTUNGSFENSTER.find((erlaubt) => erlaubt === roh);
  if (treffer === undefined) {
    throw new Error(`Ungültiger Wert für COCKPIT_WARTUNGSFENSTER. Erlaubt: ${WARTUNGSFENSTER.map((erlaubt) => `"${erlaubt}"`).join(' oder ')}.`);
  }
  return treffer;
}
