import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from './app.js';
import type { Erweiterung } from './erweiterungen.js';
import { basisUrl, loadEnv } from './env.js';
import { erzeugeAuth, geheimnisBesorgen } from '../auth/konfiguration.js';
import {
  benutzerVorhanden,
  neuesErststartTokenAnlegen,
} from '../auth/erststart-speicher.js';
import {
  erststartBlockAusgeben,
  erststartBlockBauen,
} from '../auth/erststart-ausgabe.js';
import { verfalleneKontenMarkieren } from '../auth/konto-verfall.js';
import { startpruefung } from '../datenbank/migrationen.js';
import { repowacheAusUmgebung } from '../freigaben/repowache.js';
import { koordinatorAusUmgebung } from '../chat/koordinator.js';
import { pushAusUmgebung } from '../chat/push.js';
import { pipelineAusUmgebung } from '../pipeline/signatur.js';
import { ZWEITKANAL_FRIST_MINUTEN_STANDARD, ZWEITKANAL_TAKT_MS, zweitkanalLaufen } from '../chat/zweitkanal.js';
import { mailversandAusEnv } from '../mail/versand.js';
import { instanzAngaben, paketVersionLesen } from '../status/instanz.js';
import { instanzMelden } from '../status/instanz-speicher.js';
import { PLANER_TAKT_MS, updatePlanerLaufen } from '../status/update-planer.js';

/**
 * Der Start des Cockpits: Umgebung lesen, Pool, Auth, Mailversand, App und Listen. Das Kundenimage startet ihn über
 * diese Datei ohne Erweiterungen (COPI-195); ein Projekt, das den Kern erweitert, übergibt sie über seinen eigenen Einstieg. Der Kern
 * kennt keinen Schalter, er bekommt nur die fertige Liste (`AppAbhaengigkeiten.erweiterungen`, COPI-193).
 */
export function cockpitStarten(erweiterungen: readonly Erweiterung[] = []): void {
  const env = loadEnv();

  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL ist nicht gesetzt');
  }

  const pool = new pg.Pool({ connectionString: env.databaseUrl });
  // Der Logger entsteht erst mit der App: Hinweise zum Geheimnis (Datei angelegt, kein Speichern möglich)
  // werden gesammelt und gleich nach dem Aufbau der App geschrieben.
  const geheimnisHinweise: string[] = [];
  const auth = erzeugeAuth({
    databaseUrl: env.databaseUrl,
    basisUrl: basisUrl(env),
    secret: geheimnisBesorgen(env, { hinweis: (text) => geheimnisHinweise.push(text) }),
    pool,
  });

  /**
   * Ohne SMTP-Konfiguration (`SMTP_HOST`/`SMTP_FROM`) gibt es keinen Versand und
   * damit keine Einladungsroute. Das Cockpit startet trotzdem — die Instanz
   * bleibt über den Erststart-Zugang bedienbar —, weist aber beim Start darauf
   * hin. E-Mail ist laut Architektur-Vorschlag Pflicht-Zweitkanal; eine Instanz
   * ohne SMTP ist ein unfertiger Aufbau, kein normaler Betriebszustand.
   */
  const versand = mailversandAusEnv(env);

  /** Der Koordinator-Agent (COPI-54). Eine halbe Konfiguration hält den Start an, statt still ohne Antworten zu laufen. */
  const koordinator = koordinatorAusUmgebung(env);
  /** Die Freigabe-Inbox (COPI-139): ohne Adresse und Token ist das Modul ausgeblendet. */
  const repowache = repowacheAusUmgebung(env);
  /** Web Push (COPI-59): ein halbes VAPID-Paar hält den Start an. */
  const push = pushAusUmgebung(env, basisUrl(env));
  /** Die Pipeline-API (COPI-145): ein zu kurzes Geheimnis hält den Start an, ohne Geheimnis nimmt sie nichts an. */
  const pipeline = pipelineAusUmgebung(env);

  const app = buildApp(env, {
    auth,
    pool,
    ...(koordinator ? { koordinator } : {}),
    ...(repowache ? { repowache } : {}),
    ...(push ? { push } : {}),
    ...(pipeline ? { pipeline } : {}),
    ...(env.chatTageslimit ? { chatTageslimit: env.chatTageslimit } : {}),
    basisUrl: basisUrl(env),
    ...(versand ? { versand } : {}),
    ...(env.instanzName ? { instanzName: env.instanzName } : {}),
    ...(erweiterungen.length > 0 ? { erweiterungen } : {}),
  });

  for (const hinweis of geheimnisHinweise) {
    app.log.warn(hinweis);
  }

  if (!push) {
    app.log.warn('Web Push nicht konfiguriert (COCKPIT_VAPID_PUBLIC_KEY/_PRIVATE_KEY) — dringende Nachrichten nur per E-Mail.');
  }

  if (!koordinator) {
    app.log.warn('Koordinator nicht konfiguriert (COCKPIT_KOORDINATOR_URL/_SECRET) — der Assistent im Chat ist nicht angebunden.');
  }

  if (!versand) {
    app.log.warn(
      'SMTP nicht konfiguriert (SMTP_HOST/SMTP_FROM) — Einladungen und der E-Mail-Zweitkanal des Chats sind deaktiviert.',
    );
  }

  /**
   * Erststart-Bootstrap (Architektur-Vorschlag Abschnitt 13.2): Solange kein
   * Benutzer existiert, wird bei **jedem** Start ein neues Token erzeugt und auf
   * stdout ausgegeben. Existiert bereits ein Benutzer, passiert hier nichts.
   */
  async function erststartVorbereiten(): Promise<void> {
    if (await benutzerVorhanden(pool)) {
      return;
    }
    const token = await neuesErststartTokenAnlegen(pool);
    erststartBlockAusgeben(erststartBlockBauen(token, basisUrl(env)));
  }

  const AUFRAEUM_INTERVALL_MS = 15 * 60 * 1000;

  /**
   * Aufräumen verfallener Konten und ggf. ein neues Erststart-Token erzeugen.
   *
   * Das Erststart-Token wird **nur erzeugt, wenn dieser Lauf etwas gelöscht hat**.
   * Ohne diese Bedingung würde `erststartVorbereiten()` bei jedem Tick ein neues
   * Token erzeugen, solange der Erststart nicht abgeschlossen ist — und dabei
   * das schon ausgegebene 24h-Token laufend entwerten. Beim Serverstart selbst
   * gibt es einen separaten Aufruf (unverändert).
   */
  async function verfalleneKontenAufraeumen(): Promise<number> {
    const anzahl = await verfalleneKontenMarkieren(pool, new Date());
    if (anzahl > 0) {
      app.log.info({ anzahl }, 'Verfallene Konten als gelöscht markiert');
    }
    return anzahl;
  }

  /**
   * Ein Lauf im festen Takt. Ein Lauf, der noch nicht fertig ist (langsamer SMTP-Server, volle Datenbank), wird nicht von
   * einem zweiten überholt; ein Fehler landet im Log und hält den Takt nicht an.
   */
  function imTakt(name: string, lauf: () => Promise<void>, taktMs: number): void {
    let laeuft = false;
    setInterval(() => {
      if (laeuft) {
        return;
      }
      laeuft = true;
      lauf()
        .catch((fehler: unknown) => {
          app.log.error(fehler, `${name}: Lauf gescheitert`);
        })
        .finally(() => {
          laeuft = false;
        });
    }, taktMs);
  }

  /** Der E-Mail-Zweitkanal (COPI-60) im Takt einer Minute. */
  function zweitkanalStarten(): void {
    if (!versand) {
      return;
    }
    const lauf = {
      pool,
      versand,
      basisUrl: basisUrl(env),
      fristMinuten: env.chatMailNachMinuten ?? ZWEITKANAL_FRIST_MINUTEN_STANDARD,
      log: app.log,
    };
    imTakt(
      'Zweitkanal',
      async () => {
        const ergebnis = await zweitkanalLaufen(lauf, new Date());
        if (ergebnis.gesendet > 0) {
          app.log.info({ gesendet: ergebnis.gesendet }, 'Zweitkanal: dringende, ungelesene Nachrichten per E-Mail gemeldet');
        }
      },
      ZWEITKANAL_TAKT_MS,
    );
  }

  /**
   * Der Update-Planer (COPI-142) im Takt einer Minute: im Freigabemodus `automatisch` stellt er Anträge selbst. Im Log
   * stehen gestellte Anträge und Fehler; ein Versuch, den der Schleifenschutz abweist, bleibt still (er käme jede Minute).
   */
  function updatePlanerStarten(): void {
    imTakt(
      'Update-Planer',
      async () => {
        for (const versuch of await updatePlanerLaufen(pool, new Date(), env.wartungsfenster)) {
          const { modul, ziel, ergebnis } = versuch;
          if (ergebnis.ok) {
            app.log.info({ eingriff: ergebnis.id, modul, ziel }, 'Update-Planer: Antrag automatisch gestellt und freigegeben');
          } else if (ergebnis.grund === 'fehler') {
            app.log.error({ modul, ziel, grund: ergebnis.meldung }, 'Update-Planer: Antrag gescheitert');
          }
        }
      },
      PLANER_TAKT_MS,
    );
  }

  /**
   * Exit-Code, wenn das Schema nicht auf dem Stand des Images ist (COPI-31): vom Betreiber
   * unterscheidbar von einem Absturz (1). Der Container endet, die Meldung steht auf stderr.
   */
  const EXIT_SCHEMA_NICHT_AUF_STAND = 3;

  /**
   * Als **Erstes**, vor jeder anderen Abfrage: ohne Schema oder mit ausstehender Migration startet das
   * Cockpit nicht — und sagt, was fehlt und was zu tun ist, statt mit einem SQL-Fehler
   * (`relation "cockpit.user" does not exist`) mitten im Start zu enden. Es migriert nicht selbst:
   * ein Image-Update soll die Datenbank nicht ohne Freigabe verändern (ADR 13.1); der Schritt ist der
   * Befehl `migrieren` (siehe README, „Schema und Migrationen").
   */
  async function schemaPruefen(): Promise<void> {
    const ergebnis = await startpruefung(pool);
    if (!ergebnis.ok) {
      process.stderr.write(`\nCOCKPIT STARTET NICHT\n${ergebnis.meldung}\n\n`);
      process.exit(EXIT_SCHEMA_NICHT_AUF_STAND);
    }
    if (ergebnis.warnung !== undefined) {
      app.log.warn(ergebnis.warnung);
    }
  }

  /**
   * Selbstmeldung (COPI-39, ADR 13.1): Version und Digest dieses Cockpits in `cockpit.instanz`, **vor** dem
   * Lauschen — wer auf `/gesund` antwortet, hat sich gemeldet. In derselben Transaktion belegt sie ein laufendes
   * Update als erledigt, wenn dieses Cockpit dessen Ziel ist (COPI-41): Erfolg heißt „ein Cockpit mit Ziel-Digest und
   * Ziel-Version hat sich gemeldet", nicht „der Befehl lief durch". Scheitert das Schreiben, startet das Cockpit nicht
   * (Exit 1): ohne Meldung ließe sich ein Update nie bestätigen.
   */
  async function instanzMeldenBeimStart(): Promise<void> {
    const angaben = instanzAngaben(
      { nodeEnv: env.nodeEnv, version: env.imageVersion, commit: env.imageCommit, digest: env.imageDigest },
      paketVersionLesen(),
    );
    for (const hinweis of angaben.hinweise) {
      app.log.warn(hinweis);
    }
    const ergebnis = await instanzMelden(pool, angaben, new Date());
    app.log.info({ version: angaben.version, digest: angaben.digest ?? null }, 'Cockpit gemeldet');
    if (ergebnis.erledigt !== undefined) {
      app.log.info({ eingriff: ergebnis.erledigt }, 'Update belegt: dieses Cockpit ist das Ziel des laufenden Eingriffs, er ist erledigt');
    }
  }

  schemaPruefen()
    .then(() => instanzMeldenBeimStart())
    .then(() => verfalleneKontenAufraeumen())
    .then(() => erststartVorbereiten())
    .then(() => app.listen({ port: env.port, host: env.host }))
    .then(() => {
      app.log.info(`Cockpit hört auf ${env.host}:${env.port}`);
      setInterval(() => {
        void verfalleneKontenAufraeumen().then((anzahl) => {
          if (anzahl > 0) {
            return erststartVorbereiten();
          }
        });
      }, AUFRAEUM_INTERVALL_MS);
      zweitkanalStarten();
      updatePlanerStarten();
    })
    .catch((error: unknown) => {
      app.log.error(error);
      process.exit(1);
    });
}

/**
 * Ist diese Datei der Einstieg des Prozesses (`node dist/server/index.js`) und nicht nur importiert? Wer sie
 * importiert (etwa der Einstieg eines erweiternden Projekts), startet selbst. `metaUrl` ist `import.meta.url` des Einstiegs.
 */
export function istEinstieg(metaUrl: string): boolean {
  const aufgerufen = process.argv[1];
  if (aufgerufen === undefined) {
    return false;
  }
  try {
    return realpathSync(aufgerufen) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (istEinstieg(import.meta.url)) {
  cockpitStarten();
}
