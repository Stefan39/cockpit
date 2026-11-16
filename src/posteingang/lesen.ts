/**
 * Liest den Posteingang eines Kontos (COPI-112) und reichert den Zugangsleser damit an — wie `moduleSichtbar`
 * (COPI-78) und `updateVerfuegbar` (COPI-84): jede Seite bekommt Badge und Zahl in der Navigation, ohne dass ihre Route
 * davon weiß.
 *
 * **Dieselben Regeln wie die Seiten, keine zweiten.** Chat nur mit dem Recht `chat_nutzen` (wie `/chat`), ein Postfach
 * nur, wenn `modulZugriffErlaubt` das Modul zeigt (wie `/module/:kennung`), Meldungen in der Sicht der Seite Meldungen
 * (Rohbefunde nur mit `rohbefunde_sehen`, sonst nur kundensichtbare im Klartext).
 *
 * **Aufgaben (COPI-124).** Module mit `entscheidung.aufgabe` melden jede offene Zeile (rot oder gelb) unter „Freigaben",
 * neben den Antwortentwürfen (COPI-90): eine Aufgabe zählt, bis sie erledigt ist.
 *
 * **Eine Randnotiz, kein Grund zum Scheitern.** Scheitert eine Quelle, fehlt nur sie (Grund im Log); scheitert alles,
 * zeigt die Seite keinen Posteingang. Gelesen wird nur für angezeigte Seiten (`GET`, kein Ereignis-Strom): ein Formular
 * oder ein offener Strom braucht keinen.
 */
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hatRecht, type Zugang, type ZugangLesen } from '../auth/berechtigung.js';
import { absenderText } from '../chat/ansicht.js';
import { ungeleseneGesamt, ungeleseneNachrichten } from '../chat/nachricht-speicher.js';
import { aktiveModule, type AktivesModul } from '../module/modul-speicher.js';
import { modulListeLesen, type Meldung } from '../module/liste-detail.js';
import { modulHandelnErlaubt, modulZugriffErlaubt } from '../module/sichtbarkeit.js';
import { betreuerMeldungenLesen, kundenMeldungenLesen } from '../status/meldungen-speicher.js';
import { NAME_OHNE_ANZEIGENAME } from '../status/uebersicht.js';
import {
  modulQuelle,
  posteingangZielPfad,
  posteingangAnsicht,
  POSTEINGANG_HOECHSTENS,
  QUELLE_MELDUNGEN,
  type PosteingangAnsicht,
  type PosteingangEintrag,
  type PosteingangQuelle,
  type PosteingangTeil,
} from './posteingang.js';
import { postfachUngelesenLesen, standSichern } from './posteingang-speicher.js';
import { entscheidungAlsAufgabe, freigabeErlaubt, inHauptnavigation } from '../module/block.js';
import { offeneFreigabenLesen } from '../module/freigabe.js';

/** So viele Wechsel liest der Posteingang höchstens aus den Meldungen — genug für Zahl und Liste. */
const MELDUNGEN_HOECHSTENS = 50;

/** Ein Modul mit `posteingang:`, das dieser Zugang sehen darf. */
export interface Postfach {
  readonly modul: AktivesModul;
  readonly posteingang: NonNullable<AktivesModul['block']['posteingang']>;
}

/** Die Postfächer, die dieser Zugang sehen darf, nach Menüname. */
export function sichtbarePostfaecher(module: readonly AktivesModul[], zugang: Zugang | undefined): Postfach[] {
  return module
    .flatMap((modul) => (modul.block.posteingang !== undefined && modulZugriffErlaubt(zugang, modul) ? [{ modul, posteingang: modul.block.posteingang }] : []))
    .sort((a, b) => a.modul.block.menuename.localeCompare(b.modul.block.menuename, 'de'));
}

async function chatTeil(pool: pg.Pool, benutzerId: string): Promise<PosteingangTeil> {
  const [anzahl, ungelesen] = await Promise.all([ungeleseneGesamt(pool, benutzerId), ungeleseneNachrichten(pool, benutzerId, POSTEINGANG_HOECHSTENS)]);
  return {
    anzahl,
    eintraege: ungelesen.map(({ nachricht, kanalArt }) => ({
      quelle: 'chat',
      herkunft: kanalArt === 'assistent' ? 'Chat · Assistent' : 'Chat · Team',
      titel: absenderText(nachricht, false),
      anriss: nachricht.inhalt ?? '',
      zeit: nachricht.erstelltAm,
      href: kanalArt === 'assistent' ? '/chat' : '/chat/team',
    })),
  };
}

async function postfachTeil(pool: pg.Pool, benutzerId: string, postfaecher: readonly Postfach[], jetzt: Date, log: Meldung | undefined): Promise<PosteingangTeil> {
  const teile = await Promise.all(
    postfaecher.map(async ({ modul, posteingang }) => {
      const bis = await standSichern(pool, benutzerId, modulQuelle(modul.kennung), jetzt);
      const gelesen = await postfachUngelesenLesen(pool, modul.kennung, modul.block, posteingang, benutzerId, bis, log);
      if (!gelesen.ok) {
        return { kennung: modul.kennung, anzahl: 0, eintraege: [] };
      }
      return {
        kennung: modul.kennung,
        anzahl: gelesen.wert.anzahl,
        eintraege: gelesen.wert.zeilen.map((zeile) => ({
          quelle: 'postfach' as const,
          herkunft: modul.block.menuename,
          titel: zeile.titel,
          anriss: zeile.anriss,
          zeit: zeile.zeit ?? jetzt,
          href: posteingangZielPfad(modul.kennung, zeile.id, inHauptnavigation(modul.block)),
          kennung: modul.kennung,
        })),
      };
    }),
  );
  return {
    anzahl: teile.reduce((summe, teil) => summe + teil.anzahl, 0),
    eintraege: teile.flatMap((teil) => teil.eintraege),
    je: Object.fromEntries(teile.map((teil) => [teil.kennung, teil.anzahl])),
  };
}

/** „Jana Peters <j.peters@example.org>" → „Jana Peters"; ohne Namen die Adresse. */
export function empfaengerName(empfaenger: string): string {
  const name = empfaenger.replace(/\s*<[^>]*>\s*$/, '').trim();
  return name.length > 0 ? name : empfaenger.replace(/[<>]/g, '').trim();
}

/**
 * Offene Freigaben (COPI-90) in Modulen mit `antwort_freigeben`, in denen der Zugang handeln darf — Aufgaben, kein
 * Lesestand. Ein Betreuer mit nur lesendem Zugriff (COPI-134) bekommt keine Aufgabe, die er nicht erledigen kann.
 */
async function freigabeTeil(pool: pg.Pool, module: readonly AktivesModul[], zugang: Zugang, jetzt: Date, log: Meldung | undefined): Promise<PosteingangTeil> {
  const teile = await Promise.all(
    module
      .filter((modul) => freigabeErlaubt(modul.block) && modulHandelnErlaubt(zugang, modul))
      .map(async (modul) => {
        const gelesen = await offeneFreigabenLesen(pool, modul.kennung, modul.block, POSTEINGANG_HOECHSTENS, log);
        if (!gelesen.ok) {
          return [];
        }
        return gelesen.wert.zeilen.map((zeile) => ({
          quelle: 'freigabe' as const,
          herkunft: `Freigabe nötig · ${modul.block.menuename}`,
          titel: zeile.empfaenger === undefined ? zeile.titel : `Antwort an ${empfaengerName(zeile.empfaenger)}: ${zeile.titel}`,
          anriss: `Ein Antwortentwurf (Fassung ${String(zeile.fassung)}) wartet auf deine Freigabe.`,
          zeit: zeile.seit ?? jetzt,
          href: posteingangZielPfad(modul.kennung, zeile.id, modul.block.posteingang === undefined || inHauptnavigation(modul.block)),
          kennung: modul.kennung,
        }));
      }),
  );
  const eintraege = [...teile.flat(), ...(await aufgabenLesen(pool, module, zugang, jetzt, log))];
  return { anzahl: eintraege.length, eintraege };
}

/**
 * Offene Zeilen der Module mit `entscheidung.aufgabe` (COPI-124, etwa Maras Posts): jede Zeile mit Status rot oder gelb
 * ist eine Aufgabe unter „Freigaben" — so lange, bis sie nicht mehr offen ist, nicht bis sie gelesen ist. Anriss ist der
 * Kurztext der Übersicht, wenn der Block einen nennt.
 */
async function aufgabenLesen(pool: pg.Pool, module: readonly AktivesModul[], zugang: Zugang, jetzt: Date, log: Meldung | undefined): Promise<PosteingangEintrag[]> {
  const teile = await Promise.all(
    module
      .filter((modul) => entscheidungAlsAufgabe(modul.block) && modulHandelnErlaubt(zugang, modul))
      .map(async (modul) => {
        const gelesen = await modulListeLesen(pool, modul.kennung, modul.block, log);
        if (!gelesen.ok) {
          return [];
        }
        const kurztext = modul.block.uebersicht?.kurztext;
        return gelesen.wert
          .filter((zeile) => zeile.werte.status === 'rot' || zeile.werte.status === 'gelb')
          .map((zeile): PosteingangEintrag => ({
            quelle: 'freigabe',
            herkunft: `Entscheidung · ${modul.block.menuename}`,
            titel: wertText(zeile.werte.titel),
            anriss: kurztext === undefined ? '' : wertText(zeile.werte[kurztext]),
            zeit: zeile.werte.aktualisiert_am instanceof Date ? zeile.werte.aktualisiert_am : jetzt,
            href: `/module/${encodeURIComponent(modul.kennung)}/${encodeURIComponent(wertText(zeile.werte.id))}`,
            kennung: modul.kennung,
          }));
      }),
  );
  return teile.flat();
}

function wertText(wert: unknown): string {
  return wert === null || wert === undefined ? '' : typeof wert === 'string' ? wert : String(wert);
}

async function meldungTeil(pool: pg.Pool, zugang: Zugang, benutzerId: string, jetzt: Date): Promise<PosteingangTeil> {
  const bis = await standSichern(pool, benutzerId, QUELLE_MELDUNGEN, jetzt);
  const lesen = hatRecht(zugang, 'rohbefunde_sehen') ? betreuerMeldungenLesen : kundenMeldungenLesen;
  const zeilen = (await lesen(pool, { art: undefined, suche: undefined, anzahl: MELDUNGEN_HOECHSTENS })).filter(
    (zeile) => zeile.status !== 'gruen' && zeile.gemeldetAm.getTime() > bis.getTime(),
  );
  return {
    anzahl: zeilen.length,
    eintraege: zeilen.map((zeile) => ({
      quelle: 'meldung',
      herkunft: zeile.status === 'rot' ? 'Meldung · Rot' : 'Meldung · Gelb',
      titel: zeile.name ?? NAME_OHNE_ANZEIGENAME,
      anriss: zeile.text,
      zeit: zeile.gemeldetAm,
      href: '/meldungen',
      rot: zeile.status === 'rot',
    })),
  };
}

/** Eine Quelle, deren Fehler nur sie selbst kostet (siehe Kopf). */
async function quelleLesen(name: PosteingangQuelle, lesen: () => Promise<PosteingangTeil>, log: Meldung | undefined): Promise<PosteingangTeil | undefined> {
  try {
    return await lesen();
  } catch (fehler) {
    log?.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, `Posteingang: Quelle ${name} nicht gelesen`);
    return undefined;
  }
}

/**
 * Der Posteingang dieses Zugangs, oder `undefined` ohne Sitzung samt zweitem Faktor. `module` sind die aktiven Module,
 * wenn der Aufrufer sie schon hat.
 */
export async function posteingangLesen(
  pool: pg.Pool,
  zugang: Zugang,
  jetzt: Date,
  log?: Meldung,
  module?: readonly AktivesModul[],
): Promise<PosteingangAnsicht | undefined> {
  const teile = await posteingangTeileLesen(pool, zugang, jetzt, log, module);
  return teile === undefined ? undefined : posteingangAnsicht(teile, jetzt);
}

/** Die Teile des Posteingangs je Quelle, roh (mit Zeitpunkten) — für die Ansicht und für den Push (COPI-116). */
export async function posteingangTeileLesen(
  pool: pg.Pool,
  zugang: Zugang,
  jetzt: Date,
  log?: Meldung,
  module?: readonly AktivesModul[],
): Promise<Partial<Record<PosteingangQuelle, PosteingangTeil>> | undefined> {
  const benutzerId = zugang.benutzerId;
  if (zugang.angemeldet !== true || zugang.zweiterFaktorAktiv !== true || benutzerId === undefined) {
    return undefined;
  }
  const alle = async (): Promise<readonly AktivesModul[]> => module ?? (await aktiveModule(pool));
  const [freigabe, chat, postfach, meldung] = await Promise.all([
    quelleLesen('freigabe', async () => freigabeTeil(pool, await alle(), zugang, jetzt, log), log),
    hatRecht(zugang, 'chat_nutzen') ? quelleLesen('chat', () => chatTeil(pool, benutzerId), log) : undefined,
    quelleLesen('postfach', async () => postfachTeil(pool, benutzerId, sichtbarePostfaecher(await alle(), zugang), jetzt, log), log),
    quelleLesen('meldung', () => meldungTeil(pool, zugang, benutzerId, jetzt), log),
  ]);
  return { ...(freigabe ? { freigabe } : {}), ...(chat ? { chat } : {}), ...(postfach ? { postfach } : {}), ...(meldung ? { meldung } : {}) };
}

/**
 * Der Zugang mit neu gelesenem Posteingang — für Seiten, die selbst etwas als gelesen markieren (Chat, Detailseite eines
 * Postfachs, Meldungen): der beim Lesen des Zugangs ermittelte Stand zählte sonst mit, was die Seite gerade zeigt. Ein
 * Zugang ohne Posteingang (etwa in Tests mit eigenem Zugangsleser) bleibt, wie er ist.
 */
export async function mitFrischemPosteingang(pool: pg.Pool, zugang: Zugang, jetzt: Date, log?: Meldung): Promise<Zugang> {
  if (zugang.posteingang === undefined) {
    return zugang;
  }
  const posteingang = await posteingangLesen(pool, zugang, jetzt, log);
  return posteingang === undefined ? zugang : { ...zugang, posteingang };
}

/** Nur angezeigte Seiten lesen den Posteingang (siehe Kopf). */
function seitenAnfrage(request: FastifyRequest): boolean {
  return request.method === 'GET' && !request.url.split('?')[0]?.endsWith('/ereignisse');
}

/** Wie `zugangLesen`, aber mit `posteingang` ergänzt (siehe Kopf). */
export function zugangLesenMitPosteingang(basis: ZugangLesen, pool: pg.Pool, jetzt: () => Date): ZugangLesen {
  return async (request: FastifyRequest): Promise<Zugang> => {
    const zugang = await basis(request);
    if (!seitenAnfrage(request)) {
      return zugang;
    }
    const posteingang = await posteingangLesen(pool, zugang, jetzt(), request.log);
    return posteingang === undefined ? zugang : { ...zugang, posteingang };
  };
}
