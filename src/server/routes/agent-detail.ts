/**
 * Die Detailseite eines Agenten (COPI-113, freigegebener Entwurf): `GET /agenten/:schluessel` (`agentSchluessel`: die
 * Kundensicht zeigt die Kennung nirgends, auch nicht in der Adresse, COPI-38), mit `?bereich=` für die
 * Reiter (Steckbrief, Chats, Mails, Protokoll, Verbrauch), `?kanal=` für ein Gespräch und `?art=` für den Filter des
 * Protokolls — alles Links, ohne Skript.
 *
 * **Wer:** wie die Seite Agenten jedes angemeldete Konto; was es sieht, regeln dieselben Rechte wie überall
 * (`agenten/detail.ts`, Kopf). Eine unbekannte oder ungültige Kennung ergibt die neutrale 404; ein entfernter Agent
 * bleibt aufrufbar (nie löschen).
 *
 * **Fremdtexte** (Nachrichten, Mail-Betreffe, Befunde, Inventar) werden escaped und nie verlinkt (JAC-577).
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { hatRecht, type Zugang, type ZugangLesen } from '../../auth/berechtigung.js';
import { nachrichtAnsicht, standText as seitenStand, vorschau } from '../../chat/ansicht.js';
import { agentGespraeche, verlaufLesen, type Kanal } from '../../chat/nachricht-speicher.js';
import {
  agentenEreignis,
  agentEreignisZeile,
  agentPfad,
  agentSchluessel,
  AGENT_SCHLUESSEL,
  bereichAus,
  initiale,
  protokollAnsicht,
  protokollArtAus,
  protokollChips,
  reiter,
  standText,
  stufeAus,
  stufenChips,
  uebernahmeEreignisse,
  verbrauchAb,
  verbrauchAnsicht,
  type Bereich,
  type ProtokollEreignis,
} from '../../agenten/detail.js';
import { ereignisseLesen as gemeldeteEreignisseLesen } from '../../agenten/ereignis-speicher.js';
import { AGENT_TAGE, agentenNachrichtenLesen, agentNachrichtenZaehlen, agentVerbrauchLesen, uebernahmenLesen } from '../../agenten/detail-speicher.js';
import { aktiveModule, type AktivesModul } from '../../module/modul-speicher.js';
import { modulZugriffErlaubt } from '../../module/sichtbarkeit.js';
import { modulQuelle, postfachAnsicht, postfachDetailPfad, postfachPfad, type PostfachZeileAnsicht } from '../../posteingang/posteingang.js';
import { postfachLesen, standSichern, type PostfachZeile } from '../../posteingang/posteingang-speicher.js';
import { agentenMitEntferntenLesen, type AgentMitStand } from '../../status/agenten-speicher.js';
import { agentenAnsicht } from '../../status/agenten.js';
import { betreuerMeldungenLesen, kundenMeldungenLesen } from '../../status/meldungen-speicher.js';
import { navigationFuerZugang } from '../navigation.js';
import { nichtGefunden } from './neutral.js';

export interface AgentDetailAbhaengigkeiten {
  readonly pool?: pg.Pool;
  readonly zugangLesen?: ZugangLesen;
  readonly jetzt: () => Date;
}

/** So viele Einträge zeigt „Zuletzt" im Steckbrief. */
const ZULETZT = 3;

interface Postfach {
  readonly modul: AktivesModul;
  readonly zeilen: readonly PostfachZeile[];
  readonly verfuegbar: boolean;
}

/** Der Agent zu einem Schlüssel aus der Adresse (`agentSchluessel`); `undefined` für jede andere Form oder ohne Treffer. */
async function agentZu(pool: pg.Pool, schluessel: string): Promise<AgentMitStand | undefined> {
  if (!AGENT_SCHLUESSEL.test(schluessel)) {
    return undefined;
  }
  return (await agentenMitEntferntenLesen(pool)).find((agent) => agentSchluessel(agent.kennung) === schluessel);
}

export function registerAgentDetailRoute(app: FastifyInstance, abhaengigkeiten: AgentDetailAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt } = abhaengigkeiten;

  /** Die Zeilen der Postfächer des Agenten, mit „ungelesen" für dieses Konto. */
  async function postfaecherLesen(db: pg.Pool, module: readonly AktivesModul[], benutzerId: string | undefined, zeitpunkt: Date, log: Parameters<typeof postfachLesen>[6]): Promise<Postfach[]> {
    return Promise.all(
      module
        .filter((modul) => modul.block.posteingang !== undefined)
        .map(async (modul) => {
          const posteingang = modul.block.posteingang;
          if (posteingang === undefined || benutzerId === undefined) {
            return { modul, zeilen: [], verfuegbar: false };
          }
          const bis = await standSichern(db, benutzerId, modulQuelle(modul.kennung), zeitpunkt);
          const gelesen = await postfachLesen(db, modul.kennung, modul.block, posteingang, benutzerId, bis, log);
          return { modul, zeilen: gelesen.ok ? gelesen.wert : [], verfuegbar: gelesen.ok };
        }),
    );
  }

  /** Alles, was das Protokoll zeigt (siehe `agenten/detail.ts`), für diesen Zugang. */
  async function ereignisseLesen(db: pg.Pool, zugang: Zugang | undefined, kennung: string, module: readonly AktivesModul[], postfaecher: readonly Postfach[], zeitpunkt: Date): Promise<ProtokollEreignis[]> {
    const technik = zugang !== undefined && hatRecht(zugang, 'technik_sehen');
    const seit = new Date(zeitpunkt.getTime() - AGENT_TAGE * 86_400_000);
    const namen = new Map(module.map((modul) => [modul.kennung, modul.block.menuename]));
    const titel = new Map(postfaecher.flatMap((fach) => fach.zeilen.map((zeile) => [`${fach.modul.kennung}/${zeile.id}`, zeile.titel] as const)));
    const [uebernahmen, nachrichten, befunde, gemeldet] = await Promise.all([
      uebernahmenLesen(db, module.map((modul) => modul.kennung), seit, 50),
      technik ? agentenNachrichtenLesen(db, kennung, seit, 50) : [],
      (technik ? betreuerMeldungenLesen : kundenMeldungenLesen)(db, { art: undefined, suche: undefined, anzahl: 50, agent: kennung }),
      gemeldeteEreignisseLesen(db, kennung, seit, technik, 50),
    ]);
    return [
      ...gemeldet.map(agentEreignisZeile),
      ...postfaecher.flatMap((fach) =>
        fach.zeilen
          .filter((zeile) => zeile.zeit !== undefined && zeile.zeit.getTime() >= seit.getTime())
          .map((zeile): ProtokollEreignis => ({
            art: 'mail',
            titel: 'Mail eingegangen',
            text: zeile.anriss.length > 0 ? `${zeile.titel} — ${zeile.anriss}` : zeile.titel,
            am: zeile.zeit ?? zeitpunkt,
            ton: 'akzent',
            typ: fach.modul.block.menuename,
            href: postfachDetailPfad(fach.modul.kennung, zeile.id),
          })),
      ),
      ...uebernahmen.flatMap((uebernahme) =>
        uebernahmeEreignisse(uebernahme, namen.get(uebernahme.modul) ?? uebernahme.modul, titel.get(`${uebernahme.modul}/${uebernahme.vorgangId}`), postfachDetailPfad(uebernahme.modul, uebernahme.vorgangId)),
      ),
      ...nachrichten.map((nachricht) => agentenEreignis(nachricht, kennung, `${agentPfad(kennung, 'chats')}&kanal=${String(nachricht.kanalId)}`)),
      ...befunde
        .filter((befund) => befund.gemeldetAm.getTime() >= seit.getTime())
        .map((befund): ProtokollEreignis => ({
          art: 'befund',
          titel: `Befund: ${befund.name ?? 'Wache'}`,
          text: befund.text,
          am: befund.gemeldetAm,
          ton: befund.status,
          typ: befund.status === 'rot' ? 'Befund · Rot' : befund.status === 'gelb' ? 'Befund · Gelb' : 'Befund · Grün',
          href: '/meldungen',
        })),
    ];
  }

  /** Die Gespräche des Agenten in dieser Sicht und das gewählte mit seinem Verlauf. */
  async function chatsLesen(db: pg.Pool, zugang: Zugang, kennung: string, gewaehlt: unknown, zeitpunkt: Date) {
    const benutzerId = zugang.benutzerId ?? '';
    const technik = hatRecht(zugang, 'technik_sehen');
    const alle = (await agentGespraeche(db, kennung, benutzerId)).filter((gespraech) => technik || gespraech.kanal.art !== 'agent');
    // Nur mit `technik` gibt es Agentenkanäle; nur dort steht eine Kennung im Namen.
    const name = (kanal: Kanal): string => {
      if (kanal.art === 'agent' && kanal.agenten) {
        const [a, b] = kanal.agenten;
        return `${kennung} ↔ ${a === kennung ? b : a}`;
      }
      return kanal.art === 'team' ? 'Team-Kanal' : 'Dein Assistent-Kanal';
    };
    const id = typeof gewaehlt === 'string' && /^[1-9][0-9]{0,14}$/.test(gewaehlt) ? Number(gewaehlt) : undefined;
    const aktuell = alle.find((gespraech) => gespraech.kanal.id === id) ?? alle[0];
    const verlauf = aktuell === undefined ? [] : await verlaufLesen(db, aktuell.kanal.id);
    return {
      liste: alle.map((gespraech) => ({
        name: name(gespraech.kanal),
        agent: gespraech.kanal.art === 'agent',
        href: `${agentPfad(kennung, 'chats')}&kanal=${String(gespraech.kanal.id)}`,
        aktuell: gespraech === aktuell,
        vorschau: vorschau(gespraech.letzte),
      })),
      titel: aktuell === undefined ? undefined : name(aktuell.kanal),
      nurLesen: aktuell?.kanal.art === 'agent',
      nachrichten: verlauf.map((nachricht) => {
        const ansicht = nachrichtAnsicht(nachricht, benutzerId, zeitpunkt);
        const vomAgenten = nachricht.absenderAgent;
        // Im Kanal zweier Agenten steht der Agent dieser Seite rechts; jede Agenten-Nachricht trägt ihre Kennung.
        return vomAgenten === undefined ? ansicht : { ...ansicht, absender: vomAgenten, eigen: aktuell?.kanal.art === 'agent' && vomAgenten === kennung };
      }),
    };
  }

  app.get<{ Params: { schluessel: string }; Querystring: { bereich?: unknown; kanal?: unknown; art?: unknown; stufe?: unknown } }>('/agenten/:schluessel', async (request, reply) => {
    const zugang = zugangLesen ? await zugangLesen(request) : undefined;
    const agent = pool ? await agentZu(pool, request.params.schluessel) : undefined;
    if (pool === undefined || agent === undefined) {
      return nichtGefunden(app, reply);
    }
    const kennung = agent.kennung;
    const zeitpunkt = jetzt();
    const technik = zugang !== undefined && hatRecht(zugang, 'technik_sehen');
    const bereich: Bereich = bereichAus(request.query.bereich, technik);
    const module = (await aktiveModule(pool)).filter((modul) => modul.block.agent === kennung && modulZugriffErlaubt(zugang, modul));
    const ungelesen = module.reduce((summe, modul) => summe + (zugang?.posteingang?.postfaecher[modul.kennung] ?? 0), 0);
    const braucht = (bereiche: readonly Bereich[]): boolean => bereiche.includes(bereich);
    const postfaecher = braucht(['steckbrief', 'mails', 'protokoll']) ? await postfaecherLesen(pool, module, zugang?.benutzerId, zeitpunkt, request.log) : [];
    const art = protokollArtAus(request.query.art);
    const stufe = art === 'ereignis' ? stufeAus(request.query.stufe) : undefined;
    const ereignisse = braucht(['steckbrief', 'protokoll']) ? await ereignisseLesen(pool, zugang, kennung, module, postfaecher, zeitpunkt) : [];
    // COPI-114: gemeldete Fehler der letzten sieben Tage, in der Sicht des Betrachters (Kennzahl im Steckbrief).
    const fehlerSieben = ereignisse.filter((ereignis) => ereignis.stufe === 'fehler' && ereignis.am.getTime() >= zeitpunkt.getTime() - 7 * 86_400_000);
    const verbrauch = technik && braucht(['steckbrief', 'verbrauch']) ? verbrauchAnsicht(await agentVerbrauchLesen(pool, kennung, verbrauchAb(zeitpunkt)), zeitpunkt) : undefined;
    const karte = agentenAnsicht([agent], technik ? 'betreuer' : 'kunde', zeitpunkt).karten[0];

    const html = await app.render('agent-detail.eta', {
      titel: agent.rolle,
      nav: navigationFuerZugang('agenten', zugang),
      kennung,
      technik,
      initiale: initiale(agent.rolle, kennung),
      karte,
      stand: standText(agent.aktualisiertAm, agent.entferntAm, zeitpunkt),
      seitenStand: seitenStand(zeitpunkt),
      bereich,
      reiter: reiter(kennung, bereich, technik, { mails: ungelesen }),
      zeitplan: agent.zeitplan,
      module: module.map((modul) => ({
        name: modul.block.menuename,
        href: modul.block.posteingang === undefined ? `/module/${encodeURIComponent(modul.kennung)}` : postfachPfad(modul.kennung),
        ungelesen: zugang?.posteingang?.postfaecher[modul.kennung] ?? 0,
        postfach: modul.block.posteingang !== undefined,
      })),
      kennzahlen:
        bereich === 'steckbrief'
          ? {
              offen: ungelesen,
              nachrichten: zugang?.benutzerId === undefined ? 0 : await agentNachrichtenZaehlen(pool, kennung, zugang.benutzerId, new Date(zeitpunkt.getTime() - 7 * 86_400_000), technik),
              kosten: verbrauch?.monat,
              monat: verbrauch?.monatName,
              // COPI-114: gemeldete Fehler der letzten sieben Tage (in der Sicht des Betrachters).
              fehler: fehlerSieben.length,
              fehlerZuletzt: protokollAnsicht(fehlerSieben, zeitpunkt, undefined, 1)[0],
            }
          : undefined,
      zuletzt: bereich === 'steckbrief' ? protokollAnsicht(ereignisse, zeitpunkt, undefined, ZULETZT) : [],
      chats: bereich === 'chats' && zugang !== undefined ? await chatsLesen(pool, zugang, kennung, request.query.kanal, zeitpunkt) : undefined,
      mails:
        bereich === 'mails'
          ? postfaecher.map((fach) => ({
              name: fach.modul.block.menuename,
              href: postfachPfad(fach.modul.kennung),
              verfuegbar: fach.verfuegbar,
              zeilen: postfachAnsicht(fach.modul.kennung, fach.zeilen, zeitpunkt, fach.modul.block.statuswoerter) satisfies PostfachZeileAnsicht[],
            }))
          : [],
      protokoll:
        bereich === 'protokoll'
          ? {
              chips: protokollChips(kennung, art, technik),
              stufen: art === 'ereignis' ? stufenChips(kennung, stufe) : [],
              zeilen: protokollAnsicht(ereignisse, zeitpunkt, art, 50, stufe),
            }
          : undefined,
      verbrauch: bereich === 'verbrauch' ? verbrauch : undefined,
    });
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
}
