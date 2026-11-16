/**
 * Das Protokoll der Sicherheitsereignisse (COPI-23, Migration 0009).
 *
 * Jede sicherheitsrelevante Änderung im Zugang hinterlässt einen Eintrag. Die
 * Tabelle ist in der Datenbank auf „nur anhängen" gesperrt: Änderungen, Löschen
 * und Leeren scheitern. Weil sich ein Eintrag nie mehr entfernen lässt, gilt
 * Datensparsamkeit **schon beim Schreiben** — `pruefeEreignis` lässt nur
 * Kennungen und feste Begriffe zu, nie eine Adresse, ein Token, ein Passwort
 * oder eine IP. Das ist der einzige Weg ins Protokoll; die Anwendung schreibt
 * nirgends per SQL an der Funktion vorbei.
 *
 * Wo die Anwendung ohnehin eine eigene Transaktion hat (Einladung anlegen und
 * einlösen, Konto-Verfall, Betreuerübergabe), läuft der Eintrag **in
 * derselben Transaktion** wie die Änderung (`protokollSchreiben` mit dem
 * Client der Transaktion): beides gilt oder keins von beidem. Wo Better Auth die
 * Änderung macht (Anmeldung, zweiter Faktor, Abmeldung, Konto anlegen), folgt der
 * Eintrag unmittelbar danach; ein Absturz dazwischen lässt dort einen Eintrag
 * fehlen — bewusst akzeptiert, eine gemeinsame Transaktion über die
 * Bibliotheksgrenze ist nicht erreichbar. Dort schreibt `protokollNotieren`:
 * ein Fehler wird laut gemeldet, bricht aber weder die Anmeldung noch die
 * Abmeldung ab (Verfügbarkeit vor Vollständigkeit).
 */
import type pg from 'pg';

/**
 * Die bekannten Ereignisse; muss mit der Tabelle `cockpit.protokoll_art` übereinstimmen (seit Migration 0019,
 * vorher eine CHECK-Liste). Neue Arten kommen mit den Tickets, die sie erzeugen, samt Migration — dort ein
 * `INSERT INTO cockpit.protokoll_art`, nicht mehr die ganze Liste.
 */
export const PROTOKOLL_ARTEN = [
  'konto_angelegt',
  'einladung_erzeugt',
  'einladung_eingeloest',
  'anmeldung_erfolgreich',
  'anmeldung_fehlgeschlagen',
  'sperre_ausgeloest',
  'zweiter_faktor_eingerichtet',
  'ersatzcode_verwendet',
  'abmeldung',
  'konto_verfallen',
  'betreuer_uebergeben',
  'erststart_token_erzeugt',
  'konto_entsperrt',
  'zugang_wiederhergestellt',
  'api_token_erzeugt',
  'api_token_widerrufen',
  'api_zugriff_abgelehnt',
  'update_beantragt',
  'update_zurueckgezogen',
  'update_freigegeben',
  'update_gestartet',
  'update_erledigt',
  'update_fehlgeschlagen',
  'name_geaendert',
  'rolle_geaendert',
  'konto_entfernt',
  'email_aenderung_beantragt',
  'email_geaendert',
  'chat_mail_gesendet',
  'vorgang_uebernommen',
  'vorgang_zurueckgegeben',
  'erscheinungsbild_geaendert',
  // COPI-90, Migration 0038.
  'antwort_freigegeben',
  'freigabe_zurueckgezogen',
  // COPI-94, Migration 0042: zweite Faktoren verwalten.
  'zweiter_faktor_hinzugefuegt',
  'zweiter_faktor_entfernt',
  'ersatzcodes_erneuert',
  'faktor_bestaetigt',
  // COPI-110, Migration 0044: ein Anhang aus einer Modulseite heruntergeladen.
  'anhang_heruntergeladen',
  // COPI-91, Migration 0045: eine Entscheidung an einem Vorgang (Eingriff „entscheiden").
  'entscheidung_getroffen',
  'entscheidung_zurueckgenommen',
  // COPI-134, Migration 0048: der Betriebs-Admin (oder ein Server-Kommando) setzt den Betreuer-Zugriff auf ein Modul.
  'betreuer_zugriff_geaendert',
  // COPI-141, Migration 0050: der Betreuer schaltet den Freigabemodus für Updates um.
  'update_freigabemodus_geaendert',
] as const;

export type ProtokollArt = (typeof PROTOKOLL_ARTEN)[number];

/**
 * Die Schlüssel der Einzelheiten. Eine Liste statt freier Schlüssel: wer etwas
 * Neues protokollieren will, muss es hier ausdrücklich zulassen und im Review
 * begründen — ein `email` oder `token` kommt so nicht versehentlich hinein.
 */
const EINZELHEITEN_SCHLUESSEL = [
  'weg',
  'rolle',
  'faktor',
  'schritt',
  'sperre',
  'einladung_id',
  'von',
  'an',
  'bisherige_rolle',
  // Agenten-API (COPI-35): Nummer und Name des Zugangs, der Grund einer Ablehnung, das fehlende Recht.
  'token_id',
  'name',
  'grund',
  'scope',
  // Update-Antrag (COPI-40) und seine Übergänge (COPI-41): die Nummer des Antrags. Digests und Ziel-Version stehen
  // unveränderlich in dessen Zeile.
  'eingriff_id',
  // E-Mail-Zweitkanal (COPI-60): wie viele dringende Nachrichten eine Mail meldet — nie welche, nie ihr Inhalt.
  'anzahl',
  // Übernahme-Sperre (COPI-85): die Nummer der Sperre. Modul und Vorgang stehen unveränderlich in deren Zeile — die
  // `id` eines Vorgangs ist Text aus einer Fach-View und passt nicht sicher als Kennung ins Protokoll.
  'vorgang_sperre_id',
  // App-Symbol (COPI-101): `hochgeladen` oder `zurueckgesetzt` (Schlüssel `weg`) und die Nummer der Zeile.
  'app_symbol_id',
  // Antwort freigeben (COPI-90): die Nummer der Freigabe. Modul, Vorgang, Fassung und Hash stehen unveränderlich in
  // deren Zeile — wie bei der Sperre nie der Text.
  'freigabe_id',
  // Anhang heruntergeladen (COPI-110): die Nummer des Nachweises. Modul, Vorgang, Dateiname und SHA-256 stehen
  // unveränderlich in dessen Zeile — Dateinamen sind Fremdtext und gehören nicht ins Protokoll.
  'anhang_download_id',
  // Entscheidung (COPI-91): die Nummer der Entscheidung. Modul, Vorgang und Wert stehen unveränderlich in deren Zeile.
  'entscheidung_id',
  // Betreuer-Zugriff (COPI-134): die Nummer der Zeile. Modul und Stufe stehen unveränderlich in ihr.
  'betreuer_zugriff_id',
  // Freigabemodus (COPI-141): die Nummer der Zeile, Bereich und Modus stehen unveränderlich in ihr; dazu `von`/`an`.
  'update_freigabemodus_id',
] as const;

export type EinzelheitenSchluessel = (typeof EINZELHEITEN_SCHLUESSEL)[number];

export type Einzelheiten = Partial<Record<EinzelheitenSchluessel, string | number | boolean>>;

export interface Ereignis {
  readonly art: ProtokollArt;
  /**
   * Konto-ID oder ein fester Begriff, wenn kein Konto handelt: `system` (die
   * Anwendung), `konsole` (ein Server-Kommando), `erststart`, `einladung` und
   * `wiederherstellung` (wer ein Token einlöst, ist noch nicht angemeldet).
   */
  readonly akteur: string;
  /** Konto-ID, wenn das Ereignis ein Konto betrifft. */
  readonly ziel?: string;
  readonly einzelheiten?: Einzelheiten;
}

/**
 * Höchstens 40 Zeichen aus Buchstaben, Ziffern, Unterstrich und Bindestrich.
 * Damit passt eine Better-Auth-Konto-ID (32 Zeichen) und jeder feste Begriff,
 * eine Adresse (`@`, `.`), eine IP (`.`, `:`), ein Satz (Leerzeichen) und ein Token
 * (43 Zeichen) aber nicht.
 */
const KENNUNG = /^[A-Za-z0-9_-]{1,40}$/;

function abgewiesen(grund: string): never {
  // Die Meldung nennt nie den abgewiesenen Wert: sie landet in Logs.
  throw new Error(`Protokoll: Eintrag abgewiesen (${grund})`);
}

function kennungPruefen(wert: unknown, name: string): void {
  if (typeof wert !== 'string' || !KENNUNG.test(wert)) {
    abgewiesen(`${name} ist keine Kennung`);
  }
}

/**
 * Prüft ein Ereignis, bevor es geschrieben wird: bekannte Art, Kennungen statt
 * Klartext, nur zugelassene Schlüssel mit flachen, kurzen Werten.
 */
export function pruefeEreignis(ereignis: Ereignis): void {
  if (!(PROTOKOLL_ARTEN as readonly string[]).includes(ereignis.art)) {
    abgewiesen('unbekannte Art');
  }
  kennungPruefen(ereignis.akteur, 'Akteur');
  if (ereignis.ziel !== undefined) {
    kennungPruefen(ereignis.ziel, 'Ziel');
  }
  for (const [schluessel, wert] of Object.entries(ereignis.einzelheiten ?? {})) {
    if (!(EINZELHEITEN_SCHLUESSEL as readonly string[]).includes(schluessel)) {
      abgewiesen('unbekannter Schlüssel');
    }
    if (typeof wert === 'string') {
      kennungPruefen(wert, 'Einzelheit');
    } else if (typeof wert !== 'number' && typeof wert !== 'boolean') {
      abgewiesen('Einzelheit ist weder Kennung noch Zahl noch Wahrheitswert');
    }
  }
}

/** Ein Pool oder der Client einer laufenden Transaktion. */
export type Abfrager = Pick<pg.Pool, 'query'>;

/**
 * Schreibt einen Eintrag. Wirft bei einem ungültigen Ereignis und bei einem
 * Datenbankfehler. Mit dem Client einer Transaktion aufgerufen, gehört der
 * Eintrag zu ihr.
 */
export async function protokollSchreiben(db: Abfrager, ereignis: Ereignis): Promise<void> {
  pruefeEreignis(ereignis);
  await db.query(
    `INSERT INTO cockpit.protokoll (art, akteur, ziel, einzelheiten)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [ereignis.art, ereignis.akteur, ereignis.ziel ?? null, JSON.stringify(ereignis.einzelheiten ?? {})],
  );
}

/**
 * Ein Konto ist angelegt worden: über den Erststart oder eine eingelöste Einladung.
 * Der Weg ist zugleich der Akteur (niemand ist angemeldet, es zählt das Token).
 */
export interface KontoAngelegt {
  readonly weg: 'erststart' | 'einladung';
  readonly kontoId: string;
  readonly rolle: string;
}

/** Was `protokollNotieren` zum Melden braucht — Fastifys `request.log` passt. */
export interface Meldung {
  error(objekt: { grund: string }, nachricht: string): void;
}

/**
 * Die jüngste erfolgreiche Anmeldung je Konto (COPI-45, Seite Benutzer): Konto-ID → Zeitpunkt. Ein Konto, das sich nie
 * angemeldet hat, fehlt. Gelesen in einem Durchgang, gruppiert — nicht je Konto einzeln gesucht.
 */
export async function letzteAnmeldungen(db: Abfrager): Promise<ReadonlyMap<string, Date>> {
  const ergebnis = await db.query<{ akteur: string; zuletzt: Date }>(
    `SELECT akteur, max(zeitpunkt) AS zuletzt
       FROM cockpit.protokoll
      WHERE art = 'anmeldung_erfolgreich'
      GROUP BY akteur`,
  );
  return new Map(ergebnis.rows.map((zeile) => [zeile.akteur, zeile.zuletzt]));
}

/**
 * Wie `protokollSchreiben`, aber ohne Ausnahme: ein Fehler wird laut gemeldet und
 * nicht verschluckt, hält den Ablauf aber nicht an. Für Stellen, an denen ein
 * fehlgeschlagener Eintrag eine Anmeldung nicht verhindern soll.
 */
export async function protokollNotieren(
  db: Abfrager,
  meldung: Meldung,
  ereignis: Ereignis,
): Promise<void> {
  try {
    await protokollSchreiben(db, ereignis);
  } catch (fehler) {
    meldung.error(
      { grund: fehler instanceof Error ? fehler.message : 'unbekannt' },
      `Protokoll: Eintrag ${ereignis.art} konnte nicht geschrieben werden`,
    );
  }
}

/** Hält fest, dass ein Konto angelegt wurde; Fehler wie bei `protokollNotieren`. */
export async function kontoAngelegtNotieren(
  db: Abfrager,
  meldung: Meldung,
  angelegt: KontoAngelegt,
): Promise<void> {
  await protokollNotieren(db, meldung, {
    art: 'konto_angelegt',
    akteur: angelegt.weg,
    ziel: angelegt.kontoId,
    einzelheiten: { weg: angelegt.weg, rolle: angelegt.rolle },
  });
}

export interface EigenesEreignis {
  readonly zeitpunkt: Date;
  readonly art: ProtokollArt;
  readonly einzelheiten: Einzelheiten;
}

/**
 * Die jüngsten Einträge, die ein Konto selbst ausgelöst hat, aus einer festen Liste von Arten — neueste zuerst. Für
 * „Letzte Änderungen" auf `/sicherheit` (COPI-94): nur das eigene Konto, nur Kennungen und feste Begriffe (mehr steht
 * im Protokoll ohnehin nicht, `pruefeEreignis`).
 */
export async function eigeneEreignisseLesen(
  db: Abfrager,
  akteur: string,
  arten: readonly ProtokollArt[],
  anzahl: number,
): Promise<EigenesEreignis[]> {
  const ergebnis = await db.query<EigenesEreignis>(
    `SELECT zeitpunkt, art, einzelheiten
       FROM cockpit.protokoll
      WHERE akteur = $1 AND art = ANY($2::text[])
      ORDER BY id DESC
      LIMIT $3`,
    [akteur, arten, anzahl],
  );
  return ergebnis.rows;
}
