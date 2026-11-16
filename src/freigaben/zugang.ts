import { hatRecht, type Zugang, type ZugangLesen } from '../auth/berechtigung.js';
import { offeneZaehlen } from './ansicht.js';
import type { AbrufHolen } from './repowache.js';

/**
 * Reichert einen `ZugangLesen` um die Freigabe-Inbox an (COPI-139): Konten mit `technik_sehen` bekommen die Zahl der
 * offenen Entwürfe für die Navigation. Alle anderen laden nichts — die Kundensicht fragt die Repo-Wache nie. Antwortet
 * sie nicht, bleibt der Eintrag ohne Zahl, die Seite lädt trotzdem.
 */
export function zugangLesenMitFreigaben(lesen: ZugangLesen, abruf: AbrufHolen): ZugangLesen {
  return async (request) => {
    const zugang = await lesen(request);
    if (!zugang.angemeldet || !zugang.zweiterFaktorAktiv || !hatRecht(zugang, 'technik_sehen')) {
      return zugang;
    }
    const ergebnis = await abruf();
    return { ...zugang, freigaben: { offen: ergebnis.ok ? offeneZaehlen(ergebnis.eintraege) : undefined } } satisfies Zugang;
  };
}
