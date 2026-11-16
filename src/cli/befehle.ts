/**
 * Das Server-Kommando des Cockpits (COPI-24, Architektur-Vorschlag 13.2).
 *
 * Wer das Kommando auf dem Server ausführen kann, darf es: der Serverzugang ist
 * die Vertrauensgrenze, es gibt keine eigene Anmeldung. Deshalb liegt hier
 * nichts, was über `docker compose exec` hinaus erreichbar wäre — das Cockpit
 * selbst (der öffentlich erreichbare Dienst) kennt diese Befehle nicht.
 *
 * Befehle:
 *   * `erststart` — neues Erststart-Token, solange noch kein Benutzer existiert.
 *   * `einladung` — Einladung **ohne Mail**, der Link kommt auf stdout.
 *   * `betreuer-uebergeben` — die Betreuer-Rolle an ein anderes Konto übergeben.
 *   * `entsperren` — Zugang bei verlorenem zweitem Faktor wiederherstellen (COPI-28).
 *   * `migrieren` — das Schema anlegen und nachziehen, `--status`, `--zurueck` (COPI-31).
 *   * `api-token-erzeugen`, `api-token-auflisten`, `api-token-widerrufen` — die Zugänge der
 *     Agenten-API (COPI-35). Nur hier entstehen und enden sie, nie über die Oberfläche.
 *   * `pipeline-repo`, `pipeline-repos` — die Einstellungen je Repo der Entwicklungspipeline (COPI-145).
 *     Phase und Auto-Merge entscheidet nur Stefan; deshalb hier und nicht in der Agenten-API.
 *   * `pipeline-anbieter`, `pipeline-anbieter-setzen` — den Zustand der KI-Anbieter der Pipeline zeigen und
 *     von Hand auf ok oder aus (disabled) setzen (COPI-181).
 *   * `pipeline-freigaben` — die Pipeline-PRs auflisten, die auf Stefans Freigabe warten; nur lesend (COPI-184).
 *
 * Ausgabe: Ergebnisse und Token **nur auf stdout**, Fehler und Hinweise auf
 * stderr, nichts davon in einem Log. Exit-Codes: 0 erledigt, 1 abgelehnt oder
 * fehlgeschlagen, 2 falsche Bedienung.
 *
 * Aufgeteilt, damit sich alles ohne Prozess testen lässt: `befehlLesen` ist eine
 * reine Funktion, `cliAusfuehren` bekommt Datenbank und Ausgabekanäle
 * hereingereicht, und der eigentliche Einstieg (`index.ts`) ist nur Verdrahtung.
 */
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { benutzerIdZuEmail } from '../auth/anmeldevorgang.js';
import {
  istVergebbareRolle,
  ROLLEN_NAMEN,
  type VergebbareRolle,
} from '../auth/berechtigung.js';
import { BetreuerUebergabeFehler, betreuerUebergeben } from '../auth/betreuer.js';
import { vapidErzeugen } from '../chat/push.js';
import {
  einladungAnlegen,
  emailNormalisieren,
  kontoVorhanden,
} from '../auth/einladung-speicher.js';
import { EINLADUNG_GUELTIGKEIT_MS } from '../auth/einladung-token.js';
import { kontoEntsperren, WIEDERHERSTELLUNG_GUELTIGKEIT_MS } from '../auth/entsperrung.js';
import { erststartBlockBauen } from '../auth/erststart-ausgabe.js';
import { benutzerVorhanden, neuesErststartTokenAnlegen } from '../auth/erststart-speicher.js';
import {
  ausstehendMeldung,
  MigrationFehler,
  migrationenAnwenden,
  migrationsstand,
  migrationZuruecknehmen,
} from '../datenbank/migrationen.js';
import { apiTokenAnlegen, apiTokenAuflisten, apiTokenWiderrufen } from '../intern/token-speicher.js';
import { API_SCOPES, API_TOKEN_NAME, istApiScope, type ApiScope } from '../intern/token.js';
import { BETREUER_ZUGRIFF_TEXT, betreuerZugriffSetzen, istBetreuerZugriff, type BetreuerZugriff } from '../module/betreuer-zugriff.js';
import { istBetriebsmodul, istModulKennung } from '../module/block.js';
import { aktiveModule, modulEinspielen } from '../module/modul-speicher.js';
import { offeneFreigaben } from '../pipeline/freigaben.js';
import { anbieterLesen, anbieterSetzen, istAnbieter, type SetzbarerZustand } from '../pipeline/anbieter.js';
import type { Anbieter } from '../pipeline/queue.js';
import { repoConfigPruefen, repoConfigSpeichern, repoConfigsLesen } from '../pipeline/repo-config.js';
import { emailPlausibel } from '../server/routes/formular.js';
import { kostenNeuBerechnen } from '../verbrauch/verbrauch-speicher.js';
import { apiTokenBlockBauen, einladungBlockBauen, entsperrungBlockBauen, modulEinspielenBlockBauen } from './ausgabe.js';

export const EXIT_ERLEDIGT = 0;
export const EXIT_ABGELEHNT = 1;
export const EXIT_BEDIENUNG = 2;

export const NUTZUNG = `Nutzung: <kommando> <befehl> [optionen]

  erststart
      Erzeugt ein neues Erststart-Token (entwertet offene), solange noch kein
      Benutzer existiert. Der Link kommt auf stdout.

  einladung --email <adresse> --rolle <betriebs_admin|betrieb_mitarbeiter>
      Legt eine Einladung ohne Mail an. Der Link kommt auf stdout und ist 3
      Stunden gültig, einmal einlösbar. Die Rolle betreuer ist nie einladbar.

  betreuer-uebergeben --an <adresse> [--bisheriger-wird <betriebs_admin|betrieb_mitarbeiter>]
      Übergibt die Betreuer-Rolle an ein anderes Konto (aktiviert, mit zweitem
      Faktor). Der bisherige Betreuer wird Mitarbeiter, auf Wunsch Betriebs-Admin.

  entsperren --konto <adresse>
      Stellt den Zugang bei verlorenem zweiten Faktor wieder her: entfernt alle
      Faktoren, beendet alle Sitzungen, entwertet das Passwort und gibt einen
      Link auf stdout aus (3 Stunden, einmal einlösbar) für ein neues Passwort.

  api-token-erzeugen --name <name> --scope <recht> [--scope <recht> ...]
      Legt einen Zugang der Agenten-API an (Bearer-Token für den Admin-Agenten). Das Token
      kommt einmalig auf stdout und steht nirgends sonst. Rechte: befund_schreiben,
      agenten_schreiben, eingriff_verwalten (Admin-Agent), chat_antworten, zustand_lesen
      (Koordinator-Agent), vorgang_lesen (Fachagenten), verbrauch_schreiben, verbrauch_lesen (KI-Verbrauch),
      pipeline_verwalten (Koordinator: Jobs der Entwicklungspipeline anlegen und aufräumen). Der Name besteht aus Kleinbuchstaben, Ziffern,
      _ und - (höchstens 40 Zeichen). Für ein neues Token oder andere Rechte einen neuen
      Zugang anlegen; der alte gilt, bis er widerrufen ist.

  vapid-erzeugen
      Erzeugt das Schlüsselpaar für Web Push und gibt es einmal aus (COCKPIT_VAPID_PUBLIC_KEY,
      COCKPIT_VAPID_PRIVATE_KEY). Ins Zugangsdatenblatt und in die .env der Instanz, nie in die
      Datenbank. Braucht keine Datenbank. Ein neues Paar entwertet alle Abos.

  api-token-auflisten
      Zeigt alle Zugänge mit Nummer, Name, Rechten und Stand — nie ein Token.

  api-token-widerrufen --id <nummer>
      Widerruft einen Zugang sofort und endgültig.

  modul-einspielen [--herkunft <text>]
      Liest einen Modul-Block (YAML, direkt oder unter dem Schlüssel cockpit:) von der
      Standardeingabe, prüft ihn gegen Schema und Katalog (die genannte View mit ihren
      Pflichtspalten) und legt ihn als neue, aktive Version an. Ein unveränderter Block (gleiche
      Prüfsumme wie die aktive Version und dieselbe Herkunft) erzeugt keine neue Version.
      --herkunft sagt, woher der Block stammt; in der Form agent-blueprints@<commit>:<pfad> lässt
      sich das Modul in den Einstellungen per Antrag aktualisieren, und ein laufender Modul-Antrag
      auf diesen Commit ist damit erledigt.

  module-auflisten
      Zeigt die aktiven Module mit Kennung, Version, Zeitpunkt des Einspielens und dem Zugriff des
      Betreuers (technisches Modul: immer).

  modul-freigabe --modul <kennung> --stufe <aus|lesen|entscheiden>
      Setzt, ob der Betreuer die Inhalte eines Fachmoduls sieht: aus (Standard), lesen oder lesen
      und entscheiden (übernehmen, freigeben, entscheiden). Für eine Instanz ohne Betriebs-Admin des
      Kunden; sonst entscheidet das der Betriebs-Admin unter Einstellungen. Steht im Protokoll
      („konsole") und ist für den Betriebs-Admin sichtbar. Ein technisches Modul (art: betrieb)
      sieht der Betreuer immer; dafür gibt es keine Stufe.

  pipeline-repo
      Liest die Einstellungen eines Repos der Entwicklungspipeline (YAML) von der Standardeingabe
      und legt sie an oder ersetzt sie: repo (owner/name), quelle (jira|github), jira_project
      (Pflicht bei jira), base_branch (Standard main), auto_merge (Standard false), phase (0-2,
      Standard 0), reviewers (codex, gemini, copilot; Standard codex), protected_paths. Für
      Für Repos der Sperrliste (COCKPIT_AUTO_MERGE_SPERRLISTE, kommagetrennt) ist auto_merge nie erlaubt.

  pipeline-repos
      Zeigt die Repos der Entwicklungspipeline mit Quelle, Basis-Branch, Phase und Auto-Merge.

  pipeline-anbieter
      Zeigt den Zustand der KI-Anbieter der Entwicklungspipeline (ok, exhausted, disabled) mit
      Ablaufzeit und letzter Änderung. Ohne Einträge sind alle Anbieter ok.

  pipeline-anbieter-setzen --anbieter <claude|codex|gemini|copilot> --zustand <ok|aus>
      Setzt einen Anbieter von Hand zurück (ok) oder schaltet ihn ab (aus, in der Datenbank
      disabled). Leert dabei die Ablaufzeit. „erschöpft" lässt sich nicht von Hand setzen, das
      meldet nur der Runner.

  pipeline-freigaben
      Zeigt die PRs der Entwicklungspipeline, die auf Stefans Freigabe warten: Ticket, Repo, PR,
      Runden (saubere Review-Runden), Zeitpunkt der Anfrage und Titel (auf 60 Zeichen gekürzt),
      älteste zuerst. Ohne offene Freigaben eine Zeile. Nur lesend.

  verbrauch-kosten-neu
      Rechnet die Kosten aller Einträge im KI-Verbrauchsprotokoll neu aus der Preistabelle —
      nach einem nachgetragenen oder berichtigten Preis. Ändert sonst nichts.

  migrieren [--status | --zurueck --bestaetigt]
      Legt das Schema an und zieht es nach: wendet alle ausstehenden Migrationen an
      (zweiter Aufruf: nichts zu tun). --status zeigt den Stand und ändert nichts.
      --zurueck nimmt nur die letzte Migration zurück und **löscht dabei Tabellen und
      Daten**; es läuft nur mit --bestaetigt. Bei einem neuen Image und auf einer
      neuen Instanz vor dem ersten Start ausführen (docker compose run --rm, denn
      das Cockpit startet ohne Schema nicht).

Exit-Codes: 0 erledigt, 1 abgelehnt oder fehlgeschlagen, 2 falsche Bedienung.
Benötigt DATABASE_URL (und COCKPIT_DOMAIN für die Adresse in den Links).`;

export type Befehl =
  | { readonly befehl: 'hilfe' }
  | { readonly befehl: 'erststart' }
  | { readonly befehl: 'einladung'; readonly email: string; readonly rolle: VergebbareRolle }
  | {
      readonly befehl: 'betreuer-uebergeben';
      readonly an: string;
      readonly bisherigerWirdRolle?: VergebbareRolle;
    }
  | { readonly befehl: 'entsperren'; readonly konto: string }
  | { readonly befehl: 'migrieren'; readonly modus: 'anwenden' | 'status' | 'zurueck' }
  | {
      readonly befehl: 'api-token-erzeugen';
      readonly name: string;
      readonly scopes: readonly ApiScope[];
    }
  | { readonly befehl: 'api-token-auflisten' }
  | { readonly befehl: 'api-token-widerrufen'; readonly id: number }
  | { readonly befehl: 'vapid-erzeugen' }
  | { readonly befehl: 'modul-einspielen'; readonly herkunft?: string }
  | { readonly befehl: 'module-auflisten' }
  | { readonly befehl: 'modul-freigabe'; readonly modul: string; readonly stufe: BetreuerZugriff }
  | { readonly befehl: 'pipeline-repo' }
  | { readonly befehl: 'pipeline-repos' }
  | { readonly befehl: 'pipeline-anbieter' }
  | { readonly befehl: 'pipeline-freigaben' }
  | { readonly befehl: 'pipeline-anbieter-setzen'; readonly anbieter: Anbieter; readonly zustand: SetzbarerZustand }
  | { readonly befehl: 'verbrauch-kosten-neu' };

/** Eine falsche Bedienung. Die Meldung wiederholt nie einen eingegebenen Wert. */
export interface Bedienfehler {
  readonly fehler: string;
}

const OPTIONEN = {
  email: { type: 'string' },
  rolle: { type: 'string' },
  an: { type: 'string' },
  konto: { type: 'string' },
  'bisheriger-wird': { type: 'string' },
  name: { type: 'string' },
  herkunft: { type: 'string' },
  modul: { type: 'string' },
  stufe: { type: 'string' },
  anbieter: { type: 'string' },
  zustand: { type: 'string' },
  // Mehrfach erlaubt bzw. auf genau eine Angabe geprüft: `parseArgs` würde bei einer wiederholten
  // Option sonst stillschweigend die letzte nehmen.
  scope: { type: 'string', multiple: true },
  id: { type: 'string', multiple: true },
  status: { type: 'boolean' },
  zurueck: { type: 'boolean' },
  bestaetigt: { type: 'boolean' },
  hilfe: { type: 'boolean', short: 'h' },
  help: { type: 'boolean' },
} as const;

type Optionen = Readonly<
  Record<'email' | 'rolle' | 'an' | 'konto' | 'bisheriger-wird' | 'name' | 'scope' | 'id' | 'herkunft' | 'modul' | 'stufe' | 'anbieter' | 'zustand', string | undefined>
>;

/** Die Nummer eines Zugangs: eine positive ganze Zahl ohne führende Nullen, die in eine Datenbank-`int` passt. */
const ZUGANGS_NUMMER = /^[1-9][0-9]{0,9}$/;
const HOECHSTE_NUMMER = 2_147_483_647;

function adresseLesen(wert: string | undefined, name: string): string | Bedienfehler {
  if (wert === undefined) {
    return { fehler: `Die Angabe --${name} fehlt.` };
  }
  const adresse = emailNormalisieren(wert);
  return emailPlausibel(adresse) ? adresse : { fehler: `--${name} ist keine gültige E-Mail-Adresse.` };
}

function rolleLesen(wert: string | undefined, name: string): VergebbareRolle | Bedienfehler {
  if (wert === undefined) {
    return { fehler: `Die Angabe --${name} fehlt.` };
  }
  if (wert === 'betreuer') {
    return {
      fehler:
        'Die Rolle betreuer lässt sich nicht einladen und nicht so vergeben. ' +
        'Ein Betreuerwechsel geht nur mit dem Befehl betreuer-uebergeben.',
    };
  }
  return istVergebbareRolle(wert)
    ? wert
    : { fehler: `--${name} muss betriebs_admin oder betrieb_mitarbeiter sein.` };
}

function unerlaubteOptionen(optionen: Optionen, erlaubt: readonly string[]): Bedienfehler | undefined {
  const fremd = Object.entries(optionen).find(([name, wert]) => wert !== undefined && !erlaubt.includes(name));
  return fremd ? { fehler: `Die Option --${fremd[0]} gehört nicht zu diesem Befehl.` } : undefined;
}

/**
 * Liest die Argumente (ohne Interpreter und Skriptname). Reine Funktion: prüft
 * Befehl, Pflichtangaben, Werte und überzählige Optionen und liefert entweder den
 * Befehl oder einen Bedienfehler.
 */
export function befehlLesen(argumente: readonly string[]): Befehl | Bedienfehler {
  let gelesen;
  try {
    gelesen = parseArgs({
      args: [...argumente],
      options: OPTIONEN,
      allowPositionals: true,
      strict: true,
    });
  } catch {
    // Die Meldung von parseArgs nennt die abgewiesene Angabe; sie bleibt draußen.
    return { fehler: 'Ungültige Angabe.' };
  }
  const { values, positionals } = gelesen;
  if (values.hilfe === true || values.help === true || positionals[0] === 'hilfe') {
    return { befehl: 'hilfe' };
  }
  if (positionals.length === 0) {
    return { fehler: 'Es fehlt ein Befehl.' };
  }
  if (positionals.length > 1) {
    return { fehler: 'Es ist genau ein Befehl erlaubt.' };
  }

  const optionen: Optionen = {
    email: values.email,
    rolle: values.rolle,
    an: values.an,
    konto: values.konto,
    'bisheriger-wird': values['bisheriger-wird'],
    name: values.name,
    scope: values.scope?.join(','),
    id: values.id?.join(','),
    herkunft: values.herkunft,
    modul: values.modul,
    stufe: values.stufe,
    anbieter: values.anbieter,
    zustand: values.zustand,
  };

  switch (positionals[0]) {
    case 'erststart': {
      return unerlaubteOptionen(optionen, []) ?? { befehl: 'erststart' };
    }
    case 'einladung': {
      const fremd = unerlaubteOptionen(optionen, ['email', 'rolle']);
      const email = adresseLesen(optionen.email, 'email');
      const rolle = rolleLesen(optionen.rolle, 'rolle');
      if (fremd) return fremd;
      if (typeof email !== 'string') return email;
      if (typeof rolle !== 'string') return rolle;
      return { befehl: 'einladung', email, rolle };
    }
    case 'betreuer-uebergeben': {
      const fremd = unerlaubteOptionen(optionen, ['an', 'bisheriger-wird']);
      const an = adresseLesen(optionen.an, 'an');
      if (fremd) return fremd;
      if (typeof an !== 'string') return an;
      if (optionen['bisheriger-wird'] === undefined) {
        return { befehl: 'betreuer-uebergeben', an };
      }
      const rolle = rolleLesen(optionen['bisheriger-wird'], 'bisheriger-wird');
      return typeof rolle === 'string'
        ? { befehl: 'betreuer-uebergeben', an, bisherigerWirdRolle: rolle }
        : rolle;
    }
    case 'entsperren': {
      const fremd = unerlaubteOptionen(optionen, ['konto']);
      const konto = adresseLesen(optionen.konto, 'konto');
      if (fremd) return fremd;
      if (typeof konto !== 'string') return konto;
      return { befehl: 'entsperren', konto };
    }
    case 'api-token-erzeugen': {
      const fremd = unerlaubteOptionen(optionen, ['name', 'scope']);
      if (fremd) return fremd;
      if (values.name === undefined) return { fehler: 'Die Angabe --name fehlt.' };
      if (!API_TOKEN_NAME.test(values.name)) {
        return {
          fehler:
            '--name darf nur Kleinbuchstaben, Ziffern, _ und - enthalten (höchstens 40 Zeichen, nicht mit _ oder - beginnend).',
        };
      }
      const genannt = values.scope ?? [];
      if (genannt.length === 0) return { fehler: 'Die Angabe --scope fehlt (mindestens ein Recht).' };
      if (!genannt.every(istApiScope)) {
        return { fehler: `--scope muss ${API_SCOPES.join(', ')} sein.` };
      }
      return { befehl: 'api-token-erzeugen', name: values.name, scopes: [...new Set(genannt)] };
    }
    case 'api-token-auflisten': {
      return unerlaubteOptionen(optionen, []) ?? { befehl: 'api-token-auflisten' };
    }
    case 'api-token-widerrufen': {
      const fremd = unerlaubteOptionen(optionen, ['id']);
      if (fremd) return fremd;
      const nummern = values.id ?? [];
      if (nummern.length === 0) return { fehler: 'Die Angabe --id fehlt.' };
      if (nummern.length > 1) return { fehler: 'Es ist genau eine --id erlaubt.' };
      const nummer = nummern[0] ?? '';
      if (!ZUGANGS_NUMMER.test(nummer) || Number(nummer) > HOECHSTE_NUMMER) {
        return { fehler: '--id muss die Nummer eines Zugangs sein (siehe api-token-auflisten).' };
      }
      return { befehl: 'api-token-widerrufen', id: Number(nummer) };
    }
    case 'vapid-erzeugen': {
      return unerlaubteOptionen(optionen, []) ?? { befehl: 'vapid-erzeugen' };
    }
    case 'modul-einspielen': {
      const fremd = unerlaubteOptionen(optionen, ['herkunft']);
      if (fremd) return fremd;
      return optionen.herkunft === undefined
        ? { befehl: 'modul-einspielen' }
        : { befehl: 'modul-einspielen', herkunft: optionen.herkunft };
    }
    case 'module-auflisten': {
      return unerlaubteOptionen(optionen, []) ?? { befehl: 'module-auflisten' };
    }
    case 'modul-freigabe': {
      const fremd = unerlaubteOptionen(optionen, ['modul', 'stufe']);
      if (fremd) return fremd;
      if (optionen.modul === undefined || !istModulKennung(optionen.modul)) {
        return { fehler: '--modul muss die Kennung eines Moduls sein (siehe module-auflisten).' };
      }
      if (!istBetreuerZugriff(optionen.stufe)) {
        return { fehler: '--stufe muss aus, lesen oder entscheiden sein.' };
      }
      return { befehl: 'modul-freigabe', modul: optionen.modul, stufe: optionen.stufe };
    }
    case 'verbrauch-kosten-neu': {
      return unerlaubteOptionen(optionen, []) ?? { befehl: 'verbrauch-kosten-neu' };
    }
    case 'pipeline-repo': {
      return unerlaubteOptionen(optionen, []) ?? { befehl: 'pipeline-repo' };
    }
    case 'pipeline-repos': {
      return unerlaubteOptionen(optionen, []) ?? { befehl: 'pipeline-repos' };
    }
    case 'pipeline-anbieter': {
      return unerlaubteOptionen(optionen, []) ?? { befehl: 'pipeline-anbieter' };
    }
    case 'pipeline-freigaben': {
      return unerlaubteOptionen(optionen, []) ?? { befehl: 'pipeline-freigaben' };
    }
    case 'pipeline-anbieter-setzen': {
      const fremd = unerlaubteOptionen(optionen, ['anbieter', 'zustand']);
      if (fremd) return fremd;
      if (!istAnbieter(optionen.anbieter)) {
        return { fehler: '--anbieter muss claude, codex, gemini oder copilot sein.' };
      }
      if (optionen.zustand !== 'ok' && optionen.zustand !== 'aus') {
        return { fehler: '--zustand muss ok oder aus sein.' };
      }
      return {
        befehl: 'pipeline-anbieter-setzen',
        anbieter: optionen.anbieter,
        zustand: optionen.zustand === 'aus' ? 'disabled' : 'ok',
      };
    }
    case 'migrieren': {
      const fremd = unerlaubteOptionen(optionen, []);
      if (fremd) return fremd;
      if (values.status === true && values.zurueck === true) {
        return { fehler: '--status und --zurueck schließen sich aus.' };
      }
      if (values.bestaetigt === true && values.zurueck !== true) {
        return { fehler: '--bestaetigt gehört nur zu --zurueck.' };
      }
      if (values.zurueck === true && values.bestaetigt !== true) {
        return {
          fehler:
            '--zurueck nimmt die letzte Migration zurück und löscht dabei Tabellen und Daten. ' +
            'Es läuft nur mit --bestaetigt.',
        };
      }
      if (values.status === true) return { befehl: 'migrieren', modus: 'status' };
      return { befehl: 'migrieren', modus: values.zurueck === true ? 'zurueck' : 'anwenden' };
    }
    default:
      return { fehler: 'Unbekannter Befehl.' };
  }
}

/** Was `cliAusfuehren` von außen bekommt: Datenbank, Basis-URL und die Ausgabekanäle. */
export interface CliUmgebung {
  /** Repos, für die `auto_merge` nie erlaubt ist; ohne Angabe die Umgebungsvariable `COCKPIT_AUTO_MERGE_SPERRLISTE`. */
  sperrliste?: readonly string[];
  readonly pool: pg.Pool;
  /** Öffentliche Basis-URL für die Links, aus denselben Variablen wie in der Anwendung. */
  readonly basisUrl: string;
  /** Ergebnisse und Token: stdout. */
  readonly ausgabe: (text: string) => void;
  /** Fehler und Hinweise: stderr. */
  readonly fehlerausgabe: (text: string) => void;
  readonly jetzt?: () => Date;
  /** Ein anderer Ordner mit Migrationen als der des Images — nur für Tests. */
  readonly migrationsOrdner?: string;
  /** Liest den rohen Modul-Block von der Standardeingabe (`modul-einspielen`); ohne Angabe leer. */
  readonly eingabeLesen?: () => Promise<string>;
}

const EINLADUNG_STUNDEN = EINLADUNG_GUELTIGKEIT_MS / (60 * 60 * 1000);

async function erststartAusfuehren(umgebung: CliUmgebung): Promise<number> {
  // Ein Token gibt es nur, solange kein Benutzer existiert: mit einem Benutzer
  // wäre es wertlos (siehe `tokenPruefen`), und das Kommando soll keinen
  // Eindruck erwecken, es öffne einen Weg.
  if (await benutzerVorhanden(umgebung.pool)) {
    umgebung.fehlerausgabe(
      'Es existiert bereits ein Benutzer. Ein Erststart-Token gibt es nur, solange keiner existiert.',
    );
    return EXIT_ABGELEHNT;
  }
  const jetzt = umgebung.jetzt?.() ?? new Date();
  const token = await neuesErststartTokenAnlegen(umgebung.pool, jetzt, 'konsole');
  umgebung.ausgabe(erststartBlockBauen(token, umgebung.basisUrl));
  return EXIT_ERLEDIGT;
}

async function einladungAusfuehren(
  umgebung: CliUmgebung,
  email: string,
  rolle: VergebbareRolle,
): Promise<number> {
  if (await kontoVorhanden(umgebung.pool, email)) {
    umgebung.fehlerausgabe('Für diese Adresse gibt es bereits einen Zugang.');
    return EXIT_ABGELEHNT;
  }
  const jetzt = umgebung.jetzt?.() ?? new Date();
  // Kein Einladender, keine Mail: der Akteur im Protokoll ist die Konsole.
  const token = await einladungAnlegen(umgebung.pool, email, undefined, rolle, {
    jetzt,
    akteur: 'konsole',
  });
  umgebung.ausgabe(
    einladungBlockBauen({
      email,
      rolle,
      url: `${umgebung.basisUrl}/einladung/${token.token}`,
      gueltigStunden: EINLADUNG_STUNDEN,
    }),
  );
  return EXIT_ERLEDIGT;
}

async function uebergabeAusfuehren(
  umgebung: CliUmgebung,
  an: string,
  bisherigerWirdRolle: VergebbareRolle | undefined,
): Promise<number> {
  const zielId = await benutzerIdZuEmail(umgebung.pool, an);
  if (zielId === undefined) {
    umgebung.fehlerausgabe('Zu dieser Adresse gibt es kein Konto.');
    return EXIT_ABGELEHNT;
  }
  try {
    const ergebnis = await betreuerUebergeben(umgebung.pool, {
      an: zielId,
      akteur: 'konsole',
      ...(bisherigerWirdRolle ? { bisherigerWirdRolle } : {}),
    });
    umgebung.ausgabe(`Der Betreuer ist jetzt ${an}.`);
    if (ergebnis.von === undefined) {
      umgebung.ausgabe('Es gab keinen bisherigen Betreuer.');
    } else {
      const alt = await umgebung.pool.query<{ email: string }>(
        'SELECT email FROM cockpit."user" WHERE id = $1',
        [ergebnis.von],
      );
      const rolle = ROLLEN_NAMEN[bisherigerWirdRolle ?? 'betrieb_mitarbeiter'];
      umgebung.ausgabe(
        `Der bisherige Betreuer (${alt.rows[0]?.email ?? 'unbekannt'}) hat jetzt die Rolle „${rolle}".`,
      );
    }
    return EXIT_ERLEDIGT;
  } catch (fehler) {
    if (fehler instanceof BetreuerUebergabeFehler) {
      umgebung.fehlerausgabe(fehler.message);
      return EXIT_ABGELEHNT;
    }
    throw fehler;
  }
}

async function entsperrenAusfuehren(umgebung: CliUmgebung, konto: string): Promise<number> {
  // Der Aufrufer hat Serverzugang: hier ist eine klare Auskunft richtig (anders als auf der
  // Anmeldeseite, wo eine unbekannte Adresse nie erkennbar sein darf).
  const benutzerId = await benutzerIdZuEmail(umgebung.pool, konto);
  if (benutzerId === undefined) {
    umgebung.fehlerausgabe('Zu dieser Adresse gibt es kein Konto.');
    return EXIT_ABGELEHNT;
  }
  const jetzt = umgebung.jetzt?.() ?? new Date();
  const ergebnis = await kontoEntsperren(umgebung.pool, benutzerId, jetzt);
  if (ergebnis.rolle === 'betreuer') {
    // Auch der Betreuer ist entsperrbar (sonst sperrt ein verlorener Faktor die Instanz aus);
    // die Warnung steht auf stderr, der Link auf stdout.
    umgebung.fehlerausgabe(
      'Achtung: Dieses Konto ist der Betreuer. Sein Zugang ist gesperrt, bis der Link eingelöst ist.',
    );
  }
  umgebung.ausgabe(
    entsperrungBlockBauen({
      email: ergebnis.email,
      url: `${umgebung.basisUrl}/zugang-wiederherstellen/${ergebnis.token}`,
      gueltigStunden: WIEDERHERSTELLUNG_GUELTIGKEIT_MS / (60 * 60 * 1000),
    }),
  );
  return EXIT_ERLEDIGT;
}

async function apiTokenErzeugenAusfuehren(
  umgebung: CliUmgebung,
  name: string,
  scopes: readonly ApiScope[],
): Promise<number> {
  const angelegt = await apiTokenAnlegen(umgebung.pool, { name, scopes });
  umgebung.ausgabe(apiTokenBlockBauen({ id: angelegt.id, name, scopes, token: angelegt.token }));
  return EXIT_ERLEDIGT;
}

async function apiTokenAuflistenAusfuehren(umgebung: CliUmgebung): Promise<number> {
  const zugaenge = await apiTokenAuflisten(umgebung.pool);
  if (zugaenge.length === 0) {
    umgebung.ausgabe('Kein Zugang angelegt.');
    return EXIT_ERLEDIGT;
  }
  for (const zugang of zugaenge) {
    const stand = zugang.widerrufenAm === undefined ? 'gültig' : `widerrufen seit ${zugang.widerrufenAm.toISOString()}`;
    umgebung.ausgabe(`${String(zugang.id).padStart(4)}  ${zugang.name.padEnd(24)} ${zugang.scopes.join(',')}  ${stand}`);
  }
  return EXIT_ERLEDIGT;
}

async function apiTokenWiderrufenAusfuehren(umgebung: CliUmgebung, id: number): Promise<number> {
  const ergebnis = await apiTokenWiderrufen(umgebung.pool, id);
  switch (ergebnis) {
    case 'widerrufen':
      umgebung.ausgabe(`Zugang ${String(id)} widerrufen. Sein Token gilt ab sofort nicht mehr.`);
      return EXIT_ERLEDIGT;
    case 'schon_widerrufen':
      umgebung.ausgabe(`Zugang ${String(id)} war schon widerrufen: nichts zu tun.`);
      return EXIT_ERLEDIGT;
    case 'unbekannt':
      umgebung.fehlerausgabe('Diesen Zugang gibt es nicht (siehe api-token-auflisten).');
      return EXIT_ABGELEHNT;
  }
}

async function migrierenAusfuehren(
  umgebung: CliUmgebung,
  modus: 'anwenden' | 'status' | 'zurueck',
): Promise<number> {
  const ordner = umgebung.migrationsOrdner === undefined ? {} : { ordner: umgebung.migrationsOrdner };
  try {
    if (modus === 'status') {
      const stand = await migrationsstand(umgebung.pool, umgebung.migrationsOrdner);
      const meldung = ausstehendMeldung(stand);
      if (meldung !== undefined) {
        umgebung.ausgabe(meldung);
      }
      for (const id of stand.angewendet.filter((eintrag) => !stand.unbekannt.includes(eintrag))) {
        umgebung.ausgabe(`angewendet   ${id}`);
      }
      for (const migration of stand.ausstehend) {
        umgebung.ausgabe(`ausstehend   ${migration.id}`);
      }
      for (const id of stand.unbekannt) {
        umgebung.ausgabe(`unbekannt    ${id}`);
      }
      return EXIT_ERLEDIGT;
    }
    if (modus === 'zurueck') {
      const id = await migrationZuruecknehmen(umgebung.pool, ordner);
      umgebung.ausgabe(id === undefined ? 'Keine Migration zum Zurücknehmen.' : `zurückgenommen: ${id}`);
      return EXIT_ERLEDIGT;
    }
    const angewendet = await migrationenAnwenden(umgebung.pool, {
      ...ordner,
      angewendet: (id) => umgebung.ausgabe(`angewendet: ${id}`),
    });
    umgebung.ausgabe(
      angewendet.length === 0
        ? 'Das Schema ist auf dem Stand: nichts zu tun.'
        : `${String(angewendet.length)} Migrationen angewendet.`,
    );
    return EXIT_ERLEDIGT;
  } catch (fehler) {
    if (fehler instanceof MigrationFehler) {
      // Die Meldung nennt die Migration und den Grund; die Zugangsdaten der Datenbank stehen nirgends darin.
      umgebung.fehlerausgabe(fehler.message);
      return EXIT_ABGELEHNT;
    }
    throw fehler;
  }
}

/**
 * Erzeugt ein VAPID-Paar für Web Push (COPI-59) und gibt es **einmal** aus. Es gehört ins Zugangsdatenblatt und in die
 * `.env` der Instanz, nie in die Datenbank, ein Repo oder einen Log. Ein neues Paar entwertet alle Abos: danach muss
 * jedes Gerät Push neu einschalten.
 */
function vapidErzeugenAusfuehren(umgebung: CliUmgebung): number {
  const paar = vapidErzeugen();
  umgebung.ausgabe(
    [
      'VAPID-Schlüssel für Web Push (nur jetzt sichtbar, ins Zugangsdatenblatt übernehmen):',
      '',
      `COCKPIT_VAPID_PUBLIC_KEY=${paar.oeffentlich}`,
      `COCKPIT_VAPID_PRIVATE_KEY=${paar.privat}`,
      '',
      'In die .env der Instanz eintragen und das Cockpit neu starten. Ein neues Paar entwertet alle bestehenden Abos.',
    ].join('\n'),
  );
  return EXIT_ERLEDIGT;
}

async function modulEinspielenAusfuehren(umgebung: CliUmgebung, herkunft: string | undefined): Promise<number> {
  const rohtext = await (umgebung.eingabeLesen?.() ?? Promise.resolve(''));
  const ergebnis = await modulEinspielen(umgebung.pool, {
    rohtext,
    akteur: 'konsole',
    ...(herkunft === undefined ? {} : { herkunft }),
  });
  if (!ergebnis.ok) {
    umgebung.fehlerausgabe(ergebnis.grund);
    return EXIT_ABGELEHNT;
  }
  umgebung.ausgabe(modulEinspielenBlockBauen(ergebnis));
  return EXIT_ERLEDIGT;
}

async function moduleAuflistenAusfuehren(umgebung: CliUmgebung): Promise<number> {
  const module = await aktiveModule(umgebung.pool);
  if (module.length === 0) {
    umgebung.ausgabe('Kein Modul eingespielt.');
    return EXIT_ERLEDIGT;
  }
  for (const modul of module) {
    const zugriff = istBetriebsmodul(modul.block) ? 'immer (technisch)' : modul.betreuerZugriff;
    umgebung.ausgabe(
      `${modul.kennung.padEnd(24)} Version ${String(modul.version).padStart(3)}  eingespielt ${modul.eingespieltAm.toISOString()}  Betreuer: ${zugriff}`,
    );
  }
  return EXIT_ERLEDIGT;
}

/** Setzt den Betreuer-Zugriff auf ein Fachmodul (COPI-134) — für eine Instanz ohne Betriebs-Admin des Kunden. */
async function modulFreigabeAusfuehren(umgebung: CliUmgebung, modul: string, stufe: BetreuerZugriff): Promise<number> {
  const ergebnis = await betreuerZugriffSetzen(umgebung.pool, { kennung: modul, stufe });
  if (!ergebnis.ok) {
    umgebung.fehlerausgabe(ergebnis.grund);
    return EXIT_ABGELEHNT;
  }
  umgebung.ausgabe(
    ergebnis.status === 'gesetzt'
      ? `Betreuer-Zugriff auf ${modul}: ${BETREUER_ZUGRIFF_TEXT[stufe]}. Steht im Protokoll.`
      : `Betreuer-Zugriff auf ${modul} war schon ${BETREUER_ZUGRIFF_TEXT[stufe]}; nichts geändert.`,
  );
  return EXIT_ERLEDIGT;
}

/** Rechnet die Kosten des KI-Verbrauchsprotokolls neu (COPI-97) und sagt, wie viele Einträge ohne Preis bleiben. */
async function verbrauchKostenNeuAusfuehren(umgebung: CliUmgebung): Promise<number> {
  const ergebnis = await kostenNeuBerechnen(umgebung.pool);
  umgebung.ausgabe(`${String(ergebnis.eintraege)} Einträge neu berechnet, davon ${String(ergebnis.ohnePreis)} ohne Preis.`);
  return EXIT_ERLEDIGT;
}

/** Legt die Einstellungen eines Pipeline-Repos an oder ersetzt sie (COPI-145). */
async function pipelineRepoAusfuehren(umgebung: CliUmgebung): Promise<number> {
  const gelesen = repoConfigPruefen(
    await (umgebung.eingabeLesen?.() ?? Promise.resolve('')),
    umgebung.sperrliste,
  );
  if (!gelesen.ok) {
    umgebung.fehlerausgabe(gelesen.grund);
    return EXIT_ABGELEHNT;
  }
  const config = gelesen.wert;
  const ergebnis = await repoConfigSpeichern(umgebung.pool, config, umgebung.jetzt?.() ?? new Date());
  umgebung.ausgabe(
    `${config.repo} ${ergebnis === 'angelegt' ? 'angelegt' : 'geändert'}: Phase ${String(config.phase)}, ` +
      `Auto-Merge ${config.auto_merge ? 'an' : 'aus'}, Reviewer ${config.reviewers.join(', ') || 'keine'}.`,
  );
  return EXIT_ERLEDIGT;
}

async function pipelineReposAusfuehren(umgebung: CliUmgebung): Promise<number> {
  const repos = await repoConfigsLesen(umgebung.pool);
  if (repos.length === 0) {
    umgebung.ausgabe('Kein Repo in der Pipeline.');
    return EXIT_ERLEDIGT;
  }
  for (const repo of repos) {
    const herkunft = repo.quelle === 'jira' ? `jira ${repo.jiraProject ?? ''}` : 'github';
    umgebung.ausgabe(
      `${repo.repo.padEnd(32)} ${herkunft.padEnd(12)} Basis ${repo.baseBranch}  Phase ${String(repo.phase)}  Auto-Merge ${repo.autoMerge ? 'an' : 'aus'}`,
    );
  }
  return EXIT_ERLEDIGT;
}

/** Zeigt den Zustand der KI-Anbieter der Pipeline (COPI-181). */
async function pipelineAnbieterAusfuehren(umgebung: CliUmgebung): Promise<number> {
  const zeilen = await anbieterLesen(umgebung.pool);
  if (zeilen.length === 0) {
    umgebung.ausgabe('alle ok (keine Einträge)');
    return EXIT_ERLEDIGT;
  }
  const zeit = (wert: Date | null): string => (wert ? wert.toISOString() : '-');
  umgebung.ausgabe(`${'Anbieter'.padEnd(10)} ${'Zustand'.padEnd(10)} ${'bis'.padEnd(24)} geändert`);
  for (const zeile of zeilen) {
    umgebung.ausgabe(
      `${zeile.provider.padEnd(10)} ${zeile.state.padEnd(10)} ${zeit(zeile.until).padEnd(24)} ${zeit(zeile.updatedAt)}`,
    );
  }
  return EXIT_ERLEDIGT;
}

const FREIGABE_TITEL_MAX = 60;

/** Titel einzeilig und auf 60 Zeichen gekürzt (mit …); ohne Titel „–“. */
function freigabeTitel(titel: string | null): string {
  const einzeilig = (titel ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (einzeilig === '') {
    return '–';
  }
  const zeichen = Array.from(einzeilig);
  return zeichen.length > FREIGABE_TITEL_MAX ? `${zeichen.slice(0, FREIGABE_TITEL_MAX - 1).join('')}…` : einzeilig;
}

/** Listet die Pipeline-PRs, die auf Stefans Freigabe warten; schreibt nichts (COPI-184). */
async function pipelineFreigabenAusfuehren(umgebung: CliUmgebung): Promise<number> {
  const freigaben = await offeneFreigaben(umgebung.pool);
  if (freigaben.length === 0) {
    umgebung.ausgabe('keine offenen Freigaben');
    return EXIT_ERLEDIGT;
  }
  const zeilen = freigaben.map((f) => [
    f.ticketKey,
    f.repo,
    typeof f.pr === 'number' && Number.isSafeInteger(f.pr) && f.pr > 0 ? `#${String(f.pr)}` : '–',
    f.runden === null ? '–' : String(f.runden),
    f.angefragtAm.toISOString(),
    freigabeTitel(f.titel),
  ]);
  const kopf = ['Ticket', 'Repo', 'PR', 'Runden', 'angefragt', 'Titel'];
  const breiten = kopf.map((name, i) => Math.max(name.length, ...zeilen.map((z) => (z[i] ?? '').length)));
  for (const zeile of [kopf, ...zeilen]) {
    umgebung.ausgabe(zeile.map((wert, i) => (i === zeile.length - 1 ? wert : wert.padEnd(breiten[i] ?? 0))).join(' '));
  }
  return EXIT_ERLEDIGT;
}

/** Setzt einen Anbieter von Hand auf ok oder disabled (COPI-181). */
async function pipelineAnbieterSetzenAusfuehren(
  umgebung: CliUmgebung,
  anbieter: Anbieter,
  zustand: SetzbarerZustand,
): Promise<number> {
  await anbieterSetzen(umgebung.pool, {
    provider: anbieter,
    state: zustand,
    jetzt: umgebung.jetzt?.() ?? new Date(),
  });
  umgebung.ausgabe(`${anbieter}: ${zustand}`);
  return EXIT_ERLEDIGT;
}

/** Führt einen Befehl aus und liefert den Exit-Code. Wirft nie: unerwartete Fehler werden zu Exit 1. */
export async function cliAusfuehren(
  argumente: readonly string[],
  umgebung: CliUmgebung,
): Promise<number> {
  const gelesen = befehlLesen(argumente);
  if ('fehler' in gelesen) {
    umgebung.fehlerausgabe(`${gelesen.fehler}\n\n${NUTZUNG}`);
    return EXIT_BEDIENUNG;
  }
  if (gelesen.befehl === 'hilfe') {
    umgebung.ausgabe(NUTZUNG);
    return EXIT_ERLEDIGT;
  }
  try {
    switch (gelesen.befehl) {
      case 'erststart':
        return await erststartAusfuehren(umgebung);
      case 'einladung':
        return await einladungAusfuehren(umgebung, gelesen.email, gelesen.rolle);
      case 'betreuer-uebergeben':
        return await uebergabeAusfuehren(umgebung, gelesen.an, gelesen.bisherigerWirdRolle);
      case 'entsperren':
        return await entsperrenAusfuehren(umgebung, gelesen.konto);
      case 'migrieren':
        return await migrierenAusfuehren(umgebung, gelesen.modus);
      case 'api-token-erzeugen':
        return await apiTokenErzeugenAusfuehren(umgebung, gelesen.name, gelesen.scopes);
      case 'api-token-auflisten':
        return await apiTokenAuflistenAusfuehren(umgebung);
      case 'api-token-widerrufen':
        return await apiTokenWiderrufenAusfuehren(umgebung, gelesen.id);
      case 'vapid-erzeugen':
        return vapidErzeugenAusfuehren(umgebung);
      case 'modul-einspielen':
        return await modulEinspielenAusfuehren(umgebung, gelesen.herkunft);
      case 'module-auflisten':
        return await moduleAuflistenAusfuehren(umgebung);
      case 'modul-freigabe':
        return await modulFreigabeAusfuehren(umgebung, gelesen.modul, gelesen.stufe);
      case 'verbrauch-kosten-neu':
        return await verbrauchKostenNeuAusfuehren(umgebung);
      case 'pipeline-repo':
        return await pipelineRepoAusfuehren(umgebung);
      case 'pipeline-repos':
        return await pipelineReposAusfuehren(umgebung);
      case 'pipeline-anbieter':
        return await pipelineAnbieterAusfuehren(umgebung);
      case 'pipeline-freigaben':
        return await pipelineFreigabenAusfuehren(umgebung);
      case 'pipeline-anbieter-setzen':
        return await pipelineAnbieterSetzenAusfuehren(umgebung, gelesen.anbieter, gelesen.zustand);
    }
  } catch (fehler) {
    // Nur die Meldung, nie das Fehlerobjekt.
    umgebung.fehlerausgabe(`Fehler: ${fehler instanceof Error ? fehler.message : 'unbekannt'}`);
    return EXIT_ABGELEHNT;
  }
}
