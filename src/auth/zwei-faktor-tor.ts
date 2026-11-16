/**
 * Das zentrale Tor des Cockpits — Sitzungspflicht (COPI-13) und zweiter
 * Faktor (COPI-10) an genau einer Stelle.
 *
 * Bewusst genau ein `onRequest`-Haken auf App-Ebene statt Einzelprüfungen in
 * den Routen — eine vergessene Route wäre sonst ein offenes Loch.
 *
 * Zwei Stufen, in dieser Reihenfolge:
 *
 *   1. **Sitzungspflicht, deny by default (COPI-13).** Ohne Sitzung ist nur
 *      eine ausdrückliche Allowlist erreichbar (`ANONYM_ERLAUBT`); alles
 *      andere landet auf der Anmeldeseite. Das ersetzt die „neutrale
 *      Wurzelseite" aus COPI-10: `/` ist ohne Anmeldung nicht mehr
 *      erreichbar.
 *   2. **Zweiter Faktor (COPI-10).** Ein frisch angelegtes Konto ist im
 *      Zustand „zweiter Faktor fehlt", bis TOTP eingerichtet **und** einmal
 *      erfolgreich geprüft wurde. Better Auth bildet genau das ab:
 *      Der Faktor gilt erst beim erfolgreichen Verifizieren des Einrichtungs-
 *      Codes als aktiv. Die Antwort kommt aus einer Quelle, der Datenbank-
 *      Funktion `cockpit.zweiter_faktor_aktiv` (COPI-25), nicht aus der Sitzung.
 *
 * Zwei Pfadgruppen bekommen **keine** Umleitung, sondern die neutrale
 * „nicht gefunden"-Seite:
 *
 *   * `/einladung` (das Formular, exakt) ohne Sitzung — Vertrag aus COPI-11:
 *     dieselbe Antwort für „nicht angemeldet", „falsche Rolle" und „kein
 *     Token". Ebenso `/zugang-wiederherstellen` ohne Token (COPI-28).
 *   * `/intern/*` — die **Agenten-API** (COPI-35) ist die einzige Ausnahme von „Sitzung und zweiter
 *     Faktor vor jeder Route": sie wird maschinell mit einem Bearer-Token aufgerufen, nicht von einem
 *     Konto. Das Tor lässt den Präfix durch, ohne eine Sitzung auch nur zu lesen (ein Cookie schaltet
 *     dort nichts frei), und die Routen darunter prüfen das Token selbst (`src/intern/zugang.ts`).
 *     Freigegeben nur, wenn **jede** Schreibweise des Pfades auf `/intern` zeigt. Ebenso `/pipeline/*`, die
 *     Pipeline-API für den Runner (COPI-145): dort prüft die Route eine HMAC-Signatur (`src/pipeline/api.ts`).
 *   * `/api/auth/*` — die rohen Better-Auth-Endpunkte, **in jedem Zustand**
 *     (COPI-20). Das serverseitig gerenderte Cockpit braucht sie im Browser
 *     nicht; die Seiten arbeiten mit `auth.api.*` im Serverprozess. Erreichbar
 *     wäre sonst z. B. `/two-factor/disable` mit gestohlener Sitzung und
 *     Passwort, oder `/sign-in/email` an der eigenen Ratenbegrenzung vorbei.
 *     Deshalb deny by default: nur `AUTH_ERLAUBT`, nur mit Sitzung, sonst
 *     dieselbe 404 wie für Anonyme, ohne ablesbaren Unterschied.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ASSETS_PFAD } from '../assets/manifest.js';
import { SYMBOL_PFAD } from '../pwa/symbol.js';
import { htmlSenden } from './antwort.js';
import { AUTH_BASIS_PFAD } from './konfiguration.js';

export const ANMELDEN_PFAD = '/anmelden';
export const ZWEI_FAKTOR_PFAD = '/zwei-faktor';
export const ABMELDEN_PFAD = '/abmelden';
export const ERSTSTART_PFAD = '/erststart';
export const GESUND_PFAD = '/gesund';
/** Das Einladungsformular selbst — nicht `/einladung/<token>` zum Einlösen. */
export const EINLADUNG_FORMULAR_PFAD = '/einladung';
/** Der Link aus dem Server-Kommando `entsperren` (COPI-28); `/zugang-wiederherstellen` ohne Token gibt es nicht. */
export const ZUGANG_WIEDERHERSTELLEN_PFAD = '/zugang-wiederherstellen';
/** Der Link aus der Mail an eine neue Adresse (COPI-47); `/email-bestaetigen` ohne Token gibt es nicht. */
export const EMAIL_BESTAETIGEN_PFAD = '/email-bestaetigen';

/**
 * Die Agenten-API (COPI-35): maschinell, mit Bearer-Token statt Sitzung. Alles unter diesem Präfix
 * prüft das Token selbst — auch ein Pfad, den es nicht gibt (`src/intern/zugang.ts`).
 */
export const INTERN_PFAD = '/intern';

/**
 * Die Pipeline-API für den Runner (COPI-145): maschinell wie `/intern`, aber mit HMAC-Signatur statt Bearer-Token.
 * Alles unter diesem Präfix prüft die Signatur selbst (`src/pipeline/api.ts`).
 */
export const PIPELINE_PFAD = '/pipeline';

/**
 * Die Dateien der installierbaren App (COPI-58): Manifest, Service Worker und Symbole. Der Browser holt das Manifest
 * **ohne Cookie** — hinter dem Tor landete er auf der Anmeldung, und das Cockpit wäre nicht installierbar. Nichts davon
 * enthält Daten. Freigegeben sind genau diese Pfade, in jedem Zustand, und nur exakt: kein Präfix, kein Unterpfad.
 * Dazu die Symbole mit Inhalts-Hash (COPI-101), ebenfalls nur exakt: `SYMBOL_PFAD` lässt genau vier Namen mit
 * optionalem zwölfstelligem Hash zu.
 */
export const APP_DATEIEN: readonly string[] = [
  '/manifest.webmanifest',
  '/sw.js',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

/** Selbstregistrierung ist im Cockpit nicht vorgesehen — siehe benutzer-anlage.ts. */
const GESPERRTER_PFAD = `${AUTH_BASIS_PFAD}/sign-up`;

/**
 * Die vollständige Liste der Pfade, die **ohne Sitzung** erreichbar sind:
 * Anmeldung samt Codeschritt, Erststart, Einlösen einer Einladung, das Wiederherstellen
 * des Zugangs (COPI-28), das Bestätigen einer neuen E-Mail-Adresse (COPI-47), der Health-Endpunkt und das Abmelden (es soll auch mit abgelaufener Sitzung
 * nicht ins Leere laufen) — und `/assets` (COPI-30): Stylesheet und Schriften, die schon die
 * Anmeldeseite braucht. Die Route liefert nur Dateien aus dem Manifest des Builds, keine Geheimnisse.
 *
 * `EINLADUNG_FORMULAR_PFAD` steht hier als Präfix und erlaubt damit
 * `/einladung/<token>`; der Pfad ohne Token wird eine Zeile vorher in
 * `ANONYM_VERBORGEN` abgefangen.
 */
const ANONYM_ERLAUBT = [
  ANMELDEN_PFAD,
  ERSTSTART_PFAD,
  EINLADUNG_FORMULAR_PFAD,
  ZUGANG_WIEDERHERSTELLEN_PFAD,
  EMAIL_BESTAETIGEN_PFAD,
  GESUND_PFAD,
  ABMELDEN_PFAD,
  ASSETS_PFAD,
];

/**
 * Die vollständige Liste der rohen Better-Auth-Endpunkte, die **mit Sitzung**
 * erreichbar sind — für jedes angemeldete Konto, mit oder ohne zweiten Faktor
 * (COPI-20). Alles andere unter `/api/auth` ist zu; ohne Sitzung auch diese.
 *
 * Exakte Pfade, keine Präfixe: `/api/auth/get-session/x` bleibt zu, ebenso
 * eine abweichende Schreibweise und der Pfad mit abschließendem Schrägstrich.
 *
 * **Erweitern ist Absicht, keine Bequemlichkeit.** Braucht ein späteres Ticket
 * einen weiteren Endpunkt (etwa für die PWA), nimmt es ihn
 * mit Begründung und Test hier auf — und beantwortet dabei, was der Endpunkt
 * mit einer gestohlenen Sitzung anrichten kann. `test/auth-endpunkte-datenbank.test.ts`
 * misst die Liste gegen die installierte better-auth-Version.
 */
const AUTH_ERLAUBT: readonly string[] = [
  `${AUTH_BASIS_PFAD}/get-session`,
  `${AUTH_BASIS_PFAD}/sign-out`,
];

/**
 * Pfade, die auch ohne zweiten Faktor erreichbar bleiben müssen: die
 * Einrichtungsseite selbst, das Abmelden, Erststart und Health-Endpunkt.
 *
 * Die rohen Better-Auth-Endpunkte stehen hier bewusst nicht: für sie gilt
 * `AUTH_ERLAUBT` in jedem Zustand gleich.
 */
const AUSNAHMEN = [ZWEI_FAKTOR_PFAD, ABMELDEN_PFAD, ERSTSTART_PFAD, GESUND_PFAD, ASSETS_PFAD];

export interface TorEingabe {
  readonly pfad: string;
  readonly sitzungVorhanden: boolean;
  readonly zweiterFaktorAktiv: boolean;
}

export type TorEntscheidung =
  | { readonly art: 'weiter' }
  | { readonly art: 'umleiten'; readonly ziel: string }
  | { readonly art: 'blockieren' };

function beginntMit(pfad: string, praefix: string): boolean {
  return pfad === praefix || pfad.startsWith(`${praefix}/`);
}

/** Genau dieser Pfad, mit oder ohne abschließenden Schrägstrich. */
function istGenau(pfad: string, ziel: string): boolean {
  return pfad === ziel || pfad === `${ziel}/`;
}

/** Exakt einer der Pfade — kein Präfix, kein abschließender Schrägstrich. */
function istExakt(pfad: string, liste: readonly string[]): boolean {
  return liste.includes(pfad);
}

/**
 * Alle Schreibweisen eines Pfades, gegen die geprüft wird: die rohe, die
 * kleingeschriebene und die prozent-dekodierte. So greift die Sperre auch bei
 * `%2e%2e`-Spielereien und bei anderer Groß-/Kleinschreibung, unabhängig
 * davon, wie eine nachgelagerte Bibliothek dekodiert.
 *
 * Die rohe Schreibweise steht bewusst mit in der Liste: Sperren prüfen mit
 * `some` (eine passende Variante genügt), Freigaben mit `every` (jede
 * Variante muss passen). Dadurch macht eine zusätzliche Schreibweise die
 * Sperre breiter und die Freigabe enger — beides die sichere Richtung.
 */
function pfadVarianten(pfad: string): string[] {
  const klein = pfad.toLowerCase();
  const varianten = new Set([pfad, klein]);
  try {
    const dekodiert = new URL(decodeURIComponent(klein), 'http://cockpit.invalid').pathname;
    // Auch danach kleinschreiben: `%49ntern` dekodiert zu `Intern`.
    varianten.add(dekodiert);
    varianten.add(dekodiert.toLowerCase());
  } catch {
    // Ungültige Kodierung — die übrigen Varianten genügen.
  }
  return [...varianten];
}

/**
 * Zeigt der Pfad auf die Agenten-API? Wie bei den Freigaben für Anonyme muss **jede** Schreibweise
 * (roh, klein, prozent-dekodiert) auf `/intern` zeigen: `/INTERN/x`, `/%69ntern/x` und
 * `/intern%2Fx` sind keine Agenten-API, sondern bleiben zu.
 */
export function istInternerPfad(pfad: string): boolean {
  return pfadVarianten(pfad).every((kandidat) => beginntMit(kandidat, INTERN_PFAD));
}

/** Zeigt der Pfad auf die Pipeline-API (COPI-145)? Dieselbe Regel wie bei `/intern`: jede Schreibweise. */
export function istPipelinePfad(pfad: string): boolean {
  return pfadVarianten(pfad).every((kandidat) => beginntMit(kandidat, PIPELINE_PFAD));
}

/**
 * Zeigt **irgendeine** Schreibweise des Pfades (roh, klein, prozent-dekodiert) auf `/intern` oder `/pipeline`? Die
 * Gegenrichtung zu `istInternerPfad`: das Tor gibt diese Bereiche nur frei, wenn jede Schreibweise passt; wer eine Route
 * dort anlegen will (Erweiterungen, COPI-193), wird schon abgewiesen, wenn eine einzige passt.
 */
export function beruehrtMaschinellenBereich(pfad: string): boolean {
  return pfadVarianten(pfad).some((kandidat) => beginntMit(kandidat, INTERN_PFAD) || beginntMit(kandidat, PIPELINE_PFAD));
}

/** Eine der beiden maschinellen Schnittstellen: ohne Sitzung, die Routen prüfen selbst. */
function istMaschinellerPfad(pfad: string): boolean {
  return istInternerPfad(pfad) || istPipelinePfad(pfad);
}

/**
 * Reine Entscheidungsfunktion — ohne Fastify und ohne Datenbank testbar.
 *
 * Die Prüfrichtung ist überall dieselbe und fällt im Zweifel zugunsten der
 * Sperre aus: gesperrt wird, sobald **eine** Schreibweise des Pfades auf
 * einen gesperrten Bereich zeigt; freigegeben nur, wenn **jede** Schreibweise
 * auf eine Ausnahme zeigt.
 */
export function torEntscheidung(eingabe: TorEingabe): TorEntscheidung {
  const varianten = pfadVarianten(eingabe.pfad);
  const zeigtAuf = (praefix: string): boolean =>
    varianten.some((kandidat) => beginntMit(kandidat, praefix));
  const nurAuf = (liste: readonly string[]): boolean =>
    varianten.every((kandidat) => liste.some((eintrag) => beginntMit(kandidat, eintrag)));

  if (zeigtAuf(GESPERRTER_PFAD)) {
    return { art: 'blockieren' };
  }

  // Rohe Better-Auth-Endpunkte (COPI-20): in jedem Zustand deny by default.
  // Freigabe nur mit Sitzung und nur, wenn **jede** Schreibweise exakt auf
  // einen Listeneintrag zeigt. Vor der Zweiter-Faktor-Stufe, damit ein aktiver
  // Faktor den Baum nicht wieder öffnet.
  if (zeigtAuf(AUTH_BASIS_PFAD)) {
    const frei =
      eingabe.sitzungVorhanden && varianten.every((kandidat) => istExakt(kandidat, AUTH_ERLAUBT));
    return frei ? { art: 'weiter' } : { art: 'blockieren' };
  }

  // Agenten-API (COPI-35) und Pipeline-API (COPI-145): kein Cookie, keine Sitzung, kein zweiter Faktor. Nach den
  // Sperren oben, damit ein Pfad wie `/intern/../api/auth/…` (der auf einen gesperrten Bereich zeigt) zu bleibt.
  if (istMaschinellerPfad(eingabe.pfad)) {
    return { art: 'weiter' };
  }

  // Die App-Dateien (COPI-58): jede Schreibweise muss exakt einer von ihnen sein.
  if (varianten.every((kandidat) => istExakt(kandidat, APP_DATEIEN) || SYMBOL_PFAD.test(kandidat))) {
    return { art: 'weiter' };
  }

  if (!eingabe.sitzungVorhanden) {
    // Die Pfade ohne Token (das Einladungsformular, die Wiederherstellung, die Adressbestätigung) gibt es
    // für Anonyme nicht: dieselbe neutrale Antwort wie für ein fehlendes Token.
    if (
      varianten.some(
        (kandidat) =>
          istGenau(kandidat, EINLADUNG_FORMULAR_PFAD) ||
          istGenau(kandidat, ZUGANG_WIEDERHERSTELLEN_PFAD) ||
          istGenau(kandidat, EMAIL_BESTAETIGEN_PFAD),
      )
    ) {
      return { art: 'blockieren' };
    }
    return nurAuf(ANONYM_ERLAUBT) ? { art: 'weiter' } : { art: 'umleiten', ziel: ANMELDEN_PFAD };
  }

  if (eingabe.zweiterFaktorAktiv) {
    return { art: 'weiter' };
  }
  return nurAuf(AUSNAHMEN) ? { art: 'weiter' } : { art: 'umleiten', ziel: ZWEI_FAKTOR_PFAD };
}

export interface SitzungsZustand {
  readonly sitzungVorhanden: boolean;
  readonly zweiterFaktorAktiv: boolean;
}

export type SitzungLesen = (request: FastifyRequest) => Promise<SitzungsZustand>;

export function registriereZweiFaktorTor(
  app: FastifyInstance,
  sitzungLesen: SitzungLesen,
): void {
  /**
   * Eine einzige neutrale Antwort für alles, was das Tor verbirgt — wortgleich
   * mit der 404 der Einladungsroute aus COPI-11. Verschiedene Texte oder
   * Inhaltstypen wären ein Unterschied, an dem sich ablesen ließe, warum
   * abgewiesen wurde.
   */
  async function neutraleAntwort(reply: FastifyReply): Promise<void> {
    const html = await app.render('nicht-gefunden.eta', { titel: 'Nicht gefunden' });
    await htmlSenden(reply, html, 404);
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const pfad = new URL(request.url, 'http://cockpit.invalid').pathname;

    // Was schon der großzügigste Zustand (Sitzung mit Faktor) nicht bekommt —
    // Selbstregistrierung und jeder nicht freigegebene `/api/auth`-Pfad —,
    // wird vor jedem Datenbankzugriff abgewiesen.
    const vorpruefung = torEntscheidung({
      pfad,
      sitzungVorhanden: true,
      zweiterFaktorAktiv: true,
    });
    if (vorpruefung.art === 'blockieren') {
      return neutraleAntwort(reply);
    }

    // Agenten- und Pipeline-API lesen nie eine Sitzung: ein Cookie schaltet dort nichts frei und kostet keine
    // Datenbankabfrage. Die Route prüft das Bearer-Token bzw. die Signatur.
    if (istMaschinellerPfad(pfad)) {
      return undefined;
    }

    const zustand = await sitzungLesen(request);
    const entscheidung = torEntscheidung({
      pfad,
      sitzungVorhanden: zustand.sitzungVorhanden,
      zweiterFaktorAktiv: zustand.zweiterFaktorAktiv,
    });

    if (entscheidung.art === 'blockieren') {
      return neutraleAntwort(reply);
    }
    if (entscheidung.art === 'umleiten') {
      return reply.redirect(entscheidung.ziel, 303);
    }
    return undefined;
  });
}
