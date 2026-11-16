/**
 * `GET /intern/zustand` (COPI-55): der Zustand der Instanz für den Koordinator-Agenten — **genau die Kundensicht**.
 *
 * ADR 6: Der Koordinator fasst den Zustand in Klartext zusammen, **nur `kundensichtbar: true`**, und gibt nie
 * Rohbefunde aus. Deshalb liest dieser Endpunkt nicht selbst, sondern nimmt dieselbe Abfrage und dieselbe Aufbereitung
 * wie die Übersicht des Kunden (`kundenWachenLesen`, `kundenUebersicht`): die Abfrage kennt nur kundensichtbare Befunde
 * und nur deren Klartext, ein Rohbefund kommt gar nicht erst in den Speicher dieses Prozesses. Was der Kunde nicht
 * sieht, kann der Koordinator nicht weitersagen.
 *
 * **Recht `zustand_lesen`.** Keine Kennungen, keine Rohbefunde, keine Quelle — nur, was auf der Übersicht steht.
 *
 * **`messwert` (COPI-83):** der Hauptmesswert desselben jüngsten kundensichtbaren Befunds, sonst `null` — ein
 * zusätzliches Feld, kein Bruch des Vertrags: die Abfrage liest ihn nur aus kundensichtbaren Befunden, ein
 * Messwert eines internen Befunds kommt so wenig vor wie dessen Rohbefund.
 */
import { kundenWachenLesen } from '../status/uebersicht-speicher.js';
import { kundenUebersicht } from '../status/uebersicht.js';
import type { InternAbhaengigkeiten, InternerRouter } from './zugang.js';

export function registriereZustandRoute(router: InternerRouter, abhaengigkeiten: InternAbhaengigkeiten): void {
  const { pool, jetzt } = abhaengigkeiten;

  router.route({
    methode: 'GET',
    url: '/zustand',
    scope: 'zustand_lesen',
    handler: async () => {
      const zeitpunkt = jetzt();
      const uebersicht = kundenUebersicht(await kundenWachenLesen(pool), zeitpunkt);
      return {
        stand: zeitpunkt.toISOString(),
        status: uebersicht.status,
        bereiche: uebersicht.kacheln.map((kachel) => ({
          name: kachel.name,
          farbe: kachel.farbe,
          status_wort: kachel.statusWort,
          text: kachel.text,
          geprueft: kachel.geprueft,
          ueberfaellig: kachel.ueberfaellig,
          messwert: kachel.messwert ?? null,
        })),
      };
    },
  });
}
