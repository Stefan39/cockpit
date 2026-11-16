import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { hatRecht, istRolle, ROLLE_BETREUER, ROLLEN_NAMEN, type Zugang, type ZugangLesen } from '../../auth/berechtigung.js';
import { BETREUER_ZUGRIFF_STANDARD, BETREUER_ZUGRIFF_STUFEN, BETREUER_ZUGRIFF_TEXT, betreuerZugriffeLesen, type BetreuerZugriffStand } from '../../module/betreuer-zugriff.js';
import { istBetriebsmodul } from '../../module/block.js';
import { aktiveModule } from '../../module/modul-speicher.js';
import { FREIGABE_BEREICH_TEXT, FREIGABE_BEREICHE, FREIGABE_MODI, FREIGABE_TEXT, freigabeModiLesen } from '../../status/freigabe-modus.js';
import { WARTUNGSFENSTER_STANDARD, WARTUNGSFENSTER_TEXT, type Wartungsfenster } from '../../status/wartungsfenster.js';
import { betreuerVersionenLesen, kundenVersionenLesen } from '../../status/versionen-speicher.js';
import { betreuerVersionen, kundenVersionen } from '../../status/versionen.js';
import { zeitText } from '../../chat/ansicht.js';
import { geraetName } from '../../chat/push.js';
import { aktiveAbos } from '../../chat/push-speicher.js';
import type { SymbolQuelle } from '../../pwa/symbol-speicher.js';
import { istModulKennung } from '../../module/block.js';
import type { CockpitAuth } from '../../auth/konfiguration.js';
import { faktorenLesen } from '../../auth/faktoren.js';
import { navigationFuerZugang } from '../navigation.js';

export const EINSTELLUNGEN_PFAD = '/einstellungen';

export interface EinstellungenAbhaengigkeiten {
  /** Ohne Datenbank zeigt die Seite, was ohne Daten gilt (Tests und Entwicklung ohne Datenbank). */
  readonly pool?: pg.Pool;
  /** Ohne Zugangsleser (keine Anmeldung eingerichtet) gilt die Kundensicht. */
  readonly zugangLesen?: ZugangLesen;
  readonly jetzt: () => Date;
  /** Der öffentliche VAPID-Schlüssel (COPI-59); ohne ihn ist Push auf der Instanz nicht eingerichtet. */
  readonly pushOeffentlich?: string;
  /** Das App-Symbol (COPI-101); ohne Quelle kein Abschnitt „Erscheinungsbild". */
  readonly symbole?: SymbolQuelle;
  /** Für den Abschnitt „Anmeldung & Sicherheit" (COPI-94); ohne (keine Anmeldung eingerichtet) kein Abschnitt. */
  readonly auth?: CockpitAuth;
  /** Das Wartungsfenster der automatischen Image-Updates (COPI-235); ohne Angabe der Standard. */
  readonly wartungsfenster?: Wartungsfenster;
}

/**
 * Der Abschnitt „Anmeldung & Sicherheit" (COPI-94): eine Zusammenfassung der eigenen zweiten Faktoren und der Weg zur
 * Seite `/sicherheit`. Für jede Rolle (es ist das eigene Konto); nur mit Datenbank, Anmeldung und Sitzung.
 */
async function sicherheitAbschnitt(zugang: Zugang | undefined, abhaengigkeiten: Pick<EinstellungenAbhaengigkeiten, 'pool' | 'auth'>) {
  const { pool, auth } = abhaengigkeiten;
  const benutzerId = zugang?.angemeldet === true ? zugang.benutzerId : undefined;
  if (pool === undefined || auth === undefined || benutzerId === undefined) {
    return undefined;
  }
  const faktoren = await faktorenLesen(pool, auth, benutzerId);
  const anzahl = faktoren.passkeys.length;
  return {
    plakette: anzahl === 1 ? '1 Passkey' : `${String(anzahl)} Passkeys`,
    passkeys: anzahl === 0 ? 'keine' : faktoren.passkeys.map((passkey) => passkey.name).join(', '),
    totp: faktoren.totp ? 'eingerichtet' : 'nicht eingerichtet',
    ersatzcodes: faktoren.ersatzcodes,
  };
}

/** Was die Seite nach einem Update-Antrag (COPI-40) zusätzlich zeigt. Nur in der Betreuersicht. */
export interface AntragsRueckmeldung {
  /** Die Bestätigung nach einem Antrag oder Rückzug. */
  readonly hinweis?: string;
  /** Warum ein Antrag nicht gestellt wurde. */
  readonly fehler?: string;
  /** Die Eingabe, die zum Fehler führte: sie steht wieder im Feld (maskiert). */
  readonly eingabe?: string;
  /** Betrifft die Rückmeldung ein Modul (COPI-106), steht sie bei dessen Karte; sonst beim Cockpit. */
  readonly modul?: string;
  /** Nach dem Entfernen eines Geräts (COPI-59) oder einem Test-Push (COPI-116). */
  readonly pushHinweis?: string;
  /** Kein Gerät hat den Test-Push angenommen (COPI-116). */
  readonly pushFehler?: string;
  /** Nach dem Speichern oder Zurücksetzen des App-Symbols (COPI-101). */
  readonly symbolHinweis?: string;
}

/**
 * Der Abschnitt Benachrichtigungen (COPI-58, COPI-59): ob Push auf der Instanz eingerichtet ist, der öffentliche
 * Schlüssel für das Skript, und die eigenen Geräte. Ohne Recht `chat_nutzen` oder ohne Datenbank keine Geräte.
 */
/** Die Rückmeldungen zu Push in der Adresse: nur feste Texte (COPI-59, COPI-116). */
const PUSH_HINWEISE: Readonly<Record<string, string>> = {
  entfernt: 'Das Gerät bekommt keine Benachrichtigungen mehr.',
  test: 'Test-Push verschickt. Kommt er auf einem Gerät nicht an, dort Benachrichtigungen aus- und wieder einschalten.',
};

const PUSH_TEST_FEHLER =
  'Kein Gerät hat den Test-Push angenommen (oder es kam gerade erst einer). Benachrichtigungen auf dem Gerät aus- und wieder einschalten.';

async function pushAbschnitt(
  zugang: Zugang | undefined,
  abhaengigkeiten: Pick<EinstellungenAbhaengigkeiten, 'pool' | 'jetzt' | 'pushOeffentlich'>,
  hinweis: string | undefined,
  fehler: string | undefined,
) {
  const { pool, jetzt, pushOeffentlich } = abhaengigkeiten;
  const konto = zugang !== undefined && hatRecht(zugang, 'chat_nutzen') ? zugang.benutzerId : undefined;
  if (pushOeffentlich === undefined || konto === undefined || pool === undefined) {
    return { eingerichtet: pushOeffentlich !== undefined, oeffentlich: undefined, geraete: [], hinweis, fehler };
  }
  const zeitpunkt = jetzt();
  const geraete = (await aktiveAbos(pool, konto)).map((abo) => ({
    id: abo.id,
    name: geraetName(abo.endpoint),
    seit: zeitText(abo.angelegtAm, zeitpunkt),
    erreicht: abo.zuletztErfolgreichAm === undefined ? 'noch nie erreicht' : `zuletzt erreicht ${zeitText(abo.zuletztErfolgreichAm, zeitpunkt)}`,
  }));
  return { eingerichtet: true, oeffentlich: pushOeffentlich, geraete, hinweis, fehler };
}

/**
 * Der Abschnitt Erscheinungsbild (COPI-101): nur mit dem Recht `erscheinungsbild_aendern` und einer Symbol-Quelle.
 * Ob ein eigenes Symbol gilt, seit wann und von wem; das Bild selbst zeigt die Seite über die Adresse mit Hash.
 */
async function erscheinungsbildAbschnitt(
  zugang: Zugang | undefined,
  abhaengigkeiten: Pick<EinstellungenAbhaengigkeiten, 'symbole' | 'jetzt'>,
  hinweis: string | undefined,
) {
  const { symbole, jetzt } = abhaengigkeiten;
  if (symbole === undefined || zugang === undefined || !hatRecht(zugang, 'erscheinungsbild_aendern')) {
    return undefined;
  }
  const { satz, eigenes } = await symbole.aktuell();
  return {
    hash: satz.hash,
    eigenes: eigenes === undefined ? undefined : { seit: zeitText(eigenes.seit, jetzt()), von: eigenes.von },
    hinweis,
  };
}

/** Wer zuletzt gesetzt hat, als Satz: „von Anna Beispiel, heute 18:10", „per Server-Kommando", „beim Update". */
function zugriffHerkunft(stand: BetreuerZugriffStand, jetzt: Date): string {
  const wer = stand.weg === 'oberflaeche' ? `von ${stand.von ?? 'einem entfernten Konto'}` : stand.weg === 'konsole' ? 'per Server-Kommando' : 'beim Update übernommen';
  return `${wer}, ${zeitText(stand.am, jetzt)}`;
}

/**
 * Der Abschnitt Betreuer-Zugriff (COPI-134): je aktives Fachmodul die Stufe, die der Kunde dem Betreuer freigegeben hat.
 * Der Betriebs-Admin (Recht `betreuer_zugriff_freigeben`) ändert sie, der Betreuer sieht nur den Stand — was er sehen
 * darf, entscheidet der Kunde. Für den Mitarbeiter und ohne Datenbank kein Abschnitt. Technische Module (`art: betrieb`)
 * stehen nicht darin: die sieht der Betreuer immer.
 */
async function betreuerZugriffAbschnitt(zugang: Zugang | undefined, pool: pg.Pool | undefined, jetzt: Date, hinweis: ZugriffHinweis | undefined) {
  const aendern = zugang !== undefined && hatRecht(zugang, 'betreuer_zugriff_freigeben');
  if (pool === undefined || zugang === undefined || !(aendern || zugang.rolle === ROLLE_BETREUER)) {
    return undefined;
  }
  const [module, staende] = await Promise.all([aktiveModule(pool), betreuerZugriffeLesen(pool)]);
  return {
    aendern,
    hinweis,
    stufen: BETREUER_ZUGRIFF_STUFEN.map((stufe) => ({ wert: stufe, text: BETREUER_ZUGRIFF_TEXT[stufe] })),
    module: module
      .filter((modul) => !istBetriebsmodul(modul.block))
      .map((modul) => {
        const stand = staende.get(modul.kennung);
        const stufe = stand?.stufe ?? BETREUER_ZUGRIFF_STANDARD;
        return {
          kennung: modul.kennung,
          name: modul.block.menuename,
          stufe,
          text: BETREUER_ZUGRIFF_TEXT[stufe],
          herkunft: stand === undefined ? undefined : zugriffHerkunft(stand, jetzt),
        };
      }),
  };
}

interface ZugriffHinweis {
  readonly art: 'ok' | 'fehler';
  readonly text: string;
}

const ZUGRIFF_HINWEISE: Readonly<Record<string, ZugriffHinweis>> = {
  gesetzt: { art: 'ok', text: 'Gespeichert. Der Betreuer sieht das Modul ab sofort so.' },
  unveraendert: { art: 'ok', text: 'Diese Stufe galt schon; es wurde nichts geändert.' },
  abgewiesen: { art: 'fehler', text: 'Das hat nicht geklappt: das Modul ist nicht (mehr) aktiv. Es wurde nichts geändert.' },
};

const FREIGABE_HINWEISE: Readonly<Record<string, ZugriffHinweis>> = {
  gesetzt: { art: 'ok', text: 'Gespeichert. Der neue Freigabemodus gilt für jeden neuen Antrag; laufende behalten ihren.' },
  unveraendert: { art: 'ok', text: 'Dieser Freigabemodus galt schon; es wurde nichts geändert.' },
  abgewiesen: { art: 'fehler', text: 'Das hat nicht geklappt: unbekannter Bereich oder Modus. Es wurde nichts geändert.' },
};

/**
 * Freigabe von Updates (COPI-141): je Bereich der geltende Modus und wer ihn wann gesetzt hat. Nur für den Betreuer, der
 * beantragen darf, und nur mit Datenbank.
 */
async function freigabeAbschnitt(
  pool: pg.Pool | undefined,
  moeglich: boolean,
  jetzt: Date,
  hinweis: ZugriffHinweis | undefined,
  fenster: Wartungsfenster,
) {
  if (pool === undefined || !moeglich) {
    return undefined;
  }
  const staende = await freigabeModiLesen(pool);
  return {
    hinweis,
    modi: FREIGABE_MODI.map((modus) => ({ wert: modus, text: FREIGABE_TEXT[modus] })),
    bereiche: FREIGABE_BEREICHE.map((bereich) => {
      const stand = staende[bereich];
      return {
        bereich,
        name: FREIGABE_BEREICH_TEXT[bereich],
        modus: stand.modus,
        text: FREIGABE_TEXT[stand.modus],
        fenster: bereich === 'cockpit' && stand.modus === 'automatisch' ? WARTUNGSFENSTER_TEXT[fenster] : undefined,
        herkunft: stand.am === undefined ? undefined : `von ${stand.von ?? 'einem entfernten Konto'}, ${zeitText(stand.am, jetzt)}`,
      };
    }),
  };
}

const SYMBOL_HINWEISE: Readonly<Record<string, string>> = {
  gespeichert: 'Das neue Symbol ist gespeichert.',
  zurueckgesetzt: 'Das Standard-Symbol gilt wieder.',
};

/** Die Rückmeldungen, die nach einem Antrag in der Adresse stehen dürfen: nur feste Texte, nie ein Wert aus ihr. */
const HINWEISE: Readonly<Record<string, string>> = {
  gestellt: 'Antrag gestellt. Die Freigabe erfolgt außerhalb des Cockpits.',
  // COPI-141: im Freigabemodus „direkt" ist der Antrag mit dem Bestätigen freigegeben.
  freigegeben: 'Update freigegeben. Der Admin-Agent spielt es ohne Rückfrage ein; bis er beginnt, lässt es sich zurückziehen.',
  zurueckgezogen: 'Antrag zurückgezogen.',
};

/**
 * Die Einstellungen (COPI-39) mit dem Abschnitt **Versionen** — aufgebaut wie der Bildschirm „Einstellungen" des
 * Prototyps. Die Stammdaten des Prototyps (Benachrichtigungs-E-Mail) kommen erst, wenn es sie gibt.
 *
 * **Zwei Sichten** (ADR 13.1): wer das Recht `technik_sehen` hat (der Betreuer), sieht Version, laufenden Digest,
 * Soll-Digest, verfügbare Version und den Stand der Versions-Wache; alle anderen einen Klartextsatz je Bereich,
 * keine Digests, keine Versionsnummern. Die Trennung liegt schon in der Abfrage (`versionen-speicher.ts`): die
 * Kundensicht lädt nur den Status des jüngsten Antrags. Ein Konto mit unbekannter Rolle bekommt die Kundensicht.
 *
 * Wer das Recht `update_beantragen` hat (der Betreuer), stellt hier den Update-Antrag oder zieht ihn zurück
 * (COPI-40, `update-antrag.ts`). Wer es nicht hat, sieht dafür weder Knopf noch Formular.
 *
 * Oben steht wie im Prototyp „Ansicht: <Rolle>". Die Rolle kommt bei jeder Anfrage frisch aus der Datenbank; die
 * Seite ist rollenabhängig und deshalb `no-store`.
 */
export async function einstellungenSenden(
  app: FastifyInstance,
  reply: FastifyReply,
  zugang: Zugang | undefined,
  abhaengigkeiten: Pick<EinstellungenAbhaengigkeiten, 'pool' | 'jetzt' | 'pushOeffentlich' | 'symbole' | 'auth' | 'wartungsfenster'>,
  rueckmeldung: AntragsRueckmeldung & { readonly zugriffHinweis?: ZugriffHinweis; readonly freigabeHinweis?: ZugriffHinweis } = {},
  status = 200,
): Promise<void> {
  const { pool, jetzt } = abhaengigkeiten;
  const fenster = abhaengigkeiten.wartungsfenster ?? WARTUNGSFENSTER_STANDARD;
  const betreuer = zugang !== undefined && hatRecht(zugang, 'technik_sehen');
  const versionen = betreuer
    ? { sicht: 'betreuer', ...betreuerVersionen(pool ? await betreuerVersionenLesen(pool, jetzt(), fenster) : { instanz: undefined, antrag: undefined, wache: undefined }, jetzt()) }
    : { sicht: 'kunde', ...kundenVersionen(pool ? await kundenVersionenLesen(pool) : { antragStatus: undefined }) };
  const beantragen = zugang !== undefined && hatRecht(zugang, 'update_beantragen');
  const push = await pushAbschnitt(zugang, abhaengigkeiten, rueckmeldung.pushHinweis, rueckmeldung.pushFehler);
  const erscheinungsbild = await erscheinungsbildAbschnitt(zugang, abhaengigkeiten, rueckmeldung.symbolHinweis);
  const sicherheit = await sicherheitAbschnitt(zugang, abhaengigkeiten);
  const betreuerZugriff = await betreuerZugriffAbschnitt(zugang, pool, jetzt(), rueckmeldung.zugriffHinweis);
  const freigabe = await freigabeAbschnitt(pool, betreuer && beantragen, jetzt(), rueckmeldung.freigabeHinweis, fenster);

  const html = await app.render('einstellungen.eta', {
    titel: 'Einstellungen',
    nav: navigationFuerZugang('einstellungen', zugang),
    ansicht: zugang?.angemeldet === true && istRolle(zugang.rolle) ? ROLLEN_NAMEN[zugang.rolle] : undefined,
    versionen,
    // Ohne das Recht gibt es keinen Antrag — und damit auch keine Rückmeldung dazu.
    antrag: betreuer && beantragen ? { ...rueckmeldung, moeglich: true } : { moeglich: false },
    push,
    erscheinungsbild,
    sicherheit,
    betreuerZugriff,
    freigabe,
  });
  await reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
}

export function registerEinstellungenRoute(app: FastifyInstance, abhaengigkeiten: EinstellungenAbhaengigkeiten): void {
  const { zugangLesen } = abhaengigkeiten;

  app.get<{ Querystring: { antrag?: unknown; modul?: unknown; push?: unknown; symbol?: unknown; zugriff?: unknown; freigabe?: unknown } }>(EINSTELLUNGEN_PFAD, async (request, reply) => {
    const zugang = zugangLesen ? await zugangLesen(request) : undefined;
    const antrag = request.query.antrag;
    const hinweis = typeof antrag === 'string' && Object.hasOwn(HINWEISE, antrag) ? HINWEISE[antrag] : undefined;
    // Nur eine gültige Kennung, und nur als Zuordnung zu einer Karte: der Text bleibt fest.
    const kennung = request.query.modul;
    const modul = hinweis !== undefined && typeof kennung === 'string' && istModulKennung(kennung) ? kennung : undefined;
    const push = request.query.push;
    const pushHinweis = typeof push === 'string' && Object.hasOwn(PUSH_HINWEISE, push) ? PUSH_HINWEISE[push] : undefined;
    const pushFehler = push === 'test-fehler' ? PUSH_TEST_FEHLER : undefined;
    const symbol = request.query.symbol;
    const symbolHinweis = typeof symbol === 'string' && Object.hasOwn(SYMBOL_HINWEISE, symbol) ? SYMBOL_HINWEISE[symbol] : undefined;
    const zugriff = request.query.zugriff;
    const zugriffHinweis = typeof zugriff === 'string' && Object.hasOwn(ZUGRIFF_HINWEISE, zugriff) ? ZUGRIFF_HINWEISE[zugriff] : undefined;
    const freigabeWert = request.query.freigabe;
    const freigabeHinweis = typeof freigabeWert === 'string' && Object.hasOwn(FREIGABE_HINWEISE, freigabeWert) ? FREIGABE_HINWEISE[freigabeWert] : undefined;
    await einstellungenSenden(app, reply, zugang, abhaengigkeiten, {
      ...(hinweis === undefined ? {} : { hinweis }),
      ...(modul === undefined ? {} : { modul }),
      ...(pushHinweis === undefined ? {} : { pushHinweis }),
      ...(pushFehler === undefined ? {} : { pushFehler }),
      ...(symbolHinweis === undefined ? {} : { symbolHinweis }),
      ...(zugriffHinweis === undefined ? {} : { zugriffHinweis }),
      ...(freigabeHinweis === undefined ? {} : { freigabeHinweis }),
    });
  });
}
