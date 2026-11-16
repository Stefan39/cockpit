import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { hatRecht, type Zugang, type ZugangLesen } from '../../auth/berechtigung.js';
import { detailBauen, kennzahlZeileBauen, sichereAdresse, zeileBauen } from '../../freigaben/ansicht.js';
import {
  aktionAusloesen,
  AKTIONEN,
  hinweisText,
  type Aktion,
  type Abruf,
  type AktionsErgebnis,
  type Eintrag,
  type RepowacheKonfiguration,
  type ZwischengespeicherterAbruf,
} from '../../freigaben/repowache.js';
import { bestaetigungAusstellen, bestaetigungPruefen, type BestaetigungsFelder } from '../../auth/bestaetigung.js';
import { text } from './formular.js';
import { kontoMitHerkunft } from './konto-pruefen.js';
import { standText } from '../../chat/ansicht.js';
import { navigationFuerZugang } from '../navigation.js';
import { nichtGefunden } from './neutral.js';

export interface FreigabenAbhaengigkeiten {
  readonly zugangLesen: ZugangLesen;
  readonly abruf: ZwischengespeicherterAbruf;
  readonly jetzt: () => Date;
  /** Für die Aktionen (Teil 2, COPI-217); ohne sie gibt es nur Liste und Detail. */
  readonly repowache?: RepowacheKonfiguration;
  readonly holen?: typeof fetch;
}

/** Längster Text, den „Ändern und senden" annimmt. */
export const TEXT_HOECHSTLAENGE = 10_000;

export interface Meldung {
  readonly art: 'ok' | 'fehler' | 'info';
  readonly text: string;
  /** Die Adresse der Antwort als Text und, nur bei `http(s)`, als Link. */
  readonly adresse?: string;
  readonly link?: string;
}

const UNKLAR_HINWEIS = 'Ergebnis unklar, nicht erneut senden';

/** Meldung und Sperre der Knöpfe zu einem Ergebnis der Repo-Wache. */
function meldungZu(ergebnis: AktionsErgebnis): { readonly meldung: Meldung; readonly gesperrt: boolean } {
  switch (ergebnis.art) {
    case 'ok': {
      const link = sichereAdresse(ergebnis.antwortUrl);
      return {
        meldung: {
          art: 'ok',
          text: `Neuer Status: ${ergebnis.status}.`,
          ...(ergebnis.antwortUrl === undefined ? {} : { adresse: ergebnis.antwortUrl }),
          ...(link === undefined ? {} : { link }),
        },
        gesperrt: true,
      };
    }
    case 'konflikt':
      return { meldung: { art: 'fehler', text: ergebnis.fehler }, gesperrt: false };
    case 'unklar':
      return { meldung: { art: 'fehler', text: UNKLAR_HINWEIS }, gesperrt: true };
    case 'fehler':
      return { meldung: { art: 'fehler', text: hinweisText(ergebnis.grund) }, gesperrt: false };
  }
}

/**
 * Die Freigabe-Inbox, Teil 1 (COPI-139): Liste der Entwürfe der Repo-Wache und Detailansicht. Teil 2 (COPI-217): die
 * drei Aktionen `POST /freigaben/:id/senden|aendern|verwerfen`, serverseitig an `…/webhook/repowache/aktion`; dafür
 * dasselbe Recht wie fürs Ansehen und die strenge Herkunftsprüfung (`kontoMitHerkunft`, CSRF). Ohne Konfiguration
 * wird die Route gar nicht erst angelegt (`app.ts`); ohne Recht `technik_sehen` antwortet sie mit der neutralen 404. Der
 * Abruf geschieht im Server — die Seite enthält weder Token noch Adresse der Repo-Wache. Ein Fehlschlag der Quelle
 * ergibt einen Hinweistext statt eines Fehlers. Die Seiten hängen von Rolle und Quelle ab und sind `no-store`.
 */
export function registriereFreigabenRouten(app: FastifyInstance, abhaengigkeiten: FreigabenAbhaengigkeiten): void {
  const { zugangLesen, abruf, jetzt, repowache, holen } = abhaengigkeiten;

  const senden = (reply: FastifyReply, html: string): FastifyReply =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);

  /** Nur im Speicher des Prozesses: nach einem Neustart gelten offene Formulare nicht mehr. */
  const schluessel = randomBytes(32);
  const csrfZweck = (aktion: Aktion): string => `freigabe-${aktion}`;
  const csrfFelder = (konto: string, id: string): Record<Aktion, BestaetigungsFelder> => ({
    senden: bestaetigungAusstellen(schluessel, csrfZweck('senden'), [konto, id], jetzt()),
    aendern: bestaetigungAusstellen(schluessel, csrfZweck('aendern'), [konto, id], jetzt()),
    verwerfen: bestaetigungAusstellen(schluessel, csrfZweck('verwerfen'), [konto, id], jetzt()),
  });

  /** Einmalige Meldung je Konto für die Liste nach einer Aktion (Post-Redirect-Get). */
  const meldungen = new Map<string, Meldung>();
  /**
   * Einträge mit unklarem Ergebnis: Knöpfe bleiben gesperrt, solange der Prozess läuft. Der Listenabruf liefert nur
   * offen/info und höchstens 100 Einträge; dass ein Eintrag fehlt, belegt keinen Folgestatus.
   */
  const unklar = new Set<string>();

  /** Der Eintrag zur `id` aus dem Abruf. */
  async function eintragSuchen(id: string): Promise<{ readonly abruf: Abruf; readonly eintrag: Eintrag | undefined }> {
    const abgerufen = await abruf();
    const eintrag = abgerufen.ok ? abgerufen.eintraege.find((kandidat) => kandidat.id === id) : undefined;
    return { abruf: abgerufen, eintrag };
  }

  app.get('/freigaben', async (request, reply) => {
    const zugang = await zugangLesen(request);
    if (!hatRecht(zugang, 'technik_sehen')) {
      return nichtGefunden(app, reply);
    }
    const konto = zugang.angemeldet ? zugang.benutzerId : undefined;
    const meldung = konto === undefined ? undefined : meldungen.get(konto);
    if (konto !== undefined) {
      meldungen.delete(konto);
    }
    const ergebnis = await abruf();
    const html = await app.render('freigaben.eta', {
      titel: 'Freigaben',
      nav: navigationFuerZugang('freigaben', zugang),
      stand: standText(jetzt()),
      hinweis: ergebnis.ok ? undefined : hinweisText(ergebnis.grund),
      zeilen: ergebnis.ok ? ergebnis.eintraege.map((eintrag) => zeileBauen(eintrag, jetzt())) : [],
      kennzahlen: ergebnis.ok ? ergebnis.kennzahlen.map(kennzahlZeileBauen) : [],
      meldung,
    });
    return senden(reply, html);
  });

  /** Die Detailseite zu `id`; `undefined`, wenn es den Eintrag nicht (mehr) gibt. */
  const detailSeite = async (
    zugang: Zugang,
    id: string,
    zusatz: { readonly meldung?: Meldung; readonly eingabe?: string | undefined; readonly gesperrt?: boolean } = {},
  ): Promise<string | undefined> => {
    const { abruf: ergebnis, eintrag } = await eintragSuchen(id);
    if (ergebnis.ok && eintrag === undefined) {
      return undefined;
    }
    const konto = (zugang.angemeldet ? zugang.benutzerId : undefined) ?? '';
    const istUnklar = unklar.has(id);
    return app.render('freigabe-detail.eta', {
      titel: 'Freigabe',
      nav: navigationFuerZugang('freigaben', zugang),
      zurueck: { href: '/freigaben', ziel: 'Freigaben' },
      hinweis: ergebnis.ok ? undefined : hinweisText(ergebnis.grund),
      detail: eintrag === undefined ? undefined : detailBauen(eintrag, jetzt()),
      aktionen: repowache !== undefined,
      csrf: csrfFelder(konto, id),
      meldung: zusatz.meldung ?? (istUnklar ? { art: 'fehler', text: UNKLAR_HINWEIS } : undefined),
      gesperrt: zusatz.gesperrt === true || istUnklar,
      eingabe: zusatz.eingabe,
    });
  };

  const antwortSeite = async (
    reply: FastifyReply,
    zugang: Zugang,
    id: string,
    status: number,
    zusatz: Parameters<typeof detailSeite>[2] = {},
  ): Promise<FastifyReply> => {
    const html = await detailSeite(zugang, id, zusatz);
    if (html === undefined) {
      // Steht der Eintrag nicht mehr in der Liste, geht die Meldung zur Aktion nicht verloren, sondern kommt zur Liste.
      const konto = zugang.angemeldet ? zugang.benutzerId : undefined;
      if (zusatz.meldung !== undefined && konto !== undefined) {
        meldungen.set(konto, zusatz.meldung);
        return reply.redirect('/freigaben', 303);
      }
      await nichtGefunden(app, reply);
      return reply;
    }
    return senden(reply.code(status), html);
  };

  app.get<{ Params: { id: string } }>('/freigaben/:id', async (request, reply) => {
    const zugang = await zugangLesen(request);
    if (!hatRecht(zugang, 'technik_sehen')) {
      return nichtGefunden(app, reply);
    }
    return antwortSeite(reply, zugang, request.params.id, 200);
  });

  if (repowache === undefined) {
    return;
  }

  const aktionRoute = (aktion: Aktion): void => {
    app.post<{ Params: { id: string }; Body: { text?: unknown; bis?: unknown; token?: unknown } | undefined }>(`/freigaben/:id/${aktion}`, async (request, reply) => {
      const konto = await kontoMitHerkunft(app, request, reply, zugangLesen, (zugang) => (hatRecht(zugang, 'technik_sehen') ? zugang.benutzerId : undefined), 'Freigabe-Inbox');
      if (konto === undefined) {
        return reply;
      }
      const zugang = await zugangLesen(request);
      const { id } = request.params;
      if (!bestaetigungPruefen(schluessel, { bis: request.body?.bis, token: request.body?.token }, csrfZweck(aktion), [konto, id], jetzt())) {
        request.log.warn('Freigabe-Inbox: Anfrage abgewiesen (CSRF-Token)');
        return antwortSeite(reply, zugang, id, 403, { meldung: { art: 'fehler', text: 'Das Formular ist abgelaufen oder ungültig. Bitte die Seite neu laden.' } });
      }
      if (unklar.has(id)) {
        return antwortSeite(reply, zugang, id, 409, { meldung: { art: 'fehler', text: UNKLAR_HINWEIS }, gesperrt: true });
      }
      const eingabe = aktion === 'aendern' ? text(request.body?.text) : undefined;
      if (eingabe !== undefined && (eingabe === '' || eingabe.length > TEXT_HOECHSTLAENGE)) {
        const meldung: Meldung = { art: 'fehler', text: `Bitte einen Text mit 1 bis ${String(TEXT_HOECHSTLAENGE)} Zeichen angeben.` };
        return antwortSeite(reply, zugang, id, 200, { meldung, eingabe });
      }
      const ergebnis = await aktionAusloesen(repowache, { id, aktion, ...(eingabe === undefined ? {} : { text: eingabe }) }, holen ? { holen } : {});
      request.log.info({ id, aktion, ergebnis: ergebnis.art, konto }, 'Freigabe-Inbox: Aktion');
      abruf.vergessen();
      const ausgang = meldungZu(ergebnis);
      if (ergebnis.art === 'ok') {
        meldungen.set(konto, ausgang.meldung);
        return reply.redirect('/freigaben', 303);
      }
      if (ergebnis.art === 'unklar') {
        unklar.add(id);
      }
      return antwortSeite(reply, zugang, id, 200, { meldung: ausgang.meldung, gesperrt: ausgang.gesperrt, eingabe });
    });
  };
  AKTIONEN.forEach(aktionRoute);
}
