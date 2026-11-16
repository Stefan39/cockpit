/**
 * Entscheiden an einem Vorgang (COPI-91, freigegebener Entwurf „Akquise"): `POST /module/:kennung/:id/entscheiden` und
 * `POST /module/:kennung/:id/entscheidung-zuruecknehmen` — gewöhnliche Formulare der Entscheidungskarte, ohne Skript,
 * danach `303` auf die Detailseite.
 *
 * Dieselben Prüfungen wie Sperre und Freigabe (`vorgangAktionPruefer`): Zugriff, Konto, Eingriff `entscheiden` im Block,
 * Herkunft. Dazu eine signierte Bestätigung (`auth/bestaetigung.ts`), gebunden an Konto, Modul, Vorgang, Wert und den
 * Stand, den die Seite gezeigt hat; die Option muss bei diesem Stand erlaubt sein (`wenn` im Block), und die Zeile muss
 * in der View stehen. Hat sich der Stand inzwischen geändert (jemand anders hat entschieden), wird nichts gespeichert.
 *
 * `entscheidungAnsicht` baut die Karte der Detailseite (`views/partials/entscheidung-karte.eta`) mit denselben
 * Schlüsseln — deshalb registriert `module.ts` diese Routen und bekommt die Ansicht zurück.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Zugang } from '../../auth/berechtigung.js';
import { bestaetigungAusstellen, bestaetigungPruefen } from '../../auth/bestaetigung.js';
import { zeitText } from '../../chat/ansicht.js';
import { langtextBereinigen } from '../../module/ansicht.js';
import { ENTSCHEIDUNG_OFFEN, entscheidenErlaubt } from '../../module/block.js';
import { textBloecke, type TextBlock } from '../../module/einfacher-text.js';
import { entscheiden, entscheidungEntwurfLesen, entscheidungZuruecknehmen, geltendeEntscheidungen, moeglicheOptionen, type Entscheidung, type EntscheidungEntwurf } from '../../module/entscheidung.js';
import type { Meldung } from '../../module/liste-detail.js';
import { modulZeileVorhanden } from '../../module/liste-detail.js';
import type { AktivesModul } from '../../module/modul-speicher.js';
import { detailPfad, modulHinweisSenden, type VorgangAktionPruefen } from './modul-ziel.js';
import { nichtGefunden } from './neutral.js';

/** Der Zweck der signierten Bestätigung: getrennt von Sperre, Freigabe und Download. */
const ENTSCHEIDUNG_ZWECK = 'entscheidung';

/** Hinweise der Detailseite nach einer Entscheidung (`?hinweis=`), nur diese festen Werte. */
export const ENTSCHEIDUNG_HINWEISE: Readonly<Record<string, string>> = {
  'entscheidung-geaendert': 'Die Entscheidung wurde inzwischen geändert. Es wurde nichts gespeichert; bitte den Stand unten prüfen.',
};

const NICHT_VERFUEGBAR = 'Dieses Modul ist gerade nicht verfügbar. Es wurde nichts geändert.';

type Formular = { readonly href: string; readonly bis: string; readonly token: string };

export interface EntscheidungKarte {
  readonly titel: string;
  readonly hinweis: string | undefined;
  /** Die geltende Entscheidung als Band, etwa „Interessant · von Stefan, heute 18:10". */
  readonly geltend: { readonly kurz: string; readonly von: string; readonly am: string; readonly wert: string } | undefined;
  readonly entwurf:
    | {
        readonly titel: string;
        readonly text: string;
        readonly fassung: number | undefined;
        readonly hinweis: string | undefined;
        /** Nur mit `entwurf.format: einfach` (COPI-125): der Text als Absätze, Überschriften und Listen. */
        readonly bloecke?: readonly TextBlock[];
      }
    | undefined;
  readonly optionen: readonly (Formular & { readonly label: string; readonly primaer: boolean; readonly wert: string; readonly erwartet: string })[];
  readonly zuruecknehmen: (Formular & { readonly entscheidung: string }) | undefined;
  readonly meldung: string | undefined;
}

export interface EntscheidungRouten {
  /** Die Karte der Detailseite; `undefined` ohne Eingriff `entscheiden`. */
  ansicht(
    zugang: Zugang | undefined,
    modul: AktivesModul,
    id: string,
    geltend: Entscheidung | undefined,
    entwurf: EntscheidungEntwurf | undefined,
    hinweis: unknown,
  ): EntscheidungKarte | undefined;
  /** Die Marke einer Listenzeile, etwa „Interessant · Stefan", je `id`. */
  marken(modul: AktivesModul, geltende: ReadonlyMap<string, Entscheidung>): Map<string, string>;
}

/** Ob die Zeile gerade einen Entwurf hat (COPI-125); `undefined`, wenn die View nicht lesbar ist. */
async function entwurfVorhanden(db: Parameters<typeof entscheidungEntwurfLesen>[0], modul: AktivesModul, id: string, log: Meldung): Promise<boolean | undefined> {
  const gelesen = await entscheidungEntwurfLesen(db, modul.kennung, modul.block, id, log);
  return gelesen.ok ? gelesen.wert !== undefined : undefined;
}

function vorname(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

export function registerModulEntscheidungRoutes(app: FastifyInstance, jetzt: () => Date, vorgangAktionPruefen: VorgangAktionPruefen): EntscheidungRouten {
  // Nur im Speicher dieses Prozesses: nach einem Neustart gilt keine alte Bestätigung mehr.
  const schluessel = randomBytes(32);

  function formular(konto: string, kennung: string, id: string, aktion: string, inhalt: readonly string[]): Formular {
    return {
      href: `${detailPfad(kennung, id)}/${aktion}`,
      ...bestaetigungAusstellen(schluessel, ENTSCHEIDUNG_ZWECK, [konto, kennung, id, aktion, ...inhalt], jetzt()),
    };
  }

  function ansicht(zugang: Zugang | undefined, modul: AktivesModul, id: string, geltend: Entscheidung | undefined, entwurf: EntscheidungEntwurf | undefined, hinweis: unknown): EntscheidungKarte | undefined {
    const entscheidung = modul.block.entscheidung;
    if (entscheidung === undefined || !entscheidenErlaubt(modul.block)) {
      return undefined;
    }
    const konto = zugang?.benutzerId;
    const erwartet = geltend?.wert ?? ENTSCHEIDUNG_OFFEN;
    const option = entscheidung.optionen.find((kandidat) => kandidat.wert === geltend?.wert);
    return {
      titel: entscheidung.titel,
      hinweis: entscheidung.hinweis,
      geltend: geltend === undefined ? undefined : { kurz: option?.kurz ?? geltend.wert, von: geltend.von, am: zeitText(geltend.am, jetzt()), wert: geltend.wert },
      entwurf:
        entwurf === undefined || entscheidung.entwurf === undefined
          ? undefined
          : {
              titel: entscheidung.entwurf.titel,
              text: langtextBereinigen(entwurf.text),
              fassung: entwurf.fassung,
              hinweis: entscheidung.entwurf.hinweis,
              // Einfache Formatierung (COPI-125): Blöcke aus demselben bereinigten Text; die Vorlage maskiert jeden.
              ...(entscheidung.entwurf.format === 'einfach' ? { bloecke: textBloecke(langtextBereinigen(entwurf.text)) } : {}),
            },
      optionen:
        konto === undefined
          ? []
          : moeglicheOptionen(entscheidung.optionen, geltend?.wert, entwurf !== undefined).map((moeglich) => ({
              label: moeglich.label,
              primaer: moeglich.primaer === true,
              wert: moeglich.wert,
              erwartet,
              ...formular(konto, modul.kennung, id, 'entscheiden', [moeglich.wert, erwartet]),
            })),
      zuruecknehmen:
        konto === undefined || geltend === undefined
          ? undefined
          : { entscheidung: String(geltend.id), ...formular(konto, modul.kennung, id, 'entscheidung-zuruecknehmen', [String(geltend.id)]) },
      meldung: typeof hinweis === 'string' ? ENTSCHEIDUNG_HINWEISE[hinweis] : undefined,
    };
  }

  function marken(modul: AktivesModul, geltende: ReadonlyMap<string, Entscheidung>): Map<string, string> {
    const optionen = modul.block.entscheidung?.optionen ?? [];
    return new Map(
      [...geltende].map(([id, geltend]) => [id, `${optionen.find((option) => option.wert === geltend.wert)?.kurz ?? geltend.wert} · ${vorname(geltend.von)}`]),
    );
  }

  /** Gemeinsam für beide Aktionen: Prüfungen, Bestätigung, Zeile vorhanden. `undefined`: die Antwort ist gesendet. */
  async function vorbereiten(
    request: FastifyRequest<{ Params: { kennung: string; id: string } }>,
    reply: FastifyReply,
    aktion: string,
    inhalt: readonly string[],
    felder: { readonly bis?: unknown; readonly token?: unknown },
  ) {
    const geprueft = await vorgangAktionPruefen(request, reply, (modul) => entscheidenErlaubt(modul.block), `Entscheidung (${aktion})`);
    if (geprueft === undefined) {
      return undefined;
    }
    const { zugang, modul, db, konto, id, detail } = geprueft;
    if (!bestaetigungPruefen(schluessel, felder, ENTSCHEIDUNG_ZWECK, [konto, modul.kennung, id, aktion, ...inhalt], jetzt())) {
      request.log.warn({ aktion }, 'Entscheidung: Bestätigung ungültig oder abgelaufen');
      await reply.redirect(`${detail}?hinweis=abgelaufen`, 303);
      return undefined;
    }
    const vorhanden = await modulZeileVorhanden(db, modul.kennung, modul.block, id, request.log);
    if (!vorhanden.ok) {
      await modulHinweisSenden(app, reply, zugang, 503, NICHT_VERFUEGBAR, detail);
      return undefined;
    }
    if (!vorhanden.wert) {
      await nichtGefunden(app, reply);
      return undefined;
    }
    return geprueft;
  }

  app.post<{ Params: { kennung: string; id: string }; Body: { wert?: unknown; erwartet?: unknown; bis?: unknown; token?: unknown } | undefined }>(
    '/module/:kennung/:id/entscheiden',
    async (request, reply) => {
      const body = request.body ?? {};
      const wert = typeof body.wert === 'string' ? body.wert : '';
      const erwartet = typeof body.erwartet === 'string' ? body.erwartet : '';
      const geprueft = await vorbereiten(request, reply, 'entscheiden', [wert, erwartet], body);
      if (geprueft === undefined) {
        return reply;
      }
      const { modul, db, konto, id, detail } = geprueft;
      const optionen = modul.block.entscheidung?.optionen ?? [];
      // Ob die Zeile einen Entwurf hat (COPI-125), nur wenn eine Option danach fragt; nicht lesbar: nichts entscheiden.
      const entwurfDa = optionen.some((option) => option.entwurf !== undefined) ? await entwurfVorhanden(db, modul, id, request.log) : false;
      if (entwurfDa === undefined) {
        return modulHinweisSenden(app, reply, geprueft.zugang, 503, NICHT_VERFUEGBAR, detail);
      }
      // Die Option muss es geben und bei diesem Stand gehen — der Server prüft es, nicht nur die Seite.
      if (!moeglicheOptionen(optionen, erwartet === ENTSCHEIDUNG_OFFEN ? undefined : erwartet, entwurfDa).some((option) => option.wert === wert)) {
        request.log.warn('Entscheidung: Option bei diesem Stand nicht möglich');
        return reply.redirect(`${detail}?hinweis=entscheidung-geaendert`, 303);
      }
      const gespeichert = await entscheiden(db, { modul: modul.kennung, vorgangId: id }, wert, erwartet, konto);
      request.log.info({ gespeichert }, 'Entscheidung');
      return reply.redirect(gespeichert ? detail : `${detail}?hinweis=entscheidung-geaendert`, 303);
    },
  );

  app.post<{ Params: { kennung: string; id: string }; Body: { entscheidung?: unknown; bis?: unknown; token?: unknown } | undefined }>(
    '/module/:kennung/:id/entscheidung-zuruecknehmen',
    async (request, reply) => {
      const body = request.body ?? {};
      const entscheidung = typeof body.entscheidung === 'string' && /^[1-9][0-9]{0,15}$/.test(body.entscheidung) ? body.entscheidung : '';
      const geprueft = await vorbereiten(request, reply, 'entscheidung-zuruecknehmen', [entscheidung], body);
      if (geprueft === undefined) {
        return reply;
      }
      const { modul, db, konto, id, detail } = geprueft;
      const zurueck = entscheidung !== '' && (await entscheidungZuruecknehmen(db, { modul: modul.kennung, vorgangId: id }, Number(entscheidung), konto));
      request.log.info({ zurueck }, 'Entscheidung zurückgenommen');
      return reply.redirect(zurueck ? detail : `${detail}?hinweis=entscheidung-geaendert`, 303);
    },
  );

  return { ansicht, marken };
}

/** Die geltenden Entscheidungen der gezeigten Zeilen, nur bei Eingriff `entscheiden` (sonst leer). */
export async function entscheidungenFuer(db: Parameters<typeof geltendeEntscheidungen>[0], modul: AktivesModul, ids: readonly string[]): Promise<Map<string, Entscheidung>> {
  return entscheidenErlaubt(modul.block) ? geltendeEntscheidungen(db, modul.kennung, ids) : new Map();
}
