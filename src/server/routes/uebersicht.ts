import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { standText } from '../../chat/ansicht.js';
import { hatRecht, type Zugang, type ZugangLesen } from '../../auth/berechtigung.js';
import { dashboardAnsicht } from '../../module/uebersicht-karten.js';
import { dashboardModuleLesen, kennzahlenKartenLesen } from '../../module/uebersicht-lesen.js';
import { betreuerUebersicht, kundenUebersicht } from '../../status/uebersicht.js';
import { betreuerWachenLesen, kundenWachenLesen } from '../../status/uebersicht-speicher.js';
import { betreuerMeldungenLesen, kundenMeldungenLesen } from '../../status/meldungen-speicher.js';
import { meldungenAnsicht } from '../../status/meldungen.js';
import { entscheidungAlsAufgabe, freigabeErlaubt, inHauptnavigation } from '../../module/block.js';
import type { Meldung } from '../../module/liste-detail.js';
import { offeneFreigaben } from '../../pipeline/freigaben.js';
import { aktiveModule } from '../../module/modul-speicher.js';
import { modulZugriffErlaubt } from '../../module/sichtbarkeit.js';
import { sichtbarePostfaecher } from '../../posteingang/lesen.js';
import { modulQuelle } from '../../posteingang/posteingang.js';
import { offeneZeilenLesen, standSichern } from '../../posteingang/posteingang-speicher.js';
import { ZU_TUN_HOECHSTENS, zuTunAnsicht, type ZuTunModul, type ZuTunSpalte } from '../../posteingang/zu-tun.js';
import { navigationFuerZugang } from '../navigation.js';

/** Wie viele Meldungen die Übersicht zeigt, wie im Prototyp. */
const LETZTE_MELDUNGEN = 3;

export interface UebersichtAbhaengigkeiten {
  /** Ohne Datenbank zeigt die Seite den Leerzustand (Tests und Entwicklung ohne Datenbank). */
  readonly pool?: pg.Pool;
  /** Ohne Zugangsleser (keine Anmeldung eingerichtet) gilt die Kundensicht. */
  readonly zugangLesen?: ZugangLesen;
  readonly jetzt: () => Date;
}

/**
 * Erste Seite der Informationsarchitektur (Architektur-Vorschlag Abschnitt 5, COPI-37): ein Satz Klartext-
 * Status, die Kacheln der Wachen und, was ein Mensch tun muss.
 *
 * **Zwei Sichten auf dieselben Daten.** Der Betreuer (Recht `rohbefunde_sehen`) sieht jede Wache mit ihrem
 * Rohbefund. Alle anderen — Betriebs-Admin, Mitarbeiter, ein Konto mit unbekannter Rolle — bekommen die
 * Kundensicht: **nur** kundensichtbare Befunde mit ihrem Klartext. Der Unterschied liegt schon in der
 * Abfrage (`uebersicht-speicher.ts`), nicht erst in der Vorlage: die Kundensicht lädt keinen Rohbefund.
 * Im Zweifel sieht ein Konto weniger.
 *
 * **Dashboard (COPI-81).** Sieht der Zugang mindestens ein aktives Modul mit `uebersicht:` (dieselbe Regel wie
 * die Modulseiten), wird die Seite ein Dashboard: Zustandsband, Kennzahlen, Kartenraster je Modul, Wochendiagramm
 * und „Letzte Meldungen"; die Wachen-Kacheln zeigt dann nur noch der Betreuer („Alle Wachen · nur Betreuer"). Ohne
 * ein solches Modul bleibt die Seite genau wie bisher.
 *
 * **Kennzahlen-Karten (COPI-98).** Ein Modul mit `ansicht: kennzahlen` und `uebersicht:` zeigt je eine Karte: den
 * Hauptwert des laufenden Monats, den Vormonat und die letzten 30 Tage. Diese Karten tragen keinen Zustand und zählen
 * deshalb nicht in Zustandsband, Kennzahlen und Wochendiagramm des Dashboards.
 *
 * **Zu tun (COPI-122).** Über allem anderen (nach Statuszeile und Kennzahlen) die Reihe „Zu tun": je angeheftetem
 * Modul mit `posteingang:` die offenen Zeilen, die ungelesenen Nachrichten und die wartenden Freigaben
 * (`posteingang/zu-tun.ts`) — mit und ohne Dashboard, denn Arbeit gibt es auch ohne Karten. Sie braucht den Posteingang
 * des Zugangs; ohne (keine Sitzung samt zweitem Faktor) fehlt sie. Scheitert das Lesen, fehlt nur sie.
 * Dazu (COPI-183) die Spalte „PR-Freigaben" mit den offenen Freigaben der Dev-Pipeline: nur mit `technik_sehen` (der
 * Betreuer) gelesen und nur, wenn es welche gibt.
 *
 * Die Rolle kommt aus der Datenbank (`zugangLesen`), nicht aus der Sitzung: eine Herabstufung wirkt sofort.
 * Die Seite ist rollenabhängig und deshalb `no-store`. Sie lädt nicht selbst nach: die Aktualisierung in
 * Echtzeit kommt mit E4 (SSE), bis dahin genügt ein Neuladen.
 */
/** Die Reihe „Zu tun" (siehe Kopf); leer ohne Posteingang oder wenn das Lesen scheitert. */
async function zuTunLesen(pool: pg.Pool, zugang: Zugang, jetzt: Date, log: Meldung): Promise<ZuTunSpalte[]> {
  const benutzerId = zugang.benutzerId;
  if (zugang.posteingang === undefined || benutzerId === undefined) {
    return [];
  }
  try {
    const sichtbar = (await aktiveModule(pool)).filter((modul) => modulZugriffErlaubt(zugang, modul));
    const angeheftet = sichtbar.flatMap((modul) => (inHauptnavigation(modul.block) && modul.block.posteingang !== undefined ? [{ modul, posteingang: modul.block.posteingang }] : []));
    const module = await Promise.all(
      angeheftet.map(async ({ modul, posteingang }): Promise<ZuTunModul> => {
        const bis = await standSichern(pool, benutzerId, modulQuelle(modul.kennung), jetzt);
        const gelesen = await offeneZeilenLesen(pool, modul.kennung, modul.block, posteingang, benutzerId, bis, ZU_TUN_HOECHSTENS, log);
        const { offen, zeilen } = gelesen.ok ? gelesen.wert : { offen: 0, zeilen: [] };
        return { kennung: modul.kennung, menuename: modul.block.menuename, statuswoerter: modul.block.statuswoerter, offen, zeilen };
      }),
    );
    const postfaecher = sichtbarePostfaecher(sichtbar, zugang).filter(({ modul }) => !inHauptnavigation(modul.block));
    return zuTunAnsicht({
      posteingang: zugang.posteingang,
      module,
      nachrichten: hatRecht(zugang, 'chat_nutzen') || postfaecher.length > 0,
      freigaben: sichtbar.some((modul) => freigabeErlaubt(modul.block) || entscheidungAlsAufgabe(modul.block)),
      pipelineFreigaben: hatRecht(zugang, 'technik_sehen') ? await offeneFreigaben(pool) : undefined,
      jetzt,
    });
  } catch (fehler) {
    log.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Übersicht: „Zu tun" nicht gelesen');
    return [];
  }
}

export function registerUebersichtRoute(app: FastifyInstance, abhaengigkeiten: UebersichtAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt } = abhaengigkeiten;

  app.get('/', async (request, reply) => {
    const zugang = zugangLesen ? await zugangLesen(request) : undefined;
    const sicht = zugang && hatRecht(zugang, 'rohbefunde_sehen') ? 'betreuer' : 'kunde';
    const module = pool && zugang ? await dashboardModuleLesen(pool, zugang, jetzt(), request.log) : [];
    const dashboard = module.length > 0 ? dashboardAnsicht(module, jetzt()) : undefined;
    // Im Dashboard braucht die Kundensicht die Wachen nicht mehr: sie lädt sie dann gar nicht erst.
    const uebersicht =
      sicht === 'betreuer'
        ? betreuerUebersicht(pool ? await betreuerWachenLesen(pool) : [], jetzt())
        : dashboard === undefined
          ? kundenUebersicht(pool ? await kundenWachenLesen(pool) : [], jetzt())
          : undefined;

    // „Letzte Meldungen" (COPI-43): dieselben Wechsel wie die Seite Meldungen, dieselbe Trennung je Sicht.
    const letzte = { art: undefined, suche: undefined, anzahl: LETZTE_MELDUNGEN };
    const meldungen = pool ? await (sicht === 'betreuer' ? betreuerMeldungenLesen : kundenMeldungenLesen)(pool, letzte) : [];

    // Kennzahlen-Module (COPI-98) melden je eine Karte an — unabhängig davon, ob es ein Dashboard gibt.
    const kennzahlenKarten = pool && zugang ? await kennzahlenKartenLesen(pool, zugang, jetzt(), request.log) : [];
    const zuTun = pool && zugang ? await zuTunLesen(pool, zugang, jetzt(), request.log) : [];

    const html = await app.render('uebersicht.eta', {
      titel: 'Übersicht',
      sicht,
      uebersicht,
      dashboard,
      kennzahlenKarten,
      zuTun,
      kennzahlenStand: standText(jetzt()),
      // Sichtbarer Stand der Seite, die sich selbst neu lädt (COPI-105).
      stand: standText(jetzt()),
      nav: navigationFuerZugang('uebersicht', zugang),
      letzteMeldungen: meldungenAnsicht(meldungen, jetzt()),
    });
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
}
