/**
 * Die Chat-Seite (COPI-53, ADR 6), wie die Bildschirme „Chat" und „Chat – Desktop" des Prototyps: am Desktop links die
 * Liste „Verlauf" mit den Kanälen, rechts der Verlauf mit Eingabezeile; mobil nur der Kanal, mit einer Umschaltung
 * zwischen Assistent und Team im Kopf.
 *
 *   * `GET /chat` — der eigene Kanal mit dem Assistenten (Koordinator-Agent); `GET /chat/team` — der gemeinsame
 *     Team-Kanal. `?vor=<id>` blättert zu älteren Nachrichten.
 *   * `POST /chat`, `POST /chat/team` — eine Nachricht schreiben. Ein gewöhnliches Formular, das ohne Skript
 *     funktioniert: gespeichert, dann zurück zum Kanal (303). Das Nachladen ohne Neuladen folgt mit COPI-56.
 *   * **Koordinator (COPI-54):** Eine Nachricht im Assistenten-Kanal geht nach dem Speichern an den Webhook
 *     (`chat/koordinator.ts`); gewartet wird nur auf dessen Quittung. Scheitert sie, steht eine Meldung des Cockpits im
 *     Verlauf. Der Team-Kanal bleibt unter Menschen. Ohne konfigurierten Webhook sagt der Assistenten-Kanal, dass kein
 *     Assistent angebunden ist, und nimmt nichts an.
 *
 * **Wer:** jedes Konto mit dem Recht `chat_nutzen` (alle Rollen). Ohne das Recht antwortet jede Route mit der
 * neutralen 404, wie die Benutzerseiten. Anonyme erreichen die Routen nie: das Tor schickt sie vorher zur Anmeldung.
 *
 * **CSRF:** Die Herkunft ist beim Schreiben Pflicht (`herkunftBelegt`, wie beim Update-Antrag): unter
 * `<kuerzel>.example.com` gilt jede Nachbar-Subdomain für `SameSite` als „same site".
 *
 * **Inhalte** bleiben Klartext: escaped, nie verlinkt, kein Markdown (ADR 10, JAC-577). Antworten des Koordinators sind
 * sichtbar als KI-erzeugt gekennzeichnet (Art. 50 KI-VO).
 *
 * **Lesestand:** Wer die jüngste Seite eines Kanals ansieht, hat ihn gelesen. Ältere Seiten ändern daran nichts.
 *
 * **Häkchen und Trenner "Neu" (COPI-69), nur im Assistenten-Kanal:** Eigene Nachrichten tragen einen Haken (gesendet),
 * zwei Haken (angenommen: der Webhook hat quittiert, `zugestellt_am`) oder zwei Haken in Akzentfarbe (beantwortet: später
 * steht eine Antwort des Koordinators im Verlauf, abgeleitet, keine Spalte). Vor der ersten ungelesenen fremden Nachricht
 * steht der Trenner; dafür wird der alte Lesestand gelesen, bevor die Seite ihn setzt.
 *
 * **Server-Sent Events (COPI-56):** `GET /chat/ereignisse` und `GET /chat/team/ereignisse` liefern neue Nachrichten des
 * Kanals, jede als fertig escaptes HTML-Fragment (dasselbe Partial wie die Seite) mit ihrer ID als Ereignis-ID. Rechte
 * wie die Seite; die Sitzung prüft das Tor. Wer neu verbindet, bekommt Verpasstes aus der Datenbank nach
 * (`Last-Event-ID`, beim ersten Öffnen `?seit=`), erst dann Neues — abonniert wird vorher, damit dazwischen nichts
 * verloren geht, und eine ID kommt nie zweimal. Heartbeat alle 25 s, höchstens fünf Streams je Konto (`429`). Das
 * Skript dazu (`/chat/skript.js`) hängt neue Nachrichten an; ohne Skript bleibt die Seite, wie sie ist.
 *
 * **Postfächer (COPI-112):** Module mit `posteingang:` (etwa die Mails des Moduls Kommunikation) stehen als zweite Gruppe
 * in „Verlauf" (mobil als Chips). `GET /chat/postfach/:kennung` zeigt ihre Zeilen im Rahmen der Chat-Seite, jüngste
 * zuerst, Ungelesenes hervorgehoben; jede führt auf ihre Detailseite (`?von=nachrichten`, zurück hierher). Wer das Modul
 * nicht sehen darf (`modulZugriffErlaubt`), bekommt die neutrale 404 — wie auf der Modulseite. Die Seite markiert nichts
 * als gelesen; das tut erst die Detailseite.
 *
 * **Tageslimit (COPI-57):** Nachrichten an den Assistenten zählen je Konto und Berliner Kalendertag, atomar in der
 * Datenbank. Ist das Limit erreicht, wird die Nachricht weder gespeichert noch weitergeleitet (`429`, die Eingabe bleibt
 * im Feld), und die Seite sagt, ab wann es wieder geht; ab 80 % zeigt sie den Rest. Der Team-Kanal zählt nicht.
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { hatRecht, type Zugang, type ZugangLesen } from '../../auth/berechtigung.js';
import { herkunftBelegt } from '../../auth/herkunft.js';
import { eigeneStaende, eingabePruefen, nachrichtAnsicht, nachrichtStatus, neuTrennerVor, vorschau, zeitText } from '../../chat/ansicht.js';
import { berlinerTag, naechsterTagesbeginn, restAnzeige } from '../../chat/tageslimit.js';
import { verbrauchBuchen, verbrauchLesen, verbrauchZurueckgeben } from '../../chat/verbrauch-speicher.js';
import type { ChatEreignisse } from '../../chat/ereignisse.js';
import { antwortStand, weiterleiten, type KoordinatorKonfiguration } from '../../chat/koordinator.js';
import {
  agentAntwortNach,
  assistentKanal,
  INHALT_HOECHSTENS,
  kanalStand,
  lesestandLesen,
  lesestandSetzen,
  nachrichtAlsZugestelltMarkieren,
  nachrichtAnlegen,
  nachrichtenSeit,
  SEITE_HOECHSTENS,
  teamKanal,
  ungeleseneGesamt,
  verlaufLesen,
  type Kanal,
  type Nachricht,
} from '../../chat/nachricht-speicher.js';
import { ereignisText, PULS, PULS_MS, seitAus, StromZaehler, WIEDERVERBINDEN_MS } from '../../chat/strom.js';
import { navigationFuerZugang } from '../navigation.js';
import { inHauptnavigation, istModulKennung } from '../../module/block.js';
import { aktiveModule } from '../../module/modul-speicher.js';
import { mitFrischemPosteingang, sichtbarePostfaecher, type Postfach } from '../../posteingang/lesen.js';
import { modulQuelle, postfachAnsicht, postfachPfad } from '../../posteingang/posteingang.js';
import { postfachLesen, standSichern } from '../../posteingang/posteingang-speicher.js';
import { skriptAusliefern, skriptLesen } from './passkey-skript.js';
import { nichtGefunden } from './neutral.js';
import { SICHERHEITS_KOPF } from '../sicherheit.js';

export const CHAT_PFAD = '/chat';
export const TEAM_PFAD = '/chat/team';
export const SKRIPT_PFAD = '/chat/skript.js';

type KanalWahl = 'assistent' | 'team';

const KANAELE: readonly { readonly wahl: KanalWahl; readonly name: string; readonly pfad: string }[] = [
  { wahl: 'assistent', name: 'Assistent', pfad: CHAT_PFAD },
  { wahl: 'team', name: 'Team', pfad: TEAM_PFAD },
];

const FEHLER = {
  herkunft: 'Diese Nachricht kam nicht aus dem Cockpit und wurde nicht gespeichert.',
  gescheitert: 'Die Nachricht wurde nicht gespeichert. Bitte später noch einmal versuchen.',
  keinAssistent: 'Auf dieser Instanz ist noch kein Assistent angebunden.',
} as const;

/** Die Meldung des Cockpits im Verlauf, wenn die Weiterleitung scheitert. */
export const NICHT_ERREICHBAR = 'Der Assistent ist gerade nicht erreichbar. Ihre Nachricht ist gespeichert; bitte versuchen Sie es später noch einmal.';

/** Eine Nachrichten-ID aus der Adresse: eine positive ganze Zahl, sicher darstellbar. */
const ID = /^[1-9][0-9]{0,14}$/;

export interface ChatAbhaengigkeiten {
  readonly pool: pg.Pool;
  readonly zugangLesen: ZugangLesen;
  readonly jetzt: () => Date;
  /** Ohne ihn ist kein Assistent angebunden. */
  readonly koordinator?: KoordinatorKonfiguration;
  /** Nur für Tests: statt `fetch`. */
  readonly holen?: typeof fetch;
  /** Jede gespeicherte Nachricht geht hierhin (SSE, Push). */
  readonly chatEreignisse: ChatEreignisse;
  /** Nur für Tests: Abstand des Heartbeats. */
  readonly pulsMs?: number;
  /** Nachrichten an den Assistenten je Konto und Tag. */
  readonly tageslimit: number;
}

/** Ein Postfach in „Verlauf" bzw. als Chip. */
function postfachEintraege(postfaecher: readonly Postfach[], zugang: Zugang, aktuell: string | undefined) {
  // Ein angeheftetes Modul (COPI-121) hat seinen eigenen Eintrag in der Navigation und steht hier nicht noch einmal.
  return postfaecher.filter(({ modul }) => !inHauptnavigation(modul.block)).map(({ modul }) => ({
    name: modul.block.menuename,
    // Mobil als Chip neben „Assistent" und „Team": kurz, wie im Entwurf.
    kurz: 'Mails',
    href: postfachPfad(modul.kennung),
    aktuell: modul.kennung === aktuell,
    ungelesen: zugang.posteingang?.postfaecher[modul.kennung] ?? 0,
  }));
}

interface SeitenAngaben {
  readonly vor?: number;
  readonly fehler?: string;
  readonly eingabe?: string;
  readonly status?: number;
}

export function registriereChatRouten(app: FastifyInstance, abhaengigkeiten: ChatAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt, koordinator, holen, chatEreignisse, tageslimit } = abhaengigkeiten;

  /** Stand des Tageslimits eines Kontos, wie die Seite ihn zeigt. */
  async function limitStand(benutzerId: string, zeitpunkt: Date) {
    const verbraucht = await verbrauchLesen(pool, benutzerId, berlinerTag(zeitpunkt));
    return {
      rest: restAnzeige(verbraucht, tageslimit),
      erschoepft: verbraucht >= tageslimit,
      ab: zeitText(naechsterTagesbeginn(zeitpunkt), zeitpunkt),
    };
  }

  function limitErreicht(zeitpunkt: Date): string {
    return `Das Tageslimit von ${String(tageslimit)} Nachrichten an den Assistenten ist erreicht. Ab ${zeitText(naechsterTagesbeginn(zeitpunkt), zeitpunkt)} Uhr geht es wieder.`;
  }
  const stroeme = new StromZaehler();
  skriptAusliefern(app, SKRIPT_PFAD, skriptLesen('chat.js'));

  function kanalFuer(wahl: KanalWahl, benutzerId: string): Promise<Kanal> {
    return wahl === 'assistent' ? assistentKanal(pool, benutzerId) : teamKanal(pool);
  }

  /** Das Konto, wenn es chatten darf; sonst `undefined`. */
  function chatKonto(zugang: Zugang): string | undefined {
    return hatRecht(zugang, 'chat_nutzen') ? zugang.benutzerId : undefined;
  }

  async function seiteSenden(reply: FastifyReply, zugang: Zugang, benutzerId: string, wahl: KanalWahl, angaben: SeitenAngaben = {}) {
    const zeitpunkt = jetzt();
    const kanaele = await Promise.all(KANAELE.map(async (eintrag) => ({ ...eintrag, kanal: await kanalFuer(eintrag.wahl, benutzerId) })));
    const aktuell = kanaele.find((eintrag) => eintrag.wahl === wahl) ?? kanaele[0];
    if (aktuell === undefined) {
      throw new Error('Kein Kanal');
    }
    const verlauf = await verlaufLesen(pool, aktuell.kanal.id, angaben.vor === undefined ? {} : { vor: angaben.vor });
    const juengste = verlauf.at(-1);
    const aelteste = verlauf[0];
    const assistent = wahl === 'assistent';
    // Der alte Lesestand für den Trenner „Neu" (COPI-69): gelesen, bevor die Seite ihn neu setzt.
    const alterLesestand = assistent ? await lesestandLesen(pool, benutzerId, aktuell.kanal.id) : 0;
    if (angaben.vor === undefined && juengste !== undefined) {
      await lesestandSetzen(pool, benutzerId, aktuell.kanal.id, juengste.id);
    }
    // Erst nach dem Lesestand: sonst zählte die Navigation, was gerade gelesen wurde.
    const [staende, ungelesen, module] = await Promise.all([
      Promise.all(kanaele.map((eintrag) => kanalStand(pool, benutzerId, eintrag.kanal.id))),
      ungeleseneGesamt(pool, benutzerId),
      aktiveModule(pool),
    ]);
    const frisch = await mitFrischemPosteingang(pool, { ...zugang, chatUngelesen: ungelesen }, zeitpunkt, app.log);
    // Häkchen und Trenner gibt es nur im Assistenten-Kanal (COPI-69).
    const haken = assistent
      ? eigeneStaende(verlauf, benutzerId, juengste !== undefined && angaben.vor !== undefined && (await agentAntwortNach(pool, aktuell.kanal.id, juengste.id)))
      : new Map();
    const neuVor = assistent ? neuTrennerVor(verlauf, benutzerId, alterLesestand, verlauf.length === SEITE_HOECHSTENS) : undefined;

    const html = await app.render('chat.eta', {
      titel: aktuell.name,
      nav: navigationFuerZugang('chat', frisch),
      pfad: aktuell.pfad,
      postfaecher: postfachEintraege(sichtbarePostfaecher(module, zugang), frisch, undefined),
      ki: wahl === 'assistent',
      limit: wahl === 'assistent' ? await limitStand(benutzerId, zeitpunkt) : undefined,
      // Im Team-Kanal schreibt man immer; im Assistenten-Kanal nur, wenn einer angebunden ist.
      angebunden: wahl === 'team' || koordinator !== undefined,
      antwort:
        wahl === 'assistent' && koordinator !== undefined && angaben.vor === undefined
          ? antwortStand(verlauf, zeitpunkt, koordinator.fristMs)
          : undefined,
      kanaele: kanaele.map((eintrag, index) => ({
        name: eintrag.name,
        href: eintrag.pfad,
        aktuell: eintrag.wahl === wahl,
        vorschau: vorschau(staende[index]?.letzte),
        ungelesen: eintrag.wahl === wahl ? 0 : (staende[index]?.ungelesen ?? 0),
      })),
      nachrichten: verlauf.map((nachricht) => nachrichtAnsicht(nachricht, benutzerId, zeitpunkt, haken.get(nachricht.id))),
      neuVor,
      // Nur auf der jüngsten Seite: wer blättert, braucht keine neuen Nachrichten eingeblendet.
      strom:
        angaben.vor === undefined ? `${aktuell.pfad}/ereignisse${juengste === undefined ? '' : `?seit=${String(juengste.id)}`}` : undefined,
      aeltere: verlauf.length === SEITE_HOECHSTENS && aelteste !== undefined ? `${aktuell.pfad}?vor=${String(aelteste.id)}` : undefined,
      neuere: angaben.vor === undefined ? undefined : aktuell.pfad,
      fehler: angaben.fehler,
      eingabe: angaben.eingabe ?? '',
      hoechstens: INHALT_HOECHSTENS,
    });
    return reply
      .code(angaben.status ?? 200)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(html);
  }

  /**
   * Leitet die Frage an den Koordinator weiter. Scheitert es, schreibt das Cockpit eine Meldung dazu in den Verlauf —
   * die Frage selbst bleibt gespeichert. Im Log steht der Grund, nie der Inhalt.
   */
  async function koordinatorFragen(
    konfiguration: KoordinatorKonfiguration,
    frage: Nachricht,
    text: string,
    kanal: Kanal,
    zugang: Zugang,
    benutzerId: string,
    log: FastifyBaseLogger,
  ): Promise<void> {
    const ergebnis = await weiterleiten(
      konfiguration,
      {
        nachrichtId: frage.id,
        benutzer: { id: benutzerId, rolle: zugang.rolle ?? 'unbekannt', name: frage.absenderName },
        text,
        zeitpunkt: frage.erstelltAm,
      },
      jetzt(),
      holen ? { holen } : {},
    );
    if (ergebnis.ok) {
      // Quittung festhalten, bevor die Seite neu lädt: Haken angenommen (COPI-69). Scheitert das, bleibt es beim Haken gesendet.
      await nachrichtAlsZugestelltMarkieren(pool, frage.id).catch((fehler: unknown) => {
        log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Chat: Quittung nicht gespeichert');
      });
      return;
    }
    log.warn({ grund: ergebnis.grund, ...(ergebnis.grund === 'status' ? { status: ergebnis.status } : {}) }, 'Chat: Koordinator nicht erreicht');
    try {
      chatEreignisse.melden(await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'system', inhalt: NICHT_ERREICHBAR, antwortAuf: frage.id }));
    } catch (fehler) {
      log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Chat: Meldung zum Koordinator nicht gespeichert');
    }
  }

  /**
   * Öffnet den Stream eines Kanals. Die Reihenfolge schützt vor Lücken: erst abonnieren (was dann kommt, wartet), dann
   * Verpasstes aus der Datenbank senden, dann das Wartende — jede ID höchstens einmal, in aufsteigender Folge.
   */
  async function stromOeffnen(reply: FastifyReply, log: FastifyBaseLogger, wahl: KanalWahl, benutzerId: string, seit: number | undefined) {
    if (!stroeme.belegen(benutzerId)) {
      return reply.code(429).header('retry-after', '30').header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Zu viele offene Verbindungen.');
    }
    const raw = reply.raw;
    let letzte = seit;
    let offen = true;
    let bereit = false;
    const wartend: Nachricht[] = [];
    // Eine Kette statt paralleler Sendungen: das Rendern ist asynchron, die Reihenfolge soll trotzdem stimmen.
    let kette = Promise.resolve();
    let abmelden = (): void => undefined;
    const puls = setInterval(() => {
      if (offen) {
        raw.write(PULS);
      }
    }, abhaengigkeiten.pulsMs ?? PULS_MS);
    const schliessen = (): void => {
      if (!offen) {
        return;
      }
      offen = false;
      clearInterval(puls);
      abmelden();
      stroeme.freigeben(benutzerId);
    };
    raw.on('close', schliessen);

    async function senden(nachricht: Nachricht): Promise<void> {
      if (!offen || (letzte !== undefined && nachricht.id <= letzte)) {
        return;
      }
      letzte = nachricht.id;
      const html = await app.render('partials/chat-nachricht.eta', { nachricht: nachrichtAnsicht(nachricht, benutzerId, jetzt(), wahl === 'assistent' ? nachrichtStatus(nachricht, false) : undefined) });
      if (offen) {
        raw.write(ereignisText({ id: nachricht.id, art: 'nachricht', daten: html.trim() }));
      }
    }

    function einreihen(nachricht: Nachricht): void {
      kette = kette.then(() => senden(nachricht)).catch((fehler: unknown) => {
        log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Chat: Ereignis nicht gesendet');
      });
    }

    reply.hijack();
    raw.writeHead(200, {
      // `hijack` umgeht alle Haken, auch den der Sicherheits-Header (COPI-93).
      ...SICHERHEITS_KOPF,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      // Für Proxies, die sonst puffern (nginx); Caddy reicht text/event-stream von selbst sofort durch.
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    raw.write(ereignisText({ retry: WIEDERVERBINDEN_MS }));
    try {
      const kanal = await kanalFuer(wahl, benutzerId);
      abmelden = chatEreignisse.abonnieren((nachricht) => {
        if (nachricht.kanalId !== kanal.id) {
          return;
        }
        if (bereit) {
          einreihen(nachricht);
        } else {
          wartend.push(nachricht);
        }
      });
      if (!offen) {
        abmelden();
        return;
      }
      if (seit !== undefined) {
        const verpasst = await nachrichtenSeit(pool, kanal.id, seit);
        for (const nachricht of verpasst) {
          einreihen(nachricht);
        }
        if (verpasst.length === SEITE_HOECHSTENS) {
          // Mehr verpasst, als eine Seite fasst: die Seite lädt neu, statt eine Lücke zu zeigen.
          kette = kette.then(() => {
            if (offen) {
              raw.write(ereignisText({ art: 'neuladen', daten: 'mehr als eine Seite verpasst' }));
            }
          });
        }
      }
      bereit = true;
      for (const nachricht of wartend.splice(0)) {
        einreihen(nachricht);
      }
    } catch (fehler) {
      log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Chat: Stream nicht geöffnet');
      schliessen();
      raw.end();
    }
    return reply;
  }

  app.get<{ Params: { kennung: string } }>('/chat/postfach/:kennung', async (request, reply) => {
    const zugang = await zugangLesen(request);
    const benutzerId = chatKonto(zugang);
    const { kennung } = request.params;
    const postfaecher = benutzerId !== undefined && istModulKennung(kennung) ? sichtbarePostfaecher(await aktiveModule(pool), zugang) : [];
    const postfach = postfaecher.find(({ modul }) => modul.kennung === kennung);
    if (benutzerId === undefined || postfach === undefined) {
      return nichtGefunden(app, reply);
    }
    const zeitpunkt = jetzt();
    const { modul, posteingang } = postfach;
    const bis = await standSichern(pool, benutzerId, modulQuelle(modul.kennung), zeitpunkt);
    const kanaele = await Promise.all(KANAELE.map(async (eintrag) => ({ ...eintrag, kanal: await kanalFuer(eintrag.wahl, benutzerId) })));
    const [staende, gelesen] = await Promise.all([
      Promise.all(kanaele.map((eintrag) => kanalStand(pool, benutzerId, eintrag.kanal.id))),
      postfachLesen(pool, modul.kennung, modul.block, posteingang, benutzerId, bis, request.log),
    ]);
    const html = await app.render('chat.eta', {
      titel: modul.block.menuename,
      nav: navigationFuerZugang('chat', zugang),
      pfad: postfachPfad(modul.kennung),
      ki: false,
      kanaele: kanaele.map((eintrag, index) => ({
        name: eintrag.name,
        href: eintrag.pfad,
        aktuell: false,
        vorschau: vorschau(staende[index]?.letzte),
        ungelesen: staende[index]?.ungelesen ?? 0,
      })),
      postfaecher: postfachEintraege(postfaecher, zugang, modul.kennung),
      postfach: {
        unterzeile: `${String(zugang.posteingang?.postfaecher[modul.kennung] ?? 0)} ungelesen · auch unter Module erreichbar`,
        verfuegbar: gelesen.ok,
        zeilen: gelesen.ok ? postfachAnsicht(modul.kennung, gelesen.wert, zeitpunkt, modul.block.statuswoerter) : [],
      },
      nachrichten: [],
    });
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });

  for (const { wahl, pfad } of KANAELE) {
    app.get<{ Querystring: { seit?: unknown } }>(`${pfad}/ereignisse`, async (request, reply) => {
      const zugang = await zugangLesen(request);
      const benutzerId = chatKonto(zugang);
      if (benutzerId === undefined) {
        return nichtGefunden(app, reply);
      }
      return stromOeffnen(reply, request.log, wahl, benutzerId, seitAus(request.headers['last-event-id'], request.query.seit));
    });

    app.get<{ Querystring: { vor?: unknown } }>(pfad, async (request, reply) => {
      const zugang = await zugangLesen(request);
      const benutzerId = chatKonto(zugang);
      if (benutzerId === undefined) {
        return nichtGefunden(app, reply);
      }
      const vor = request.query.vor;
      return seiteSenden(reply, zugang, benutzerId, wahl, typeof vor === 'string' && ID.test(vor) ? { vor: Number(vor) } : {});
    });

    app.post<{ Body: { inhalt?: unknown } | undefined }>(pfad, async (request, reply) => {
      const zugang = await zugangLesen(request);
      const benutzerId = chatKonto(zugang);
      if (benutzerId === undefined) {
        return nichtGefunden(app, reply);
      }
      const roh = request.body?.inhalt;
      // Höchstens so viel einer abgewiesenen Eingabe kommt zurück ins Feld: sie steht dort wieder, damit nichts verloren geht.
      const eingabe = typeof roh === 'string' ? Array.from(roh).slice(0, INHALT_HOECHSTENS + 100).join('') : '';
      const { origin, referer, host } = request.headers;
      if (!herkunftBelegt(origin, referer, host)) {
        request.log.warn('Chat: Nachricht abgewiesen (Herkunft)');
        return seiteSenden(reply, zugang, benutzerId, wahl, { fehler: FEHLER.herkunft, status: 403 });
      }
      if (wahl === 'assistent' && koordinator === undefined) {
        return seiteSenden(reply, zugang, benutzerId, wahl, { fehler: FEHLER.keinAssistent, status: 409 });
      }
      const pruefung = eingabePruefen(roh);
      if (!pruefung.ok) {
        return seiteSenden(reply, zugang, benutzerId, wahl, { fehler: pruefung.fehler, eingabe, status: 400 });
      }
      // Erst buchen, dann speichern: die Datenbank lässt nie mehr als das Limit durch, auch nicht bei parallelen Anfragen.
      const zeitpunkt = jetzt();
      const tag = berlinerTag(zeitpunkt);
      if (wahl === 'assistent' && (await verbrauchBuchen(pool, benutzerId, tag, tageslimit)) === undefined) {
        return seiteSenden(reply, zugang, benutzerId, wahl, { fehler: limitErreicht(zeitpunkt), eingabe, status: 429 });
      }
      let frage: Nachricht;
      let kanal: Kanal;
      try {
        kanal = await kanalFuer(wahl, benutzerId);
        frage = await nachrichtAnlegen(pool, { kanalId: kanal.id, absenderArt: 'mensch', absenderId: benutzerId, inhalt: pruefung.inhalt });
      } catch (fehler) {
        if (wahl === 'assistent') {
          // Nicht gespeichert heißt nicht verbraucht.
          await verbrauchZurueckgeben(pool, benutzerId, tag).catch(() => undefined);
        }
        // Nur die Meldung, nie der Inhalt der Nachricht: der gehört nicht ins Log.
        request.log.error({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Chat: Nachricht nicht gespeichert');
        return seiteSenden(reply, zugang, benutzerId, wahl, { fehler: FEHLER.gescheitert, eingabe, status: 500 });
      }
      chatEreignisse.melden(frage);
      // Wer schreibt, hat den Kanal bis dahin gesehen (COPI-69): auch was live per SSE kam, nachdem die Seite den
      // Lesestand gesetzt hatte. Sonst stünde eine längst gelesene Antwort nach dem Neuladen wieder hinter „Neu“.
      await lesestandSetzen(pool, benutzerId, kanal.id, frage.id - 1).catch((fehler: unknown) => {
        request.log.warn({ grund: fehler instanceof Error ? fehler.message : 'unbekannt' }, 'Chat: Lesestand beim Schreiben nicht gesetzt');
      });
      if (wahl === 'assistent' && koordinator !== undefined) {
        await koordinatorFragen(koordinator, frage, pruefung.inhalt, kanal, zugang, benutzerId, request.log);
      }
      return reply.code(303).header('location', pfad).header('cache-control', 'no-store').send();
    });
  }
}
