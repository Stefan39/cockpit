/**
 * Die Seite Benutzer (COPI-45, ADR Abschnitt 5: „echte Menschen, Rolle, 2FA-Status — Agenten stehen hier bewusst
 * nicht") — reine Funktionen, der Zeitpunkt ist ein Parameter.
 *
 * Betreuer und Betriebs-Admin (Recht `benutzer_sehen`) sehen dasselbe: jedes Konto und jede offene Einladung. Auch der
 * Betreuer-Zugang steht in der Liste — der Betrieb soll sehen, wer Zugriff auf sein System hat.
 *
 * **Der Stand eines Kontos** folgt aus dem zweiten Faktor (die eine Quelle, `cockpit.zweiter_faktor_aktiv`, COPI-25):
 *
 *   * `aktiv` — der zweite Faktor ist eingerichtet;
 *   * `Einrichtung offen` — das Konto wurde angelegt, der zweite Faktor fehlt noch. Es verfällt 72 Stunden nach der
 *     Anlage (COPI-17); die Seite sagt, wann;
 *   * `wird wiederhergestellt` — das Konto war schon aktiv, der Betreuer hat es entsperrt (COPI-28): Faktoren und
 *     Passwort sind entwertet, bis der persönlich übergebene Link eingelöst ist. Ein solches Konto verfällt nicht.
 *
 * **Nur lesend.** Sperren, Löschen und Rollen ändern sind sicherheitskritisch und bekommen ein eigenes Ticket.
 */
import { KONTO_VERFALL_FRIST_MS } from './konto-verfall.js';
import { istRolle, ROLLEN_NAMEN, type Rolle } from './berechtigung.js';
import { inText, vorText } from '../status/zustand.js';

/** Ein Konto, wie es die Abfrage liefert — nie mit Passwort, Hash, Geheimnis oder Sitzung. */
export interface KontoDaten {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  /** Der Wert aus der Datenbank; ein unbekannter wird nicht geraten, sondern als solcher gezeigt. */
  readonly rolle: string;
  readonly zweiterFaktorAktiv: boolean;
  /** Anzahl der Passkeys. */
  readonly passkeys: number;
  /** Ein TOTP-Faktor (Authenticator-App) ist eingerichtet. */
  readonly totp: boolean;
  readonly angelegtAm: Date;
  /** Gesetzt, sobald das Konto einmal einen zweiten Faktor hatte (Migration 0006). */
  readonly aktiviertAm: Date | undefined;
  /** Die jüngste erfolgreiche Anmeldung laut Protokoll. */
  readonly zuletztAngemeldet: Date | undefined;
}

/** Eine offene Einladung: nicht eingelöst, nicht abgelaufen. */
export interface EinladungDaten {
  readonly email: string;
  readonly rolle: string;
  /** Der Name dessen, der eingeladen hat; `undefined`, wenn sein Konto nicht mehr besteht. */
  readonly eingeladenVon: string | undefined;
  readonly ablaufAm: Date;
}

export interface BenutzerDaten {
  readonly konten: readonly KontoDaten[];
  readonly einladungen: readonly EinladungDaten[];
  /** Das Konto, das die Seite ansieht: seine Zeile trägt „Sie". */
  readonly selbstId: string | undefined;
  /** Darf, wer die Seite ansieht, dieses Konto bearbeiten (COPI-46)? Ohne Angabe keines. */
  readonly bearbeitbar?: (konto: KontoDaten) => boolean;
}

export interface KontoStand {
  readonly text: string;
  readonly farbe: 'gruen' | 'gelb';
  /** Was dazu wichtig ist, etwa „verfällt in 5 Stunden"; sonst keins. */
  readonly hinweis: string | undefined;
}

export interface KontoZeile {
  readonly name: string;
  readonly email: string;
  readonly rolle: string;
  readonly stand: KontoStand;
  readonly faktor: string;
  readonly angelegt: string;
  readonly zuletzt: string;
  readonly selbst: boolean;
  /** Die Seite zum Bearbeiten, wenn der Ansehende daran etwas darf; sonst keine. */
  readonly bearbeiten: string | undefined;
}

export interface EinladungZeile {
  readonly email: string;
  readonly rolle: string;
  readonly von: string;
  readonly ablauf: string;
}

export interface BenutzerListe {
  readonly konten: readonly KontoZeile[];
  readonly einladungen: readonly EinladungZeile[];
}

/** Die Reihenfolge der Liste: wer am meisten darf, steht oben. */
const ROLLEN_FOLGE: readonly Rolle[] = ['betreuer', 'betriebs_admin', 'betrieb_mitarbeiter'];

function rolleName(rolle: string): string {
  return istRolle(rolle) ? ROLLEN_NAMEN[rolle] : 'unbekannte Rolle';
}

function rollenRang(rolle: string): number {
  const rang = ROLLEN_FOLGE.findIndex((kandidat) => kandidat === rolle);
  return rang === -1 ? ROLLEN_FOLGE.length : rang;
}

/** Sekunden bis zu einem Zeitpunkt, nie negativ. */
function bis(zeitpunkt: Date, jetzt: Date): number {
  return Math.max(0, Math.floor((zeitpunkt.getTime() - jetzt.getTime()) / 1000));
}

/** Sekunden seit einem Zeitpunkt, nie negativ: springt die Uhr zurück, heißt es „gerade eben". */
function seit(zeitpunkt: Date, jetzt: Date): number {
  return Math.max(0, Math.floor((jetzt.getTime() - zeitpunkt.getTime()) / 1000));
}

export function kontoStand(konto: KontoDaten, jetzt: Date): KontoStand {
  if (konto.zweiterFaktorAktiv) {
    return { text: 'aktiv', farbe: 'gruen', hinweis: undefined };
  }
  if (konto.aktiviertAm !== undefined) {
    return { text: 'wird wiederhergestellt', farbe: 'gelb', hinweis: 'Zweiter Faktor wird neu eingerichtet' };
  }
  const verfall = new Date(konto.angelegtAm.getTime() + KONTO_VERFALL_FRIST_MS);
  return { text: 'Einrichtung offen', farbe: 'gelb', hinweis: `verfällt ${inText(bis(verfall, jetzt))}` };
}

/** „Passkey", „2 Passkeys", „Authenticator-App", beides verbunden mit „und" — oder „keiner". */
export function faktorText(konto: Pick<KontoDaten, 'passkeys' | 'totp'>): string {
  const teile: string[] = [];
  if (konto.passkeys === 1) {
    teile.push('Passkey');
  } else if (konto.passkeys > 1) {
    teile.push(`${String(konto.passkeys)} Passkeys`);
  }
  if (konto.totp) {
    teile.push('Authenticator-App');
  }
  return teile.length === 0 ? 'keiner' : teile.join(' und ');
}

function nachRolleUndName(a: KontoDaten, b: KontoDaten): number {
  return rollenRang(a.rolle) - rollenRang(b.rolle) || a.name.localeCompare(b.name, 'de') || a.email.localeCompare(b.email, 'de');
}

export function benutzerListe(daten: BenutzerDaten, jetzt: Date): BenutzerListe {
  return {
    konten: [...daten.konten].sort(nachRolleUndName).map((konto) => ({
      name: konto.name,
      email: konto.email,
      rolle: rolleName(konto.rolle),
      stand: kontoStand(konto, jetzt),
      faktor: faktorText(konto),
      angelegt: vorText(seit(konto.angelegtAm, jetzt)),
      zuletzt: konto.zuletztAngemeldet === undefined ? 'noch nie' : vorText(seit(konto.zuletztAngemeldet, jetzt)),
      selbst: konto.id === daten.selbstId,
      bearbeiten: daten.bearbeitbar?.(konto) === true ? `/benutzer/${encodeURIComponent(konto.id)}` : undefined,
    })),
    einladungen: [...daten.einladungen]
      .sort((a, b) => a.ablaufAm.getTime() - b.ablaufAm.getTime())
      .map((einladung) => ({
        email: einladung.email,
        rolle: rolleName(einladung.rolle),
        von: einladung.eingeladenVon ?? 'ein nicht mehr bestehendes Konto',
        ablauf: `läuft ab ${inText(bis(einladung.ablaufAm, jetzt))}`,
      })),
  };
}
