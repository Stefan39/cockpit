/**
 * Die Modulseiten (COPI-78, Epic E5): `/module` (die für die Rolle sichtbaren aktiven Module), `/module/:kennung`
 * (die Liste ihrer Zeilen) und `/module/:kennung/:id` (eine einzelne Zeile). „Modulseiten sind deklariert, nicht
 * programmiert" (ADR) — diese Routen kennen kein einziges Fachmodul, nur den geprüften Block und die View, die er
 * nennt (`module/liste-detail.ts`).
 *
 * **Eine Regel für alles, was nicht verraten werden soll.** Eine unbekannte oder ungültige Kennung, ein
 * inaktives Modul, eine Rolle ohne Zugriff und eine unbekannte `id` enden alle in derselben neutralen 404
 * (`modulZugriffErlaubt`, `module/sichtbarkeit.ts`) — nicht in vier verschiedenen Antworten, aus denen sich
 * ablesen ließe, was es gibt. Der Betreuer sieht immer alles.
 *
 * **Moduldaten werden nie automatisch verlinkt und immer escaped** (dieselbe Regel wie bei Gästeinhalten im
 * Chat, JAC-577): sie kommen aus einer Fach-View, die ein Agent oder ein anderes Team pflegt, nicht aus dem
 * Cockpit selbst.
 *
 * **Übernahme-Sperre (COPI-85).** `POST /module/:kennung/:id/uebernehmen` und `…/zurueckgeben` — zwei gewöhnliche
 * Formulare der Detailseite, die ohne Skript funktionieren und danach mit `303` auf die Detailseite zurückführen. Vor
 * jeder Änderung, in dieser Reihenfolge:
 *
 *   1. Sitzung, zweiter Faktor und Zugriff auf das Modul (`modulZiel`, dieselbe neutrale 404 wie die Seiten); die Rolle
 *      ist frisch aus der Datenbank gelesen (`zugangLesen`). Übernehmen nur, wenn der Block `eingriffe: [uebernehmen]`
 *      trägt — sonst dieselbe neutrale 404. Zurückgeben geht auch ohne: eine Sperre soll sich lösen lassen, selbst
 *      wenn das Modul den Eingriff inzwischen nicht mehr anbietet.
 *   2. **CSRF**, zweifach wie beim Update-Antrag: die Herkunft ist Pflicht (`herkunftBelegt`; fehlt sie oder ist sie
 *      fremd: `403`, nichts geändert), und das Formular trägt eine signierte Bestätigung (`auth/bestaetigung.ts`),
 *      gebunden an Konto, Modul, Vorgang und Aktion, zehn Minuten gültig. Ist sie abgelaufen, führt die Antwort ohne
 *      Änderung auf die Detailseite zurück, die einen neuen Knopf mit frischer Bestätigung zeigt.
 *   3. Die Zeile muss in der View existieren (ein Vorgang ist eine Zeile) — sonst die neutrale 404.
 *
 * **Postfächer (COPI-112).** Trägt der Block `posteingang:`, markiert die Detailseite ihre Zeile für dieses Konto als
 * gelesen (`modul_gelesen`), bevor sie die Navigation baut. Mit `?von=nachrichten` (aus Posteingang oder Postfach) führt
 * der Zurück-Knopf ins Postfach, und markiert ist „Nachrichten".
 *
 * **Antwort freigeben (COPI-90).** Trägt der Block `eingriffe: [antwort_freigeben]` mit `freigabe:`, zeigt die Detailseite
 * die jüngste Fassung des Entwurfs. „Freigeben" führt ohne Skript auf `?bestaetigen=freigabe` (Rückfrage), von dort
 * `POST …/freigeben`; `POST …/freigabe-zurueckziehen` nimmt sie bis zum Versand zurück. Dieselben Prüfungen wie bei der
 * Sperre (Zugriff, Herkunft, signierte Bestätigung, Zeile vorhanden); die Bestätigung bindet zusätzlich Fassung und Hash
 * des Texts, den die Seite gezeigt hat. Hat sich der Entwurf inzwischen geändert, wird nichts freigegeben und die Seite
 * sagt es. Ist der Vorgang übernommen, gibt es kein Freigeben (der Agent sendet dort ohnehin nicht).
 *
 * Ist der Vorgang schon übernommen, zeigt die Detailseite „bereits von <Name> übernommen" (kein Fehler). Eine fremde
 * Sperre zurückgeben darf nur, wer übernommen hat, sowie Betriebs-Admin und Betreuer; sonst `403`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { datumText, standText } from '../../chat/ansicht.js';
import { randomBytes } from 'node:crypto';
import type { Zugang, ZugangLesen } from '../../auth/berechtigung.js';
import { bestaetigungAusstellen, bestaetigungPruefen } from '../../auth/bestaetigung.js';
import { berlinerTag } from '../../chat/tageslimit.js';
import { modulDetailAbschnitte, modulDetailAnsicht, modulListeAnsicht, modulZeilenTitel, moduleAnsicht } from '../../module/ansicht.js';
import { ANSICHT_KENNZAHLEN, DARSTELLUNG_STANDARD, entscheidenErlaubt, freigabeErlaubt, inHauptnavigation, uebernehmenErlaubt } from '../../module/block.js';
import { anhangZeileAnsicht } from '../../module/anhang-ansicht.js';
import { anhaengeLesen } from '../../module/anhaenge.js';
import { entscheidungEntwurfLesen, type Entscheidung } from '../../module/entscheidung.js';
import { entwurfLesen, freigabenLesen, freigabeZustand, freigabeZurueckziehen, freigeben, type Entwurf, type Freigabe } from '../../module/freigabe.js';
import { zeitText } from '../../chat/ansicht.js';
import { FILTER_LEER, kennzahlenSeite } from '../../module/kennzahlen-ansicht.js';
import { hinweiseLesen, kennzahlenLesen, type KennzahlenFilter } from '../../module/kennzahlen-lesen.js';
import { ZEITRAUM_STANDARD, istZeitraum, zeitraumAus } from '../../module/kennzahlen-zeitraum.js';
import { modulListeLesen, modulListeUndZeileLesen, modulZeileVorhanden, type Meldung, type ModulZeileRoh } from '../../module/liste-detail.js';
import { kachelChips, kachelFilterAus, kachelnAnsicht, kachelnGefiltert } from '../../module/modul-kacheln.js';
import { aktiveModule, type AktivesModul } from '../../module/modul-speicher.js';
import { modulHandelnErlaubt, modulZugriffErlaubt } from '../../module/sichtbarkeit.js';
import { modulVerlaufLesen } from '../../module/uebersicht-lesen.js';
import {
  aktiveSperren,
  darfZurueckgeben,
  sperrMarke,
  uebernehmen,
  zurueckgeben,
  VORGANG_ID_HOECHSTENS,
  type VorgangSperre,
} from '../../module/vorgang-sperre.js';
import { navigationFuerZugang } from '../navigation.js';
import { rueckwegMitHerkunft, ZURUECK_MODULE } from '../../module/rueckweg.js';
import { anhangPfad, bildPfad } from './modul-anhaenge.js';
import { entscheidungenFuer, registerModulEntscheidungRoutes } from './modul-entscheidung.js';
import { detailPfad, modulHinweisSenden, modulZielFinder, seiteSenden, vorgangAktionPruefer, type ModulZiel } from './modul-ziel.js';
import { nichtGefunden } from './neutral.js';
import { mitFrischemPosteingang } from '../../posteingang/lesen.js';
import { postfachPfad, VON_NACHRICHTEN } from '../../posteingang/posteingang.js';
import { zeileGelesen } from '../../posteingang/posteingang-speicher.js';

export interface ModulSeitenAbhaengigkeiten {
  /** Ohne Datenbank gibt es keine Module: `/module` zeigt den Leerzustand, die anderen beiden Routen 404. */
  readonly pool?: pg.Pool;
  readonly zugangLesen?: ZugangLesen;
  readonly jetzt: () => Date;
}

/** Höchstlänge einer Zeilen-`id` in der Adresse (COPI-78): länger ist sicher kein gültiger Schlüssel. */
const ID_HOECHSTENS = VORGANG_ID_HOECHSTENS;

/** Höchstlänge eines Filterwerts in der Adresse einer Kennzahlen-Seite (COPI-98). */
const FILTER_HOECHSTENS = 200;

/** Die beiden Aktionen der Übernahme-Sperre (COPI-85) — zugleich der letzte Teil ihrer Adresse. */
type SperrAktion = 'uebernehmen' | 'zurueckgeben';

/** Der Zweck der signierten Bestätigung (`auth/bestaetigung.ts`): trennt sie von jeder anderen Aktion. */
const SPERRE_ZWECK = 'vorgang-sperre';

/** Hinweise der Detailseite nach einer Aktion (`?hinweis=`), nur diese festen Werte. */
const HINWEIS_BEREITS = 'bereits-uebernommen';
const HINWEIS_ABGELAUFEN = 'abgelaufen';
const HINWEIS_GEAENDERT = 'entwurf-geaendert';

/** Der Zweck der signierten Bestätigung beim Freigeben (COPI-90): getrennt von der Sperre. */
const FREIGABE_ZWECK = 'antwort-freigabe';

type FreigabeAktion = 'freigeben' | 'freigabe-zurueckziehen';

const FREIGABE_HINWEISE: Readonly<Record<string, string>> = {
  [HINWEIS_GEAENDERT]: 'Der Entwurf wurde inzwischen geändert. Es wurde nichts freigegeben; bitte die neue Fassung prüfen.',
};

const SPERRE_FEHLER = {
  nichtErlaubt: 'Diesen Vorgang kann nur zurückgeben, wer ihn übernommen hat, oder ein Betriebs-Admin. Es wurde nichts geändert.',
  nichtVerfuegbar: 'Dieses Modul ist gerade nicht verfügbar. Es wurde nichts geändert.',
  abgelaufen: 'Die Seite war zu lange geöffnet. Es wurde nichts geändert; bitte noch einmal wählen.',
} as const;

/** „Version 3 · eingespielt am 27.09.2026" — der Kopf der Modulseiten (COPI-84), als sichtbarer Text statt nur als Tooltip. */
function versionText(modul: AktivesModul): string {
  return `Version ${String(modul.version)} · eingespielt am ${datumText(modul.eingespieltAm)}`;
}

export function registerModulRoutes(app: FastifyInstance, abhaengigkeiten: ModulSeitenAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt } = abhaengigkeiten;
  // Nur im Speicher dieses Prozesses (wie beim Update-Antrag): nach einem Neustart gilt keine alte Bestätigung mehr.
  const schluessel = randomBytes(32);

  const modulZiel = modulZielFinder(app, pool, zugangLesen);

  app.get('/module', async (request, reply) => {
    const zugang = zugangLesen ? await zugangLesen(request) : undefined;
    const module = pool ? await aktiveModule(pool) : [];
    const sichtbar = module.filter((modul) => modulZugriffErlaubt(zugang, modul));

    const html = await app.render('module.eta', {
      titel: 'Module',
      nav: navigationFuerZugang('module', zugang),
      module: moduleAnsicht(sichtbar),
    });
    return seiteSenden(reply, html);
  });

  /**
   * Die Kacheln einer gelesenen Zeilenliste (`darstellung: kacheln`, COPI-82): derselbe Verlauf wie das Dashboard
   * (`modulVerlaufLesen`, `uebersicht-lesen.ts`) — nur für die gezeigten `ids`, in einer eigenen Katalogprüfung
   * und Transaktion mit eigenem Timeout. Scheitert der Verlauf, entfällt nur der Block „Letzte 7 Tage"
   * (`kachelnAnsicht`), die Kacheln selbst erscheinen trotzdem.
   */
  async function kacheln(
    db: pg.Pool,
    modul: AktivesModul,
    zeilen: readonly ModulZeileRoh[],
    sperren: ReadonlyMap<string, VorgangSperre>,
    jetztWert: Date,
    log: Meldung,
  ) {
    const verlauf = await modulVerlaufLesen(db, modul.kennung, modul.block, zeilenIds(zeilen), jetztWert, log);
    return kachelnAnsicht(modul.kennung, modul.block, zeilen, verlauf.ok ? verlauf.wert : undefined, jetztWert, sperren);
  }

  /** Die Formularfelder einer Aktion: Adresse und signierte Bestätigung, gebunden an Konto, Modul, Vorgang und Aktion. */
  function sperrFormular(konto: string, kennung: string, id: string, aktion: SperrAktion) {
    return {
      href: `${detailPfad(kennung, id)}/${aktion}`,
      ...bestaetigungAusstellen(schluessel, SPERRE_ZWECK, [konto, kennung, id, aktion], jetzt()),
    };
  }

  /**
   * Was die Detailseite zur Übernahme zeigt: die Sperre als Band, sonst den Knopf „Übernehmen" (nur, wenn der Block ihn
   * erlaubt), den Knopf „Zurückgeben" nur für den, der zurückgeben darf, und einen Hinweis nach einer Aktion.
   */
  function uebernahmeAnsicht(zugang: Zugang | undefined, modul: AktivesModul, id: string, sperre: VorgangSperre | undefined, hinweis: unknown) {
    const konto = zugang?.benutzerId;
    const handelnder = konto === undefined ? undefined : { id: konto, rolle: zugang?.rolle };
    const marke = sperre === undefined ? undefined : sperrMarke(sperre, jetzt());
    const bereits = hinweis === HINWEIS_BEREITS && marke !== undefined ? `Dieser Vorgang wurde bereits von ${marke.name} übernommen.` : undefined;
    return {
      sperre: marke,
      uebernehmen:
        handelnder !== undefined && sperre === undefined && uebernehmenErlaubt(modul.block) ? sperrFormular(handelnder.id, modul.kennung, id, 'uebernehmen') : undefined,
      zurueckgeben:
        handelnder !== undefined && sperre !== undefined && darfZurueckgeben(handelnder, sperre)
          ? sperrFormular(handelnder.id, modul.kennung, id, 'zurueckgeben')
          : undefined,
      hinweis: hinweis === HINWEIS_ABGELAUFEN ? SPERRE_FEHLER.abgelaufen : bereits,
    };
  }

  /** Die Formularfelder einer Freigabe-Aktion: gebunden an Konto, Modul, Vorgang, Aktion, Fassung und Hash. */
  function freigabeFormular(konto: string, kennung: string, id: string, aktion: FreigabeAktion, entwurf: Pick<Entwurf, 'fassung' | 'hash'>) {
    return {
      href: `${detailPfad(kennung, id)}/${aktion}`,
      fassung: String(entwurf.fassung),
      hash: entwurf.hash,
      ...bestaetigungAusstellen(schluessel, FREIGABE_ZWECK, [konto, kennung, id, aktion, String(entwurf.fassung), entwurf.hash], jetzt()),
    };
  }

  /**
   * Was die Entwurfskarte zeigt (COPI-90): den Entwurf, seinen Zustand und genau die Knöpfe, die gerade gehen — oder
   * `undefined` ohne Eingriff bzw. ohne Entwurf.
   */
  function freigabeAnsicht(zugang: Zugang | undefined, modul: AktivesModul, id: string, entwurf: Entwurf | undefined, freigaben: readonly Freigabe[], gesperrt: boolean, query: { bestaetigen?: unknown; hinweis?: unknown }) {
    if (!freigabeErlaubt(modul.block) || entwurf === undefined) {
      return undefined;
    }
    const konto = zugang?.benutzerId;
    const zustand = freigabeZustand(entwurf, freigaben);
    const jetztWert = jetzt();
    const freigabeText = (freigabe: Freigabe | undefined) => (freigabe === undefined ? undefined : { von: freigabe.von, am: zeitText(freigabe.am, jetztWert), fassung: freigabe.fassung });
    const offen = zustand.art === 'offen' && !gesperrt && konto !== undefined;
    const bestaetigen = offen && query.bestaetigen === 'freigabe';
    const freigegeben = zustand.art === 'freigegeben' ? zustand.freigabe : undefined;
    return {
      art: gesperrt && zustand.art === 'offen' ? 'uebernommen' : bestaetigen ? 'bestaetigen' : zustand.art,
      text: entwurf.text,
      fassung: entwurf.fassung,
      empfaenger: entwurf.empfaenger,
      betreff: entwurf.betreff,
      veraltet: zustand.art === 'offen' ? freigabeText(zustand.veraltet) : undefined,
      freigabe: freigabeText(freigegeben ?? (zustand.art === 'gesendet' ? zustand.freigabe : undefined)),
      gesendet: zustand.art === 'gesendet' ? zeitText(zustand.am, jetztWert) : undefined,
      freigebenHref: offen && !bestaetigen ? `${detailPfad(modul.kennung, id)}?bestaetigen=freigabe` : undefined,
      bestaetigen: bestaetigen && konto !== undefined ? freigabeFormular(konto, modul.kennung, id, 'freigeben', entwurf) : undefined,
      abbrechenHref: detailPfad(modul.kennung, id),
      zurueckziehen:
        freigegeben !== undefined && konto !== undefined && darfZurueckgeben({ id: konto, rolle: zugang?.rolle }, { uebernommenVon: freigegeben.vonId })
          ? freigabeFormular(konto, modul.kennung, id, 'freigabe-zurueckziehen', entwurf)
          : undefined,
      hinweis: typeof query.hinweis === 'string' ? FREIGABE_HINWEISE[query.hinweis] : undefined,
    };
  }

  /**
   * Die Seite eines Kennzahlen-Moduls (COPI-98): Zeitraum und Filter aus der Adresse, beides ohne Skript. Ein
   * unbekannter Zeitraum gilt als der Standard, ein Filter nur, wenn der Block eine Aufteilung mit `filter: true`
   * trägt — sein Wert geht nur als Parameter in die Abfrage. Scheitern die Hinweise, erscheinen die Zahlen trotzdem.
   */
  async function kennzahlenSenden(request: FastifyRequest<{ Querystring: { zeitraum?: unknown; filter?: unknown; von?: unknown } }>, reply: FastifyReply, ziel: ModulZiel): Promise<FastifyReply> {
    const { zugang, modul, pool: db } = ziel;
    const { block, kennung } = modul;
    const jetztWert = jetzt();
    const zeitraum = zeitraumAus(istZeitraum(request.query.zeitraum) ? request.query.zeitraum : ZEITRAUM_STANDARD, berlinerTag(jetztWert));
    const filterSpalte = block.aufteilungen?.find((aufteilung) => aufteilung.filter === true)?.name;
    const roh = request.query.filter;
    const filter: KennzahlenFilter | undefined =
      filterSpalte !== undefined && typeof roh === 'string' && roh.length > 0 && roh.length <= FILTER_HOECHSTENS
        ? { spalte: filterSpalte, wert: roh === FILTER_LEER ? null : roh }
        : undefined;

    const gelesen = await kennzahlenLesen(db, kennung, block, { spanne: zeitraum.spanne, vergleich: zeitraum.vergleich, filter }, request.log);
    const hinweise = gelesen.ok ? await hinweiseLesen(db, kennung, block, request.log) : undefined;
    const html = await app.render('modul-kennzahlen.eta', {
      titel: block.menuename,
      nav: navigationFuerZugang('module', zugang, kennung),
      versionText: versionText(modul),
      stand: standText(jetztWert),
      krume: [{ text: 'Module', href: '/module' }],
      zurueck: rueckwegMitHerkunft(ZURUECK_MODULE, request.query.von),
      verfuegbar: gelesen.ok,
      seite: gelesen.ok ? kennzahlenSeite(kennung, block, zeitraum, filter, gelesen.wert, hinweise?.ok === true ? hinweise.wert : []) : undefined,
    });
    return seiteSenden(reply, html);
  }

  app.get<{ Params: { kennung: string }; Querystring: { status?: unknown; zeitraum?: unknown; filter?: unknown; von?: unknown } }>('/module/:kennung', async (request, reply) => {
    const ziel = await modulZiel(request, reply);
    if (ziel === undefined) {
      return reply;
    }
    if (ziel.modul.block.ansicht === ANSICHT_KENNZAHLEN) {
      return kennzahlenSenden(request, reply, ziel);
    }
    const { zugang, modul, pool: db } = ziel;
    const gelesen = await modulListeLesen(db, modul.kennung, modul.block, request.log);
    const darstellung = modul.block.darstellung ?? DARSTELLUNG_STANDARD;
    const jetztWert = jetzt();
    const nav = navigationFuerZugang('module', zugang, modul.kennung);
    const zurueck = rueckwegMitHerkunft(ZURUECK_MODULE, request.query.von);
    const sperren = gelesen.ok ? await aktiveSperren(db, modul.kennung, zeilenIds(gelesen.wert)) : new Map<string, VorgangSperre>();

    if (darstellung === 'kacheln') {
      const alle = gelesen.ok ? await kacheln(db, modul, gelesen.wert, sperren, jetztWert, request.log) : [];
      const filter = kachelFilterAus(request.query);
      const html = await app.render('modul.eta', {
        titel: modul.block.menuename,
        nav,
        kennung: modul.kennung,
        versionText: versionText(modul),
        verfuegbar: gelesen.ok,
        darstellung,
        stand: standText(jetztWert),
        krume: [{ text: 'Module', href: '/module' }],
        zurueck,
        chips: kachelChips(modul.kennung, alle, filter),
        kacheln: kachelnGefiltert(alle, filter),
        gefiltert: filter.status !== undefined,
      });
      return seiteSenden(reply, html);
    }

    const html = await app.render('modul.eta', {
      titel: modul.block.menuename,
      nav,
      kennung: modul.kennung,
      versionText: versionText(modul),
      verfuegbar: gelesen.ok,
      darstellung,
      zurueck,
      zeilen: gelesen.ok ? modulListeAnsicht(modul.kennung, gelesen.wert, jetztWert, sperren, modul.block.statuswoerter, entscheidung.marken(modul, await entscheidungenFuer(db, modul, zeilenIds(gelesen.wert)))) : [],
    });
    return seiteSenden(reply, html);
  });

  app.get<{ Params: { kennung: string; id: string }; Querystring: { hinweis?: unknown; von?: unknown; bestaetigen?: unknown } }>('/module/:kennung/:id', async (request, reply) => {
    const ziel = await modulZiel(request, reply);
    if (ziel === undefined) {
      return reply;
    }
    const { zugang, modul, pool: db } = ziel;
    const { id } = request.params;
    // Ein Kennzahlen-Modul (COPI-98) hat keine Zeilen, also auch keine Detailseite.
    if (id.length === 0 || id.length > ID_HOECHSTENS || modul.block.ansicht === ANSICHT_KENNZAHLEN) {
      await nichtGefunden(app, reply);
      return reply;
    }

    // Eine Katalogprüfung, eine Transaktion, für Liste (linke Spalte am Desktop, Review COPI-78) und Zeile zugleich.
    const gelesen = await modulListeUndZeileLesen(db, modul.kennung, modul.block, id, request.log);
    if (gelesen.ok && gelesen.wert.zeile === undefined) {
      await nichtGefunden(app, reply);
      return reply;
    }
    const zeile = gelesen.ok ? gelesen.wert.zeile : undefined;
    // Die Sperren der Liste links und dieser Zeile in einer Abfrage (COPI-85).
    const sperren = gelesen.ok ? await aktiveSperren(db, modul.kennung, [...zeilenIds(gelesen.wert.zeilen), id]) : new Map<string, VorgangSperre>();

    // Geöffnet heißt gelesen (COPI-112), und zwar vor dem Bau der Navigation: sonst zählte das Badge diese Zeile noch.
    const postfach = modul.block.posteingang !== undefined;
    const konto = zugang?.benutzerId;
    let navZugang = zugang;
    if (postfach && zeile !== undefined && konto !== undefined && zugang !== undefined) {
      try {
        await zeileGelesen(db, konto, modul.kennung, id);
        navZugang = await mitFrischemPosteingang(db, zugang, jetzt(), request.log);
      } catch (fehler) {
        // Der Lesestand ist eine Randnotiz: scheitert er, zeigt die Seite trotzdem den Vorgang.
        request.log.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Posteingang: Zeile nicht als gelesen markiert');
      }
    }
    // Ein angeheftetes Modul (COPI-121) ist kein Postfach unter „Nachrichten": seine Detailseite bleibt eine Modulseite.
    const ausNachrichten = postfach && request.query.von === VON_NACHRICHTEN && !inHauptnavigation(modul.block);
    // Antwort freigeben (COPI-90): Entwurf und Freigaben nur, wenn der Block den Eingriff trägt.
    const mitFreigabe = gelesen.ok && zeile !== undefined && freigabeErlaubt(modul.block);
    const entwurf = mitFreigabe ? await entwurfLesen(db, modul.kennung, modul.block, id, request.log) : undefined;
    // Entscheiden (COPI-91): die geltenden Entscheidungen der Liste links und dieser Zeile, dazu der Entwurf des Agenten.
    const geltende = gelesen.ok ? await entscheidungenFuer(db, modul, [...zeilenIds(gelesen.wert.zeilen), id]) : new Map<string, Entscheidung>();
    const entscheidungEntwurf = gelesen.ok && zeile !== undefined && entscheidenErlaubt(modul.block) ? await entscheidungEntwurfLesen(db, modul.kennung, modul.block, id, request.log) : undefined;
    // Anhänge (COPI-110): scheitert ihr Lesen, fehlt nur die Liste — die Zeile selbst erscheint trotzdem.
    const anhaenge = gelesen.ok && zeile !== undefined ? await anhaengeLesen(db, modul.kennung, modul.block, id, request.log) : undefined;
    const freigaben = entwurf?.ok === true && entwurf.wert !== undefined ? await freigabenLesen(db, modul.kennung, id) : [];
    // Ohne Recht zu handeln (Betreuer mit nur lesendem Zugriff, COPI-134) bauen die Karten keine Formulare: ohne Zugang
    // gibt es kein Konto und damit keine Aktion — Inhalte, Sperre und geltende Entscheidung bleiben sichtbar.
    const handelnd = modulHandelnErlaubt(zugang, modul) ? zugang : undefined;

    const html = await app.render('modul-detail.eta', {
      titel: zeile ? modulZeilenTitel(zeile) || modul.block.menuename : modul.block.menuename,
      nav: navigationFuerZugang(ausNachrichten ? 'chat' : 'module', navZugang, modul.kennung),
      kennung: modul.kennung,
      versionText: versionText(modul),
      zurueck: ausNachrichten
        ? { href: postfachPfad(modul.kennung), ziel: modul.block.menuename }
        : rueckwegMitHerkunft({ href: `/module/${encodeURIComponent(modul.kennung)}`, ziel: 'Liste' }, request.query.von),
      id,
      verfuegbar: gelesen.ok,
      zeilen: gelesen.ok ? modulListeAnsicht(modul.kennung, gelesen.wert.zeilen, jetzt(), sperren, modul.block.statuswoerter, entscheidung.marken(modul, geltende)) : [],
      felder: zeile ? modulDetailAnsicht(modul.block.spalten, zeile, jetzt(), modul.block.statuswoerter) : [],
      abschnitte: zeile ? modulDetailAbschnitte(modul.block.spalten, zeile) : [],
      uebernahme: uebernahmeAnsicht(handelnd, modul, id, sperren.get(id), request.query.hinweis),
      freigabe: freigabeAnsicht(handelnd, modul, id, entwurf?.ok === true ? entwurf.wert : undefined, freigaben, sperren.has(id), request.query),
      entscheidung: zeile ? entscheidung.ansicht(handelnd, modul, id, geltende.get(id), entscheidungEntwurf?.ok === true ? entscheidungEntwurf.wert : undefined, request.query.hinweis) : undefined,
      anhaenge: anhaenge?.ok === true ? anhaenge.wert.map((anhang) => anhangZeileAnsicht(anhang, anhangPfad(modul.kennung, id, anhang.id))) : [],
      // Bildvorschau (COPI-124): nur mit `bildvorschau: true` und nur erkannte Bilder (PNG, JPEG, WebP).
      bilder:
        anhaenge?.ok === true && modul.block.bildvorschau === true
          ? anhaenge.wert.filter((anhang) => anhang.einstufung.bild !== undefined).map((anhang) => ({ name: anhang.dateiname, src: bildPfad(modul.kennung, id, anhang.id) }))
          : [],
    });
    return seiteSenden(reply, html);
  });

  function sperrHinweis(reply: FastifyReply, zugang: Zugang | undefined, status: 403 | 503, text: string, zurueck: string): Promise<FastifyReply> {
    return modulHinweisSenden(app, reply, zugang, status, text, zurueck);
  }

  const vorgangAktionPruefen = vorgangAktionPruefer(app, modulZiel);
  // Entscheiden (COPI-91): eigene Routen, die Karte der Detailseite kommt von dort (dieselben Schlüssel).
  const entscheidung = registerModulEntscheidungRoutes(app, jetzt, vorgangAktionPruefen);

  /** Beide Aktionen der Übernahme-Sperre (COPI-85): dieselben Prüfungen in derselben Reihenfolge (siehe Kopf). */
  async function sperrAktion(
    request: FastifyRequest<{ Params: { kennung: string; id: string }; Body: { bis?: unknown; token?: unknown } | undefined }>,
    reply: FastifyReply,
    aktion: SperrAktion,
  ): Promise<FastifyReply> {
    const geprueft = await vorgangAktionPruefen(request, reply, (modul) => aktion !== 'uebernehmen' || uebernehmenErlaubt(modul.block), `Übernahme-Sperre (${aktion})`);
    if (geprueft === undefined) {
      return reply;
    }
    const { zugang, modul, db, konto, id, detail } = geprueft;
    if (!bestaetigungPruefen(schluessel, request.body ?? {}, SPERRE_ZWECK, [konto, modul.kennung, id, aktion], jetzt())) {
      request.log.warn({ aktion }, 'Übernahme-Sperre: Bestätigung ungültig oder abgelaufen');
      return reply.redirect(`${detail}?hinweis=${HINWEIS_ABGELAUFEN}`, 303);
    }
    const vorhanden = await modulZeileVorhanden(db, modul.kennung, modul.block, id, request.log);
    if (!vorhanden.ok) {
      return sperrHinweis(reply, zugang, 503, SPERRE_FEHLER.nichtVerfuegbar, detail);
    }
    if (!vorhanden.wert) {
      await nichtGefunden(app, reply);
      return reply;
    }

    const vorgang = { modul: modul.kennung, vorgangId: id };
    const handelnder = { id: konto, rolle: zugang?.rolle };
    if (aktion === 'uebernehmen') {
      const ergebnis = await uebernehmen(db, vorgang, handelnder);
      request.log.info({ aktion, gelungen: ergebnis.ok }, 'Übernahme-Sperre');
      return reply.redirect(ergebnis.ok ? detail : `${detail}?hinweis=${HINWEIS_BEREITS}`, 303);
    }
    const ergebnis = await zurueckgeben(db, vorgang, handelnder);
    if (!ergebnis.ok && ergebnis.grund === 'nicht_erlaubt') {
      request.log.warn({ aktion }, 'Übernahme-Sperre: fremde Sperre, Rückgabe nicht erlaubt');
      return sperrHinweis(reply, zugang, 403, SPERRE_FEHLER.nichtErlaubt, detail);
    }
    request.log.info({ aktion, gelungen: ergebnis.ok }, 'Übernahme-Sperre');
    return reply.redirect(detail, 303);
  }

  /**
   * Freigeben und Zurückziehen (COPI-90): dieselben Prüfungen wie bei der Sperre; die Bestätigung bindet Fassung und
   * Hash, die die Seite gezeigt hat. Danach wird der Entwurf neu gelesen: hat er sich geändert, wird nichts freigegeben.
   */
  async function freigabeAktion(
    request: FastifyRequest<{ Params: { kennung: string; id: string }; Body: { bis?: unknown; token?: unknown; fassung?: unknown; hash?: unknown } | undefined }>,
    reply: FastifyReply,
    aktion: FreigabeAktion,
  ): Promise<FastifyReply> {
    const geprueft = await vorgangAktionPruefen(request, reply, (modul) => freigabeErlaubt(modul.block), `Freigabe (${aktion})`);
    if (geprueft === undefined) {
      return reply;
    }
    const { zugang, modul, db, konto, id, detail } = geprueft;
    const body = request.body ?? {};
    const fassung = typeof body.fassung === 'string' && /^[1-9][0-9]{0,8}$/.test(body.fassung) ? body.fassung : '';
    const hash = typeof body.hash === 'string' && /^[0-9a-f]{64}$/.test(body.hash) ? body.hash : '';
    if (fassung === '' || hash === '' || !bestaetigungPruefen(schluessel, body, FREIGABE_ZWECK, [konto, modul.kennung, id, aktion, fassung, hash], jetzt())) {
      request.log.warn({ aktion }, 'Freigabe: Bestätigung ungültig oder abgelaufen');
      return reply.redirect(`${detail}?hinweis=${HINWEIS_ABGELAUFEN}`, 303);
    }
    const entwurf = await entwurfLesen(db, modul.kennung, modul.block, id, request.log);
    if (!entwurf.ok) {
      return sperrHinweis(reply, zugang, 503, SPERRE_FEHLER.nichtVerfuegbar, detail);
    }
    if (entwurf.wert === undefined) {
      await nichtGefunden(app, reply);
      return reply;
    }
    const vorgang = { modul: modul.kennung, vorgangId: id };
    if (aktion === 'freigabe-zurueckziehen') {
      const freigabe = (await freigabenLesen(db, modul.kennung, id)).find((kandidat) => kandidat.zurueckgezogenAm === undefined && String(kandidat.fassung) === fassung);
      if (freigabe !== undefined && !darfZurueckgeben({ id: konto, rolle: zugang?.rolle }, { uebernommenVon: freigabe.vonId })) {
        return sperrHinweis(reply, zugang, 403, 'Diese Freigabe kann nur zurückziehen, wer sie erteilt hat, oder ein Betriebs-Admin. Es wurde nichts geändert.', detail);
      }
      const ok = entwurf.wert.gesendetAm === undefined && (await freigabeZurueckziehen(db, vorgang, Number(fassung), konto));
      request.log.info({ aktion, gelungen: ok }, 'Freigabe');
      return reply.redirect(detail, 303);
    }
    if (String(entwurf.wert.fassung) !== fassung || entwurf.wert.hash !== hash) {
      request.log.info({ aktion }, 'Freigabe: Entwurf hat sich geändert');
      return reply.redirect(`${detail}?hinweis=${HINWEIS_GEAENDERT}`, 303);
    }
    if (entwurf.wert.gesendetAm !== undefined || (await aktiveSperren(db, modul.kennung, [id])).has(id)) {
      return reply.redirect(detail, 303);
    }
    const ergebnis = await freigeben(db, vorgang, entwurf.wert, konto);
    request.log.info({ aktion, gelungen: ergebnis.ok }, 'Freigabe');
    return reply.redirect(detail, 303);
  }

  for (const aktion of ['freigeben', 'freigabe-zurueckziehen'] as const) {
    app.post<{ Params: { kennung: string; id: string }; Body: { bis?: unknown; token?: unknown; fassung?: unknown; hash?: unknown } | undefined }>(
      `/module/:kennung/:id/${aktion}`,
      (request, reply) => freigabeAktion(request, reply, aktion),
    );
  }

  for (const aktion of ['uebernehmen', 'zurueckgeben'] as const) {
    app.post<{ Params: { kennung: string; id: string }; Body: { bis?: unknown; token?: unknown } | undefined }>(
      `/module/:kennung/:id/${aktion}`,
      (request, reply) => sperrAktion(request, reply, aktion),
    );
  }
}

/** Die `id` jeder gelesenen Zeile, als Text — für Verlauf und Sperren derselben Zeilen. */
function zeilenIds(zeilen: readonly ModulZeileRoh[]): string[] {
  return zeilen.map((zeile) => String(zeile.werte.id));
}
