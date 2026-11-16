/**
 * Rollen und die eine Stelle, an der entschieden wird, wer was darf
 * (COPI-11, COPI-22, Architektur-Vorschlag Abschnitt 7 und 13.1).
 *
 * Bewusst getrennt in zwei Teile:
 *   1. Reine Funktionen über einen bereits ermittelten Zugangszustand
 *      (`hatRecht`, `darfEinladen`, `einladbareRollen`). Ohne Fastify, ohne
 *      Datenbank, vollständig testbar — und die einzigen Stellen, an denen die
 *      Bedingungen überhaupt formuliert sind.
 *   2. `zugangLeserBauen` — ermittelt diesen Zustand aus der Anfrage.
 *
 * Drei Rollen, in dieser Rangfolge:
 *   * `betreuer` — Stefan bzw. wer die Betreuung übernimmt. Höchstens **einer**
 *     je Instanz (partieller Unique-Index in der Datenbank), dauerhaft, mit
 *     vollständigen Rechten für das gesamte System. Nie über die Oberfläche
 *     oder eine Einladung vergebbar; entsteht durch den Erststart und wechselt
 *     nur durch `betreuerUebergeben` (`betreuer.ts`).
 *   * `betriebs_admin` — Betriebs-Admin des Kunden, darf Mitarbeiter einladen.
 *   * `betrieb_mitarbeiter` — Default für jeden eingeladenen Zugang.
 *
 * Jede Rechtsprüfung verlangt vollständig: angemeldet UND aktiver zweiter
 * Faktor UND eine bekannte Rolle mit dem Recht. Auch der Betreuer braucht Sitzung
 * und zweiten Faktor — „vollständige Rechte" heißt nicht „ohne Tor".
 *
 * Wichtig für das Review: diese Prüfung steht **nicht** stellvertretend für
 * die zentrale 2FA-Weiche und verlässt sich auch nicht auf sie. Die Weiche
 * schützt jede Route vor Konten ohne zweiten Faktor; hier wird der zweite
 * Faktor ein zweites Mal geprüft, damit die Einladungsroute auch dann dicht
 * bleibt, wenn an der Weiche einmal etwas geändert wird.
 */
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ungeleseneGesamt } from '../chat/nachricht-speicher.js';
import type { PosteingangAnsicht } from '../posteingang/posteingang.js';
import { SITZUNGS_COOKIE_NAME, type CockpitAuth } from './konfiguration.js';

/** Die Rolle mit vollständigen Rechten. Höchstens ein Konto, nie vergebbar (siehe Kopf). */
export const ROLLE_BETREUER = 'betreuer';

/**
 * Die Rollen, die in der Oberfläche vergebbar sind, also über eine Einladung.
 * `betreuer` ist laut Architektur-Vorschlag in der Oberfläche nicht vergebbar —
 * sonst könnte sich der Betriebs-Admin selbst dorthin befördern — und steht
 * deshalb hier bewusst nicht.
 */
export const ROLLEN = ['betriebs_admin', 'betrieb_mitarbeiter'] as const;

export type VergebbareRolle = (typeof ROLLEN)[number];

/** Alle Rollen, die in der Datenbank stehen dürfen: die vergebbaren und der Betreuer. */
export const ALLE_ROLLEN = [ROLLE_BETREUER, ...ROLLEN] as const;

export type Rolle = (typeof ALLE_ROLLEN)[number];

/** Betriebssprache: so heißen die Rollen für Menschen, nicht wie in der Datenbank. */
export const ROLLEN_NAMEN: Readonly<Record<Rolle, string>> = {
  betreuer: 'Betreuer',
  betriebs_admin: 'Betriebs-Admin',
  betrieb_mitarbeiter: 'Mitarbeiter',
};

/** Rolle jedes eingeladenen Kontos, wenn nichts anderes verlangt ist; entspricht dem Spalten-Default. */
export const ROLLE_DEFAULT: VergebbareRolle = 'betrieb_mitarbeiter';

/** Rolle des Betriebs-Admins. */
export const ROLLE_ADMIN: VergebbareRolle = 'betriebs_admin';

/**
 * Wandelt einen Datenbankwert in eine bekannte Rolle. Ein unbekannter Wert
 * ergibt `false` und damit keine Berechtigung — die Prüfung fällt im
 * Zweifel zugunsten der Sperre aus.
 */
export function istRolle(wert: unknown): wert is Rolle {
  return typeof wert === 'string' && (ALLE_ROLLEN as readonly string[]).includes(wert);
}

/** Wie `istRolle`, aber nur für Rollen, die eine Einladung vergeben darf. */
export function istVergebbareRolle(wert: unknown): wert is VergebbareRolle {
  return typeof wert === 'string' && (ROLLEN as readonly string[]).includes(wert);
}

export interface Zugang {
  readonly angemeldet: boolean;
  readonly rolle: Rolle | undefined;
  readonly zweiterFaktorAktiv: boolean;
  /** Konto-ID der Sitzung — nur für die Zuordnung „wer hat eingeladen". */
  readonly benutzerId: string | undefined;
  /**
   * Seit wann die Sitzung besteht: die Anmeldung samt zweitem Faktor (COPI-46, „frische Anmeldung"). Ohne Angabe gilt
   * die Sitzung als nicht frisch — im Zweifel zu.
   */
  readonly angemeldetSeit?: Date;
  /**
   * Ungelesene Nachrichten im Chat (COPI-53), für das Kennzeichen in der Navigation. Nur gesetzt, wenn das Konto chatten
   * darf; ohne Angabe zeigt die Navigation keins.
   */
  readonly chatUngelesen?: number;
  /**
   * Mindestens ein aktives Modul ist für diese Rolle sichtbar (COPI-78, `module/sichtbarkeit.ts`), für den
   * Eintrag „Module" der Navigation. Wird nicht hier, sondern beim Aufbau der Anwendung ergänzt
   * (`server/app.ts`), damit `berechtigung.ts` die Modul-Registry nicht kennen muss (sonst ein Ringschluss:
   * `module/block.ts` importiert von hier). Ohne Angabe gilt „kein Modul sichtbar".
   */
  readonly moduleSichtbar?: boolean;
  /**
   * Die Module mit `navigation: haupt` (COPI-121), die dieser Zugang sieht, nach Menüname — je ein eigener Eintrag in der
   * Navigation. Ergänzt wie `moduleSichtbar`; ohne Angabe keins.
   */
  readonly moduleAngeheftet?: readonly AngeheftetesModul[];
  /**
   * Die Navigationseinträge der Erweiterungen (COPI-193), die dieser Zugang sehen darf (Recht geprüft). Ergänzt wie
   * `moduleAngeheftet` in `server/app.ts`; ohne Angabe keiner — im Kundenimage ist die Liste der Erweiterungen leer.
   */
  readonly erweiterungen?: readonly ErweiterungEintrag[];
  /**
   * Der Hinweis „Update verfügbar" (COPI-84): der Text der Versions-Wache, wenn ihr jüngster Befund gelb ist. Nur für
   * Konten mit `technik_sehen` gelesen (`status/update-hinweis.ts`, ergänzt in `server/app.ts`); die Kundensicht lädt nie
   * Daten der Wache (ADR 13.1). Ohne Angabe: kein Hinweis.
   */
  readonly updateVerfuegbar?: { readonly text: string };
  /**
   * Mindestens eine Karte unter Einstellungen › Versionen bietet „Update installieren" an (COPI-140): dann trägt
   * „Einstellungen" in der Navigation einen Hinweispunkt. Gelesen wie `updateVerfuegbar`, nur mit `technik_sehen`.
   */
  readonly updateInstallierbar?: boolean;
  /**
   * Der Posteingang im Kopf der Seiten (COPI-112): Ungelesenes aus Chat, Postfächern und Meldungen. Ergänzt in
   * `server/app.ts` (`posteingang/lesen.ts`), aus demselben Grund wie `moduleSichtbar`. Ohne Angabe: kein Badge.
   */
  readonly posteingang?: PosteingangAnsicht;
  /**
   * Die Freigabe-Inbox (COPI-139): die Zahl der offenen Entwürfe der Repo-Wache für die Navigation. Ergänzt in
   * `server/app.ts` (`freigaben/zugang.ts`), nur für Konten mit `technik_sehen` und nur, wenn das Modul konfiguriert ist.
   * Ohne Angabe: kein Eintrag. `offen` ist `undefined`, wenn die Repo-Wache gerade nicht antwortet.
   */
  readonly freigaben?: { readonly offen: number | undefined };
}

/** Ein angeheftetes Modul in der Navigation (COPI-121): Kennung und Menüname, mehr braucht der Eintrag nicht. */
export interface AngeheftetesModul {
  readonly kennung: string;
  readonly menuename: string;
}

/** Der Navigationseintrag einer Erweiterung (COPI-193): Kennung, Text und Ziel. */
export interface ErweiterungEintrag {
  readonly kennung: string;
  readonly text: string;
  readonly href: string;
}

export const OHNE_ZUGANG: Zugang = {
  angemeldet: false,
  rolle: undefined,
  zweiterFaktorAktiv: false,
  benutzerId: undefined,
};

/**
 * Die Rechte, die eine Rolle haben kann. Neue Rechte kommen hier und in `RECHTE_JE_ROLLE` dazu.
 *
 * `rohbefunde_sehen` (COPI-37): die Befunde sehen, die nicht für Kunden bestimmt sind. Der Betreuer hat
 * es, der Betriebs-Admin und der Mitarbeiter nicht — auf der Übersicht sehen sie nur, was der Agent für
 * sie freigegeben hat (Architektur-Vorschlag 4 und 10).
 *
 * `technik_sehen` (COPI-38): Kennung und Version der Agenten sehen. Ebenfalls nur der Betreuer. Ein eigenes
 * Recht, weil es etwas anderes ist als die Rohbefunde: wer eines später einer weiteren Rolle gibt, gibt damit
 * nicht das andere.
 *
 * `update_beantragen` (COPI-40): ein Update des Cockpits beantragen und einen noch nicht freigegebenen Antrag
 * zurückziehen. Nur der Betreuer (ADR 13.1). Wer Digests sehen darf, darf damit noch keinen Antrag stellen.
 *
 * `benutzer_sehen` (COPI-45): die Seite Benutzer — alle Konten mit Rolle und Stand des zweiten Faktors, dazu die
 * offenen Einladungen. Betreuer und Betriebs-Admin: wer Menschen in den Betrieb holt, soll sehen, wer schon Zugang hat.
 * Der Mitarbeiter nicht — Adressen und Rollen der Kollegen braucht er für seine Arbeit nicht.
 *
 * `benutzer_bearbeiten` (COPI-46): Konten mit **niedrigerer** Rolle bearbeiten — Name, entfernen, zweiten Faktor
 * zurücksetzen. Betreuer und Betriebs-Admin; an wem, regelt `benutzer-bearbeiten.ts`.
 *
 * `rollen_aendern` (COPI-46): die Rolle eines Kontos zwischen Betriebs-Admin und Mitarbeiter wechseln. Nur der
 * Betreuer (Stefans Entscheidung vom 22.09.2026). Betreuer wird dadurch niemand: diese Rolle ist nie vergebbar.
 *
 * `chat_nutzen` (COPI-53): den Chat — den eigenen Kanal mit dem Assistenten und den gemeinsamen Team-Kanal. Jede Rolle;
 * der Betreuer hat es wie jedes Recht, er sieht also auch den Team-Kanal des Kunden (Betreuung).
 *
 * `erscheinungsbild_aendern` (COPI-101): das App-Symbol der Instanz hochladen und auf den Standard zurücksetzen.
 * Betreuer und Betriebs-Admin — es ist die App des Kunden. Der Mitarbeiter nicht.
 *
 * `betreuer_zugriff_freigeben` (COPI-134): festlegen, ob der Betreuer die Fachdaten eines Moduls sieht (`aus`, `lesen`,
 * `entscheiden`). **Nur der Betriebs-Admin, ausdrücklich nicht der Betreuer** (`NIE_FUER_BETREUER`): der Kunde
 * entscheidet über seine Daten (Stefan, 09.10.2026), sonst gäbe sich der Betreuer den Zugriff selbst.
 */
export const RECHTE = [
  'einladen',
  'rohbefunde_sehen',
  'technik_sehen',
  'update_beantragen',
  'benutzer_sehen',
  'benutzer_bearbeiten',
  'rollen_aendern',
  'chat_nutzen',
  'erscheinungsbild_aendern',
  'betreuer_zugriff_freigeben',
] as const;

export type Recht = (typeof RECHTE)[number];

/**
 * Rechte der vergebbaren Rollen. Der Betreuer steht hier **nicht**: er hat jedes
 * Recht, auch jedes künftige, per Konstruktion in `hatRecht` — ein Eintrag je
 * Recht, den man vergessen kann, gäbe es sonst genau bei dem Recht, das er
 * dringend braucht.
 */
const RECHTE_JE_ROLLE: Readonly<Record<VergebbareRolle, readonly Recht[]>> = {
  betriebs_admin: ['einladen', 'benutzer_sehen', 'benutzer_bearbeiten', 'chat_nutzen', 'erscheinungsbild_aendern', 'betreuer_zugriff_freigeben'],
  betrieb_mitarbeiter: ['chat_nutzen'],
};

/**
 * Die einzigen Rechte, die der Betreuer **nicht** hat (COPI-134). Sonst hat er jedes Recht per Konstruktion (siehe
 * `RECHTE_JE_ROLLE`); hier steht, was der Kunde selbst entscheidet.
 */
const NIE_FUER_BETREUER: readonly Recht[] = ['betreuer_zugriff_freigeben'];

/** Wen welche Rolle einladen darf. Der Betreuer ist nie einladbar. */
const EINLADBAR_DURCH: Readonly<Record<Rolle, readonly VergebbareRolle[]>> = {
  betreuer: ['betriebs_admin', 'betrieb_mitarbeiter'],
  // Kleinstes Recht: der Betriebs-Admin holt nur Mitarbeiter dazu (Annahme, die ADR schweigt dazu).
  betriebs_admin: ['betrieb_mitarbeiter'],
  betrieb_mitarbeiter: [],
};

/**
 * Die eine Rechteregel. Alle Bedingungen müssen halten; sie werden explizit auf
 * `true` bzw. auf die Rolle geprüft, damit kein wahrheitsähnlicher Wert
 * durchrutscht. Eine fehlende oder unbekannte Rolle hat nie ein Recht.
 */
export function hatRecht(zugang: Zugang, recht: Recht): boolean {
  if (zugang.angemeldet !== true || zugang.zweiterFaktorAktiv !== true) {
    return false;
  }
  if (zugang.rolle === ROLLE_BETREUER) {
    return !NIE_FUER_BETREUER.includes(recht);
  }
  return istVergebbareRolle(zugang.rolle) && RECHTE_JE_ROLLE[zugang.rolle].includes(recht);
}

/** Die Rollen, die dieser Zugang einladen darf — leer, wenn er nicht einladen darf. */
export function einladbareRollen(zugang: Zugang): readonly VergebbareRolle[] {
  if (!hatRecht(zugang, 'einladen') || !istRolle(zugang.rolle)) {
    return [];
  }
  return EINLADBAR_DURCH[zugang.rolle];
}

/** Darf dieser Zugang jemanden mit dieser Rolle einladen? */
export function darfEinladen(zugang: Zugang, zielRolle: VergebbareRolle): boolean {
  return einladbareRollen(zugang).includes(zielRolle);
}

/** Rolle und zweiter Faktor eines Kontos, wie sie gerade in der Datenbank stehen. */
export interface ZugangsZustand {
  /** `undefined` bei unbekanntem Konto oder einem Wert, der keine Rolle ist. */
  readonly rolle: Rolle | undefined;
  readonly zweiterFaktorAktiv: boolean;
}

/**
 * Liest Rolle **und** zweiten Faktor in einer Abfrage. Der Faktor kommt aus der einen
 * Quelle (`cockpit.zweiter_faktor_aktiv`, COPI-25), nicht aus der Sitzung.
 */
export async function zugangsZustandLesen(
  pool: pg.Pool,
  benutzerId: string,
): Promise<ZugangsZustand> {
  const ergebnis = await pool.query<{ rolle: string; aktiv: boolean }>(
    // Ein als gelöscht markiertes Konto hat keine Rolle und keinen Zugang mehr (COPI-62).
    'SELECT rolle, cockpit.zweiter_faktor_aktiv(u) AS aktiv FROM cockpit."user" u WHERE u.id = $1 AND u.geloescht_am IS NULL',
    [benutzerId],
  );
  const zeile = ergebnis.rows[0];
  return {
    rolle: istRolle(zeile?.rolle) ? zeile.rolle : undefined,
    zweiterFaktorAktiv: zeile?.aktiv === true,
  };
}

export type ZugangLesen = (request: FastifyRequest) => Promise<Zugang>;

/**
 * Ermittelt den Zugangszustand einer Anfrage: Sitzung über Better Auth,
 * Rolle und zweiter Faktor frisch aus der Datenbank.
 *
 * Die Rolle kommt bewusst aus der Datenbank und nicht aus der Sitzung: eine
 * Rollenänderung wirkt damit sofort und nicht erst nach dem nächsten
 * Anmelden. Ohne Sitzungs-Cookie wird die Datenbank gar nicht erst gefragt.
 */
export function zugangLeserBauen(auth: CockpitAuth, pool: pg.Pool): ZugangLesen {
  return async (request: FastifyRequest): Promise<Zugang> => {
    if (!request.headers.cookie?.includes(SITZUNGS_COOKIE_NAME)) {
      return OHNE_ZUGANG;
    }
    const sitzung = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!sitzung) {
      return OHNE_ZUGANG;
    }
    const zustand = await zugangsZustandLesen(pool, sitzung.user.id);
    const zugang: Zugang = {
      angemeldet: true,
      rolle: zustand.rolle,
      zweiterFaktorAktiv: zustand.zweiterFaktorAktiv,
      benutzerId: sitzung.user.id,
      angemeldetSeit: sitzung.session.createdAt,
    };
    // Eine Abfrage mehr je angemeldeter Seite, dafür steht das Kennzeichen in jeder Navigation ohne Zutun der Route.
    return hatRecht(zugang, 'chat_nutzen') ? { ...zugang, chatUngelesen: await ungeleseneGesamt(pool, sitzung.user.id) } : zugang;
  };
}
