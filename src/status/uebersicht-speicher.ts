/**
 * Die Abfragen der Übersicht (COPI-37): was die Kundensicht und was die Betreuersicht aus der Datenbank
 * bekommen.
 *
 * Die Trennung liegt **in der Abfrage**, nicht erst in der Vorlage. Die Kundenabfrage liest gar keinen
 * Rohbefund und keine Herkunft in den Speicher, und eine Wache ohne kundensichtbaren Befund liefert sie
 * nicht einmal zurück: der Kunde erfährt nicht, dass es sie gibt. Ein Fehler in der Vorlage kann so nichts
 * zeigen, was nie geladen wurde.
 *
 * „Jüngster Befund" heißt zuletzt eingetroffen (`id`), nicht spätester Zeitpunkt: springt die Uhr zurück,
 * trägt der jüngste Befund einen früheren Zeitpunkt.
 */
import type pg from 'pg';
import { messwertAus } from './messwert.js';
import type { BetreuerZeile, KundenZeile } from './uebersicht.js';
import { befundStatusAus as status } from './zustand.js';

interface KundenSpalten {
  readonly kennung: string;
  readonly anzeigename: string | null;
  readonly takt_sekunden: number;
  readonly status: string;
  readonly text_kunde: string;
  readonly gemeldet_am: Date;
  readonly messwert: unknown;
}

/** Die Wachen, die einen kundensichtbaren Befund haben, mit genau diesem (dem jüngsten). */
export async function kundenWachenLesen(pool: pg.Pool): Promise<KundenZeile[]> {
  const ergebnis = await pool.query<KundenSpalten>(
    `SELECT w.kennung, w.anzeigename, w.takt_sekunden, s.status, s.text_kunde, s.gemeldet_am, s.messwert
       FROM cockpit.wache w
       JOIN LATERAL (
              SELECT b.status, b.text_kunde, b.gemeldet_am, b.messwert
                FROM cockpit.befund b
               WHERE b.wache = w.kennung AND b.kundensichtbar
               ORDER BY b.id DESC
               LIMIT 1
            ) s ON true`,
  );
  return ergebnis.rows.map((zeile) => ({
    kennung: zeile.kennung,
    anzeigename: zeile.anzeigename ?? undefined,
    taktSekunden: zeile.takt_sekunden,
    sichtbar: {
      status: status(zeile.status),
      textKunde: zeile.text_kunde,
      gemeldetAm: zeile.gemeldet_am,
      // Der Messwert desselben kundensichtbaren Befunds (COPI-83) — nie der eines internen.
      messwert: messwertAus(zeile.messwert),
    },
  }));
}

interface BetreuerSpalten {
  readonly kennung: string;
  readonly anzeigename: string | null;
  readonly takt_sekunden: number;
  readonly letzter_lauf: Date | null;
  readonly l_status: string | null;
  readonly l_text_intern: string | null;
  readonly l_text_kunde: string | null;
  readonly l_kundensichtbar: boolean | null;
  readonly l_gemeldet_am: Date | null;
}

/** Jede Wache, mit dem jüngsten Befund gleich welcher Sichtbarkeit. */
export async function betreuerWachenLesen(pool: pg.Pool): Promise<BetreuerZeile[]> {
  const ergebnis = await pool.query<BetreuerSpalten>(
    `SELECT w.kennung, w.anzeigename, w.takt_sekunden, w.letzter_lauf,
            l.status AS l_status, l.text_intern AS l_text_intern, l.text_kunde AS l_text_kunde,
            l.kundensichtbar AS l_kundensichtbar, l.gemeldet_am AS l_gemeldet_am
       FROM cockpit.wache w
       LEFT JOIN LATERAL (
              SELECT b.status, b.text_intern, b.text_kunde, b.kundensichtbar, b.gemeldet_am
                FROM cockpit.befund b
               WHERE b.wache = w.kennung
               ORDER BY b.id DESC
               LIMIT 1
            ) l ON true`,
  );
  return ergebnis.rows.map((zeile): BetreuerZeile => {
    const hatBefund = zeile.l_status !== null && zeile.l_text_intern !== null && zeile.l_kundensichtbar !== null && zeile.l_gemeldet_am !== null;
    return {
      kennung: zeile.kennung,
      anzeigename: zeile.anzeigename ?? undefined,
      taktSekunden: zeile.takt_sekunden,
      letzterLauf: zeile.letzter_lauf ?? undefined,
      letzter: hatBefund
        ? {
            status: status(zeile.l_status),
            textIntern: zeile.l_text_intern,
            textKunde: zeile.l_text_kunde ?? undefined,
            kundensichtbar: zeile.l_kundensichtbar,
            gemeldetAm: zeile.l_gemeldet_am,
          }
        : undefined,
    };
  });
}
